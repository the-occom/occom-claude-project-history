#!/usr/bin/env node
/**
 * Claude Project History Stop Hook — session-end.js
 *
 * Fires when Claude Code's agent turn ends.
 * If there are in-progress tasks and this is the first stop attempt,
 * blocks the stop and tells Claude to complete or cancel them.
 * If stop_hook_active is true (already continued once), allows the stop.
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

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString()));
    process.stdin.on("error", () => resolve(""));
    // If stdin is already ended (no pipe), resolve immediately
    if (process.stdin.readableEnded) resolve("");
  });
}

async function main() {
  // Allow force-stop to bypass all checks
  if (process.env.CPH_FORCE_STOP === "1") process.exit(0);

  // Read hook input from stdin (Claude Code pipes JSON context)
  let hookInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) hookInput = JSON.parse(raw);
  } catch {
    // No input or invalid JSON — continue with defaults
  }

  // If we already blocked once, let Claude stop to prevent infinite loops
  if (hookInput.stop_hook_active) {
    process.exit(0);
  }

  let workflowId = null;
  try {
    workflowId = readFileSync(WORKFLOW_ID_FILE, "utf8").trim();
  } catch {
    process.exit(0);
  }
  if (!workflowId) process.exit(0);

  let daemonPort;
  try {
    daemonPort = readFileSync(join(homedir(), ".cph", "daemon.port"), "utf8").trim();
  } catch {
    process.exit(0);
  }

  // Ensure daemon is running before checking
  ensureDaemon();

  let data;
  try {
    const res = await fetch(
      `http://localhost:${daemonPort}/hooks/session-summary?workflow_id=${encodeURIComponent(workflowId)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) process.exit(0);
    data = await res.json();
  } catch {
    process.exit(0);
  }

  // If there are in-progress tasks, block the stop and tell Claude to handle them
  if (data.in_progress?.length) {
    const taskList = data.in_progress
      .map((t) => `- "${t.title}" (${t.id})`)
      .join("\n");

    const reason = [
      `You have ${data.in_progress.length} task(s) still marked as in_progress:`,
      taskList,
      "",
      "For each task above:",
      "- If the work is done, call cph_task_complete with the task_id",
      "- If the work is NOT done and should continue next session, call cph_task_update with status='paused'",
      "- If the task should be dropped, call cph_task_cancel with the task_id",
      "",
      "Handle all tasks, then you may stop.",
    ].join("\n");

    // Output JSON to stdout — Claude Code reads this
    // Write and wait for flush before exiting (process.exit can truncate stdout)
    const output = JSON.stringify({ decision: "block", reason });
    await new Promise((resolve) => process.stdout.write(output + "\n", resolve));
    process.exit(0);
  }

  // Print informational summary to stderr for blocked/blocker items
  const lines = [];

  if (data.blocked?.length) {
    lines.push(`\n[CPH] ${data.blocked.length} blocked task(s):`);
    for (const t of data.blocked) {
      lines.push(`  ⚑ ${t.title}`);
    }
  }

  if (data.open_blockers?.length) {
    lines.push(`\n[CPH] ${data.open_blockers.length} open blocker(s):`);
    for (const b of data.open_blockers) {
      lines.push(`  ✗ [${b.blocker_type}] ${b.title}`);
    }
  }

  if (lines.length) {
    console.error(lines.join("\n"));
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
