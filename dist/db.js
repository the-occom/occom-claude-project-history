import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "crypto";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
const DB_DIR = join(homedir(), ".cph");
const DB_PATH = join(DB_DIR, "db");
export const SCHEMA_VERSION = 6;
let _db = null;
export async function getDb() {
    if (_db)
        return _db;
    // Ensure directory exists
    mkdirSync(DB_DIR, { recursive: true });
    _db = new PGlite(DB_PATH);
    await migrate(_db);
    return _db;
}
async function migrate(db) {
    // Run migrations idempotently — safe to call on every startup
    await db.exec(`
    -- ── Workflows ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS workflows (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT,
      status              TEXT NOT NULL DEFAULT 'active',
      git_branch_pattern  TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── Tasks ──────────────────────────────────────────────────────────────────
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

    -- ── Blockers ───────────────────────────────────────────────────────────────
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

    -- ── Decisions ──────────────────────────────────────────────────────────────
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

    -- ── Engineer preferences ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS engineer_preferences (
      id               TEXT PRIMARY KEY,
      engineer_id      TEXT NOT NULL UNIQUE,
      retrieval_depth  TEXT NOT NULL DEFAULT 'standard',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── Indexes ────────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_tasks_workflow        ON tasks(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status          ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_workflow_status ON tasks(workflow_id, status);
    CREATE INDEX IF NOT EXISTS idx_blockers_workflow     ON blockers(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_blockers_status       ON blockers(status);
    CREATE INDEX IF NOT EXISTS idx_decisions_workflow    ON decisions(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_tags        ON decisions(tags);
    CREATE INDEX IF NOT EXISTS idx_decisions_commit      ON decisions(commit_hash);
  `);
    // v0.3.0 — add updated_at to blockers, notification triggers
    await db.exec(`
    ALTER TABLE blockers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    CREATE OR REPLACE FUNCTION cph_notify_change() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('cph_changes', json_build_object(
        'table', TG_TABLE_NAME,
        'op', TG_OP,
        'id', COALESCE(NEW.id, OLD.id),
        'workflow_id', COALESCE(NEW.workflow_id, OLD.workflow_id, 'unknown')
      )::text);
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION cph_notify_workflow_change() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('cph_changes', json_build_object(
        'table', TG_TABLE_NAME,
        'op', TG_OP,
        'id', COALESCE(NEW.id, OLD.id),
        'workflow_id', COALESCE(NEW.id, OLD.id)
      )::text);
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_tasks_changes ON tasks;
    CREATE TRIGGER trg_tasks_changes
      AFTER INSERT OR UPDATE OR DELETE ON tasks
      FOR EACH ROW EXECUTE FUNCTION cph_notify_change();

    DROP TRIGGER IF EXISTS trg_blockers_changes ON blockers;
    CREATE TRIGGER trg_blockers_changes
      AFTER INSERT OR UPDATE OR DELETE ON blockers
      FOR EACH ROW EXECUTE FUNCTION cph_notify_change();

    DROP TRIGGER IF EXISTS trg_decisions_changes ON decisions;
    CREATE TRIGGER trg_decisions_changes
      AFTER INSERT OR UPDATE OR DELETE ON decisions
      FOR EACH ROW EXECUTE FUNCTION cph_notify_change();

    DROP TRIGGER IF EXISTS trg_workflows_changes ON workflows;
    CREATE TRIGGER trg_workflows_changes
      AFTER INSERT OR UPDATE OR DELETE ON workflows
      FOR EACH ROW EXECUTE FUNCTION cph_notify_workflow_change();
  `);
    // v0.4.0 — observability tables
    await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      workflow_id  TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      model        TEXT,
      agent_type   TEXT,
      source       TEXT,
      started_at   TIMESTAMPTZ,
      ended_at     TIMESTAMPTZ,
      exit_reason  TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      id           TEXT PRIMARY KEY,
      session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      workflow_id  TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      phase        TEXT NOT NULL,
      tool_name    TEXT NOT NULL,
      file_path    TEXT,
      command      TEXT,
      duration_ms  INTEGER,
      exit_code    INTEGER,
      error_type   TEXT,
      interrupted  BOOLEAN,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tool_events_session    ON tool_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_events_workflow   ON tool_events(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_tool_events_tool       ON tool_events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_events_created_at ON tool_events(created_at);

    CREATE TABLE IF NOT EXISTS subagents (
      id             TEXT PRIMARY KEY,
      session_id     TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      workflow_id    TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      agent_type     TEXT,
      prompt_len     INTEGER,
      files_created  TEXT DEFAULT '[]',
      files_edited   TEXT DEFAULT '[]',
      files_deleted  TEXT DEFAULT '[]',
      started_at     TIMESTAMPTZ,
      ended_at       TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS compaction_events (
      id          TEXT PRIMARY KEY,
      session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      trigger     TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS from_plan BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

    ALTER TABLE workflows ADD COLUMN IF NOT EXISTS last_planning_started_at TIMESTAMPTZ;
  `);
    // v0.5.0 — thinking time inference tables
    await db.exec(`
    ALTER TABLE tool_events ADD COLUMN IF NOT EXISTS pre_timestamp  TIMESTAMPTZ;
    ALTER TABLE tool_events ADD COLUMN IF NOT EXISTS post_timestamp TIMESTAMPTZ;
    ALTER TABLE tool_events ADD COLUMN IF NOT EXISTS execution_ms   INTEGER;
    ALTER TABLE tool_events ADD COLUMN IF NOT EXISTS gap_after_ms   INTEGER;

    CREATE TABLE IF NOT EXISTS thinking_estimates (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      workflow_id       TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      turn_number       INTEGER NOT NULL,
      initial_gap_ms    INTEGER,
      interleaved_ms    INTEGER NOT NULL DEFAULT 0,
      total_tool_ms     INTEGER NOT NULL DEFAULT 0,
      total_wall_ms     INTEGER NOT NULL DEFAULT 0,
      gap_count         INTEGER NOT NULL DEFAULT 0,
      prompt_timestamp  TIMESTAMPTZ NOT NULL,
      stop_timestamp    TIMESTAMPTZ NOT NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_thinking_session  ON thinking_estimates(session_id);
    CREATE INDEX IF NOT EXISTS idx_thinking_workflow ON thinking_estimates(workflow_id);

    CREATE TABLE IF NOT EXISTS tool_baselines (
      tool_name     TEXT PRIMARY KEY,
      avg_ms        INTEGER NOT NULL DEFAULT 0,
      p50_ms        INTEGER NOT NULL DEFAULT 0,
      p95_ms        INTEGER NOT NULL DEFAULT 0,
      sample_count  INTEGER NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Seed baselines for common tools
    INSERT INTO tool_baselines (tool_name, avg_ms, p50_ms, p95_ms, sample_count)
    VALUES
      ('Read',      50,  30,  150,  0),
      ('Write',    100,  60,  300,  0),
      ('Edit',      80,  50,  250,  0),
      ('Glob',      40,  25,  120,  0),
      ('Grep',      60,  35,  200,  0),
      ('Bash',     500, 200, 3000,  0),
      ('Agent',   5000,3000,15000,  0),
      ('TodoWrite', 30,  20,   80,  0),
      ('MultiEdit',100,  60,  350,  0),
      ('WebSearch',800, 500, 3000,  0)
    ON CONFLICT (tool_name) DO NOTHING;
  `);
    // v0.6.0 — identity, coordination, decision graph
    await db.exec(`
    -- ── Developers ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS developers (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      session_count   INTEGER NOT NULL DEFAULT 0,
      preferences     JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── Agents ────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      developer_id     TEXT REFERENCES developers(id) ON DELETE SET NULL,
      parent_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
      agent_type       TEXT NOT NULL DEFAULT 'main',
      model            TEXT,
      spawned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at         TIMESTAMPTZ,
      tool_call_count  INTEGER NOT NULL DEFAULT 0,
      task_count       INTEGER NOT NULL DEFAULT 0,
      decision_count   INTEGER NOT NULL DEFAULT 0,
      files_written    JSONB DEFAULT '[]',
      files_read       JSONB DEFAULT '[]',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agents_session     ON agents(session_id);
    CREATE INDEX IF NOT EXISTS idx_agents_developer   ON agents(developer_id);
    CREATE INDEX IF NOT EXISTS idx_agents_type        ON agents(agent_type);

    -- ── File Areas ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS file_areas (
      id               TEXT PRIMARY KEY,
      workflow_id      TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      path_pattern     TEXT NOT NULL,
      responsibility   TEXT,
      depends_on       JSONB DEFAULT '[]',
      depended_on_by   JSONB DEFAULT '[]',
      last_indexed_at  TIMESTAMPTZ,
      indexed_by       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_file_areas_workflow ON file_areas(workflow_id);

    -- ── Activity Stream ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS activity_stream (
      id             TEXT PRIMARY KEY,
      developer_id   TEXT REFERENCES developers(id) ON DELETE SET NULL,
      agent_id       TEXT,
      session_id     TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      workflow_id    TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      event_type     TEXT NOT NULL,
      subject_type   TEXT,
      subject_id     TEXT,
      subject_title  TEXT,
      detail         JSONB,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_activity_stream_workflow   ON activity_stream(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_activity_stream_developer  ON activity_stream(developer_id);
    CREATE INDEX IF NOT EXISTS idx_activity_stream_session    ON activity_stream(session_id);
    CREATE INDEX IF NOT EXISTS idx_activity_stream_type       ON activity_stream(event_type);
    CREATE INDEX IF NOT EXISTS idx_activity_stream_created_at ON activity_stream(created_at);
    -- Retention: prune events older than 30 days on daemon start

    -- ── ALTER existing tables ─────────────────────────────────────────────────
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS developer_id TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;

    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_id TEXT;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS developer_id TEXT;

    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS agent_id TEXT;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS developer_id TEXT;

    ALTER TABLE tool_events ADD COLUMN IF NOT EXISTS agent_id TEXT;

    ALTER TABLE blockers ADD COLUMN IF NOT EXISTS agent_id TEXT;
    ALTER TABLE blockers ADD COLUMN IF NOT EXISTS developer_id TEXT;

    -- ── Decision enrichment ───────────────────────────────────────────────────
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS forcing_constraint TEXT;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS unlocks TEXT;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS constrains TEXT;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS revisit_if TEXT;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS blocker_id TEXT;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS files_affected JSONB DEFAULT '[]';
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS reversibility TEXT DEFAULT 'reversible';
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT 'medium';
  `);
    // Rename alternatives_considered → alternatives_considered_legacy (conditional)
    await db.exec(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'decisions'
          AND column_name = 'alternatives_considered'
          AND data_type = 'text'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'decisions'
          AND column_name = 'alternatives_considered_legacy'
      ) THEN
        ALTER TABLE decisions RENAME COLUMN alternatives_considered TO alternatives_considered_legacy;
        ALTER TABLE decisions ADD COLUMN alternatives_considered JSONB DEFAULT '[]';
      END IF;
    END $$;
  `);
    // Ensure both columns exist (idempotent for fresh installs)
    await db.exec(`
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS alternatives_considered_legacy TEXT;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS alternatives_considered JSONB DEFAULT '[]';
  `);
}
export function newId() {
    return randomUUID();
}
export class ConflictError extends Error {
    table;
    recordId;
    constructor(table, id) {
        super(`Conflict: ${table} ${id} was modified by another session. REQUIRED: Call cph_context_sync to get current state, then retry.`);
        this.name = "ConflictError";
        this.table = table;
        this.recordId = id;
    }
}
export async function withTransaction(fn) {
    const db = await getDb();
    return db.transaction(fn);
}
// ── Query helpers ─────────────────────────────────────────────────────────────
export async function findOne(db, query, params) {
    const result = await db.query(query, params);
    return result.rows[0] ?? null;
}
export async function exists(db, table, id) {
    const result = await db.query(`SELECT COUNT(*) as count FROM ${table} WHERE id = $1`, [id]);
    return parseInt(result.rows[0]?.count ?? "0") > 0;
}
export function buildWhereClause(conditions) {
    const active = conditions.filter((c) => c !== null);
    if (!active.length)
        return { clause: "", values: [] };
    const values = [];
    const parts = active.map((c, i) => {
        values.push(c.value);
        return `${c.field} = $${i + 1}`;
    });
    return { clause: `WHERE ${parts.join(" AND ")}`, values };
}
export const PRIORITY_ORDER = `
  CASE priority
    WHEN 'critical' THEN 0
    WHEN 'high'     THEN 1
    WHEN 'medium'   THEN 2
    WHEN 'low'      THEN 3
  END
`;
//# sourceMappingURL=db.js.map