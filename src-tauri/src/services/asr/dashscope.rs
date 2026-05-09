//! 阿里云百炼 DashScope ASR 实现（qwen3-asr-flash 通过 OpenAI 兼容模式调用）。
//!
//! 选择 OpenAI 兼容端点（`/compatible-mode/v1/chat/completions`）而非原生
//! `/services/aigc/multimodal-generation/generation` 的原因：
//! - 官方文档明确 base64 时必须用 `input_audio.data` 字段，与 audio 公网 URL 字段不同；
//!   原生端点 base64 容易触发 "url error, please check url"
//! - OpenAI 兼容格式响应更扁平（`choices[0].message.content` 直接是字符串），无需爬树
//! - 与项目其他 AI 调用风格一致
//!
//! 请求 / 响应：
//!
//! ```text
//! POST /compatible-mode/v1/chat/completions
//! Authorization: Bearer {key}
//! Body:
//! {
//!   "model": "qwen3-asr-flash",
//!   "messages": [
//!     {
//!       "role": "user",
//!       "content": [
//!         {"type": "input_audio", "input_audio": {"data": "data:audio/webm;base64,..."}}
//!       ]
//!     }
//!   ],
//!   "stream": false,
//!   "extra_body": {"asr_options": {"enable_itn": false}}
//! }
//! ```
//!
//! 支持音频格式：aac/amr/flac/mp3/mpeg/ogg/opus/wav/webm 等；单文件 ≤ 10MB / ≤ 5 分钟。

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::models::{AsrConfig, TranscribeResult};
use crate::services::http_client;

const HOST_CN: &str = "https://dashscope.aliyuncs.com";
const HOST_INTL: &str = "https://dashscope-intl.aliyuncs.com";

fn host(region: &str) -> &'static str {
    match region {
        "singapore" | "intl" => HOST_INTL,
        _ => HOST_CN,
    }
}

// ─── 请求结构（OpenAI 兼容） ───────────────────

#[derive(Serialize)]
struct InputAudio<'a> {
    /// 形如 "data:audio/webm;base64,..." 的 data URL
    data: &'a str,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentPart<'a> {
    InputAudio { input_audio: InputAudio<'a> },
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: Vec<ContentPart<'a>>,
}

#[derive(Serialize)]
struct AsrOptions<'a> {
    enable_itn: bool,
    /// 语言提示，可选；缺省让模型自动检测
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'a str>,
}

#[derive(Serialize)]
struct ExtraBody<'a> {
    asr_options: AsrOptions<'a>,
}

#[derive(Serialize)]
struct ChatBody<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    stream: bool,
    extra_body: ExtraBody<'a>,
}

// ─── 响应结构（OpenAI 兼容） ────────────────────

#[derive(Deserialize)]
struct ChatResp {
    #[serde(default)]
    choices: Vec<Choice>,
    /// OpenAI 兼容模式失败时也可能出现 error 字段
    #[serde(default)]
    error: Option<ApiError>,
    /// DashScope 自家错误字段（fallback 兼容）
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct ApiError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default, rename = "type")]
    _kind: Option<String>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    message: ChoiceMessage,
}

#[derive(Deserialize, Default)]
struct ChoiceMessage {
    #[serde(default)]
    content: String,
}

// ─── 主流程 ─────────────────────────────────────

pub async fn transcribe(
    cfg: &AsrConfig,
    audio_b64: &str,
    mime: &str,
    language: Option<&str>,
) -> Result<TranscribeResult, AppError> {
    let start = std::time::Instant::now();
    let host = host(&cfg.region);
    let client = http_client::shared();

    let data_url = format!("data:{};base64,{}", mime, audio_b64);
    let lang = language.filter(|l| !l.is_empty() && *l != "auto");

    let body = ChatBody {
        model: &cfg.model,
        messages: vec![Message {
            role: "user",
            content: vec![ContentPart::InputAudio {
                input_audio: InputAudio { data: &data_url },
            }],
        }],
        stream: false,
        extra_body: ExtraBody {
            asr_options: AsrOptions {
                enable_itn: false,
                language: lang,
            },
        },
    };

    let url = format!("{host}/compatible-mode/v1/chat/completions");
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("提交识别请求失败: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Custom(format!(
            "提交识别请求失败 ({status}): {text}"
        )));
    }
    let parsed: ChatResp = resp
        .json()
        .await
        .map_err(|e| AppError::Custom(format!("解析识别响应失败: {e}")))?;
    if let Some(err) = parsed.error {
        let code = err.code.unwrap_or_default();
        let prefix = if code.is_empty() {
            String::from("DashScope 报错")
        } else {
            format!("DashScope 报错 [{code}]")
        };
        return Err(AppError::Custom(format!("{prefix}: {}", err.message)));
    }
    if let Some(code) = parsed.code {
        let msg = parsed.message.unwrap_or_else(|| "未提供错误信息".into());
        return Err(AppError::Custom(format!("DashScope 报错 [{code}]: {msg}")));
    }
    let text = parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_default();

    Ok(TranscribeResult {
        text,
        latency_ms: start.elapsed().as_millis() as u64,
        model: cfg.model.clone(),
    })
}

/// 仅校验 API Key 是否有效，不消耗识别用量。
///
/// 走 OpenAI 兼容的 `/v1/models` GET 接口：返回 200 = 鉴权通过；401/403 = Key 无效。
pub async fn probe(cfg: &AsrConfig) -> Result<(), AppError> {
    let host = host(&cfg.region);
    let client = http_client::shared();
    let url = format!("{host}/compatible-mode/v1/models");
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("无法连接 DashScope: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::Custom("鉴权失败：API Key 无效或权限不足".into()));
    }
    if status.is_server_error() {
        return Err(AppError::Custom(format!(
            "DashScope 服务异常: HTTP {status}"
        )));
    }
    Ok(())
}
