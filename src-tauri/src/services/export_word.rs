//! T-020 笔记导出为 Word（.docx）
//!
//! 设计：
//! - 用 `pulldown-cmark` 解析 markdown（项目已装），事件驱动地映射到 docx 元素
//! - 用 `docx-rs` 生成 .docx 文件
//! - 图片：识别 markdown 中的 ![](url)，对 asset:// / 本地相对路径 / 绝对路径都尝试解析为字节嵌入；
//!   失败的图片保留 alt 文本（不报错）
//!
//! 不在 v1：
//! - LaTeX 公式 `$$...$$` → 当作 plain text 段落
//! - 任务列表 `- [ ]` → 当成普通列表
//! - 嵌套表格 → 拍平为段落
//! - 复杂 inline 样式组合（粗体+斜体+链接交错）→ 简化处理

use std::path::{Path, PathBuf};

use docx_rs::*;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Parser, Tag, TagEnd};

use crate::error::AppError;

/// 导出结果
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordExportResult {
    pub file_path: String,
    pub images_embedded: usize,
    pub images_missing: usize,
}

pub struct WordExportService;

impl WordExportService {
    /// 把单条笔记导出到指定文件路径
    ///
    /// `assets_root` 是 kb_assets 目录的绝对路径（用于解析相对图片路径）；
    /// 不存在时所有非绝对路径图片都会算"缺失"。
    pub fn export_single(
        title: &str,
        markdown: &str,
        target_path: &Path,
        assets_root: &Path,
    ) -> Result<WordExportResult, AppError> {
        let mut docx = Docx::new();

        // 标题（H1 大字号）
        if !title.is_empty() {
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Heading1")
                    .add_run(Run::new().add_text(title).size(48).bold()),
            );
        }

        let parser = Parser::new(markdown);
        let mut state = RenderState::new(assets_root.to_path_buf());

        for event in parser {
            handle_event(event, &mut state, &mut docx)?;
        }

        // flush 最后一个段落
        state.flush_paragraph(&mut docx);

        // 写文件
        let file = std::fs::File::create(target_path)?;
        docx.build()
            .pack(file)
            .map_err(|e| AppError::Custom(format!("写 docx 失败: {}", e)))?;

        Ok(WordExportResult {
            file_path: target_path.to_string_lossy().into(),
            images_embedded: state.images_embedded,
            images_missing: state.images_missing,
        })
    }
}

/// 渲染期累计状态：当前段落构造中的 runs + 样式开关 + 图片统计
struct RenderState {
    /// 当前段落正在累积的 runs
    pending_runs: Vec<Run>,
    /// inline 样式栈
    bold: u32,
    italic: u32,
    strikethrough: u32,
    code: u32,
    /// 链接 url（出现 Tag::Link 时压入；EndTag 时弹出）
    link_url: Option<String>,
    /// 标题级别（None = 普通段落）
    current_heading: Option<HeadingLevel>,
    /// 在代码块内
    in_code_block: bool,
    code_block_lang: String,
    code_block_content: String,
    /// 在引用内（Blockquote）
    in_blockquote: bool,
    /// 列表层级（嵌套深度）+ 当前是有序列表？
    list_stack: Vec<bool>,
    /// 当前列表项编号（按层级）
    list_counters: Vec<u32>,
    /// 表格状态
    in_table: bool,
    table_rows: Vec<TableRow>,
    current_row_cells: Vec<TableCell>,
    current_cell_text: String,

    /// 图片解析根
    assets_root: PathBuf,
    images_embedded: usize,
    images_missing: usize,
}

impl RenderState {
    fn new(assets_root: PathBuf) -> Self {
        Self {
            pending_runs: Vec::new(),
            bold: 0,
            italic: 0,
            strikethrough: 0,
            code: 0,
            link_url: None,
            current_heading: None,
            in_code_block: false,
            code_block_lang: String::new(),
            code_block_content: String::new(),
            in_blockquote: false,
            list_stack: Vec::new(),
            list_counters: Vec::new(),
            in_table: false,
            table_rows: Vec::new(),
            current_row_cells: Vec::new(),
            current_cell_text: String::new(),
            assets_root,
            images_embedded: 0,
            images_missing: 0,
        }
    }

    /// 把"当前累积的 runs"打包成段落 push 到 docx
    fn flush_paragraph(&mut self, docx: &mut Docx) {
        if self.pending_runs.is_empty() {
            return;
        }
        let mut p = Paragraph::new();
        if let Some(level) = self.current_heading {
            let style = match level {
                HeadingLevel::H1 => "Heading1",
                HeadingLevel::H2 => "Heading2",
                HeadingLevel::H3 => "Heading3",
                HeadingLevel::H4 => "Heading4",
                HeadingLevel::H5 => "Heading5",
                HeadingLevel::H6 => "Heading6",
            };
            p = p.style(style);
        }
        if self.in_blockquote {
            // 引用：左缩进 + 灰色 + 斜体感
            p = p.indent(Some(720), None, None, None);
        }
        // 列表前缀（手动加，简化版）
        if let Some(&ordered) = self.list_stack.last() {
            let depth = self.list_stack.len();
            let indent = (depth as i32) * 360;
            p = p.indent(Some(indent), None, None, None);
            let prefix = if ordered {
                let n = self.list_counters.last().copied().unwrap_or(1);
                format!("{}. ", n)
            } else {
                "• ".to_string()
            };
            // 在第一个 run 前插一个 prefix run
            let prefix_run = Run::new().add_text(prefix);
            self.pending_runs.insert(0, prefix_run);
        }
        for r in self.pending_runs.drain(..) {
            p = p.add_run(r);
        }
        let _ = std::mem::replace(&mut self.pending_runs, Vec::new());
        *docx = std::mem::take(docx).add_paragraph(p);
    }

    fn make_run(&self, text: &str) -> Run {
        let mut r = Run::new().add_text(text);
        if self.bold > 0 {
            r = r.bold();
        }
        if self.italic > 0 {
            r = r.italic();
        }
        if self.strikethrough > 0 {
            r = r.strike();
        }
        if self.code > 0 {
            r = r.fonts(
                RunFonts::new()
                    .east_asia("Courier New")
                    .ascii("Courier New"),
            );
            r = r.color("c7254e");
        }
        if self.link_url.is_some() {
            r = r.color("0563c1").underline("single");
        }
        r
    }
}

fn handle_event(event: Event, state: &mut RenderState, docx: &mut Docx) -> Result<(), AppError> {
    match event {
        // ── 段落 ──
        Event::Start(Tag::Paragraph) => {}
        Event::End(TagEnd::Paragraph) => {
            state.flush_paragraph(docx);
        }

        // ── 标题 ──
        Event::Start(Tag::Heading { level, .. }) => {
            state.current_heading = Some(level);
        }
        Event::End(TagEnd::Heading(_)) => {
            state.flush_paragraph(docx);
            state.current_heading = None;
        }

        // ── 文本 ──
        Event::Text(t) => {
            if state.in_code_block {
                state.code_block_content.push_str(&t);
            } else if state.in_table {
                state.current_cell_text.push_str(&t);
            } else {
                let run = state.make_run(&t);
                state.pending_runs.push(run);
            }
        }
        Event::Code(t) => {
            // 行内代码
            state.code += 1;
            let run = state.make_run(&t);
            state.pending_runs.push(run);
            state.code -= 1;
        }

        // ── inline 样式 ──
        Event::Start(Tag::Strong) => state.bold += 1,
        Event::End(TagEnd::Strong) => {
            state.bold = state.bold.saturating_sub(1);
        }
        Event::Start(Tag::Emphasis) => state.italic += 1,
        Event::End(TagEnd::Emphasis) => {
            state.italic = state.italic.saturating_sub(1);
        }
        Event::Start(Tag::Strikethrough) => state.strikethrough += 1,
        Event::End(TagEnd::Strikethrough) => {
            state.strikethrough = state.strikethrough.saturating_sub(1);
        }
        Event::Start(Tag::Link { dest_url, .. }) => {
            state.link_url = Some(dest_url.into_string());
        }
        Event::End(TagEnd::Link) => {
            state.link_url = None;
        }

        // ── 代码块 ──
        Event::Start(Tag::CodeBlock(kind)) => {
            state.in_code_block = true;
            state.code_block_lang = match kind {
                CodeBlockKind::Fenced(lang) => lang.into_string(),
                CodeBlockKind::Indented => String::new(),
            };
            state.code_block_content.clear();
        }
        Event::End(TagEnd::CodeBlock) => {
            state.flush_paragraph(docx); // 先冲掉之前的内容
                                         // 整个代码块当作一个等宽字体段落，灰底（手工 shading）
            let content = std::mem::take(&mut state.code_block_content);
            for line in content.lines() {
                let p = Paragraph::new()
                    .add_run(
                        Run::new()
                            .add_text(line)
                            .fonts(
                                RunFonts::new()
                                    .east_asia("Courier New")
                                    .ascii("Courier New"),
                            )
                            .size(20),
                    )
                    .indent(Some(360), None, None, None);
                *docx = std::mem::take(docx).add_paragraph(p);
            }
            state.in_code_block = false;
        }

        // ── 引用 ──
        Event::Start(Tag::BlockQuote(_)) => {
            state.in_blockquote = true;
        }
        Event::End(TagEnd::BlockQuote(_)) => {
            state.in_blockquote = false;
        }

        // ── 列表 ──
        Event::Start(Tag::List(start)) => {
            state.list_stack.push(start.is_some());
            state.list_counters.push(start.unwrap_or(1) as u32);
        }
        Event::End(TagEnd::List(_)) => {
            state.list_stack.pop();
            state.list_counters.pop();
        }
        Event::Start(Tag::Item) => {}
        Event::End(TagEnd::Item) => {
            state.flush_paragraph(docx);
            // 有序列表自增
            if let Some(true) = state.list_stack.last() {
                if let Some(c) = state.list_counters.last_mut() {
                    *c += 1;
                }
            }
        }

        // ── 图片 ──
        Event::Start(Tag::Image {
            dest_url, title: _, ..
        }) => {
            // 先冲段落（避免图片插入与文本交错）
            state.flush_paragraph(docx);
            let url = dest_url.into_string();
            match resolve_image(&url, &state.assets_root) {
                Some(bytes) => {
                    let pic = Pic::new(&bytes).size(4_000_000, 3_000_000); // EMU；约 11x8.3 cm
                    let p = Paragraph::new().add_run(Run::new().add_image(pic));
                    *docx = std::mem::take(docx).add_paragraph(p);
                    state.images_embedded += 1;
                }
                None => {
                    // 缺失：插入占位文本
                    let p = Paragraph::new().add_run(
                        Run::new()
                            .add_text(format!("[图片缺失: {}]", url))
                            .italic()
                            .color("999999"),
                    );
                    *docx = std::mem::take(docx).add_paragraph(p);
                    state.images_missing += 1;
                }
            }
        }
        Event::End(TagEnd::Image) => {}

        // ── 表格（v1 简化：单元格只取纯文本） ──
        Event::Start(Tag::Table(_)) => {
            state.flush_paragraph(docx);
            state.in_table = true;
            state.table_rows = Vec::new();
        }
        Event::End(TagEnd::Table) => {
            if !state.table_rows.is_empty() {
                let rows = std::mem::take(&mut state.table_rows);
                let table = Table::new(rows);
                *docx = std::mem::take(docx).add_table(table);
                // 表格后插一个空段，避免下一个块紧贴表格底
                *docx = std::mem::take(docx).add_paragraph(Paragraph::new());
            }
            state.in_table = false;
        }
        Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => {
            state.current_row_cells = Vec::new();
        }
        Event::End(TagEnd::TableHead) | Event::End(TagEnd::TableRow) => {
            let cells = std::mem::take(&mut state.current_row_cells);
            if !cells.is_empty() {
                state.table_rows.push(TableRow::new(cells));
            }
        }
        Event::Start(Tag::TableCell) => {
            state.current_cell_text.clear();
        }
        Event::End(TagEnd::TableCell) => {
            let text = std::mem::take(&mut state.current_cell_text);
            let cell =
                TableCell::new().add_paragraph(Paragraph::new().add_run(Run::new().add_text(text)));
            state.current_row_cells.push(cell);
        }

        // ── 软换行 / 硬换行 ──
        Event::SoftBreak => {
            state.pending_runs.push(Run::new().add_text(" "));
        }
        Event::HardBreak => {
            state
                .pending_runs
                .push(Run::new().add_break(BreakType::TextWrapping));
        }

        // ── 水平线 ──
        Event::Rule => {
            state.flush_paragraph(docx);
            *docx = std::mem::take(docx)
                .add_paragraph(Paragraph::new().add_run(Run::new().add_text("─".repeat(40))));
        }

        // ── 其他 ──
        Event::Html(_) | Event::InlineHtml(_) => {
            // 简化：忽略 raw HTML（v1 不解析）
        }
        Event::FootnoteReference(_)
        | Event::Start(Tag::FootnoteDefinition(_))
        | Event::End(TagEnd::FootnoteDefinition) => {
            // v1 不支持脚注
        }
        Event::TaskListMarker(checked) => {
            // 任务列表 [x] / [ ] → 简单插入文本
            let mark = if checked { "☑ " } else { "☐ " };
            state.pending_runs.push(Run::new().add_text(mark));
        }
        // 其它块级标签默认不需要处理
        _ => {}
    }
    Ok(())
}

/// 解析图片 url 为字节
///
/// 支持：
/// - `data:image/...;base64,...` 内嵌
/// - `asset://localhost/...` Tauri asset URL
/// - 绝对路径 `C:\...` / `/Users/...`
/// - 相对路径（相对 assets_root）
/// - 跳过 `http(s)://`（避免迁移 docx 时拉外网）
fn resolve_image(url: &str, assets_root: &Path) -> Option<Vec<u8>> {
    // data: URL
    if let Some(stripped) = url.strip_prefix("data:") {
        if let Some(idx) = stripped.find(";base64,") {
            let b64 = &stripped[idx + 8..];
            return base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).ok();
        }
    }

    // http(s) 跳过
    if url.starts_with("http://") || url.starts_with("https://") {
        return None;
    }

    // asset://localhost/path 或 asset://path
    let path_str = if let Some(rest) = url.strip_prefix("asset://localhost/") {
        urlencoding::decode(rest).ok()?.into_owned()
    } else if let Some(rest) = url.strip_prefix("asset://") {
        urlencoding::decode(rest).ok()?.into_owned()
    } else {
        url.to_string()
    };

    let path = PathBuf::from(&path_str);
    let abs_path = if path.is_absolute() {
        path
    } else {
        assets_root.join(path)
    };

    std::fs::read(&abs_path).ok()
}
