//! 视频资产服务（与 image.rs 对称设计）
//!
//! - 落盘到 `kb_assets/videos/<note_id>/`，与 images 平级
//! - v1 不支持加密笔记的视频（视频体积大，AES 解密 + 全量加载到 WebView 不现实）
//!   加密笔记里调用 save_* 会被 Command 层提前拒绝
//! - 不复用 attachments 目录：未来要做缩略图、转码、孤儿扫描时独立目录更清晰

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::AppError;
use crate::services::safe_filename;

/// 视频资产目录名（dev 模式加 dev- 前缀实现数据隔离，与 image/attachment 一致）
const ASSETS_DIR_PROD: &str = "kb_assets";
const ASSETS_DIR_DEV: &str = "dev-kb_assets";
const VIDEOS_DIR: &str = "videos";

/// 进程内递增计数器，保证同一毫秒内多次保存也不会冲突
static VIDEO_SEQ: AtomicU64 = AtomicU64::new(0);

#[inline]
fn assets_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        ASSETS_DIR_DEV
    } else {
        ASSETS_DIR_PROD
    }
}

pub struct VideoService;

impl VideoService {
    /// 视频根目录: `{data_dir}/{prefix}kb_assets/videos/`
    pub fn videos_dir(data_dir: &Path) -> PathBuf {
        data_dir.join(assets_dir_name()).join(VIDEOS_DIR)
    }

    /// 确保目录存在；返回根目录路径
    #[allow(dead_code)] // 公开 API，给未来"打开视频目录"按钮用
    pub fn ensure_dir(data_dir: &Path) -> Result<PathBuf, AppError> {
        let dir = Self::videos_dir(data_dir);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// 保存字节到 `videos/<note_id>/`，**保留原文件名**。
    ///
    /// 命名规则：`<原 stem>.<ext>`；冲突时加 `-1/-2/...` 后缀。
    /// 视频体积可能 GB 级，`safe_filename::save_unique` 内部对 >64MB
    /// 的同名文件直接走加后缀路径，不做内容 dedup（避免双倍内存读）。
    pub fn save_bytes(
        data_dir: &Path,
        note_id: i64,
        file_name: &str,
        data: &[u8],
    ) -> Result<String, AppError> {
        let note_dir = Self::videos_dir(data_dir).join(note_id.to_string());

        let path = Path::new(file_name);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4");

        let file_path = safe_filename::save_unique(&note_dir, stem, ext, data)?;
        VIDEO_SEQ.fetch_add(1, Ordering::Relaxed);

        log::info!("视频已保存: {} ({} bytes)", file_path.display(), data.len());
        Ok(file_path.to_string_lossy().into_owned())
    }

    /// 从本地文件路径复制到 `videos/<note_id>/`，**保留原文件名**，零拷贝。
    ///
    /// 给"工具栏插入视频"这种已经有真路径的场景用。
    /// 走 `save_unique_from_path` → OS 级 `fs::copy`（避免 GB 级视频读到 RAM）。
    /// 同名时直接加 `-N` 后缀，不做内容 dedup（视频 dedup 收益小，代价大）。
    pub fn save_from_path(
        data_dir: &Path,
        note_id: i64,
        source_path: &str,
    ) -> Result<String, AppError> {
        let source = Path::new(source_path);
        if !source.exists() {
            return Err(AppError::NotFound(format!("文件不存在: {}", source_path)));
        }

        let note_dir = Self::videos_dir(data_dir).join(note_id.to_string());

        let file_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("video.mp4");
        let stem = Path::new(file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("video");
        let ext = Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4");

        let file_path = safe_filename::save_unique_from_path(&note_dir, stem, ext, source)?;
        VIDEO_SEQ.fetch_add(1, Ordering::Relaxed);

        log::info!("视频已复制: {} → {}", source.display(), file_path.display());
        Ok(file_path.to_string_lossy().into_owned())
    }

    /// 删除笔记的所有视频
    #[allow(dead_code)] // 公开 API，给"清空孤儿/删除笔记联级"等未来场景用
    pub fn delete_note_videos(data_dir: &Path, note_id: i64) -> Result<(), AppError> {
        let note_dir = Self::videos_dir(data_dir).join(note_id.to_string());
        if note_dir.exists() {
            std::fs::remove_dir_all(&note_dir)?;
            log::info!("已删除笔记 {} 的所有视频", note_id);
        }
        Ok(())
    }
}
