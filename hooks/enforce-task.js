#!/usr/bin/env node
/**
 * Claude Project History PreToolUse Hook — enforce-task.js
 *
 * Fires before every Write, Edit, or MultiEdit tool call in Claude Code.
 * Reads stdin for the hook payload, checks the daemon for an active task,
 * and exits non-zero to BLOCK the tool call if none exists.
 *
 * Claude Code hook contract:
 *   - exit 0 = allow the tool call
 *   - exit 2 = block the tool call (non-destructive)
 *   - stdout = message shown to Claude Code
 *
 * Setup: .claude/settings.json PreToolUse hook on Write|Edit|MultiEdit
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_SCRIPT = join(__dirname, "..", "scripts", "daemon.js");
const WORKFLOW_ID_FILE = join(process.cwd(), ".cph-workflow");

function ensureDaemon() {
  try {
    execFileSync(process.execPath, [DAEMON_SCRIPT, "ensure"], {
      stdio: "ignore", timeout: 10_000,
    });
  } catch {}
}

async function main() {
  // Read hook payload from stdin
  let payload = {};
  try {
    const raw = readFileSync("/dev/stdin", "utf8");
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Only enforce on file-writing tools
  const toolName = payload.tool_name ?? "";
  if (!["Write", "Edit", "MultiEdit"].includes(toolName)) {
    process.exit(0);
  }

  // Resolve workflow ID
  let workflowId = null;
  try {
    workflowId = readFileSync(WORKFLOW_ID_FILE, "utf8").trim();
  } catch {
    process.exit(0);
  }

  if (!workflowId) process.exit(0);

  // Read daemon port
  let daemonPort;
  try {
    daemonPort = readFileSync(join(homedir(), ".cph", "daemon.port"), "utf8").trim();
  } catch {
    process.exit(0); // No daemon — fail open
  }

  // Ensure daemon is running before checking
  ensureDaemon();

  // Check active tasks via daemon
  try {
    const res = await fetch(
      `http://localhost:${daemonPort}/hooks/active-tasks?workflow_id=${encodeURIComponent(workflowId)}`,
      { signal: AbortSignal.timeout(2000) }
    );
    if (!res.ok) process.exit(0);
    const data = await res.json();

    if (data.count === 0) {
      console.log(
        "[cph] No active task.\n" +
        "You have context from cph in your conversation.\n" +
        "Call cph_task_start to begin a task, or cph_task_create if none exist.\n" +
        "Check the [cph] lines at the top of your context for current state."
      );
      process.exit(2);
    }

    process.exit(0);
  } catch {
    // Daemon unreachable — fail open
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
