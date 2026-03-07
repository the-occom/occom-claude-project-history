#!/usr/bin/env node
/**
 * Claude Project History Stop Hook — session-end.js
 *
 * Fires when Claude Code stops (session end).
 * Surfaces incomplete tasks and open blockers as a reminder.
 * Non-blocking — exit 0 always, just prints info.
 *
 * Setup: .claude/settings.json Stop hook
 */

import { PGlite } from "@electric-sql/pglite";
import { join } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";

const DB_PATH = join(homedir(), ".cph", "db");
const WORKFLOW_ID_FILE = join(process.cwd(), ".cph-workflow");

async function main() {
  let workflowId = null;
  try {
    workflowId = readFileSync(WORKFLOW_ID_FILE, "utf8").trim();
  } catch {
    process.exit(0);
  }

  if (!workflowId) process.exit(0);

  try {
    const db = new PGlite(DB_PATH);

    const [inProgress, blocked, openBlockers] = await Promise.all([
      db.query(
        `SELECT id, title FROM tasks WHERE workflow_id = $1 AND status = 'in_progress' ORDER BY updated_at DESC`,
        [workflowId]
      ),
      db.query(
        `SELECT id, title FROM tasks WHERE workflow_id = $1 AND status = 'blocked' ORDER BY updated_at DESC`,
        [workflowId]
      ),
      db.query(
        `SELECT id, title, blocker_type FROM blockers WHERE workflow_id = $1 AND status = 'open' ORDER BY opened_at ASC`,
        [workflowId]
      ),
    ]);

    const lines = [];

    if (inProgress.rows.length) {
      lines.push(`\n[Claude Project History] ${inProgress.rows.length} task(s) still in progress:`);
      for (const t of inProgress.rows) {
        lines.push(`  → ${t.title} (${t.id.slice(0, 8)})`);
      }
      lines.push(`  Call cph_task_complete to close them.`);
    }

    if (blocked.rows.length) {
      lines.push(`\n[Claude Project History] ${blocked.rows.length} blocked task(s):`);
      for (const t of blocked.rows) {
        lines.push(`  ⚑ ${t.title}`);
      }
    }

    if (openBlockers.rows.length) {
      lines.push(`\n[Claude Project History] ${openBlockers.rows.length} open blocker(s):`);
      for (const b of openBlockers.rows) {
        lines.push(`  ✗ [${b.blocker_type}] ${b.title}`);
      }
    }

    if (lines.length) {
      console.error(lines.join("\n"));
    }
  } catch {
    // Silently fail
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
