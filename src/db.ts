import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "crypto";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

const DB_DIR = join(homedir(), ".cph");
const DB_PATH = join(DB_DIR, "db");

let _db: PGlite | null = null;

export async function getDb(): Promise<PGlite> {
  if (_db) return _db;

  // Ensure directory exists
  mkdirSync(DB_DIR, { recursive: true });

  _db = new PGlite(DB_PATH);
  await migrate(_db);
  return _db;
}

async function migrate(db: PGlite): Promise<void> {
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
}

export function newId(): string {
  return randomUUID();
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export async function findOne<T>(
  db: PGlite,
  query: string,
  params: unknown[]
): Promise<T | null> {
  const result = await db.query<T>(query, params);
  return result.rows[0] ?? null;
}

export async function exists(
  db: PGlite,
  table: string,
  id: string
): Promise<boolean> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${table} WHERE id = $1`,
    [id]
  );
  return parseInt(result.rows[0]?.count ?? "0") > 0;
}

export function buildWhereClause(
  conditions: Array<{ field: string; value: unknown } | null>
): { clause: string; values: unknown[] } {
  const active = conditions.filter(
    (c): c is { field: string; value: unknown } => c !== null
  );
  if (!active.length) return { clause: "", values: [] };

  const values: unknown[] = [];
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
