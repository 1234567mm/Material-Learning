//! 闪卡业务逻辑
//!
//! 这一层薄——FSRS 调度跑前端 ts-fsrs，本层只做必要的业务校验：
//!   · 创建时校验正反面非空
//!   · 评分范围 [1, 4]
//!   · 状态范围 [0, 3]
//!
//! 不做的：
//!   · 不在这里调 FSRS 算法（前端职责）
//!   · 不在这里解析笔记内容生成卡（阶段 2 才做"批注/高亮转卡"）

use crate::database::Database;
use crate::error::AppError;
use crate::models::{Card, CardReviewLog, CardStats, CreateCardInput, ReviewCardInput};

pub struct CardService;

impl CardService {
    pub fn create(db: &Database, input: CreateCardInput) -> Result<Card, AppError> {
        if input.front.trim().is_empty() {
            return Err(AppError::Custom("卡片正面不能为空".into()));
        }
        if input.back.trim().is_empty() {
            return Err(AppError::Custom("卡片反面不能为空".into()));
        }
        db.create_card(&input)
    }

    pub fn list(db: &Database, deck: Option<String>) -> Result<Vec<Card>, AppError> {
        db.list_cards(deck.as_deref())
    }

    pub fn get(db: &Database, id: i64) -> Result<Option<Card>, AppError> {
        db.get_card(id)
    }

    pub fn list_due(db: &Database, limit: Option<i64>) -> Result<Vec<Card>, AppError> {
        db.get_due_cards(limit)
    }

    pub fn update_content(
        db: &Database,
        id: i64,
        front: String,
        back: String,
    ) -> Result<(), AppError> {
        if front.trim().is_empty() || back.trim().is_empty() {
            return Err(AppError::Custom("卡片正反面不能为空".into()));
        }
        db.update_card_content(id, &front, &back)
    }

    pub fn delete(db: &Database, id: i64) -> Result<(), AppError> {
        db.soft_delete_card(id)
    }

    pub fn review(db: &Database, input: ReviewCardInput) -> Result<(), AppError> {
        if !(1..=4).contains(&input.rating) {
            return Err(AppError::Custom(format!(
                "rating 必须在 1..=4 范围内: 收到 {}",
                input.rating
            )));
        }
        if !(0..=3).contains(&input.state) {
            return Err(AppError::Custom(format!(
                "state 必须在 0..=3 范围内: 收到 {}",
                input.state
            )));
        }
        db.review_card(&input)
    }

    pub fn stats(db: &Database) -> Result<CardStats, AppError> {
        db.get_card_stats()
    }

    pub fn list_logs(
        db: &Database,
        card_id: i64,
        limit: Option<i64>,
    ) -> Result<Vec<CardReviewLog>, AppError> {
        db.list_card_review_logs(card_id, limit)
    }
}
