//! 远程图片下载服务（粘贴外链图片本地化）。
//!
//! Why 不在前端 fetch：WebView 的 fetch 会带 `tauri://localhost` Origin，
//! 钉钉 / 微信图床 / 知乎 / CSDN 等图床基本都查 Referer 防盗链 → 403 / 假图。
//! 走 Rust + reqwest 后可以按 host 智能注入 Referer，绕过常见防盗链。

use crate::error::AppError;
use crate::services::http_client;
use reqwest::header;

/// 桌面 Chrome UA。reqwest 默认 UA 形如 `reqwest/0.12`，部分图床直接拒服务。
const DEFAULT_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 单张图最大 20MB。再大就别本地化了 —— 用户体验 / 磁盘 / IPC 都吃不消。
const MAX_BYTES: usize = 20 * 1024 * 1024;

/// 单次请求超时 20s（防被恶意服务器吊在 connect 阶段）
const TIMEOUT_SECS: u64 = 20;

/// 抓远程图片字节并推断扩展名。
///
/// 返回 `(bytes, ext)`，`ext` 不带前导点（"png" / "jpg" / ...）。
pub async fn fetch_image_bytes(
    url: &str,
    referer_override: Option<&str>,
) -> Result<(Vec<u8>, String), AppError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::InvalidInput(format!(
            "不支持的 URL scheme: {}",
            url
        )));
    }

    let parsed = reqwest::Url::parse(url)
        .map_err(|e| AppError::InvalidInput(format!("URL 无效: {}", e)))?;

    let referer = match referer_override {
        Some(r) if !r.is_empty() => r.to_string(),
        _ => smart_referer(&parsed),
    };

    let resp = http_client::shared()
        .get(url)
        .header(header::USER_AGENT, DEFAULT_UA)
        .header(header::REFERER, &referer)
        .header(header::ACCEPT, "image/*,*/*;q=0.8")
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("请求失败: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::Custom(format!(
            "下载失败 HTTP {} (referer={})",
            resp.status(),
            referer
        )));
    }

    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Custom(format!("读取响应失败: {}", e)))?;

    if bytes.len() > MAX_BYTES {
        return Err(AppError::Custom(format!(
            "图片过大: {} 字节，上限 {} MB",
            bytes.len(),
            MAX_BYTES / 1024 / 1024
        )));
    }

    // 优先按 Content-Type 推断扩展，回退按 URL 末尾，最后兜底 png
    let ext = ext_from_content_type(&content_type)
        .or_else(|| ext_from_url(&parsed))
        .unwrap_or_else(|| "png".to_string());

    // 双保险：若 Content-Type 不是 image/* 且 URL 也无图片扩展名，
    // 大概率是被防盗链返回的 HTML 错误页，直接判失败避免把垃圾落盘。
    let looks_like_image = content_type.to_lowercase().starts_with("image/")
        || ext_from_url(&parsed).is_some();
    if !looks_like_image {
        return Err(AppError::Custom(format!(
            "非图片响应 (content-type={}, url={})",
            content_type, url
        )));
    }

    Ok((bytes.to_vec(), ext))
}

/// 按 host 关键字匹配最常见的国内图床，用对应站点的根路径作 Referer。
/// 命中不了的回退到 "图自身 origin"——很多防盗链允许同源访问。
fn smart_referer(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or("").to_lowercase();
    if host.contains("dingtalk") {
        return "https://im.dingtalk.com/".into();
    }
    if host.contains("qpic.cn") || host.contains("weixin") || host.contains("mmbiz") {
        return "https://mp.weixin.qq.com/".into();
    }
    if host.contains("zhimg.com") || host.contains("zhihu.com") {
        return "https://www.zhihu.com/".into();
    }
    if host.contains("csdnimg") || host.contains("csdn.net") {
        return "https://blog.csdn.net/".into();
    }
    if host.contains("hdslb.com") || host.contains("bilibili.com") {
        return "https://www.bilibili.com/".into();
    }
    if host.contains("feishu") || host.contains("larksuite") || host.contains("lark") {
        return "https://www.feishu.cn/".into();
    }
    if host.contains("juejin") || host.contains("byteimg") {
        return "https://juejin.cn/".into();
    }
    format!("{}://{}/", url.scheme(), host)
}

fn ext_from_content_type(ct: &str) -> Option<String> {
    let main = ct.split(';').next()?.trim().to_lowercase();
    match main.as_str() {
        "image/png" => Some("png".into()),
        "image/jpeg" | "image/jpg" => Some("jpg".into()),
        "image/gif" => Some("gif".into()),
        "image/webp" => Some("webp".into()),
        "image/svg+xml" => Some("svg".into()),
        "image/bmp" => Some("bmp".into()),
        _ => None,
    }
}

fn ext_from_url(url: &reqwest::Url) -> Option<String> {
    let path = url.path();
    let ext = path.rsplit('.').next()?.split('?').next()?.to_lowercase();
    if matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg" | "bmp"
    ) {
        Some(ext)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smart_referer_dingtalk() {
        let u = reqwest::Url::parse("https://static.dingtalk.com/x.png").unwrap();
        assert_eq!(smart_referer(&u), "https://im.dingtalk.com/");
    }

    #[test]
    fn smart_referer_weixin() {
        let u = reqwest::Url::parse("https://mmbiz.qpic.cn/x").unwrap();
        assert_eq!(smart_referer(&u), "https://mp.weixin.qq.com/");
    }

    #[test]
    fn smart_referer_fallback_origin() {
        let u = reqwest::Url::parse("https://example.com/foo.png").unwrap();
        assert_eq!(smart_referer(&u), "https://example.com/");
    }

    #[test]
    fn ext_from_url_basic() {
        let u = reqwest::Url::parse("https://x.com/a/b.JPG?x=1").unwrap();
        assert_eq!(ext_from_url(&u), Some("jpg".into()));
    }

    #[test]
    fn ext_from_content_type_jpeg() {
        assert_eq!(ext_from_content_type("image/jpeg; charset=utf-8"), Some("jpg".into()));
    }
}
