#!/usr/bin/env node
/**
 * Claude Project History Post-Commit Git Hook — post-commit.js
 *
 * Fires after every git commit.
 * Attaches the commit hash and diff stat (structural only, no content)
 * to any decisions recorded in the last 30 minutes.
 *
 * This is the training data linkage — decision → code change — that
 * makes our dataset unique. Runs silently, never blocks the commit.
 *
 * Install: ln -sf /path/to/hooks/post-commit.js .git/hooks/post-commit
 * Or run: npm run install-hooks (handled by scripts/install.js)
 */

import { execSync, execFileSync } from "child_process";
import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
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

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

async function main() {
  let workflowId = null;
  try {
    workflowId = readFileSync(WORKFLOW_ID_FILE, "utf8").trim();
  } catch {
    process.exit(0);
  }

  if (!workflowId) process.exit(0);

  const commitHash = safeExec("git rev-parse --short HEAD");
  const diffStat = safeExec("git diff HEAD~1 --stat --no-color 2>/dev/null | tail -1")
    || safeExec("git diff --stat --no-color 4b825dc642cb6eb9a060e54bf899d8e56a8ee28d HEAD 2>/dev/null | tail -1");

  if (!commitHash) process.exit(0);

  let daemonPort;
  try {
    daemonPort = readFileSync(join(homedir(), ".cph", "daemon.port"), "utf8").trim();
  } catch {
    process.exit(0);
  }

  // Ensure daemon is running before attaching commit
  ensureDaemon();

  try {
    await fetch(`http://localhost:${daemonPort}/hooks/attach-commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: workflowId, commit_hash: commitHash, diff_stat: diffStat }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Never block a commit
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
