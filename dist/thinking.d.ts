import type { PGlite } from "@electric-sql/pglite";
export declare function onUserPrompt(sessionId: string, timestamp: string): void;
export declare function onPreToolUse(sessionId: string, workflowId: string | null, data: Record<string, unknown>, timestamp: string, db: PGlite): Promise<void>;
export declare function onPostToolUse(sessionId: string, data: Record<string, unknown>, timestamp: string, db: PGlite): Promise<void>;
export declare function onPostToolUseFailure(sessionId: string, timestamp: string): void;
export declare function sealTurnThinking(sessionId: string, workflowId: string | null, timestamp: string, db: PGlite): Promise<void>;
//# sourceMappingURL=thinking.d.ts.map