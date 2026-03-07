import type { RetrievalDepth, SessionContext } from "../types.js";
export interface ContextDelta {
    table: string;
    op: string;
    id: string;
    workflow_id: string;
    timestamp: string;
}
export declare function registerSession(sessionId: string): void;
export declare function unregisterSession(sessionId: string): void;
export interface SyncResult {
    context: SessionContext | null;
    deltas: ContextDelta[];
    synced_at: string;
}
export declare function contextSync(sessionId: string, workflowId: string, cwd?: string, depth?: RetrievalDepth, fullRefresh?: boolean): Promise<SyncResult>;
//# sourceMappingURL=context.d.ts.map