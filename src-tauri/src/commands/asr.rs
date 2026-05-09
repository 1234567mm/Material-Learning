//! 语音识别（ASR）Command 层。
//!
//! 薄包装：调用 `services::asr::AsrService` 并把 `AppError` 转成 `String`。
//! 抽象出 4 个对外接口：
//! - `asr_get_config` 读当前配置（首次访问 = 默认值，api_key 为空）
//! - `asr_save_config` 保存配置（启用时强校验 api_key）
//! - `asr_test_connection` 测试连通性（不消耗识别用量）
//! - `asr_transcribe_audio` 把 base64 音频转文字

use crate::models::{AsrConfig, AsrTestResult, TranscribeRequest, TranscribeResult};
use crate::services::asr::AsrService;
use crate::state::AppState;

#[tauri::command]
pub fn asr_get_config(state: tauri::State<'_, AppState>) -> Result<AsrConfig, String> {
    AsrService::get_config(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn asr_save_config(state: tauri::State<'_, AppState>, config: AsrConfig) -> Result<(), String> {
    AsrService::save_config(&state.db, &config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn asr_test_connection(config: AsrConfig) -> Result<AsrTestResult, String> {
    Ok(AsrService::test_connection(&config).await)
}

#[tauri::command]
pub async fn asr_transcribe_audio(
    state: tauri::State<'_, AppState>,
    request: TranscribeRequest,
) -> Result<TranscribeResult, String> {
    AsrService::transcribe(
        &state.db,
        &request.audio_base64,
        &request.mime,
        request.language.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}
