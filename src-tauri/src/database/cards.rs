//! 闪卡 + FSRS 复习的数据访问层
//!
//! 设计要点：
//! - SRS 算法（FSRS）跑在前端 ts-fsrs，本层只负责 CRUD + 持久化新调度状态
//! - 软删除：is_deleted = 1 表示在回收站（与 notes 一致），全部查询都带这个过滤
//! - to_card 把 SQLite 行映射成 Card struct，为多个查询共用

use rusqlite::{params, Connection, Row};

use crate::database::Database;
use crate::error::AppError;
use crate::models::{Card, CardReviewLog, CardStats, CreateCardInput, ReviewCardInput};

fn to_card(row: &Row<'_>) -> rusqlite::Result<Card> {
    Ok(Card {
        id: row.get("id")?,
        note_id: row.get("note_id")?,
        front: row.get("front")?,
        back: row.get("back")?,
        deck: row.get("deck")?,
        due: row.get("due")?,
        stability: row.get("stability")?,
        difficulty: row.get("difficulty")?,
        elapsed_days: row.get("elapsed_days")?,
        scheduled_days: row.get("scheduled_days")?,
        reps: row.get("reps")?,
        lapses: row.get("lapses")?,
        state: row.get("state")?,
        last_review: row.get("last_review")?,
        is_deleted: row.get::<_, i32>("is_deleted")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const SELECT_COLS: &str = "id, note_id, front, back, deck, due, stability, difficulty, \
    elapsed_days, scheduled_days, reps, lapses, state, last_review, \
    is_deleted, created_at, updated_at";

impl Database {
    // ─── 卡片 CRUD ─────────────────────────────────────────────

    /// 新建卡片（默认状态：FSRS New，到期时间为现在 → 立即可复习）
    pub fn create_card(&self, input: &CreateCardInput) -> Result<Card, AppError> {
        let conn = self.conn_lock()?;
        let deck = input.deck.as_deref().unwrap_or("default");
        conn.execute(
            "INSERT INTO cards (note_id, front, back, deck) VALUES (?1, ?2, ?3, ?4)",
            params![input.note_id, input.front, input.back, deck],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_card(id)?.ok_or_else(|| {
            AppError::Custom(format!("卡片创建后查询失败: id={}", id))
        })
    }

    /// 查询单张卡片（不含已删除）
    pub fn get_card(&self, id: i64) -> Result<Option<Card>, AppError> {
        let conn = self.conn_lock()?;
        let sql = format!(
            "SELECT {} FROM cards WHERE id = ?1 AND is_deleted = 0",
            SELECT_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let card = stmt
            .query_row(params![id], |row| to_card(row))
            .ok();
        Ok(card)
    }

    /// 列出所有卡片（不含已删除），按 due 升序（最早到期的在前）
    pub fn list_cards(&self, deck: Option<&str>) -> Result<Vec<Card>, AppError> {
        let conn = self.conn_lock()?;
        let (sql, has_deck) = if deck.is_some() {
            (
                format!(
                    "SELECT {} FROM cards WHERE is_deleted = 0 AND deck = ?1 ORDER BY due ASC",
                    SELECT_COLS
                ),
                true,
            )
        } else {
            (
                format!(
                    "SELECT {} FROM cards WHERE is_deleted = 0 ORDER BY due ASC",
                    SELECT_COLS
                ),
                false,
            )
        };
        let mut stmt = conn.prepare(&sql)?;
        let cards = if has_deck {
            stmt.query_map(params![deck.unwrap()], |row| to_card(row))?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([], |row| to_card(row))?
                .collect::<Result<Vec<_>, _>>()?
        };
        Ok(cards)
    }

    /// 取今天到期 / 已过期的待复习卡片
    ///
    /// 为什么不限定 state：FSRS 的 New 卡 due 默认就是创建时间（即过去），所以也会被算进
    /// "到期"列表。这正是我们要的——新卡和到期卡一起进入复习队列。
    pub fn get_due_cards(&self, limit: Option<i64>) -> Result<Vec<Card>, AppError> {
        let conn = self.conn_lock()?;
        let lim = limit.unwrap_or(200);
        let sql = format!(
            "SELECT {} FROM cards WHERE is_deleted = 0 AND due <= datetime('now', 'localtime') \
             ORDER BY due ASC LIMIT ?1",
            SELECT_COLS
        );
        let mut stmt = conn.prepare(&sql)?;
        let cards = stmt
            .query_map(params![lim], |row| to_card(row))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(cards)
    }

    /// 更新卡片正反面
    pub fn update_card_content(
        &self,
        id: i64,
        front: &str,
        back: &str,
    ) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE cards SET front = ?1, back = ?2, updated_at = datetime('now', 'localtime') \
             WHERE id = ?3 AND is_deleted = 0",
            params![front, back, id],
        )?;
        Ok(())
    }

    /// 软删除卡片（移到回收站；保留 review_logs 便于以后恢复）
    pub fn soft_delete_card(&self, id: i64) -> Result<(), AppError> {
        let conn = self.conn_lock()?;
        conn.execute(
            "UPDATE cards SET is_deleted = 1, updated_at = datetime('now', 'localtime') \
             WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    // ─── 复习 ─────────────────────────────────────────────────

    /// 复习一张卡片：写一条 review_log + 更新 cards 的调度状态
    ///
    /// FSRS 算法状态由前端 ts-fsrs 算好后传入，本层不做调度计算。
    pub fn review_card(&self, input: &ReviewCardInput) -> Result<(), AppError> {
        let mut conn = self.conn_lock()?;
        let tx = conn.transaction()?;

        // 1) 写 review_log
        tx.execute(
            "INSERT INTO card_review_logs (
                card_id, rating, state, due, stability, difficulty,
                elapsed_days, last_elapsed_days, scheduled_days
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.card_id,
                input.rating,
                input.state,
                input.due,
                input.stability,
                input.difficulty,
                input.elapsed_days,
                input.last_elapsed_days,
                input.scheduled_days,
            ],
        )?;

        // 2) 更新 cards 表的调度字段
        // reps += 1；rating == 1 (Again) 时 lapses += 1
        let inc_lapses = if input.rating == 1 { 1 } else { 0 };
        tx.execute(
            "UPDATE cards SET
                state = ?1,
                due = ?2,
                stability = ?3,
                difficulty = ?4,
                elapsed_days = ?5,
                scheduled_days = ?6,
                reps = reps + 1,
                lapses = lapses + ?7,
                last_review = datetime('now', 'localtime'),
                updated_at = datetime('now', 'localtime')
             WHERE id = ?8",
            params![
                input.state,
                input.due,
                input.stability,
                input.difficulty,
                input.elapsed_days,
                input.scheduled_days,
                inc_lapses,
                input.card_id,
            ],
        )?;

        tx.commit()?;
        Ok(())
    }

    // ─── 统计 + 历史 ─────────────────────────────────────────

    pub fn get_card_stats(&self) -> Result<CardStats, AppError> {
        let conn = self.conn_lock()?;
        let stats = conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN due <= datetime('now', 'localtime') THEN 1 ELSE 0 END), 0) AS due_today,
                COALESCE(SUM(CASE WHEN state IN (1, 3) THEN 1 ELSE 0 END), 0) AS learning,
                COALESCE(SUM(CASE WHEN state = 2 THEN 1 ELSE 0 END), 0) AS review,
                COALESCE(SUM(CASE WHEN state = 0 THEN 1 ELSE 0 END), 0) AS new_cards,
                COUNT(*) AS total
             FROM cards WHERE is_deleted = 0",
            [],
            |row| {
                Ok(CardStats {
                    due_today: row.get(0)?,
                    learning: row.get(1)?,
                    review: row.get(2)?,
                    new_cards: row.get(3)?,
                    total: row.get(4)?,
                })
            },
        )?;
        Ok(stats)
    }

    pub fn list_card_review_logs(
        &self,
        card_id: i64,
        limit: Option<i64>,
    ) -> Result<Vec<CardReviewLog>, AppError> {
        let conn = self.conn_lock()?;
        let lim = limit.unwrap_or(50);
        let mut stmt = conn.prepare(
            "SELECT id, card_id, rating, state, due, stability, difficulty,
                    elapsed_days, last_elapsed_days, scheduled_days, review
             FROM card_review_logs WHERE card_id = ?1 ORDER BY review DESC LIMIT ?2",
        )?;
        let logs = stmt
            .query_map(params![card_id, lim], |row| {
                Ok(CardReviewLog {
                    id: row.get(0)?,
                    card_id: row.get(1)?,
                    rating: row.get(2)?,
                    state: row.get(3)?,
                    due: row.get(4)?,
                    stability: row.get(5)?,
                    difficulty: row.get(6)?,
                    elapsed_days: row.get(7)?,
                    last_elapsed_days: row.get(8)?,
                    scheduled_days: row.get(9)?,
                    review: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(logs)
    }
}

/// 让 to_card 能以 column-name 方式取列（方便后续多查询共用）
fn _ensure_named_columns_used() {
    let _ = to_card;
}

// rusqlite 的 row.get("col_name") 需要 prepare 出来的 Statement 有列名。
// 我们的 SELECT 都显式写出列名，所以 column_name 模式可用。
#[allow(dead_code)]
fn _silence_unused_imports() {
    let _ = Connection::open(":memory:");
}
