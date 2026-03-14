import type { PGlite } from "@electric-sql/pglite";
/**
 * Emit an activity event into the activity_stream table.
 */
export declare function emitActivity(event: {
    developer_id?: string | null;
    agent_id?: string | null;
    session_id?: string | null;
    workflow_id?: string | null;
    event_type: string;
    subject_type?: string | null;
    subject_id?: string | null;
    subject_title?: string | null;
    detail?: Record<string, unknown> | null;
}, db: PGlite): Promise<void>;
/**
 * Prune activity events older than 30 days. Called on daemon start.
 */
export declare function pruneActivityStream(db: PGlite): Promise<number>;
//# sourceMappingURL=activity.d.ts.map