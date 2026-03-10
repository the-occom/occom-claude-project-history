#!/usr/bin/env node
/**
 * Claude Project History UserPromptSubmit Hook — context-inject.js
 *
 * Fires on every user prompt. Outputs plain text CPH state to stdout.
 * Claude receives this as injected context without needing to call any tool.
 *
 * Plain text only — never JSON (Bug #17550 workaround).
 * 1500ms hard timeout — silent on timeout.
 * On any error: exit 0 with no output (never block prompts).
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CPH_DIR = join(homedir(), ".cph");
const PORT_FILE = join(CPH_DIR, "daemon.port");

async function main() {
  // Read hook payload from stdin
  let payload = {};
  try {
    const raw = readFileSync("/dev/stdin", "utf8");
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Read workflow ID from cwd
  let workflowId = null;
  try {
    const cwd = payload.cwd || process.cwd();
    workflowId = readFileSync(join(cwd, ".cph-workflow"), "utf8").trim();
  } catch {
    process.exit(0);
  }

  if (!workflowId) process.exit(0);

  // Read daemon port
  let daemonPort;
  try {
    daemonPort = readFileSync(PORT_FILE, "utf8").trim();
  } catch {
    process.stdout.write(
      "[cph] Daemon not running. Run: npx cph daemon start\n"
    );
    process.exit(0);
  }

  // Fetch context from daemon
  const sessionId = payload.session_id || "";
  const url = `http://127.0.0.1:${daemonPort}/hooks/context-inject?workflow_id=${encodeURIComponent(workflowId)}&session_id=${encodeURIComponent(sessionId)}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const text = await res.text();
      if (text) process.stdout.write(text);
    }
  } catch {
    // Timeout or connection error — silent
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
