#!/usr/bin/env node
/**
 * PGlite Compatibility Test — scripts/test-db.js
 *
 * Tests all SQL constructs used by FlowMind against a temporary PGlite instance.
 * Run: node scripts/test-db.js
 */

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "crypto";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function main() {
  console.log("PGlite Compatibility Tests\n");

  // Use in-memory DB for isolation
  const db = new PGlite();

  // ── Migration ────────────────────────────────────────────────────────────────
  console.log("1. Running migration...");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT,
      status              TEXT NOT NULL DEFAULT 'active',
      git_branch_pattern  TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      workflow_id       TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      parent_task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      title             TEXT NOT NULL,
      description       TEXT,
      completion_notes  TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      priority          TEXT NOT NULL DEFAULT 'medium',
      estimated_minutes INTEGER,
      actual_minutes    INTEGER,
      started_at        TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      compressed        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS blockers (
      id                 TEXT PRIMARY KEY,
      task_id            TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      workflow_id        TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      title              TEXT NOT NULL,
      description        TEXT,
      blocker_type       TEXT NOT NULL DEFAULT 'other',
      status             TEXT NOT NULL DEFAULT 'open',
      resolution         TEXT,
      opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at        TIMESTAMPTZ,
      resolution_minutes INTEGER,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id                      TEXT PRIMARY KEY,
      workflow_id             TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      task_id                 TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      commit_hash             TEXT,
      diff_stat               TEXT,
      title                   TEXT NOT NULL,
      context                 TEXT,
      decision                TEXT NOT NULL,
      rationale               TEXT,
      alternatives_considered TEXT,
      trade_offs              TEXT,
      tags                    TEXT,
      compressed              BOOLEAN NOT NULL DEFAULT FALSE,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS engineer_preferences (
      id               TEXT PRIMARY KEY,
      engineer_id      TEXT NOT NULL UNIQUE,
      retrieval_depth  TEXT NOT NULL DEFAULT 'standard',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_workflow        ON tasks(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status          ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_workflow_status ON tasks(workflow_id, status);
    CREATE INDEX IF NOT EXISTS idx_blockers_workflow     ON blockers(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_blockers_status       ON blockers(status);
    CREATE INDEX IF NOT EXISTS idx_decisions_workflow    ON decisions(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_tags        ON decisions(tags);
    CREATE INDEX IF NOT EXISTS idx_decisions_commit      ON decisions(commit_hash);
  `);
  assert(true, "Migration runs without error");

  // ── Migration idempotency ──────────────────────────────────────────────────
  console.log("\n2. Re-running migration (idempotency)...");
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active', git_branch_pattern TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    assert(true, "Migration is idempotent");
  } catch (e) {
    assert(false, `Migration idempotency: ${e.message}`);
  }

  // ── Insert entities ────────────────────────────────────────────────────────
  console.log("\n3. Insert entities...");
  const wfId = randomUUID();
  const taskId = randomUUID();
  const blockerId = randomUUID();
  const decisionId = randomUUID();
  const prefId = randomUUID();

  await db.query(`INSERT INTO workflows (id, name, description, git_branch_pattern) VALUES ($1, $2, $3, $4)`,
    [wfId, "Test Workflow", "A test workflow", "feature/*"]);
  assert(true, "Insert workflow");

  await db.query(`INSERT INTO tasks (id, workflow_id, title, priority, estimated_minutes) VALUES ($1, $2, $3, $4, $5)`,
    [taskId, wfId, "Test Task", "high", 30]);
  assert(true, "Insert task");

  await db.query(`INSERT INTO blockers (id, task_id, workflow_id, title, blocker_type, description) VALUES ($1, $2, $3, $4, $5, $6)`,
    [blockerId, taskId, wfId, "Test Blocker", "technical", "Something is broken"]);
  assert(true, "Insert blocker");

  await db.query(`INSERT INTO decisions (id, workflow_id, task_id, title, decision, context, rationale, tags) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [decisionId, wfId, taskId, "Use PGlite", "We will use PGlite for local storage", "Need embedded DB", "No external dependencies", "database,architecture"]);
  assert(true, "Insert decision");

  await db.query(`INSERT INTO engineer_preferences (id, engineer_id, retrieval_depth) VALUES ($1, $2, $3)`,
    [prefId, "test@example.com", "deep"]);
  assert(true, "Insert preference");

  // ── Query them back ────────────────────────────────────────────────────────
  console.log("\n4. Query entities...");
  const wfResult = await db.query(`SELECT * FROM workflows WHERE id = $1`, [wfId]);
  assert(wfResult.rows.length === 1, "Query workflow");
  assert(wfResult.rows[0].name === "Test Workflow", "Workflow name correct");

  const taskResult = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  assert(taskResult.rows.length === 1, "Query task");
  assert(taskResult.rows[0].status === "pending", "Task default status is pending");

  // ── Risky SQL constructs ───────────────────────────────────────────────────
  console.log("\n5. Test risky SQL constructs...");

  // NOW() and TIMESTAMPTZ
  const nowResult = await db.query(`SELECT NOW() as now`);
  assert(nowResult.rows[0].now !== null, "NOW() works");

  // INTERVAL
  const intervalResult = await db.query(`SELECT NOW() - INTERVAL '30 days' as past`);
  assert(intervalResult.rows[0].past !== null, "INTERVAL '30 days' works");

  const interval7 = await db.query(`SELECT NOW() - INTERVAL '7 days' as past`);
  assert(interval7.rows[0].past !== null, "INTERVAL '7 days' works");

  const interval30m = await db.query(`SELECT NOW() - INTERVAL '30 minutes' as past`);
  assert(interval30m.rows[0].past !== null, "INTERVAL '30 minutes' works");

  // EXTRACT(EPOCH FROM ...)
  const extractResult = await db.query(`SELECT EXTRACT(EPOCH FROM (NOW() - NOW() + INTERVAL '60 seconds')) / 60 as minutes`);
  assert(Math.abs(parseFloat(extractResult.rows[0].minutes) - 1) < 0.01, "EXTRACT(EPOCH FROM ...) works");

  // ILIKE
  const ilikeResult = await db.query(`SELECT * FROM decisions WHERE title ILIKE $1`, ["%pglite%"]);
  assert(ilikeResult.rows.length === 1, "ILIKE works");

  // ON CONFLICT (upsert)
  await db.query(`INSERT INTO engineer_preferences (id, engineer_id, retrieval_depth) VALUES ($1, $2, $3) ON CONFLICT (engineer_id) DO UPDATE SET retrieval_depth = $3, updated_at = NOW()`,
    [randomUUID(), "test@example.com", "minimal"]);
  const prefResult = await db.query(`SELECT * FROM engineer_preferences WHERE engineer_id = $1`, ["test@example.com"]);
  assert(prefResult.rows[0].retrieval_depth === "minimal", "ON CONFLICT upsert works");

  // CTE with mutation (WITH updated AS (UPDATE ... RETURNING id) SELECT COUNT(*))
  const cteResult = await db.query(`
    WITH updated AS (
      UPDATE decisions
      SET rationale = NULL, compressed = TRUE, updated_at = NOW()
      WHERE id = $1
      RETURNING id
    )
    SELECT COUNT(*) as count FROM updated
  `, [decisionId]);
  assert(parseInt(cteResult.rows[0].count) === 1, "CTE with mutation works");

  // SUBSTRING(... FROM x FOR y) — our replacement for LEFT()
  const substringResult = await db.query(`SELECT SUBSTRING('Hello World' FROM 1 FOR 5) as sub`);
  assert(substringResult.rows[0].sub === "Hello", "SUBSTRING(FROM x FOR y) works");

  // || concatenation (our replacement for CONCAT)
  await db.query(`UPDATE blockers SET description = COALESCE(description, '') || ' [ESCALATED: test]' WHERE id = $1`, [blockerId]);
  const concatResult = await db.query(`SELECT description FROM blockers WHERE id = $1`, [blockerId]);
  assert(concatResult.rows[0].description.includes("[ESCALATED: test]"), "|| concatenation works");

  // COALESCE, NULLIF, ROUND
  const coalesceResult = await db.query(`SELECT COALESCE(NULL, 'fallback') as val`);
  assert(coalesceResult.rows[0].val === "fallback", "COALESCE works");

  const nullifResult = await db.query(`SELECT NULLIF(0, 0) as val`);
  assert(nullifResult.rows[0].val === null, "NULLIF works");

  const roundResult = await db.query(`SELECT ROUND(3.14159::numeric, 2) as val`);
  assert(parseFloat(roundResult.rows[0].val) === 3.14, "ROUND works (with ::numeric cast)");

  // CAST and ::text
  await db.query(`UPDATE tasks SET status = 'completed', actual_minutes = 25 WHERE id = $1`, [taskId]);
  const castResult = await db.query(`SELECT ROUND(AVG(CAST(actual_minutes AS float) / NULLIF(estimated_minutes, 0))::numeric, 2)::text as ratio FROM tasks WHERE workflow_id = $1 AND actual_minutes IS NOT NULL AND estimated_minutes IS NOT NULL AND estimated_minutes > 0`, [wfId]);
  assert(castResult.rows[0].ratio !== null, "CAST/::text/AVG works");
  assert(Math.abs(parseFloat(castResult.rows[0].ratio) - 0.83) < 0.01, "Estimation ratio correct (25/30 ≈ 0.83)");

  // CASE expression (PRIORITY_ORDER)
  const caseResult = await db.query(`SELECT CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END as ord FROM tasks WHERE id = $1`, [taskId]);
  assert(parseInt(caseResult.rows[0].ord) === 1, "CASE expression works (high = 1)");

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("All PGlite compatibility tests passed!");
  }
}

main().catch((err) => {
  console.error("Test script error:", err);
  process.exit(1);
});
