//! 笔记 / 思维导图的多窗口 pop-out
//!
//! 用途：用户想"两屏对照"或"边写边看导图"时，把一个笔记/导图视图弹到独立 OS 窗口，
//! 用户自己用 Win+方向键 Snap 到副屏 / 主屏的左半屏。
//!
//! 设计要点：
//! - **同 note_id 已存在窗口直接前置**，避免重复弹
//! - **label = `popout-note-{id}`**，对应 capabilities/default.json 的 windows glob
//! - **复用主 SPA**：和 emergency_window 保持一致，直接加载 `index.html#/notes/{id}`；
//!   Tauri 会在 dev/prod 下分别映射到 devUrl / app URL
//! - **不使用 initialization_script 改 hash**：窗口创建阶段只负责加载稳定 URL，
//!   避免 document-start 脚本在 WebView2 初始化期间触发二次导航
//! - **精简模式判定**：前端读 `getCurrentWebviewWindow().label` 是否以 `popout-` 开头

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;

/// 给指定笔记打开 pop-out 窗口；同 id 已存在则前置
pub fn open_note(app: &AppHandle, note_id: i64) -> Result<(), AppError> {
    let label = format!("popout-note-{}", note_id);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = format!("index.html#/notes/{}", note_id);

    log::info!(
        "[popout] 打开笔记新窗口: label={} note_id={}",
        label,
        note_id
    );

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("笔记")
        // popout 默认窗口宽一点，编辑器 topbar 工具按钮多，900px 会挤
        .inner_size(1200.0, 780.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .resizable(true)
        // 用 OS 原生标题栏：自带标题"笔记"、最小化/最大化/关闭按钮，不需要前端自绘。
        // 前端 AppLayout 用 isPopoutWindow 给 Content 加 paddingTop=32 让位即可
        .decorations(true)
        .focused(true)
        .visible(true);

    #[cfg(debug_assertions)]
    let builder = builder.devtools(true);

    builder
        .build()
        .map_err(|e| AppError::Custom(format!("pop-out 窗口创建失败: {}", e)))?;

    Ok(())
}
