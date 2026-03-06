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
export async function runCompression(db: PGlite): Promise<CompressionResult> {
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

async function compressDecisions(db: PGlite): Promise<number> {
  const result = await db.query<{ count: string }>(
    `WITH compressed AS (
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
     SELECT COUNT(*) as count FROM compressed`
  );
  return parseInt(result.rows[0]?.count ?? "0");
}

async function compressTasks(db: PGlite): Promise<number> {
  const result = await db.query<{ count: string }>(
    `WITH compressed AS (
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
     SELECT COUNT(*) as count FROM compressed`
  );
  return parseInt(result.rows[0]?.count ?? "0");
}

async function compressBlockers(db: PGlite): Promise<number> {
  const result = await db.query<{ count: string }>(
    `WITH compressed AS (
       UPDATE blockers
       SET description = NULL
       WHERE
         status = 'resolved'
         AND resolved_at < NOW() - INTERVAL '7 days'
         AND description IS NOT NULL
       RETURNING id
     )
     SELECT COUNT(*) as count FROM compressed`
  );
  return parseInt(result.rows[0]?.count ?? "0");
}

export interface CompressionResult {
  decisions: number;
  tasks: number;
  blockers: number;
}

/**
 * Get a storage summary — useful for the dashboard and for triggering
 * the "consider upgrading to hosted" suggestion.
 */
export async function getStorageSummary(db: PGlite): Promise<StorageSummary> {
  const [workflows, tasks, blockers, decisions] = await Promise.all([
    db.query<{ count: string }>(`SELECT COUNT(*) as count FROM workflows`),
    db.query<{ count: string }>(`SELECT COUNT(*) as count FROM tasks`),
    db.query<{ count: string }>(`SELECT COUNT(*) as count FROM blockers`),
    db.query<{ count: string }>(`SELECT COUNT(*) as count FROM decisions`),
  ]);

  return {
    workflows: parseInt(workflows.rows[0]?.count ?? "0"),
    tasks: parseInt(tasks.rows[0]?.count ?? "0"),
    blockers: parseInt(blockers.rows[0]?.count ?? "0"),
    decisions: parseInt(decisions.rows[0]?.count ?? "0"),
  };
}

export interface StorageSummary {
  workflows: number;
  tasks: number;
  blockers: number;
  decisions: number;
}
