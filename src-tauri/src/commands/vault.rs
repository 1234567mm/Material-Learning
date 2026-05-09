//! T-007 笔记加密 / Vault Commands（IPC 入口）
//!
//! 分两组：
//! - Vault 管理：`vault_status` / `vault_setup` / `vault_unlock` / `vault_lock`
//! - 笔记加密：`encrypt_note` / `decrypt_note` / `disable_note_encrypt`
//!
//! Vault 派生 key 耗时 50~200ms（Argon2id），因此 `vault_setup` / `vault_unlock`
//! 声明为 async，避免在 IPC 主线程 block。

use tauri::State;

use crate::models::VaultStatus;
use crate::services::note::NoteService;
use crate::services::vault::VaultService;
use crate::state::AppState;

// ─── Vault 管理 ────────────────────────────────

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    VaultService::status(&state.db, &state.vault).map_err(|e| e.to_string())
}

/// 首次设置主密码；成功后自动解锁。若已 setup 过会返回错误。
#[tauri::command]
pub async fn vault_setup(state: State<'_, AppState>, password: String) -> Result<(), String> {
    // 同步调 Argon2id 会阻塞主线程；这里 async fn 里直接调，tokio 会自己把 Command
    // 任务调度到 worker 线程，不会阻塞 webview。相对于手工 spawn_blocking，
    // 简单且够用（派生 < 300ms）。
    VaultService::setup(&state.db, &state.vault, &password).map_err(|e| e.to_string())
}

/// 用主密码解锁 vault
#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, password: String) -> Result<(), String> {
    VaultService::unlock(&state.db, &state.vault, &password).map_err(|e| e.to_string())
}

/// 锁定 vault（清空内存 key）
#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) -> Result<(), String> {
    VaultService::lock(&state.vault).map_err(|e| e.to_string())
}

// ─── 笔记加密 ─────────────────────────────────

/// 把一篇笔记切换到加密态：读明文 content → vault 加密 → 写 blob + 占位
#[tauri::command]
pub fn encrypt_note(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    NoteService::encrypt_note(&state.db, &state.vault, &state.data_dir, id)
        .map_err(|e| e.to_string())
}

/// 解密一篇加密笔记（不改库，仅读明文给前端展示）
#[tauri::command]
pub fn decrypt_note(state: State<'_, AppState>, id: i64) -> Result<String, String> {
    NoteService::decrypt_note(&state.db, &state.vault, id).map_err(|e| e.to_string())
}

/// 取消加密：解密后把明文写回 content，清空 blob
#[tauri::command]
pub fn disable_note_encrypt(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    NoteService::disable_encrypt(&state.db, &state.vault, &state.data_dir, id)
        .map_err(|e| e.to_string())
}
