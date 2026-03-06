import { execSync } from "child_process";
import type { GitContext } from "../types.js";

/**
 * Extract git context from the current working directory.
 * All calls are safe — returns nulls on failure, never throws.
 */
export function getGitContext(cwd?: string): GitContext {
  const opts = { cwd: cwd ?? process.cwd(), encoding: "utf8" as const };

  return {
    branch: safeExec("git rev-parse --abbrev-ref HEAD", opts),
    recent_files: getRecentFiles(opts),
    repo_root: safeExec("git rev-parse --show-toplevel", opts),
    engineer_id: safeExec("git config user.email", opts),
  };
}

/**
 * Get files touched in the last N commits on the current branch.
 * Used to surface relevant decisions without any semantic content.
 */
function getRecentFiles(opts: { cwd: string; encoding: "utf8" }): string[] {
  try {
    const output = execSync("git diff HEAD~5 --name-only 2>/dev/null || git diff --name-only", opts);
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, 20); // cap at 20 files
  } catch {
    return [];
  }
}

/**
 * Infer a workflow name from the current git branch.
 * Converts branch names like "feature/auth-refactor" → "Auth Refactor"
 */
export function inferWorkflowNameFromBranch(branch: string): string {
  return branch
    .replace(/^(feature|fix|chore|refactor|feat)\//, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Check if a branch matches a workflow's git_branch_pattern.
 * Supports simple glob-style patterns: "auth/*", "feature/*"
 */
export function branchMatchesPattern(
  branch: string,
  pattern: string
): boolean {
  if (!pattern) return false;
  // Simple glob: replace * with .* for regex
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(branch);
}

/**
 * Get the short hash of the last commit — used by post-commit hook.
 */
export function getLastCommitHash(cwd?: string): string | null {
  return safeExec("git rev-parse --short HEAD", {
    cwd: cwd ?? process.cwd(),
    encoding: "utf8",
  });
}

/**
 * Get diff stat of the last commit — structural metadata only, no content.
 * e.g. "3 files changed, 45 insertions(+), 12 deletions(-)"
 */
export function getLastCommitDiffStat(cwd?: string): string | null {
  return safeExec("git diff HEAD~1 --stat --no-color 2>/dev/null | tail -1", {
    cwd: cwd ?? process.cwd(),
    encoding: "utf8",
  });
}

function safeExec(
  cmd: string,
  opts: { cwd: string; encoding: "utf8" }
): string | null {
  try {
    return execSync(cmd, { ...opts, stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}
