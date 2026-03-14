import type { PGlite } from "@electric-sql/pglite";
import type { DeveloperIdentity } from "./types.js";
/**
 * Resolve developer identity from git config, CI env, or hostname fallback.
 */
export declare function resolveIdentity(cwd?: string): DeveloperIdentity;
/**
 * Upsert developer row — INSERT ON CONFLICT UPDATE last_seen_at and session_count.
 */
export declare function upsertDeveloper(identity: DeveloperIdentity, db: PGlite): Promise<void>;
//# sourceMappingURL=identity.d.ts.map