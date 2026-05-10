use crate::database::Database;
use crate::error::AppError;
use crate::models::AppConfig;
use crate::services::crypto;

/// 配置管理服务
pub struct ConfigService;

impl ConfigService {
    /// 获取所有配置
    pub fn get_all(db: &Database) -> Result<Vec<AppConfig>, AppError> {
        db.get_all_config()
    }

    /// 获取配置值
    pub fn get(db: &Database, key: &str) -> Result<String, AppError> {
        db.get_config(key)?
            .ok_or_else(|| AppError::NotFound(format!("配置项 '{}' 不存在", key)))
    }

    /// 设置配置值
    pub fn set(db: &Database, key: &str, value: &str) -> Result<(), AppError> {
        if key.is_empty() {
            return Err(AppError::InvalidInput("配置键不能为空".into()));
        }
        db.set_config(key, value)
    }

    /// 删除配置
    pub fn delete(db: &Database, key: &str) -> Result<(), AppError> {
        let deleted = db.delete_config(key)?;
        if !deleted {
            return Err(AppError::NotFound(format!("配置项 '{}' 不存在", key)));
        }
        Ok(())
    }

    /// 加密存储敏感配置（机器绑定 AES-256-GCM）
    pub fn set_encrypted(db: &Database, key: &str, plaintext: &str) -> Result<(), AppError> {
        if key.is_empty() {
            return Err(AppError::InvalidInput("配置键不能为空".into()));
        }
        let encrypted = crypto::encrypt(plaintext)?;
        db.set_config(key, &encrypted)
    }

    /// 读取并解密敏感配置
    /// 兼容迁移：如果值不是有效的加密格式（解密失败），返回 None 而不是报错，
    /// 这样可以优雅处理旧版明文存储的配置项（如 llama_model_path）。
    pub fn get_decrypted(db: &Database, key: &str) -> Result<Option<String>, AppError> {
        match db.get_config(key)? {
            Some(enc) if !enc.is_empty() => {
                match crypto::decrypt(&enc) {
                    Ok(decrypted) => Ok(Some(decrypted)),
                    // 迁移：解密失败说明是旧版明文，直接返回 None 让调用方用明文
                    Err(_) => Ok(None),
                }
            }
            _ => Ok(None),
        }
    }

    /// 读取敏感配置（解密优先，失败则尝试明文）
    /// 用于需要同时兼容新旧两种存储格式的场景。
    pub fn get_decrypted_or_raw(db: &Database, key: &str) -> Result<Option<String>, AppError> {
        match Self::get_decrypted(db, key)? {
            Some(v) => Ok(Some(v)),
            None => Ok(db.get_config(key)?.filter(|v| !v.is_empty())),
        }
    }
}
