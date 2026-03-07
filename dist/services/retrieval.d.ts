import type { PGlite } from "@electric-sql/pglite";
import type { SessionContext, Task, Blocker, Decision, RetrievalDepth, TeammateActivity } from "../types.js";
import type { GitContext } from "../types.js";
/**
 * Build the session context for a given workflow and engineer.
 *
 * Token budget by depth:
 *   minimal  → ~300 tokens  (active tasks + open blockers only)
 *   standard → ~600 tokens  (+ recent relevant decisions)
 *   deep     → ~1200 tokens (+ teammate activity + historical patterns)
 *
 * Never returns full record content — summaries only.
 * Full records are pull-on-demand via individual get tools.
 */
export declare function buildSessionContext(db: PGlite, workflowId: string, depth: RetrievalDepth, gitContext: GitContext, engineerId: string | null): Promise<SessionContext>;
export declare function getActiveTasks(db: PGlite, workflowId: string): Promise<Pick<Task, "id" | "title" | "priority" | "status">[]>;
export declare function getOpenBlockers(db: PGlite, workflowId: string): Promise<Pick<Blocker, "id" | "title" | "blocker_type">[]>;
/**
 * Retrieve decisions relevant to the files Claude Code is currently touching.
 * Matches on tags and title keywords extracted from file paths.
 * No semantic search — purely structural matching on file path tokens.
 */
export declare function getRelevantDecisions(db: PGlite, workflowId: string, recentFiles: string[], limit: number): Promise<Pick<Decision, "id" | "title" | "decision">[]>;
export declare function buildSessionHint(activeTasks: Pick<Task, "id" | "title" | "priority" | "status">[], openBlockers: Pick<Blocker, "id" | "title" | "blocker_type">[], teammates: TeammateActivity[]): string;
export declare function extractFileTokens(files: string[]): string[];
export declare const NOISE_TOKENS: Set<string>;
//# sourceMappingURL=retrieval.d.ts.map