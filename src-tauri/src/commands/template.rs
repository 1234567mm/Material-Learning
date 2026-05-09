use crate::models::{Note, NoteInput, NoteTemplate, NoteTemplateInput};
use crate::services::note::NoteService;
use crate::services::template::{self, TemplateService};
use crate::state::AppState;

/// 获取所有模板
#[tauri::command]
pub fn list_templates(state: tauri::State<'_, AppState>) -> Result<Vec<NoteTemplate>, String> {
    TemplateService::list(&state.db).map_err(|e| e.to_string())
}

/// 获取单个模板
#[tauri::command]
pub fn get_template(state: tauri::State<'_, AppState>, id: i64) -> Result<NoteTemplate, String> {
    TemplateService::get(&state.db, id).map_err(|e| e.to_string())
}

/// 创建模板
#[tauri::command]
pub fn create_template(
    state: tauri::State<'_, AppState>,
    input: NoteTemplateInput,
) -> Result<NoteTemplate, String> {
    TemplateService::create(&state.db, &input).map_err(|e| e.to_string())
}

/// 更新模板
#[tauri::command]
pub fn update_template(
    state: tauri::State<'_, AppState>,
    id: i64,
    input: NoteTemplateInput,
) -> Result<NoteTemplate, String> {
    TemplateService::update(&state.db, id, &input).map_err(|e| e.to_string())
}

/// 删除模板
#[tauri::command]
pub fn delete_template(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    TemplateService::delete(&state.db, id).map_err(|e| e.to_string())
}

/// 按模板创建笔记：拉模板内容 → 渲染 `{{date}}` 等变量 → 落库。
/// title 不传则默认用模板名（保持与旧 GUI 行为一致）。
#[tauri::command]
pub fn create_note_from_template(
    state: tauri::State<'_, AppState>,
    template_id: i64,
    title: Option<String>,
    folder_id: Option<i64>,
) -> Result<Note, String> {
    let tpl = TemplateService::get(&state.db, template_id).map_err(|e| e.to_string())?;
    let final_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| tpl.name.clone());
    let rendered = template::render_variables(&tpl.content, &final_title);
    let input = NoteInput {
        title: final_title,
        content: rendered,
        folder_id,
    };
    NoteService::create(&state.db, &input).map_err(|e| e.to_string())
}
