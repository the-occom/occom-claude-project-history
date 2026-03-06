import type { PGlite } from "@electric-sql/pglite";
/**
 * Background compression — run at session end or on a timer.
 *
 * Compression rules:
 *   - Decisions older than 30 days: nullify rationale, alternatives, trade_offs
 *     (title + decision line preserved forever)
 *   - Completed tasks older than 7 days: nullify description, completion_notes
 *     (title, status, timing data preserved forever)
 *   - Resolved blockers older than 7 days: nullify description
 *     (title, type, resolution, timing preserved forever)
 *
 * Full records are always retrievable by ID until this runs.
 * After compression, only the structural shape remains — which is all the
 * ML layer needs and all the retrieval surface needs.
 */
export declare function runCompression(db: PGlite): Promise<CompressionResult>;
export interface CompressionResult {
    decisions: number;
    tasks: number;
    blockers: number;
}
/**
 * Get a storage summary — useful for the dashboard and for triggering
 * the "consider upgrading to hosted" suggestion.
 */
export declare function getStorageSummary(db: PGlite): Promise<StorageSummary>;
export interface StorageSummary {
    workflows: number;
    tasks: number;
    blockers: number;
    decisions: number;
}
//# sourceMappingURL=compressor.d.ts.map