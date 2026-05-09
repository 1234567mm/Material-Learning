//! Sync backend 抽象 trait
//!
//! 任意远端（本地路径 / WebDAV / S3 / Git）只要实现这套接口就能接入。
//!
//! 接口刻意 **同步阻塞**（不是 async）—— 因为：
//! 1. 上层调用方在 tauri 异步 Command 里跑（已经在 Tokio runtime），
//!    backend 内部如果需要 async（如 reqwest）可以 block_on
//! 2. 不同 backend 的"async 模式"差异大（rust-s3 / git2 是同步，reqwest 是 async）
//!    统一成同步接口降低 trait 心智负担

use std::collections::HashMap;

use crate::error::AppError;
use crate::models::SyncManifestV1;

/// backend 凭据（从 sync_backends.config_json 解析后传给具体 impl）
///
/// 各变体字段除 Local 外，T-024b/c/d 阶段才被实际读，先标 dead_code 不污染警告
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum BackendAuth {
    /// 本地路径：写到磁盘
    Local { root: String },
    /// WebDAV：现有 webdav.rs 客户端可复用（T-024c 阶段做平迁）
    Webdav {
        url: String,
        username: String,
        password: String,
    },
    /// S3 兼容（T-024b 实现）
    S3 {
        endpoint: String,
        region: String,
        bucket: String,
        access_key: String,
        secret_key: String,
        prefix: String,
    },
}

/// Manifest 在远端的标准位置（所有 backend 共用此约定）
pub const MANIFEST_FILENAME: &str = "manifest.json";

/// 笔记在远端的目录约定
///
/// 笔记按 `notes/<stable_id>.md` 存（不嵌套子目录，平铺最简单；
/// 文件夹层级用 manifest entry 的 folder_path 字段表达，重建时 ensure_folder_path）
#[allow(dead_code)]
pub const NOTES_DIR: &str = "notes";

/// 远端字节级 IO 抽象
pub trait SyncBackendImpl {
    /// backend 类型名（仅用于日志 / 错误信息）
    #[allow(dead_code)]
    fn name(&self) -> &'static str;

    /// 测试连接：成功返回 Ok(())，失败返回错误描述
    fn test_connection(&self) -> Result<(), AppError>;

    /// 读取远端 manifest.json；不存在返回 Ok(None)
    fn read_manifest(&self) -> Result<Option<SyncManifestV1>, AppError>;

    /// 写入远端 manifest.json（覆盖）
    fn write_manifest(&self, manifest: &SyncManifestV1) -> Result<(), AppError>;

    /// 上传一条笔记的 .md 文本到远端 `path`（path 是相对 vault 根的 posix 路径）
    fn put_note(&self, path: &str, content: &str) -> Result<(), AppError>;

    /// 下载一条笔记的 .md 文本；不存在返回 Ok(None)
    fn get_note(&self, path: &str) -> Result<Option<String>, AppError>;

    /// 删除远端笔记（v1 阶段还没接 tombstone 推送，留接口）
    #[allow(dead_code)]
    fn delete_note(&self, path: &str) -> Result<(), AppError>;

    /// 上传附件（按 hash 路径，CAS）；返回 Ok(()) 即可
    /// v1 阶段先不做附件同步；预留接口
    #[allow(dead_code)]
    fn put_attachment(&self, _hash: &str, _bytes: &[u8]) -> Result<(), AppError> {
        Err(AppError::Custom(
            "attachment 同步暂未实现（v1 留给后续阶段）".into(),
        ))
    }

    /// 下载附件
    #[allow(dead_code)]
    fn get_attachment(&self, _hash: &str) -> Result<Option<Vec<u8>>, AppError> {
        Err(AppError::Custom(
            "attachment 同步暂未实现（v1 留给后续阶段）".into(),
        ))
    }
}

/// 从 sync_backends.config_json 解析为 BackendAuth
///
/// 简单 JSON 反序列化；字段缺失会带具体错误提示。后续 webdav/s3 接入时按 kind 分支扩展。
pub fn parse_auth(
    kind: crate::models::SyncBackendKind,
    config_json: &str,
) -> Result<BackendAuth, AppError> {
    use crate::models::SyncBackendKind as K;
    let v: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| AppError::Custom(format!("config_json 解析失败: {}", e)))?;
    let get_str = |k: &str| -> Result<String, AppError> {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::InvalidInput(format!("config_json 缺字段: {}", k)))
    };
    let get_str_or = |k: &str, default: &str| -> String {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| default.into())
    };

    match kind {
        K::Local => Ok(BackendAuth::Local {
            root: get_str("path")?,
        }),
        K::Webdav => Ok(BackendAuth::Webdav {
            url: get_str("url")?,
            username: get_str("username")?,
            password: get_str("password")?,
        }),
        K::S3 => Ok(BackendAuth::S3 {
            endpoint: get_str("endpoint")?,
            region: get_str_or("region", "auto"),
            bucket: get_str("bucket")?,
            access_key: get_str("accessKey")?,
            secret_key: get_str("secretKey")?,
            prefix: get_str_or("prefix", ""),
        }),
    }
}

/// 工厂：根据 BackendAuth 实例化具体 backend
pub fn create_backend(auth: BackendAuth) -> Result<Box<dyn SyncBackendImpl>, AppError> {
    match auth {
        BackendAuth::Local { root } => {
            Ok(Box::new(super::backend_local::LocalPathBackend::new(&root)))
        }
        BackendAuth::Webdav {
            url,
            username,
            password,
        } => Ok(Box::new(super::backend_webdav::WebdavBackend::new(
            &url, &username, &password,
        ))),
        #[cfg(desktop)]
        BackendAuth::S3 {
            endpoint,
            region,
            bucket,
            access_key,
            secret_key,
            prefix,
        } => Ok(Box::new(super::backend_s3::S3Backend::new(
            &endpoint,
            &region,
            &bucket,
            &access_key,
            &secret_key,
            &prefix,
        )?)),
        // 移动端 S3 backend 暂不支持（rust-s3 0.34 强引入 openssl）
        #[cfg(mobile)]
        BackendAuth::S3 { .. } => Err(crate::error::AppError::Custom(
            "移动端暂不支持 S3 同步，请使用 WebDAV 或本地路径 backend".into(),
        )),
    }
}

/// 让 unused HashMap 不警告（预留给将来批量上传/校验用）
#[allow(dead_code)]
fn _hashmap_marker() -> HashMap<String, String> {
    HashMap::new()
}
