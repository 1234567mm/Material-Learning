//! 笔记正文哈希工具
//!
//! 用于导入去重：对笔记内容算 SHA-256（16 进制字符串），存到 notes.content_hash 字段，
//! 扫描外部 md 文件时以 (title, content_hash) 做兜底匹配。
//! 不用于安全场景——只要"碰撞概率足够低"即可。
use sha2::{Digest, Sha256};

pub fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let out = hasher.finalize();
    let mut s = String::with_capacity(out.len() * 2);
    for b in out {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}
