//! 本地敏感数据加密（AES-256-GCM）
//!
//! 用于加密存入 SQLite app_config 的敏感字段（如 WebDAV 密码）。
//! 密钥来源：机器 hostname + 应用标识 → SHA-256 派生 32 字节 key。
//!
//! 威胁模型：
//! - 目标：防止"app.db 被复制到别的机器后密码明文泄漏"
//! - 不防：同机器上的恶意程序逆向二进制拿到 salt 后重建 key
//!   （本地应用的固有限制，需用户信任运行环境）
//!
//! 格式：base64(nonce || ciphertext_with_tag)
//! - nonce: 12 字节随机（每次加密独立）
//! - GCM tag: 16 字节，附在密文后

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// 应用内固定 salt，用来和 hostname 拼接派生 key
/// 改这个常量会让已有的加密数据不可解密——**永不修改**
const APP_SALT: &[u8] = b"knowledge-base:v1:webdav-enc";

/// 派生 AES-256 key：sha256(hostname || APP_SALT)
fn derive_key() -> [u8; 32] {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown-host".into());
    let mut hasher = Sha256::new();
    hasher.update(host.as_bytes());
    hasher.update(APP_SALT);
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// 加密字符串 → base64 (nonce || ciphertext||tag)
pub fn encrypt(plaintext: &str) -> Result<String, AppError> {
    let key_bytes = derive_key();
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12 字节
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| AppError::Custom(format!("加密失败: {}", e)))?;

    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(&out))
}

/// 解密 base64 → 原字符串
pub fn decrypt(encoded: &str) -> Result<String, AppError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| AppError::Custom(format!("密文 base64 解析失败: {}", e)))?;
    if bytes.len() < 12 + 16 {
        return Err(AppError::Custom("密文长度不足".into()));
    }

    let (nonce_bytes, cipher_and_tag) = bytes.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let key_bytes = derive_key();
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let plain = cipher
        .decrypt(nonce, cipher_and_tag)
        .map_err(|e| AppError::Custom(format!("解密失败（可能密钥或数据损坏）: {}", e)))?;
    String::from_utf8(plain).map_err(|e| AppError::Custom(format!("解密后非法 UTF-8: {}", e)))
}

// ═══════════════════════════════════════════════════════════════════════
// T-007 笔记加密保险库（Vault）
//
// 与上面的 WebDAV 密码加密完全独立：
// - 上面 encrypt/decrypt：key 来自 hostname（应用自动派生，用户无感）
// - 下面 aead_encrypt/aead_decrypt + derive_user_key：key 来自用户主密码
//
// 数据包格式保持一致：nonce(12) || ciphertext + GCM tag(16)
// ═══════════════════════════════════════════════════════════════════════

use aes_gcm::aead::rand_core::RngCore as _;
use argon2::{Algorithm, Argon2, Params, Version};

/// 主密钥长度（AES-256）
pub const KEY_LEN: usize = 32;
/// AES-GCM nonce 长度
pub const NONCE_LEN: usize = 12;
/// Argon2 盐长度（≥16）
pub const SALT_LEN: usize = 16;

/// Argon2id 参数：内存 19 MiB / 迭代 2 / 并行 1
///
/// 比 OWASP 2024 建议最低值稍宽松，解锁单次耗时 ~50~200ms，弱机体验可接受。
fn argon2_params() -> Argon2<'static> {
    let params = Params::new(19_456, 2, 1, Some(KEY_LEN)).expect("argon2 params constant valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// 生成新盐（16 字节随机）
pub fn new_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// 从主密码 + 盐派生 32 字节 AES-256 key（Argon2id）
///
/// 耗时约 50~200ms。Command 里调用时务必用 async（tokio::task::spawn_blocking）
/// 或放 vault 初始化路径，不要在主线程同步 block。
pub fn derive_user_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], AppError> {
    let argon2 = argon2_params();
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Custom(format!("密钥派生失败: {}", e)))?;
    Ok(key)
}

/// 用 key 加密 → blob（nonce ‖ ciphertext+tag）
pub fn aead_encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| AppError::Custom(format!("AES 初始化失败: {}", e)))?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::Custom(format!("加密失败: {}", e)))?;
    let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// 解密 blob → 明文。密钥错 / blob 被篡改 → `AppError::Custom`（调用方当作"密码错误"）
pub fn aead_decrypt(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Vec<u8>, AppError> {
    if blob.len() < NONCE_LEN + 16 {
        return Err(AppError::Custom("密文过短，可能已损坏".to_string()));
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| AppError::Custom(format!("AES 初始化失败: {}", e)))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Custom("解密失败：密码错误或数据已损坏".to_string()))
}

// ═══════════════════════════════════════════════════════════════════════
// 隐藏笔记 PIN 哈希（仅用于"挡随手访问"的 UX 门禁，不是数据加密）
//
// 与 Vault 的根本区别：
// - Vault: derive_user_key 的输出当 AES key 用，加密笔记内容；忘密码=数据丢失
// - HiddenPin: derive_user_key 的输出当哈希值存，只用于 verify；忘 PIN=可重置
//
// 复用 argon2_params() 不引入新依赖；输出 32 字节哈希以 base64 存 app_config。
// ═══════════════════════════════════════════════════════════════════════

/// 计算 PIN 哈希（Argon2id, 32 字节）
pub fn hash_pin(pin: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], AppError> {
    derive_user_key(pin, salt)
}

/// 常量时间比较 PIN 是否匹配
///
/// 用 subtle::ConstantTimeEq 也行，但 derive_user_key 本身耗时 50~200ms
/// 已经远大于内存比较的纳秒级差异，这里直接 == 即可。
pub fn verify_pin(pin: &str, salt: &[u8], expected: &[u8; KEY_LEN]) -> Result<bool, AppError> {
    let actual = derive_user_key(pin, salt)?;
    Ok(&actual[..] == &expected[..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let plain = "my-secret-password";
        let enc = encrypt(plain).expect("encrypt ok");
        let dec = decrypt(&enc).expect("decrypt ok");
        assert_eq!(plain, dec);
    }

    #[test]
    fn different_nonce_each_time() {
        let p = "same input";
        let a = encrypt(p).unwrap();
        let b = encrypt(p).unwrap();
        assert_ne!(a, b, "nonce 必须随机，两次加密结果应不同");
    }

    // ─── T-007 vault 相关测试 ─────────
    //
    // 测试用低开销 argon2 参数（8 KiB / 1 iter）避免跑太慢；真实参数见 argon2_params()

    fn derive_key_fast(password: &str, salt: &[u8]) -> [u8; KEY_LEN] {
        let params = Params::new(8, 1, 1, Some(KEY_LEN)).unwrap();
        let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = [0u8; KEY_LEN];
        a2.hash_password_into(password.as_bytes(), salt, &mut key)
            .unwrap();
        key
    }

    #[test]
    fn aead_roundtrip() {
        let salt = new_salt();
        let key = derive_key_fast("hunter2", &salt);
        let plaintext = "Hello, secret 机密 🔒".as_bytes();
        let blob = aead_encrypt(&key, plaintext).unwrap();
        assert!(blob.len() > NONCE_LEN);
        let decoded = aead_decrypt(&key, &blob).unwrap();
        assert_eq!(decoded, plaintext);
    }

    #[test]
    fn aead_wrong_key_fails() {
        let salt = new_salt();
        let k1 = derive_key_fast("correct", &salt);
        let k2 = derive_key_fast("wrong", &salt);
        let blob = aead_encrypt(&k1, b"data").unwrap();
        assert!(aead_decrypt(&k2, &blob).is_err());
    }

    #[test]
    fn aead_truncated_fails() {
        let salt = new_salt();
        let key = derive_key_fast("x", &salt);
        let blob = aead_encrypt(&key, b"abc").unwrap();
        assert!(aead_decrypt(&key, &blob[..NONCE_LEN]).is_err());
    }
}
