import type { PGlite } from "@electric-sql/pglite";
export interface ChangeEvent {
    table: "tasks" | "blockers" | "decisions" | "workflows";
    op: "INSERT" | "UPDATE" | "DELETE";
    id: string;
    workflow_id: string;
}
type ChangeListener = (event: ChangeEvent) => void;
export declare class NotificationBus {
    private listeners;
    private unsub;
    start(db: PGlite): Promise<void>;
    addListener(sessionId: string, listener: ChangeListener): void;
    removeListener(sessionId: string): void;
    stop(): Promise<void>;
}
export declare const bus: NotificationBus;
export {};
//# sourceMappingURL=notify.d.ts.map