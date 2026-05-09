//! T-024 同步 V1 — Tauri Commands
//!
//! 暴露给前端的接口：
//! - sync_v1_list_backends / get_backend / create / update / delete
//! - sync_v1_test_connection
//! - sync_v1_push / pull
//!
//! 注意：所有 Command 都需要在 lib.rs 的 generate_handler! 注册。

use tauri::{Manager, State, Window};

use crate::error::AppError;
use crate::models::{
    SyncBackend, SyncBackendInput, SyncManifestV1, SyncPullResult, SyncPushResult,
};
use crate::services::sync_v1::backend;
use crate::state::AppState;

#[tauri::command]
pub fn sync_v1_list_backends(state: State<'_, AppState>) -> Result<Vec<SyncBackend>, String> {
    state.db.list_sync_backends().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_v1_get_backend(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<SyncBackend>, String> {
    state.db.get_sync_backend(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_v1_create_backend(
    state: State<'_, AppState>,
    input: SyncBackendInput,
) -> Result<i64, String> {
    state
        .db
        .create_sync_backend(&input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_v1_update_backend(
    state: State<'_, AppState>,
    id: i64,
    input: SyncBackendInput,
) -> Result<(), String> {
    state
        .db
        .update_sync_backend(id, &input)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_v1_delete_backend(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    state.db.delete_sync_backend(id).map_err(|e| e.to_string())
}

/// 测试连接
#[tauri::command]
pub fn sync_v1_test_connection(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;
    backend_impl.test_connection().map_err(|e| e.to_string())
}

/// 读远端 manifest（前端调试用）
#[tauri::command]
pub fn sync_v1_read_remote_manifest(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<SyncManifestV1>, String> {
    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;
    backend_impl.read_manifest().map_err(|e| e.to_string())
}

/// 推送
#[tauri::command]
pub fn sync_v1_push(
    state: State<'_, AppState>,
    window: Window,
    app: tauri::AppHandle,
    id: i64,
) -> Result<SyncPushResult, String> {
    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;

    let app_version = app.package_info().version.to_string();
    let device = hostname_short();

    crate::services::sync_v1::push::push(
        &state.db,
        id,
        backend_impl.as_ref(),
        &app_version,
        &device,
        &window,
    )
    .map_err(|e| e.to_string())
}

/// 拉取
#[tauri::command]
pub fn sync_v1_pull(
    state: State<'_, AppState>,
    window: Window,
    app: tauri::AppHandle,
    id: i64,
) -> Result<SyncPullResult, String> {
    let cfg = state
        .db
        .get_sync_backend(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("backend {} 不存在", id))?;
    let auth = backend::parse_auth(cfg.kind, &cfg.config_json).map_err(|e| e.to_string())?;
    let backend_impl = backend::create_backend(auth).map_err(|e| e.to_string())?;

    let app_version = app.package_info().version.to_string();
    let device = hostname_short();

    let conflicts_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sync_conflicts")
        .join(format!("backend_{}", id));

    crate::services::sync_v1::pull::pull(
        &state.db,
        id,
        backend_impl.as_ref(),
        &app_version,
        &device,
        &conflicts_dir,
        &window,
    )
    .map_err(|e| e.to_string())
}

/// 拿当前本地 manifest（调试 / UI 状态展示用）
#[tauri::command]
pub fn sync_v1_get_local_manifest(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SyncManifestV1, String> {
    let app_version = app.package_info().version.to_string();
    let device = hostname_short();
    crate::services::sync_v1::compute_local_manifest(&state.db, &app_version, &device)
        .map_err(|e: AppError| e.to_string())
}

/// 取本机 hostname（短名）；失败返回 "unknown-host"
fn hostname_short() -> String {
    // hostname crate 已是项目依赖（services/sync.rs 用了 hostname::get）
    hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into())
}
