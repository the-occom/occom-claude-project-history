#!/usr/bin/env node
/**
 * FlowMind PreToolUse Hook — enforce-task.js
 *
 * Fires before every Write, Edit, or MultiEdit tool call in Claude Code.
 * Reads stdin for the hook payload, checks PGlite for an active task,
 * and exits non-zero to BLOCK the tool call if none exists.
 *
 * Claude Code hook contract:
 *   - exit 0 = allow the tool call
 *   - exit 2 = block the tool call (non-destructive)
 *   - stdout = message shown to Claude Code
 *
 * Setup: .claude/settings.json PreToolUse hook on Write|Edit|MultiEdit
 */

import { PGlite } from "@electric-sql/pglite";
import { join } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";

const DB_PATH = join(homedir(), ".flowmind", "db");
const WORKFLOW_ID_FILE = join(process.cwd(), ".flowmind-workflow");

async function main() {
  // Read hook payload from stdin
  let payload = {};
  try {
    const raw = readFileSync("/dev/stdin", "utf8");
    payload = JSON.parse(raw);
  } catch {
    // No payload or parse error — allow through
    process.exit(0);
  }

  // Only enforce on file-writing tools
  const toolName = (payload as Record<string, string>).tool_name ?? "";
  if (!["Write", "Edit", "MultiEdit"].includes(toolName)) {
    process.exit(0);
  }

  // Resolve workflow ID — from .flowmind-workflow file or env
  let workflowId: string | null = null;
  try {
    workflowId = readFileSync(WORKFLOW_ID_FILE, "utf8").trim();
  } catch {
    // File doesn't exist — can't enforce without knowing the workflow
    process.exit(0);
  }

  if (!workflowId) process.exit(0);

  // Check for active task in PGlite
  let db: PGlite | null = null;
  try {
    db = new PGlite(DB_PATH);

    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM tasks
       WHERE workflow_id = $1
         AND status = 'in_progress'`,
      [workflowId]
    );

    const activeCount = parseInt(result.rows[0]?.count ?? "0");

    if (activeCount === 0) {
      // Block the write
      console.log(
        "FlowMind: No active task. Call flowmind_task_create then flowmind_task_start before writing files."
      );
      process.exit(2);
    }

    // Allow
    process.exit(0);
  } catch {
    // DB not accessible — don't block, fail open
    process.exit(0);
  } finally {
    // PGlite doesn't have a close method in all versions — just let it GC
  }
}

main().catch(() => process.exit(0)); // Always fail open on error
