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

import { PGlite } from "@electric-sql/pglite";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";

const DB_PATH = join(homedir(), ".cph", "db");
const WORKFLOW_ID_FILE = join(process.cwd(), ".cph-workflow");

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
    process.exit(0); // No workflow file — not a tracked project
  }

  if (!workflowId) process.exit(0);

  // Get structural metadata only — no diff content, no code
  const commitHash = safeExec("git rev-parse --short HEAD");
  const diffStat = safeExec("git diff HEAD~1 --stat --no-color 2>/dev/null | tail -1")
    || safeExec("git diff --stat --no-color 4b825dc642cb6eb9a060e54bf899d8e56a8ee28d HEAD 2>/dev/null | tail -1");

  if (!commitHash) process.exit(0);

  try {
    const db = new PGlite(DB_PATH);

    const result = await db.query(
      `WITH updated AS (
         UPDATE decisions
         SET
           commit_hash = $1,
           diff_stat   = $2,
           updated_at  = NOW()
         WHERE
           workflow_id  = $3
           AND commit_hash IS NULL
           AND created_at > NOW() - INTERVAL '30 minutes'
         RETURNING id
       )
       SELECT COUNT(*) as count FROM updated`,
      [commitHash, diffStat ?? null, workflowId]
    );

    const count = parseInt(result.rows[0]?.count ?? "0");
    if (count > 0) {
      // Silent success — don't clutter commit output
      // Uncomment to debug:
      // console.error(`[cph] Linked ${count} decision(s) to commit ${commitHash}`);
    }
  } catch {
    // Never block a commit
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
