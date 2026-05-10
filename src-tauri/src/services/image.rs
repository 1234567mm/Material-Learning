use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};

/// 进程内递增计数器，保证同一毫秒内多次保存也不会冲突
static IMAGE_SEQ: AtomicU64 = AtomicU64::new(0);

use crate::database::Database;
use crate::error::AppError;
use crate::services::safe_filename;
use crate::services::vault::{VaultService, VaultState};

/// 图片资产目录名（dev 模式加 dev- 前缀实现数据隔离）
const ASSETS_DIR_PROD: &str = "kb_assets";
const ASSETS_DIR_DEV: &str = "dev-kb_assets";
const IMAGES_DIR: &str = "images";
/// 加密图片落盘后缀。文件名形如 `20260101_xxx.png.enc`，
/// 内容为 `aead_encrypt(vault_key, raw_bytes)`。
/// 用后缀而非独立目录的好处：scan_orphans / delete_note_images 等扫盘逻辑零改动。
const ENC_SUFFIX: &str = ".enc";

/// 笔记加密态切换时的图片迁移方向
#[derive(Debug, Clone, Copy)]
pub enum ImageMigration {
    /// 普通笔记 → 加密笔记：把所有明文图片加密成 .enc，删原文件
    Encrypt,
    /// 加密笔记 → 普通笔记：把所有 .enc 解密回原后缀，删 .enc
    Decrypt,
}

#[inline]
fn assets_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        ASSETS_DIR_DEV
    } else {
        ASSETS_DIR_PROD
    }
}

pub struct ImageService;

impl ImageService {
    /// 获取图片根目录: {app_data_dir}/{prefix}kb_assets/images/
    pub fn images_dir(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(assets_dir_name()).join(IMAGES_DIR)
    }

    /// 确保图片目录存在
    pub fn ensure_dir(app_data_dir: &Path) -> Result<PathBuf, AppError> {
        let dir = Self::images_dir(app_data_dir);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 从 base64 数据保存图片（用于粘贴/拖放）。按笔记 is_encrypted 自动路由到加/明文分支。
    ///
    /// 返回保存后的绝对路径（加密笔记返回的路径以 `.enc` 结尾）
    pub fn save_from_base64(
        db: &Database,
        vault: &RwLock<VaultState>,
        app_data_dir: &Path,
        note_id: i64,
        file_name: &str,
        base64_data: &str,
    ) -> Result<String, AppError> {
        let data = STANDARD
            .decode(base64_data)
            .map_err(|e| AppError::Custom(format!("base64 解码失败: {}", e)))?;

        Self::save_bytes_routed(db, vault, app_data_dir, note_id, file_name, &data)
    }

    /// 从本地文件路径复制图片（用于工具栏插入）。按笔记 is_encrypted 自动路由。
    ///
    /// 返回保存后的绝对路径（加密笔记返回的路径以 `.enc` 结尾）
    pub fn save_from_path(
        db: &Database,
        vault: &RwLock<VaultState>,
        app_data_dir: &Path,
        note_id: i64,
        source_path: &str,
    ) -> Result<String, AppError> {
        let source = Path::new(source_path);
        if !source.exists() {
            return Err(AppError::NotFound(format!("文件不存在: {}", source_path)));
        }

        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image.png");

        let data = std::fs::read(source)?;
        Self::save_bytes_routed(db, vault, app_data_dir, note_id, file_name, &data)
    }

    /// 反查笔记 is_encrypted，加密笔记走 AEAD + `.enc`，否则走明文。
    /// 用户交互入口（粘贴/拖放/工具栏）应优先用这个。
    pub fn save_bytes_routed(
        db: &Database,
        vault: &RwLock<VaultState>,
        app_data_dir: &Path,
        note_id: i64,
        file_name: &str,
        data: &[u8],
    ) -> Result<String, AppError> {
        let is_encrypted = db.get_note_is_encrypted(note_id)?;
        if is_encrypted {
            // 加密分支：先 aead_encrypt 再落盘 .enc
            let blob = VaultService::encrypt_plaintext(vault, data)?;
            Self::save_bytes_inner(app_data_dir, note_id, file_name, &blob, true)
        } else {
            Self::save_bytes_inner(app_data_dir, note_id, file_name, data, false)
        }
    }

    /// 保存字节数据到文件（明文模式；导入流程用，新建笔记 is_encrypted 默认 false）
    ///
    /// 调用方若不能保证笔记非加密态，请改用 `save_bytes_routed`。
    pub fn save_bytes(
        app_data_dir: &Path,
        note_id: i64,
        file_name: &str,
        data: &[u8],
    ) -> Result<String, AppError> {
        Self::save_bytes_inner(app_data_dir, note_id, file_name, data, false)
    }

    /// 内部落盘实现：`encrypted` 决定文件名是否追加 `.enc`。
    ///
    /// 命名规则（保留原名风格）：
    ///   - 优先 `images/<note_id>/<原 stem>.<ext>`
    ///   - 已存在 + 内容相同 → 复用旧文件（同一张图反复粘贴不浪费盘）
    ///   - 已存在 + 内容不同 → 加 `-1` / `-2` / ... 后缀
    ///
    /// 加密模式下统一在最终落盘文件名后追加 `.enc`，让扫盘逻辑无需改动。
    /// 加密判重比对的是密文，所以同一明文每次加密 nonce 不同 → 必然加后缀，
    /// 这是预期行为（无法在不解密的情况下做语义判重）。
    fn save_bytes_inner(
        app_data_dir: &Path,
        note_id: i64,
        file_name: &str,
        data: &[u8],
        encrypted: bool,
    ) -> Result<String, AppError> {
        let note_dir = Self::images_dir(app_data_dir).join(note_id.to_string());

        // 拆分原文件名为 stem + ext
        let path = Path::new(file_name);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");

        // 加密时把 .enc 拼到 ext 上，让 save_unique 一次定位到最终落盘名
        let final_ext = if encrypted {
            format!("{}{}", ext, ENC_SUFFIX)
        } else {
            ext.to_string()
        };

        let file_path = safe_filename::save_unique(&note_dir, stem, &final_ext, data)?;

        // 触一下进程内序号，保留旧的全局原子计数语义（其他模块可能依赖统计行为）
        IMAGE_SEQ.fetch_add(1, Ordering::Relaxed);

        log::info!(
            "图片已保存{}: {}",
            if encrypted { "（加密）" } else { "" },
            file_path.display()
        );
        Ok(file_path.to_string_lossy().into_owned())
    }

    /// 给 `get_image_blob` Command 用：路径以 `.enc` 结尾时用 vault key 解密返回明文字节，
    /// 否则直接读取磁盘原字节。
    ///
    /// 安全：路径校验留给 Command 层。这里只关心读 + 解密。
    /// vault 锁定时调用加密路径会返回 `vault 未解锁` 错误。
    pub fn read_for_render(vault: &RwLock<VaultState>, path: &str) -> Result<Vec<u8>, AppError> {
        let bytes = std::fs::read(path)?;
        if path.ends_with(ENC_SUFFIX) {
            VaultService::decrypt_blob(vault, &bytes)
        } else {
            Ok(bytes)
        }
    }

    /// 笔记加密态切换时的图片立即迁移：扫 `images/{note_id}/` 把所有图片做相反操作。
    ///
    /// - `Encrypt`：跳过已带 `.enc` 后缀的；其它文件 read → aead_encrypt → 写 `*.enc` → 删原文件
    /// - `Decrypt`：跳过不带 `.enc` 的；其它 read → aead_decrypt → 写去除 `.enc` 后缀名 → 删 `.enc`
    ///
    /// 返回成功迁移的文件数。任一文件失败立即返回 Err（避免半迁移状态）。
    /// 调用方应在 vault 已解锁状态下调用，否则 encrypt/decrypt 会失败。
    pub fn migrate_note_images(
        vault: &RwLock<VaultState>,
        app_data_dir: &Path,
        note_id: i64,
        action: ImageMigration,
    ) -> Result<usize, AppError> {
        let note_dir = Self::images_dir(app_data_dir).join(note_id.to_string());
        if !note_dir.exists() {
            return Ok(0);
        }

        let mut migrated = 0usize;
        for entry in std::fs::read_dir(&note_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let is_enc = name.ends_with(ENC_SUFFIX);

            match action {
                ImageMigration::Encrypt => {
                    if is_enc {
                        continue;
                    }
                    let data = std::fs::read(&path)?;
                    let blob = VaultService::encrypt_plaintext(vault, &data)?;
                    let new_path = note_dir.join(format!("{}{}", name, ENC_SUFFIX));
                    std::fs::write(&new_path, &blob)?;
                    std::fs::remove_file(&path)?;
                    migrated += 1;
                }
                ImageMigration::Decrypt => {
                    if !is_enc {
                        continue;
                    }
                    let blob = std::fs::read(&path)?;
                    let data = VaultService::decrypt_blob(vault, &blob)?;
                    let original_name = name.strip_suffix(ENC_SUFFIX).unwrap_or(name.as_str());
                    let new_path = note_dir.join(original_name);
                    std::fs::write(&new_path, &data)?;
                    std::fs::remove_file(&path)?;
                    migrated += 1;
                }
            }
        }

        log::info!(
            "笔记 {} 图片迁移完成（{:?}）：{} 个",
            note_id,
            action,
            migrated
        );
        Ok(migrated)
    }

    /// 删除笔记的所有图片
    pub fn delete_note_images(app_data_dir: &Path, note_id: i64) -> Result<(), AppError> {
        let note_dir = Self::images_dir(app_data_dir).join(note_id.to_string());
        if note_dir.exists() {
            std::fs::remove_dir_all(&note_dir)?;
            log::info!("已删除笔记 {} 的所有图片", note_id);
        }
        Ok(())
    }

    // 孤儿扫描已迁移到 services::orphan_scan（统一扫 5 类素材，
    // 并修复 trash 笔记 content / 加密笔记 content 的引用判定 BUG）
}
