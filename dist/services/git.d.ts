import type { GitContext } from "../types.js";
/**
 * Extract git context from the current working directory.
 * All calls are safe — returns nulls on failure, never throws.
 */
export declare function getGitContext(cwd?: string): GitContext;
/**
 * Infer a workflow name from the current git branch.
 * Converts branch names like "feature/auth-refactor" → "Auth Refactor"
 */
export declare function inferWorkflowNameFromBranch(branch: string): string;
/**
 * Check if a branch matches a workflow's git_branch_pattern.
 * Supports simple glob-style patterns: "auth/*", "feature/*"
 */
export declare function branchMatchesPattern(branch: string, pattern: string): boolean;
/**
 * Get the short hash of the last commit — used by post-commit hook.
 */
export declare function getLastCommitHash(cwd?: string): string | null;
/**
 * Get diff stat of the last commit — structural metadata only, no content.
 * e.g. "3 files changed, 45 insertions(+), 12 deletions(-)"
 */
export declare function getLastCommitDiffStat(cwd?: string): string | null;
//# sourceMappingURL=git.d.ts.map