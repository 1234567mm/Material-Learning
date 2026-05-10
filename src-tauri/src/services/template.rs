use chrono::{Datelike, Local};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{NoteTemplate, NoteTemplateInput};

/// 模板内容里的占位符渲染：把 `{{date}}` / `{{weekday}}` 等替换成当前本地时间。
///
/// 支持：date / time / datetime / year / month / day / weekday / title。
/// 不支持带格式参数的 `{{date:YYYY/MM/DD}}` 语法（v1，按需后续扩展）。
///
/// **注意**：替换顺序很重要，长 key 必须在短 key 之前替换 —— 但本变量集里
/// `{{datetime}}` 不包含 `{{date}}` 子串（前者整体是 12 字符 token），所以现行顺序安全。
pub fn render_variables(content: &str, title: &str) -> String {
    let now = Local::now();
    let weekday = match now.weekday() {
        chrono::Weekday::Mon => "星期一",
        chrono::Weekday::Tue => "星期二",
        chrono::Weekday::Wed => "星期三",
        chrono::Weekday::Thu => "星期四",
        chrono::Weekday::Fri => "星期五",
        chrono::Weekday::Sat => "星期六",
        chrono::Weekday::Sun => "星期日",
    };
    content
        .replace("{{datetime}}", &now.format("%Y-%m-%d %H:%M").to_string())
        .replace("{{date}}", &now.format("%Y-%m-%d").to_string())
        .replace("{{time}}", &now.format("%H:%M").to_string())
        .replace("{{year}}", &now.format("%Y").to_string())
        .replace("{{month}}", &now.format("%m").to_string())
        .replace("{{day}}", &now.format("%d").to_string())
        .replace("{{weekday}}", weekday)
        .replace("{{title}}", title)
}

/// 模板服务
pub struct TemplateService;

impl TemplateService {
    /// 获取所有模板
    pub fn list(db: &Database) -> Result<Vec<NoteTemplate>, AppError> {
        db.list_templates()
    }

    /// 获取单个模板
    pub fn get(db: &Database, id: i64) -> Result<NoteTemplate, AppError> {
        db.get_template(id)
    }

    /// 创建模板
    pub fn create(db: &Database, input: &NoteTemplateInput) -> Result<NoteTemplate, AppError> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("模板名称不能为空".into()));
        }
        db.create_template(input)
    }

    /// 更新模板
    pub fn update(
        db: &Database,
        id: i64,
        input: &NoteTemplateInput,
    ) -> Result<NoteTemplate, AppError> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::InvalidInput("模板名称不能为空".into()));
        }
        db.update_template(id, input)
    }

    /// 删除模板
    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        db.delete_template(id)
    }
}
