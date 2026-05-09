//! 外部 .md 双向同步——内 → 外（笔记保存 → 写回原文件）
//!
//! 流程概要：
//! 1. 入口: `WriteBackService::write_back(db, note_id, force)`
//! 2. 前置：笔记必须 `source_file_type = "md"` 且 `source_file_path` 非空，否则跳过（Skipped）
//! 3. 冲突检测：读 `last_writeback_mtime` 与原文件当前 mtime 比对；不一致且未 force → Conflict
//! 4. URL 反向替换：
//!    - 命中 `note_url_mapping`（internal_url → original_url）→ 写回原始 URL
//!    - 未命中（用户在编辑器里新插的图）→ 拷到 `<basename>.assets/` 写相对路径
//! 5. fs::write + 更新 `last_writeback_mtime`
//!
//! 设计要点：URL 扫描逻辑不依赖 export.rs 的 private helpers，自包含一份避免耦合。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::database::Database;
use crate::error::AppError;

/// 写回结果——给前端做不同 UI 提示
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriteBackResult {
    /// 写回成功；含拷到原文件旁的资产数
    Ok {
        assets_copied: usize,
        file_path: String,
    },
    /// 笔记不是从外部 .md 打开来的，没什么可写回的
    Skipped { reason: String },
    /// 原文件 mtime 与上次写回时不一致 = 外部改过，让用户选策略
    Conflict {
        external_mtime: i64,
        last_known_mtime: Option<i64>,
        file_path: String,
    },
    /// 原文件已被删/移走/挂网盘失败等
    Missing { file_path: String },
}

pub struct WriteBackService;

impl WriteBackService {
    /// 把笔记当前内容写回原 .md 文件
    ///
    /// - `force = true`：跳过 mtime 冲突检测，强制覆盖（冲突 Modal 选"覆盖外部"后调用）
    /// - 默认 `force = false`：检测到冲突就返回 `WriteBackResult::Conflict` 让前端弹 Modal
    pub fn write_back(
        db: &Database,
        note_id: i64,
        force: bool,
    ) -> Result<WriteBackResult, AppError> {
        // 1. 拉笔记 content + source_file_path/type
        let (content, source_path, source_type) = {
            let conn = db.conn_lock()?;
            let mut stmt = conn.prepare(
                "SELECT content, source_file_path, source_file_type
                 FROM notes WHERE id = ?1 AND is_deleted = 0",
            )?;
            stmt.query_row([note_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|_| AppError::NotFound(format!("笔记 {} 不存在", note_id)))?
        };

        // 2. 仅对外部 .md 笔记写回
        let path_str = match (source_type.as_deref(), source_path) {
            (Some("md"), Some(p)) => p,
            _ => {
                return Ok(WriteBackResult::Skipped {
                    reason: "笔记不是从外部 .md 打开来的".into(),
                })
            }
        };
        let path = PathBuf::from(&path_str);

        // 3. 文件是否还在
        let cur_meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                return Ok(WriteBackResult::Missing {
                    file_path: path_str,
                })
            }
        };
        let cur_mtime = cur_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // 4. 冲突检测
        let last = db.get_writeback_mtime(note_id)?;
        if !force {
            if let Some(last_mt) = last {
                if cur_mtime != last_mt {
                    return Ok(WriteBackResult::Conflict {
                        external_mtime: cur_mtime,
                        last_known_mtime: Some(last_mt),
                        file_path: path_str,
                    });
                }
            }
            // last 为 None 视为"刚打开还没写回过"，外部 mtime 自然不等于"无"——
            // 但这种情况外部其实 = 我们刚读进来的版本，强行报冲突会很烦人。
            // 用 last 是 None 表示首次打开，跳过冲突检测。
        }

        // 5. URL 反向替换
        let mappings = db.list_url_mappings(note_id)?;
        let basename = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("note-{}", note_id));
        let parent = path.parent().unwrap_or(Path::new("."));
        let assets_subdir = format!("{}.assets", basename);

        let (rewritten, assets_copied) =
            rewrite_for_writeback(&content, &mappings, parent, &assets_subdir);

        // 6. 写回 + 更新 mtime
        std::fs::write(&path, &rewritten)?;
        if let Some(new_mtime) = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
        {
            let _ = db.set_writeback_mtime(note_id, new_mtime);
        }

        log::info!(
            "[writeback] 笔记 #{} 已写回 {} (mappings={}, copied={})",
            note_id,
            path.display(),
            mappings.len(),
            assets_copied
        );

        Ok(WriteBackResult::Ok {
            assets_copied,
            file_path: path_str,
        })
    }

    /// 解除笔记与外部 .md 的双向同步关联
    ///
    /// 用于：原文件被删/移走/用户主动断开。从此该笔记不再触发 writeBack，
    /// 提示也不会再弹。同时清掉 url_mapping 与 mtime 基线，避免重新关联时残留脏数据。
    pub fn clear_link(db: &Database, note_id: i64) -> Result<(), AppError> {
        db.set_note_source_file(note_id, None, None)?;
        db.clear_url_mappings(note_id)?;
        db.clear_writeback_mtime(note_id)?;
        log::info!("[writeback] 笔记 #{} 已解除外部 .md 关联", note_id);
        Ok(())
    }
}

// ───────── URL 反向替换实现 ─────────

/// 扫 content 里所有 URL，命中映射表 → 替换为原始 URL；未命中 → 复制到 assets/ 改相对路径
///
/// 返回 (新 content, 实际拷贝到 assets/ 的资产数)
fn rewrite_for_writeback(
    content: &str,
    mappings: &HashMap<String, String>,
    md_parent_dir: &Path,
    assets_subdir: &str,
) -> (String, usize) {
    let spans = extract_md_url_spans(content);
    if spans.is_empty() {
        return (content.to_string(), 0);
    }

    let assets_dir = md_parent_dir.join(assets_subdir);
    let mut taken_names: HashSet<String> = HashSet::new();
    let mut path_to_relative: HashMap<PathBuf, String> = HashMap::new();
    let mut copied = 0usize;
    let mut replacements: Vec<(usize, usize, String)> = Vec::new();

    for (start, end, url) in spans {
        // 1) 内部 URL 命中映射 → 还原为原始 URL
        if let Some(orig) = mappings.get(&url) {
            if &url != orig {
                replacements.push((start, end, orig.clone()));
            }
            continue;
        }

        // 2) 用户新插入的图：仅处理本地 asset URL（http(s) / 相对路径都不动）
        let abs = match url_to_local_path(&url) {
            Some(p) => p,
            None => continue,
        };
        let canon_abs = match abs.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };

        let relative = if let Some(rel) = path_to_relative.get(&canon_abs) {
            rel.clone()
        } else {
            if std::fs::create_dir_all(&assets_dir).is_err() {
                continue;
            }
            let original_name = canon_abs
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "asset".to_string());
            let unique = unique_file_name(&original_name, &mut taken_names);
            let dest = assets_dir.join(&unique);
            if std::fs::copy(&canon_abs, &dest).is_err() {
                continue;
            }
            copied += 1;
            // markdown 用正斜杠
            let rel = format!("{}/{}", assets_subdir, unique);
            path_to_relative.insert(canon_abs.clone(), rel.clone());
            rel
        };
        replacements.push((start, end, relative));
    }

    // 倒序应用替换避免下标错位
    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    let mut new_content = content.to_string();
    for (s, e, repl) in replacements {
        new_content.replace_range(s..e, &repl);
    }
    (new_content, copied)
}

/// 扫描 content 中所有 URL 字节范围（图片/链接/HTML 属性）
///
/// 三种形式：
/// 1. Markdown `](url)`（图片 + 链接）
/// 2. HTML `src="url"` / `src='url'`
/// 3. HTML `href="url"` / `href='url'`
fn extract_md_url_spans(content: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    out.extend(scan_paren_urls(content));
    out.extend(scan_attr_urls(content, b"src"));
    out.extend(scan_attr_urls(content, b"href"));
    out.sort_by_key(|&(s, _, _)| s);
    let mut dedup = Vec::with_capacity(out.len());
    let mut last_end = 0usize;
    for span in out {
        if span.0 >= last_end {
            last_end = span.1;
            dedup.push(span);
        }
    }
    dedup
}

fn scan_paren_urls(content: &str) -> Vec<(usize, usize, String)> {
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b']' && bytes[i + 1] == b'(' {
            let url_start = i + 2;
            let mut j = url_start;
            while j < bytes.len() && bytes[j] != b')' && bytes[j] != b'\n' && bytes[j] != b'\r' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b')' {
                if let Ok(url) = std::str::from_utf8(&bytes[url_start..j]) {
                    out.push((url_start, j, url.to_string()));
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn scan_attr_urls(content: &str, attr_name: &[u8]) -> Vec<(usize, usize, String)> {
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + attr_name.len() + 3 < bytes.len() {
        if &bytes[i..i + attr_name.len()] == attr_name {
            let prev_ok = i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'\r' | b'<');
            let mut k = i + attr_name.len();
            while k < bytes.len() && matches!(bytes[k], b' ' | b'\t') {
                k += 1;
            }
            if prev_ok && k < bytes.len() && bytes[k] == b'=' {
                k += 1;
                while k < bytes.len() && matches!(bytes[k], b' ' | b'\t') {
                    k += 1;
                }
                if k < bytes.len() && (bytes[k] == b'"' || bytes[k] == b'\'') {
                    let quote = bytes[k];
                    let url_start = k + 1;
                    let mut j = url_start;
                    while j < bytes.len() && bytes[j] != quote && bytes[j] != b'\n' {
                        j += 1;
                    }
                    if j < bytes.len() && bytes[j] == quote {
                        if let Ok(url) = std::str::from_utf8(&bytes[url_start..j]) {
                            out.push((url_start, j, url.to_string()));
                        }
                        i = j + 1;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// 把 Tauri asset 协议或 file 协议 URL 还原成本地绝对路径；返回 None 表示非本地资产
fn url_to_local_path(url: &str) -> Option<PathBuf> {
    let (body, is_file) = if let Some(r) = url.strip_prefix("http://asset.localhost/") {
        (r, false)
    } else if let Some(r) = url.strip_prefix("https://asset.localhost/") {
        (r, false)
    } else if let Some(r) = url.strip_prefix("asset://localhost/") {
        (r, false)
    } else if let Some(r) = url.strip_prefix("file://") {
        (r, true)
    } else {
        return None;
    };
    let body = body.split(['?', '#']).next().unwrap_or(body);
    let decoded = urlencoding::decode(body).ok()?.into_owned();
    let path_str = if is_file {
        if decoded.starts_with('/') && decoded.len() >= 3 && decoded.as_bytes()[2] == b':' {
            decoded[1..].to_string()
        } else {
            decoded
        }
    } else if decoded.len() >= 2 && decoded.as_bytes()[1] == b':' {
        decoded
    } else if decoded.starts_with('/') {
        decoded
    } else {
        format!("/{}", decoded)
    };
    Some(PathBuf::from(path_str))
}

/// 文件名重名加 `_1`、`_2` 后缀
fn unique_file_name(name: &str, taken: &mut HashSet<String>) -> String {
    if taken.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(p) => (&name[..p], &name[p..]),
        None => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{}_{}{}", stem, n, ext);
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    name.to_string()
}
