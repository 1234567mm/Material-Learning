//! T-007 笔记加密保险库（Vault）
//!
//! 对外职责：
//! - `status(db)` 判断 vault 当前是什么状态（NotSet / Locked / Unlocked）
//! - `setup(db, state, password)` 首次设置主密码：生成盐 + verifier 存 app_config；
//!   同时解锁（key 缓存到 state）
//! - `unlock(db, state, password)` 用密码派生 key + 校验 verifier；成功则缓存到 state
//! - `lock(state)` 清空内存中的 key（调用 zeroize）
//! - `encrypt_plaintext` / `decrypt_blob` 基于 state 里的 key 做加/解密
//!
//! vault 内部状态存放在 `AppState.vault`（`RwLock<VaultState>`），key 用 `Zeroizing`
//! 包裹，Drop 时自动清零敏感内存。
//!
//! 存储约定（app_config 两条 key）：
//! - `vault.salt`     → base64(盐 16B)
//! - `vault.verifier` → base64(aead_encrypt(key, "knowledge-base:vault:ok"))
//!
//! verifier 是用 key 加密的一个固定字符串。unlock 时用派生的 key 解它，成功=密码对；
//! 失败=密码错。这样服务器永远不存密码也不存 key。

use std::sync::RwLock;

use base64::Engine;
use zeroize::Zeroizing;

use crate::database::Database;
use crate::error::AppError;
use crate::models::VaultStatus;
use crate::services::crypto;

const CFG_SALT: &str = "vault.salt";
const CFG_VERIFIER: &str = "vault.verifier";
/// verifier 解密后的固定明文；每次解锁都用它做匹配
const VERIFIER_PLAINTEXT: &[u8] = b"knowledge-base:vault:ok";

/// Vault 会话态（只存内存；不落盘）
///
/// `key` 用 `Zeroizing` 包裹：drop 时自动写 0，防止敏感数据在 swap/内存 dump 里残留。
#[derive(Default)]
pub struct VaultState {
    key: Option<Zeroizing<[u8; crypto::KEY_LEN]>>,
}

impl VaultState {
    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }

    /// 借用 key 做一次性加/解密；外部不应持有这个引用
    fn key_bytes(&self) -> Option<&[u8; crypto::KEY_LEN]> {
        self.key.as_ref().map(|z| &**z)
    }

    fn set_key(&mut self, k: [u8; crypto::KEY_LEN]) {
        self.key = Some(Zeroizing::new(k));
    }

    fn clear(&mut self) {
        // Zeroizing drop 会自动清零
        self.key = None;
    }
}

pub struct VaultService;

impl VaultService {
    /// 查 vault 当前状态
    pub fn status(db: &Database, state: &RwLock<VaultState>) -> Result<VaultStatus, AppError> {
        let has_salt = db.get_config(CFG_SALT)?.is_some();
        let has_verifier = db.get_config(CFG_VERIFIER)?.is_some();
        if !has_salt || !has_verifier {
            return Ok(VaultStatus::NotSet);
        }
        let guard = state
            .read()
            .map_err(|e| AppError::Custom(format!("vault 状态读取失败: {}", e)))?;
        if guard.is_unlocked() {
            Ok(VaultStatus::Unlocked)
        } else {
            Ok(VaultStatus::Locked)
        }
    }

    /// 首次设置主密码（vault 必须处于 NotSet 态）
    ///
    /// 完成后自动解锁（key 已在内存中，不必立即要求用户再输一遍）。
    pub fn setup(
        db: &Database,
        state: &RwLock<VaultState>,
        password: &str,
    ) -> Result<(), AppError> {
        if password.is_empty() {
            return Err(AppError::Custom("主密码不能为空".to_string()));
        }
        if Self::status(db, state)? != VaultStatus::NotSet {
            return Err(AppError::Custom(
                "主密码已存在，请走 unlock 路径或先销毁 vault".to_string(),
            ));
        }

        let salt = crypto::new_salt();
        let key = crypto::derive_user_key(password, &salt)?;
        let verifier = crypto::aead_encrypt(&key, VERIFIER_PLAINTEXT)?;

        let salt_b64 = base64::engine::general_purpose::STANDARD.encode(salt);
        let verifier_b64 = base64::engine::general_purpose::STANDARD.encode(&verifier);
        db.set_config(CFG_SALT, &salt_b64)?;
        db.set_config(CFG_VERIFIER, &verifier_b64)?;

        let mut guard = state
            .write()
            .map_err(|e| AppError::Custom(format!("vault 状态写入失败: {}", e)))?;
        guard.set_key(key);
        Ok(())
    }

    /// 用密码解锁 vault。成功 → key 缓存到内存；失败（密码错）→ 不改 state
    pub fn unlock(
        db: &Database,
        state: &RwLock<VaultState>,
        password: &str,
    ) -> Result<(), AppError> {
        let salt_b64 = db
            .get_config(CFG_SALT)?
            .ok_or_else(|| AppError::Custom("vault 尚未初始化，请先 setup".to_string()))?;
        let verifier_b64 = db
            .get_config(CFG_VERIFIER)?
            .ok_or_else(|| AppError::Custom("vault 损坏：缺少 verifier".to_string()))?;
        let salt = base64::engine::general_purpose::STANDARD
            .decode(salt_b64.as_bytes())
            .map_err(|e| AppError::Custom(format!("vault salt 解析失败: {}", e)))?;
        let verifier = base64::engine::general_purpose::STANDARD
            .decode(verifier_b64.as_bytes())
            .map_err(|e| AppError::Custom(format!("vault verifier 解析失败: {}", e)))?;

        let key = crypto::derive_user_key(password, &salt)?;

        // 用 key 去解 verifier；解成功 + 明文匹配 = 密码正确
        let decrypted = crypto::aead_decrypt(&key, &verifier)
            .map_err(|_| AppError::Custom("主密码错误".to_string()))?;
        if decrypted != VERIFIER_PLAINTEXT {
            return Err(AppError::Custom(
                "主密码错误（verifier 不匹配）".to_string(),
            ));
        }

        let mut guard = state
            .write()
            .map_err(|e| AppError::Custom(format!("vault 状态写入失败: {}", e)))?;
        guard.set_key(key);
        Ok(())
    }

    /// 锁定 vault（清空内存里的 key）。下次加/解密前需再 unlock
    pub fn lock(state: &RwLock<VaultState>) -> Result<(), AppError> {
        let mut guard = state
            .write()
            .map_err(|e| AppError::Custom(format!("vault 状态写入失败: {}", e)))?;
        guard.clear();
        Ok(())
    }

    /// 用已解锁的 vault 加密一段明文 → blob（nonce ‖ ciphertext+tag）
    ///
    /// 未解锁返回错误。
    pub fn encrypt_plaintext(
        state: &RwLock<VaultState>,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, AppError> {
        let guard = state
            .read()
            .map_err(|e| AppError::Custom(format!("vault 状态读取失败: {}", e)))?;
        let key = guard
            .key_bytes()
            .ok_or_else(|| AppError::Custom("vault 未解锁".to_string()))?;
        crypto::aead_encrypt(key, plaintext)
    }

    /// 用已解锁的 vault 解密 blob → 明文
    pub fn decrypt_blob(state: &RwLock<VaultState>, blob: &[u8]) -> Result<Vec<u8>, AppError> {
        let guard = state
            .read()
            .map_err(|e| AppError::Custom(format!("vault 状态读取失败: {}", e)))?;
        let key = guard
            .key_bytes()
            .ok_or_else(|| AppError::Custom("vault 未解锁".to_string()))?;
        crypto::aead_decrypt(key, blob)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_state_zeroizing() {
        // 确保 VaultState 清理后 is_unlocked=false
        let mut vs = VaultState::default();
        assert!(!vs.is_unlocked());
        vs.set_key([1u8; crypto::KEY_LEN]);
        assert!(vs.is_unlocked());
        vs.clear();
        assert!(!vs.is_unlocked());
    }
}
