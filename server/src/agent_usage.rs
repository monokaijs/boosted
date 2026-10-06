//! Durable hourly accounting, with cumulative high-water marks across restarts.
use super::*;

pub(crate) async fn migrate(db: &Database) -> AppResult<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS agent_usage_threads (thread_id TEXT PRIMARY KEY, total_tokens INTEGER NOT NULL)").execute(&db.pool).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS agent_usage_buckets (agent_id TEXT NOT NULL, start_date TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY(agent_id, start_date))").execute(&db.pool).await?;
    for (table, columns) in [
        (
            "agent_usage_threads",
            vec![
                ("input_tokens", "INTEGER"),
                ("cached_tokens", "INTEGER"),
                ("output_tokens", "INTEGER"),
            ],
        ),
        (
            "agent_usage_buckets",
            vec![
                ("input_tokens", "INTEGER NOT NULL DEFAULT 0"),
                ("cached_tokens", "INTEGER NOT NULL DEFAULT 0"),
                ("output_tokens", "INTEGER NOT NULL DEFAULT 0"),
                ("detailed_tokens", "INTEGER NOT NULL DEFAULT 0"),
            ],
        ),
    ] {
        let existing = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&db.pool)
            .await?;
        for (column, definition) in columns {
            if !existing
                .iter()
                .any(|row| row.get::<String, _>("name") == column)
            {
                sqlx::query(&format!(
                    "ALTER TABLE {table} ADD COLUMN {column} {definition}"
                ))
                .execute(&db.pool)
                .await?;
            }
        }
    }
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS agent_usage_by_date ON agent_usage_buckets(start_date)",
    )
    .execute(&db.pool)
    .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS group_usage_buckets (group_id TEXT NOT NULL, agent_id TEXT NOT NULL, start_date TEXT NOT NULL, tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, detailed_tokens INTEGER NOT NULL, PRIMARY KEY(group_id,agent_id,start_date))").execute(&db.pool).await?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn record(
    db: &Database,
    agent: &str,
    thread: &str,
    params: &Value,
) -> AppResult<()> {
    record_scoped(db, agent, thread, params, None, true).await
}

pub(crate) async fn record_scoped(
    db: &Database,
    agent: &str,
    thread: &str,
    params: &Value,
    group: Option<&str>,
    include_agent: bool,
) -> AppResult<()> {
    let usage = &params["tokenUsage"]["total"];
    let number = |name: &str| usage[name].as_i64().filter(|n| *n >= 0);
    let Some(total) = number("totalTokens") else {
        return Ok(());
    };
    let input = number("inputTokens");
    let cached = number("cachedInputTokens");
    let output = number("outputTokens");
    let bucket = Utc::now().format("%Y-%m-%dT%H:00:00Z").to_string();
    let mut tx = db.pool.begin().await?;
    // Existing child conversations may predate tracking. Their first event's
    // `last` is new activity; do not charge their entire old history to today.
    let last = &params["tokenUsage"]["last"];
    let baseline = if !include_agent {
        match (
            last["totalTokens"].as_i64(),
            last["inputTokens"].as_i64(),
            last["cachedInputTokens"].as_i64(),
            last["outputTokens"].as_i64(),
            input,
            cached,
            output,
        ) {
            (Some(t), Some(i), Some(c), Some(o), Some(ti), Some(tc), Some(to))
                if t >= 0
                    && i >= 0
                    && c >= 0
                    && o >= 0
                    && c <= i
                    && i.checked_add(o) == Some(t)
                    && t <= total
                    && i <= ti
                    && c <= tc
                    && o <= to =>
            {
                (total - t, Some(ti - i), Some(tc - c), Some(to - o))
            }
            _ => (0, None, None, None),
        }
    } else {
        (0, None, None, None)
    };
    // Take the SQLite write lock before reading the watermark.
    sqlx::query("INSERT OR IGNORE INTO agent_usage_threads(thread_id,total_tokens,input_tokens,cached_tokens,output_tokens) VALUES(?,?,?,?,?)")
        .bind(thread)
        .bind(baseline.0).bind(baseline.1).bind(baseline.2).bind(baseline.3)
        .execute(&mut *tx)
        .await?;
    let previous = sqlx::query("SELECT * FROM agent_usage_threads WHERE thread_id=?")
        .bind(thread)
        .fetch_one(&mut *tx)
        .await?;
    let old = previous.get::<i64, _>("total_tokens");
    if total > old {
        let delta = |column: &str, value: Option<i64>| -> Option<i64> {
            value.and_then(|value| {
                previous
                    .get::<Option<i64>, _>(column)
                    .or((old == 0).then_some(0))
                    .and_then(|old| value.checked_sub(old))
                    .filter(|n| *n >= 0)
            })
        };
        let di = delta("input_tokens", input);
        let dc = delta("cached_tokens", cached);
        let dout = delta("output_tokens", output);
        let detailed = matches!((di,dc,dout), (Some(i),Some(c),Some(o)) if c <= i && i.checked_add(o) == Some(total-old));
        let (di, dc, dout, covered) = if detailed {
            (di.unwrap(), dc.unwrap(), dout.unwrap(), total - old)
        } else {
            (0, 0, 0, 0)
        };
        sqlx::query("UPDATE agent_usage_threads SET total_tokens=?,input_tokens=?,cached_tokens=?,output_tokens=? WHERE thread_id=?").bind(total).bind(input).bind(cached).bind(output).bind(thread).execute(&mut *tx).await?;
        if include_agent {
            sqlx::query("INSERT INTO agent_usage_buckets(agent_id,start_date,tokens,input_tokens,cached_tokens,output_tokens,detailed_tokens) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,start_date) DO UPDATE SET tokens=tokens+excluded.tokens,input_tokens=input_tokens+excluded.input_tokens,cached_tokens=cached_tokens+excluded.cached_tokens,output_tokens=output_tokens+excluded.output_tokens,detailed_tokens=detailed_tokens+excluded.detailed_tokens")
                .bind(agent).bind(&bucket).bind(total-old).bind(di).bind(dc).bind(dout).bind(covered).execute(&mut *tx).await?;
        }
        if let Some(group) = group {
            // A late child notification cannot recreate analytics for a deleted group.
            sqlx::query("INSERT INTO group_usage_buckets(group_id,agent_id,start_date,tokens,input_tokens,cached_tokens,output_tokens,detailed_tokens) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM groups WHERE id=?) ON CONFLICT(group_id,agent_id,start_date) DO UPDATE SET tokens=tokens+excluded.tokens,input_tokens=input_tokens+excluded.input_tokens,cached_tokens=cached_tokens+excluded.cached_tokens,output_tokens=output_tokens+excluded.output_tokens,detailed_tokens=detailed_tokens+excluded.detailed_tokens")
                .bind(group).bind(agent).bind(&bucket).bind(total-old).bind(di).bind(dc).bind(dout).bind(covered).bind(group).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
pub(crate) struct UsageQuery {
    pub(crate) days: Option<i64>,
}

pub(crate) async fn read_usage(
    State(state): State<AppState>,
    Query(query): Query<UsageQuery>,
) -> AppResult<Json<Value>> {
    read(&state, query, None).await
}
pub(crate) async fn read_group_usage(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Query(query): Query<UsageQuery>,
) -> AppResult<Json<Value>> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM groups WHERE id=?)")
        .bind(&group)
        .fetch_one(&state.db.pool)
        .await?;
    if !exists {
        return Err(AppError::NotFound("Group not found".into()));
    }
    read(&state, query, Some(&group)).await
}
async fn read(state: &AppState, query: UsageQuery, group: Option<&str>) -> AppResult<Json<Value>> {
    let days = query.days.unwrap_or(30);
    if ![7, 30, 90].contains(&days) {
        return Err(AppError::BadRequest(
            "Usage range must be 7, 30, or 90 days".into(),
        ));
    }
    let since = (Utc::now() - chrono::Duration::days(days + 1))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    let (rows, tracked_since) = if let Some(group) = group {
        (sqlx::query("SELECT * FROM group_usage_buckets WHERE group_id=? AND start_date>=? ORDER BY start_date").bind(group).bind(&since).fetch_all(&state.db.pool).await?,
         sqlx::query_scalar::<_,Option<String>>("SELECT MIN(start_date) FROM group_usage_buckets WHERE group_id=?").bind(group).fetch_one(&state.db.pool).await?)
    } else {
        (
            sqlx::query(
                "SELECT * FROM agent_usage_buckets WHERE start_date>=? ORDER BY start_date",
            )
            .bind(&since)
            .fetch_all(&state.db.pool)
            .await?,
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT MIN(start_date) FROM agent_usage_buckets",
            )
            .fetch_one(&state.db.pool)
            .await?,
        )
    };
    let Json(agents) = agents::list_agents(State(state.clone())).await;
    let mut ids: Vec<String> = if group.is_some() {
        rows.iter().map(|r| r.get("agent_id")).collect()
    } else {
        agents
            .iter()
            .filter_map(|a| a["id"].as_str().map(str::to_owned))
            .collect()
    };
    ids.sort();
    ids.dedup();
    let series: Vec<_> = ids.iter().map(|id| {
        let name = agents.iter().find(|a| a["id"] == *id).and_then(|a| a["profile"]["name"].as_str()).unwrap_or(id);
        let buckets: Vec<_> = rows.iter().filter(|r| r.get::<String,_>("agent_id") == *id).map(|r| json!({"startDate":r.get::<String,_>("start_date"),"tokens":r.get::<i64,_>("tokens"),"inputTokens":r.get::<i64,_>("input_tokens"),"cachedTokens":r.get::<i64,_>("cached_tokens"),"outputTokens":r.get::<i64,_>("output_tokens"),"detailedTokens":r.get::<i64,_>("detailed_tokens")})).collect();
        json!({"agentId":id,"name":name,"buckets":buckets})
    }).collect();
    Ok(Json(json!({"trackedSince":tracked_since,"series":series})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn detailed_usage_attributes_increments_and_child_runs_without_duplicates() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::connect(&root.path().join("usage.db"))
            .await
            .unwrap();
        for group in ["a", "b"] {
            sqlx::query("INSERT INTO groups(id,group_id,data) VALUES(?,?,?)")
                .bind(group)
                .bind(group)
                .bind("{}")
                .execute(&db.pool)
                .await
                .unwrap();
        }
        let usage = |input, cached, output| json!({"tokenUsage":{"total":{"totalTokens":input+output,"inputTokens":input,"cachedInputTokens":cached,"outputTokens":output}}});
        for _ in 0..2 {
            record_scoped(&db, "pock", "shared", &usage(80, 50, 20), Some("a"), true)
                .await
                .unwrap();
        }
        record_scoped(&db, "pock", "shared", &usage(120, 70, 40), Some("b"), true)
            .await
            .unwrap();
        record_scoped(&db, "pock", "child", &usage(200, 150, 50), Some("a"), false)
            .await
            .unwrap();
        let rows = sqlx::query("SELECT * FROM group_usage_buckets ORDER BY group_id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        for (row, expected) in rows.iter().zip([[350, 280, 200, 70], [60, 40, 20, 20]]) {
            for (field, expected) in ["tokens", "input_tokens", "cached_tokens", "output_tokens"]
                .iter()
                .zip(expected)
            {
                assert_eq!(row.get::<i64, _>(*field), expected);
            }
            assert_eq!(
                row.get::<i64, _>("detailed_tokens"),
                row.get::<i64, _>("tokens")
            );
        }
        let total: i64 = sqlx::query_scalar("SELECT SUM(tokens) FROM agent_usage_buckets")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(total, 160);
        sqlx::query("DELETE FROM groups WHERE id='a'")
            .execute(&db.pool)
            .await
            .unwrap();
        record_scoped(&db, "pock", "late", &usage(100, 80, 30), Some("a"), false)
            .await
            .unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT SUM(tokens) FROM group_usage_buckets WHERE group_id='a'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(count, 350);
    }

    #[tokio::test]
    async fn legacy_totals_do_not_invent_a_breakdown_and_migration_is_repeatable() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::connect(&root.path().join("usage.db"))
            .await
            .unwrap();
        migrate(&db).await.unwrap();
        record(
            &db,
            "pock",
            "legacy",
            &json!({"tokenUsage":{"total":{"totalTokens":100}}}),
        )
        .await
        .unwrap();
        let usage = |input, cached, output| json!({"tokenUsage":{"total":{"totalTokens":input+output,"inputTokens":input,"cachedInputTokens":cached,"outputTokens":output}}});
        record(&db, "pock", "legacy", &usage(120, 80, 40))
            .await
            .unwrap();
        record(&db, "pock", "legacy", &usage(150, 100, 50))
            .await
            .unwrap();
        // A regressing notification must not lower any counter.
        record(&db, "pock", "legacy", &usage(120, 80, 40))
            .await
            .unwrap();
        let row = sqlx::query("SELECT * FROM agent_usage_buckets")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("tokens"), 200);
        assert_eq!(row.get::<i64, _>("detailed_tokens"), 40);
        assert_eq!(row.get::<i64, _>("input_tokens"), 30);
        assert_eq!(row.get::<i64, _>("cached_tokens"), 20);
        assert_eq!(row.get::<i64, _>("output_tokens"), 10);
    }

    #[tokio::test]
    async fn an_existing_child_chat_counts_new_activity_instead_of_its_old_history() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::connect(&root.path().join("usage.db"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO groups VALUES('g','g','{}')")
            .execute(&db.pool)
            .await
            .unwrap();
        let usage = json!({"tokenUsage":{
            "total":{"totalTokens":1250,"inputTokens":1000,"cachedInputTokens":750,"outputTokens":250},
            "last":{"totalTokens":250,"inputTokens":200,"cachedInputTokens":150,"outputTokens":50}
        }});
        for _ in 0..2 {
            record_scoped(&db, "pock", "old-chat", &usage, Some("g"), false)
                .await
                .unwrap();
        }
        let row = sqlx::query("SELECT * FROM group_usage_buckets")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("tokens"), 250);
        assert_eq!(row.get::<i64, _>("cached_tokens"), 150);
        assert_eq!(row.get::<i64, _>("detailed_tokens"), 250);
    }

    #[tokio::test]
    async fn usage_counts_increments_once_and_persists_across_reconnection() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("usage.db");
        let db = Database::connect(&path).await.unwrap();
        for total in [100, 100, 70, 160] {
            record(
                &db,
                "pock",
                "thread-a",
                &json!({"tokenUsage":{"total":{"totalTokens":total}}}),
            )
            .await
            .unwrap();
        }
        record(
            &db,
            "sage",
            "thread-b",
            &json!({"tokenUsage":{"total":{"totalTokens":40}}}),
        )
        .await
        .unwrap();
        record(
            &db,
            "pock",
            "invalid",
            &json!({"tokenUsage":{"total":{"totalTokens":-1}}}),
        )
        .await
        .unwrap();
        db.pool.close().await;
        let db = Database::connect(&path).await.unwrap();
        record(
            &db,
            "pock",
            "thread-a",
            &json!({"tokenUsage":{"total":{"totalTokens":180}}}),
        )
        .await
        .unwrap();
        let rows = sqlx::query("SELECT agent_id,SUM(tokens) AS tokens FROM agent_usage_buckets GROUP BY agent_id ORDER BY agent_id")
            .fetch_all(&db.pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get::<String, _>("agent_id"), "pock");
        assert_eq!(rows[0].get::<i64, _>("tokens"), 180);
        assert_eq!(rows[1].get::<i64, _>("tokens"), 40);
    }
}
