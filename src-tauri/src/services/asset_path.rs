//! 资产相对路径工具：在绝对路径与"相对 instance_dir 的 POSIX 路径"之间转换。
//!
//! 笔记 content 里的素材 src 永远存为 `kb-asset://<rel>`，`<rel>` 是这里输出的形式。
//! 数据目录可被用户在运行期更换（见 `services::data_dir`），所以绝对路径不能直接落 DB。

use std::path::{Component, Path, PathBuf};

/// 已知的资产子目录。绝对路径若在 instance_dir 下解析不出，
/// 就 fallback 到"找这些段名"的截取策略（用于历史绝对路径迁移到不同 OS / 不同 data_dir 的情况）。
const KNOWN_ASSET_SEGMENTS: &[&str] = &[
    "kb_assets",
    "dev-kb_assets",
    "pdfs",
    "dev-pdfs",
    "sources",
    "dev-sources",
    "attachments",
    "dev-attachments",
];

/// 把绝对路径转成相对 `data_dir` 的 POSIX 风格相对路径。
///
/// 优先策略：纯 `strip_prefix(data_dir)` + 把 `\` 换成 `/`。
/// 失败时（路径不在 data_dir 下，比如老笔记里写的是另一台机器/旧 data_dir 的绝对路径）
/// 走 fallback：扫已知资产段名，从该段开始截。
///
/// 返回 `None` 表示既不在 data_dir 下，也找不到任何已知资产段（无法判定相对路径）。
pub fn abs_to_rel(absolute: &Path, data_dir: &Path) -> Option<String> {
    if let Ok(rel) = absolute.strip_prefix(data_dir) {
        return Some(to_posix(rel));
    }
    // fallback：遍历 components 找已知资产段
    let comps: Vec<Component<'_>> = absolute.components().collect();
    for (i, c) in comps.iter().enumerate() {
        if let Component::Normal(name) = c {
            if let Some(name_str) = name.to_str() {
                if KNOWN_ASSET_SEGMENTS.contains(&name_str) {
                    let tail: PathBuf = comps[i..].iter().map(|c| c.as_os_str()).collect();
                    return Some(to_posix(&tail));
                }
            }
        }
    }
    None
}

/// 把相对 POSIX 路径还原成绝对路径（拼接 data_dir）。
///
/// 不验证文件是否存在 —— 调用方按需 `metadata()`。
/// 安全：rel 含 `..` 会触发 `Err` 返回，避免逃逸 data_dir。
///
/// 注意：必须按 component 逐段 push，而不是直接 `data_dir.join(rel_path)`。
/// 否则 Windows 上会保留 rel 里的 `/`，产出 `C:\foo\kb_assets/images/x.png` 这种混合分隔符路径，
/// 把它再转成 String 喂给 `revealItemInDir` 时，Windows 的 `ILCreateFromPathW` 会拒收，
/// 报 OS error 123 "文件名、目录名或卷标语法不正确"。
pub fn rel_to_abs(rel: &str, data_dir: &Path) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches('/');
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        if matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("非法相对路径（含 .. 或绝对前缀）: {}", rel));
        }
    }
    let mut abs = data_dir.to_path_buf();
    for c in rel_path.components() {
        if let Component::Normal(seg) = c {
            abs.push(seg);
        }
    }
    Ok(abs)
}

/// 把 `Path` 转成 POSIX 风格字符串（`\` → `/`，剥掉 Windows verbatim 前缀）
fn to_posix(p: &Path) -> String {
    let s = p.to_string_lossy();
    // Windows 上 strip_prefix 偶尔会留下 `\\?\` 之类的 verbatim 前缀，简单处理
    let s = s.trim_start_matches(r"\\?\");
    s.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_prefix_path() {
        let data = Path::new("/tmp/kb");
        let abs = Path::new("/tmp/kb/kb_assets/images/1/x.png");
        assert_eq!(
            abs_to_rel(abs, data).as_deref(),
            Some("kb_assets/images/1/x.png")
        );
    }

    #[test]
    fn fallback_when_not_under_data_dir() {
        let data = Path::new("/totally/different/place");
        let abs = Path::new("C:/Users/xxx/AppData/Roaming/com.app/kb_assets/images/1/x.png");
        // 找到 "kb_assets" 段名后开始截
        assert_eq!(
            abs_to_rel(abs, data).as_deref(),
            Some("kb_assets/images/1/x.png")
        );
    }

    #[test]
    fn fallback_dev_prefix_segment() {
        let data = Path::new("/totally/different/place");
        let abs = Path::new("/old/data/dev-kb_assets/images/1/x.png");
        assert_eq!(
            abs_to_rel(abs, data).as_deref(),
            Some("dev-kb_assets/images/1/x.png")
        );
    }

    #[test]
    fn unknown_path_returns_none() {
        let data = Path::new("/tmp/kb");
        let abs = Path::new("/usr/share/random/file.png");
        assert!(abs_to_rel(abs, data).is_none());
    }

    #[test]
    fn rel_to_abs_joins() {
        let data = Path::new("/tmp/kb");
        let p = rel_to_abs("kb_assets/images/1/x.png", data).unwrap();
        assert_eq!(p, Path::new("/tmp/kb/kb_assets/images/1/x.png"));
    }

    #[test]
    fn rel_to_abs_rejects_parent_dir() {
        let data = Path::new("/tmp/kb");
        assert!(rel_to_abs("../etc/passwd", data).is_err());
        assert!(rel_to_abs("kb_assets/../../etc/passwd", data).is_err());
    }

    #[test]
    fn rel_to_abs_strips_leading_slash() {
        let data = Path::new("/tmp/kb");
        let p = rel_to_abs("/kb_assets/images/1/x.png", data).unwrap();
        assert_eq!(p, Path::new("/tmp/kb/kb_assets/images/1/x.png"));
    }
}
