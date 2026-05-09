//! 安全文件名工具：把任意原文件名清洗成可落盘的"原名风格"路径，
//! 同时在目标目录里去重。
//!
//! 用于 sources/ 与 images/ 落盘，让用户在文件系统里能直接认出"是哪份文件"。
//!
//! - `sanitize_stem`：替换非法/控制字符 + 字节截断 + Windows 保留名兜底
//! - `save_unique`：写入磁盘；同目录已有同名 + 内容一致 → 复用；否则加 `-1/-2/...`

use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 文件名（不含扩展名）允许的最大字节数。
///
/// 留 ~50 字节给后缀（`-12345`）+ 路径前缀（`sources/`）+ 扩展名；
/// 主流文件系统单段限 255 字节，全路径限 4096 字节，给一个保守的 200。
const MAX_STEM_BYTES: usize = 200;

/// 同名冲突时最多尝试加几个后缀
const MAX_SUFFIX_TRIES: u32 = 999;

/// 同名时做"内容比对去重"的最大文件大小（字节）。
///
/// 比对会把旧文件全量读进内存，对视频/超大附件不合适。
/// 超过这个阈值时直接走加后缀路径，不尝试 dedup。
const DEDUP_MAX_BYTES: u64 = 64 * 1024 * 1024; // 64 MB

/// Windows 保留名（不区分大小写匹配）。在这些名字下任何扩展名都不能用。
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 清洗文件名（不含扩展名）为可在 Windows / macOS / Linux 落盘的形式。
///
/// 具体处理：
///   1. 控制字符 + Windows 非法字符 (`< > : " / \ | ? *`) → `_`
///   2. 去前后空格、点号（Windows 不允许末尾 `.`）
///   3. 按字节安全截断到 200 字节，保持 UTF-8 边界
///   4. 命中 Windows 保留名（CON/PRN/...）加 `_` 前缀
///   5. 处理后为空时回退为 `untitled`
pub fn sanitize_stem(name: &str) -> String {
    // 1. 替换非法字符
    let mut s: String = name
        .chars()
        .map(|c| match c {
            c if c.is_control() => '_',
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect();

    // 2. trim 前后空格 + 点号（一并去多次直到不变）
    loop {
        let trimmed = s.trim().trim_matches('.').trim();
        if trimmed.len() == s.len() {
            break;
        }
        s = trimmed.to_string();
    }

    // 3. 字节截断（中文一字 3 字节）
    if s.as_bytes().len() > MAX_STEM_BYTES {
        let mut end = MAX_STEM_BYTES;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s = s.trim_end().to_string();
    }

    // 4. Windows 保留名兜底
    let upper = s.to_uppercase();
    if WINDOWS_RESERVED.iter().any(|&r| upper == r) {
        s = format!("_{}", s);
    }

    // 5. 空回退
    if s.is_empty() {
        s = "untitled".into();
    }
    s
}

/// 在 `dir` 里给 `new_content` 找一个唯一落盘路径并写入。
///
/// 流程：
///   1. 优先 `dir/<sanitize(stem)>.<ext>`；不存在则直接写
///   2. 已存在 + 内容相同 → 复用（不写盘，返回旧路径）
///   3. 已存在 + 内容不同 → 试 `<stem>-1.<ext>`、`<stem>-2.<ext>`…直到无冲突或复用
///   4. 极端情况 1000 次仍冲突 → 用 PID 兜底
pub fn save_unique(
    dir: &Path,
    stem: &str,
    ext: &str,
    new_content: &[u8],
) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(dir)?;
    let safe = sanitize_stem(stem);

    let make_path = |suffix: Option<u32>| -> PathBuf {
        let name = match suffix {
            None => format!("{}.{}", safe, ext),
            Some(n) => format!("{}-{}.{}", safe, n, ext),
        };
        dir.join(name)
    };

    // 优先无后缀
    let mut candidate = make_path(None);
    let mut idx: u32 = 0;
    loop {
        if !candidate.exists() {
            std::fs::write(&candidate, new_content)?;
            return Ok(candidate);
        }
        // 同名 → 试图 dedup（小文件才比对，大文件直接加后缀）
        if let Ok(meta) = std::fs::metadata(&candidate) {
            let same_size = meta.len() as usize == new_content.len();
            let small_enough = meta.len() <= DEDUP_MAX_BYTES;
            if same_size && small_enough {
                if let Ok(existing) = std::fs::read(&candidate) {
                    if existing.as_slice() == new_content {
                        return Ok(candidate); // 内容相同 → 复用
                    }
                }
            }
        }
        idx += 1;
        if idx > MAX_SUFFIX_TRIES {
            // 兜底：用 PID 拼一个几乎不会撞的名字
            let pid_path = dir.join(format!("{}-{}.{}", safe, std::process::id(), ext));
            std::fs::write(&pid_path, new_content)?;
            return Ok(pid_path);
        }
        candidate = make_path(Some(idx));
    }
}

/// 从源路径复制到 `dir`，**保留原文件名**，零拷贝（OS 级 fs::copy）。
///
/// 与 `save_unique` 不同：
///   - 源是路径而非 bytes，无需把整个文件读进 RAM
///   - 同名时 dedup：两边大小一致且 ≤64MB → 读两边比对，相同则复用
///   - 大文件（>64MB）跳过 dedup，直接加后缀（避免 GB 级视频读 RAM）
///
/// `stem`/`ext` 调用方提前从源路径拆好（保证清洗逻辑统一）。
pub fn save_unique_from_path(
    dir: &Path,
    stem: &str,
    ext: &str,
    source: &Path,
) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(dir)?;
    let safe = sanitize_stem(stem);

    // 源文件元数据用于 dedup 大小预筛
    let source_meta = std::fs::metadata(source)?;
    let source_len = source_meta.len();

    let make_path = |suffix: Option<u32>| -> PathBuf {
        let name = match suffix {
            None => format!("{}.{}", safe, ext),
            Some(n) => format!("{}-{}.{}", safe, n, ext),
        };
        dir.join(name)
    };

    let mut candidate = make_path(None);
    let mut idx: u32 = 0;
    loop {
        if !candidate.exists() {
            std::fs::copy(source, &candidate)?;
            return Ok(candidate);
        }
        // 同名 → 试图 dedup：大小一致 + 都 ≤64MB 才比对内容
        if let Ok(existing_meta) = std::fs::metadata(&candidate) {
            let same_size = existing_meta.len() == source_len;
            let small_enough = source_len <= DEDUP_MAX_BYTES;
            if same_size && small_enough {
                if let (Ok(existing), Ok(src_bytes)) =
                    (std::fs::read(&candidate), std::fs::read(source))
                {
                    if existing == src_bytes {
                        return Ok(candidate); // 内容相同 → 复用
                    }
                }
            }
        }
        idx += 1;
        if idx > MAX_SUFFIX_TRIES {
            let pid_path = dir.join(format!("{}-{}.{}", safe, std::process::id(), ext));
            std::fs::copy(source, &pid_path)?;
            return Ok(pid_path);
        }
        candidate = make_path(Some(idx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_basic() {
        assert_eq!(sanitize_stem("hello"), "hello");
        assert_eq!(sanitize_stem("hello world"), "hello world");
        assert_eq!(sanitize_stem("中文文件"), "中文文件");
    }

    #[test]
    fn sanitize_illegal_chars() {
        assert_eq!(sanitize_stem("a/b\\c:d"), "a_b_c_d");
        assert_eq!(sanitize_stem("a*b?c|d"), "a_b_c_d");
    }

    #[test]
    fn sanitize_trim_dots_spaces() {
        assert_eq!(sanitize_stem("  hello.  "), "hello");
        assert_eq!(sanitize_stem("...trick..."), "trick");
    }

    #[test]
    fn sanitize_empty_fallback() {
        assert_eq!(sanitize_stem(""), "untitled");
        assert_eq!(sanitize_stem("..."), "untitled");
        assert_eq!(sanitize_stem("///"), "___");
    }

    #[test]
    fn sanitize_windows_reserved() {
        assert_eq!(sanitize_stem("CON"), "_CON");
        assert_eq!(sanitize_stem("com1"), "_com1");
        assert_eq!(sanitize_stem("MyCONFile"), "MyCONFile");
    }

    #[test]
    fn sanitize_truncate_utf8_safe() {
        let name = "中".repeat(100); // 300 字节，超过 200
        let result = sanitize_stem(&name);
        assert!(result.as_bytes().len() <= MAX_STEM_BYTES);
        // UTF-8 边界完整
        assert!(result.chars().all(|c| c == '中'));
    }
}
