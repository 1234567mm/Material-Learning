/**
 * 配置 envelope 加密层（基于 Web Crypto API，全平台 WebView 都支持）。
 *
 * 算法：PBKDF2(SHA-256, 100k 迭代) → AES-GCM-256
 *
 * 设计目标：
 *   - 用户用 4-12 位 PIN（默认 6 位数字）派生密钥
 *   - 接收方输入相同 PIN 解密
 *   - 中途任何人捡到 envelope 都看不到 API Key / 密码
 *   - PBKDF2 100k 迭代 → 暴力破解 6 位数字 PIN 至少要算 100 万次哈希
 *     单台 GPU 大约 1-10 秒能爆 6 位数字 — 所以推荐用户起码 8 位混合
 *
 * 输出格式：base64url(salt || iv || ciphertext+tag)
 *   - salt: 16 字节
 *   - iv: 12 字节
 *   - 剩余: AES-GCM 密文（含 16 字节 tag）
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_LEN = 16;
const IV_LEN = 12;

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa → base64 → 转 base64url（替换 +/=）
  const std = btoa(bin);
  return std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 加密 plaintext → base64url 字符串 */
export async function encryptWithPin(
  plaintext: string,
  pin: string,
): Promise<string> {
  if (!pin) throw new Error("PIN 不能为空");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(pin, salt);
  const enc = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
    key,
    enc as unknown as ArrayBuffer,
  );
  const cipher = new Uint8Array(cipherBuf);
  // 拼 salt || iv || cipher
  const out = new Uint8Array(salt.length + iv.length + cipher.length);
  out.set(salt, 0);
  out.set(iv, salt.length);
  out.set(cipher, salt.length + iv.length);
  return bytesToBase64url(out);
}

/** 解密 base64url → plaintext。PIN 错或数据被篡改会抛 DOMException */
export async function decryptWithPin(
  payload: string,
  pin: string,
): Promise<string> {
  if (!pin) throw new Error("PIN 不能为空");
  const all = base64urlToBytes(payload);
  if (all.length < SALT_LEN + IV_LEN + 16) {
    throw new Error("payload 长度不合法");
  }
  const salt = all.slice(0, SALT_LEN);
  const iv = all.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const cipher = all.slice(SALT_LEN + IV_LEN);
  const key = await deriveKey(pin, salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
    key,
    cipher as unknown as ArrayBuffer,
  );
  return new TextDecoder().decode(plainBuf);
}
