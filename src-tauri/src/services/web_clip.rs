//! T-014 网页剪藏：粘贴 URL → 通过 r.jina.ai 抓正文 → markdown
//!
//! Jina Reader 是 Jina AI 提供的免费代理服务，把网页转成简洁的 markdown：
//! 把原 URL 加 `https://r.jina.ai/` 前缀直接 GET，返回类似：
//!
//! ```text
//! Title: 标题
//! URL Source: https://example.com/article
//! Markdown Content:
//! # 标题
//! 正文
//! ```
//!
//! 选择 Jina 而非本地 readability：
//! - 零新依赖（reqwest 已有）；
//! - 中英文站点处理质量高，主动剥离侧栏 / 评论 / 广告；
//! - 国内可达，无需 API Key；
//! - 后续若有隐私 / 离线诉求再切本地 readability crate（v2）。

use crate::error::AppError;
use crate::services::http_client;

/// Jina Reader 的代理前缀
const JINA_READER_PREFIX: &str = "https://r.jina.ai/";

/// 剪藏结果：标题 + 正文 markdown + 原 URL（供笔记 metadata 用）
#[derive(Debug, Clone)]
pub struct ClippedPage {
    pub title: String,
    pub markdown: String,
    pub source_url: String,
}

/// 通过 Jina Reader 抓取并解析单个网页
pub async fn fetch_via_jina_reader(url: &str) -> Result<ClippedPage, AppError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::InvalidInput("URL 不能为空".into()));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::InvalidInput(format!(
            "URL 必须以 http:// 或 https:// 开头：{}",
            url
        )));
    }

    let proxied = format!("{}{}", JINA_READER_PREFIX, url);

    let client = http_client::shared();
    let resp = client
        .get(&proxied)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("请求 Jina Reader 失败: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::Custom(format!(
            "Jina Reader 返回非 200 状态: {} —— 网址可能无法访问 / 被拦",
            resp.status()
        )));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Custom(format!("读取 Jina 响应失败: {}", e)))?;

    parse_jina_response(&body, url)
}

/// 解析 Jina Reader 返回体；纯函数便于单测
pub fn parse_jina_response(body: &str, fallback_url: &str) -> Result<ClippedPage, AppError> {
    if body.trim().is_empty() {
        return Err(AppError::Custom(
            "Jina Reader 返回空内容（网址可能不可达）".into(),
        ));
    }

    // 头部三行结构：Title / URL Source / Markdown Content:
    // 各字段可能缺失或顺序不同，这里逐行扫，记下索引；
    // "Markdown Content:" 行下面的全部内容（直到文末）即为正文。
    let mut title: Option<String> = None;
    let mut source: Option<String> = None;
    let mut content_start: Option<usize> = None;

    let mut byte_idx = 0usize;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if let Some(rest) = trimmed.strip_prefix("Title:") {
            if title.is_none() {
                title = Some(rest.trim().to_string());
            }
        } else if let Some(rest) = trimmed.strip_prefix("URL Source:") {
            if source.is_none() {
                source = Some(rest.trim().to_string());
            }
        } else if trimmed.trim_start().starts_with("Markdown Content:") {
            // 正文从下一行开始
            content_start = Some(byte_idx + line.len());
            break;
        }
        byte_idx += line.len();
    }

    let markdown = match content_start {
        Some(idx) => body[idx..].trim().to_string(),
        None => {
            // Jina 偶尔不带 "Markdown Content:" 头，直接是正文
            body.trim().to_string()
        }
    };

    if markdown.is_empty() {
        return Err(AppError::Custom(
            "Jina Reader 返回的正文为空（页面可能纯图片 / 需 JS 渲染）".into(),
        ));
    }

    let title = title
        .filter(|s| !s.is_empty())
        .or_else(|| extract_first_heading(&markdown))
        .unwrap_or_else(|| "未命名网页".to_string());

    let source_url = source.unwrap_or_else(|| fallback_url.to_string());

    Ok(ClippedPage {
        title,
        markdown,
        source_url,
    })
}

/// 从 markdown 文本里抓第一个 `# H1` 当备用标题
fn extract_first_heading(md: &str) -> Option<String> {
    for line in md.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let h1 = rest.trim().to_string();
            if !h1.is_empty() {
                return Some(h1);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_full_jina_response() {
        let body = "Title: 我的标题\nURL Source: https://example.com/a\nMarkdown Content:\n# H1\n正文一\n正文二\n";
        let r = parse_jina_response(body, "https://example.com/a").unwrap();
        assert_eq!(r.title, "我的标题");
        assert_eq!(r.source_url, "https://example.com/a");
        assert!(r.markdown.starts_with("# H1"));
        assert!(r.markdown.contains("正文二"));
    }

    #[test]
    fn parse_missing_title_falls_back_to_h1() {
        let body = "URL Source: https://x.com\nMarkdown Content:\n# 真标题\n内容\n";
        let r = parse_jina_response(body, "https://x.com").unwrap();
        assert_eq!(r.title, "真标题");
    }

    #[test]
    fn parse_no_markdown_header_treats_whole_body_as_content() {
        let body = "纯文本\n第二行\n";
        let r = parse_jina_response(body, "https://x.com").unwrap();
        assert_eq!(r.title, "未命名网页");
        assert!(r.markdown.contains("纯文本"));
        assert_eq!(r.source_url, "https://x.com");
    }

    #[test]
    fn parse_empty_body_errors() {
        let err = parse_jina_response("   \n", "https://x.com").unwrap_err();
        assert!(err.to_string().contains("空"));
    }

    #[test]
    fn parse_only_headers_no_body_errors() {
        let body = "Title: T\nMarkdown Content:\n";
        let err = parse_jina_response(body, "https://x.com").unwrap_err();
        assert!(err.to_string().contains("正文为空"));
    }

    #[test]
    fn validate_url_must_be_http() {
        // 这里只测前置校验逻辑（不真发 HTTP）
        let err = tokio_test_block_on(fetch_via_jina_reader("ftp://x.com"));
        assert!(err.is_err());
        let err = tokio_test_block_on(fetch_via_jina_reader(""));
        assert!(err.is_err());
    }

    /// 仅供本模块单测用：在 tokio 运行时里跑一个 future
    fn tokio_test_block_on<F: std::future::Future>(f: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(f)
    }
}
