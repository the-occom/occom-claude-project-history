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
export async function runCompression(db) {
    const [decisions, tasks, blockers] = await Promise.all([
        compressDecisions(db),
        compressTasks(db),
        compressBlockers(db),
    ]);
    if (decisions + tasks + blockers > 0) {
        console.error(`[cph] Compressed ${decisions} decisions, ${tasks} tasks, ${blockers} blockers`);
    }
    return { decisions, tasks, blockers };
}
async function compressDecisions(db) {
    const result = await db.query(`WITH compressed AS (
       UPDATE decisions
       SET
         rationale               = NULL,
         alternatives_considered = NULL,
         trade_offs              = NULL,
         context                 = SUBSTRING(context FROM 1 FOR 200),
         compressed              = TRUE,
         updated_at              = NOW()
       WHERE
         compressed = FALSE
         AND created_at < NOW() - INTERVAL '30 days'
       RETURNING id
     )
     SELECT COUNT(*) as count FROM compressed`);
    return parseInt(result.rows[0]?.count ?? "0");
}
async function compressTasks(db) {
    const result = await db.query(`WITH compressed AS (
       UPDATE tasks
       SET
         description      = NULL,
         completion_notes = NULL,
         compressed       = TRUE,
         updated_at       = NOW()
       WHERE
         compressed = FALSE
         AND status IN ('completed', 'cancelled')
         AND updated_at < NOW() - INTERVAL '7 days'
       RETURNING id
     )
     SELECT COUNT(*) as count FROM compressed`);
    return parseInt(result.rows[0]?.count ?? "0");
}
async function compressBlockers(db) {
    const result = await db.query(`WITH compressed AS (
       UPDATE blockers
       SET description = NULL
       WHERE
         status = 'resolved'
         AND resolved_at < NOW() - INTERVAL '7 days'
         AND description IS NOT NULL
       RETURNING id
     )
     SELECT COUNT(*) as count FROM compressed`);
    return parseInt(result.rows[0]?.count ?? "0");
}
/**
 * Get a storage summary — useful for the dashboard and for triggering
 * the "consider upgrading to hosted" suggestion.
 */
export async function getStorageSummary(db) {
    const [workflows, tasks, blockers, decisions] = await Promise.all([
        db.query(`SELECT COUNT(*) as count FROM workflows`),
        db.query(`SELECT COUNT(*) as count FROM tasks`),
        db.query(`SELECT COUNT(*) as count FROM blockers`),
        db.query(`SELECT COUNT(*) as count FROM decisions`),
    ]);
    return {
        workflows: parseInt(workflows.rows[0]?.count ?? "0"),
        tasks: parseInt(tasks.rows[0]?.count ?? "0"),
        blockers: parseInt(blockers.rows[0]?.count ?? "0"),
        decisions: parseInt(decisions.rows[0]?.count ?? "0"),
    };
}
//# sourceMappingURL=compressor.js.map