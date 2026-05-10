//! 隐藏笔记 PIN —— IPC 入口
//!
//! 业务逻辑全在 services::hidden_pin。这里只做参数转发与错误转字符串。

use tauri::State;

use crate::services::hidden_pin;
use crate::state::AppState;

#[tauri::command]
pub fn is_hidden_pin_set(state: State<'_, AppState>) -> Result<bool, String> {
    hidden_pin::is_pin_set(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_hidden_pin(
    state: State<'_, AppState>,
    old_pin: Option<String>,
    new_pin: String,
    hint: Option<String>,
) -> Result<(), String> {
    hidden_pin::set_pin(&state.db, old_pin, new_pin, hint).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_hidden_pin_hint(state: State<'_, AppState>) -> Result<Option<String>, String> {
    hidden_pin::get_hint(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn verify_hidden_pin(state: State<'_, AppState>, pin: String) -> Result<(), String> {
    hidden_pin::verify_pin(&state.db, pin).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_hidden_pin(state: State<'_, AppState>, current_pin: String) -> Result<(), String> {
    hidden_pin::clear_pin(&state.db, current_pin).map_err(|e| e.to_string())
}
