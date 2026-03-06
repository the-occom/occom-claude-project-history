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
export async function buildSessionContext(db, workflowId, depth, gitContext, engineerId) {
    const workflow = await getWorkflowSummary(db, workflowId);
    if (!workflow) {
        throw new Error(`Workflow ${workflowId} not found`);
    }
    const activeTasks = await getActiveTasks(db, workflowId);
    const openBlockers = await getOpenBlockers(db, workflowId);
    // Standard: add decisions relevant to currently-touched files
    const recentDecisions = depth === "minimal"
        ? []
        : await getRelevantDecisions(db, workflowId, gitContext.recent_files, depth === "deep" ? 8 : 5);
    // Deep: add teammate activity
    const teammateActivity = depth === "deep"
        ? await getTeammateActivity(db, workflowId, engineerId)
        : [];
    const hint = buildSessionHint(activeTasks, openBlockers, teammateActivity);
    return {
        workflow: { id: workflow.id, name: workflow.name, status: workflow.status },
        active_tasks: activeTasks,
        open_blockers: openBlockers,
        recent_decisions: recentDecisions,
        teammate_activity: teammateActivity,
        session_hint: hint,
        retrieval_depth: depth,
    };
}
// ── Private helpers ───────────────────────────────────────────────────────────
async function getWorkflowSummary(db, workflowId) {
    const result = await db.query(`SELECT * FROM workflows WHERE id = $1`, [workflowId]);
    return result.rows[0] ?? null;
}
async function getActiveTasks(db, workflowId) {
    const result = await db.query(`SELECT id, title, priority, status
     FROM tasks
     WHERE workflow_id = $1
       AND status IN ('in_progress', 'blocked')
     ORDER BY
       CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       updated_at DESC
     LIMIT 10`, [workflowId]);
    return result.rows;
}
async function getOpenBlockers(db, workflowId) {
    const result = await db.query(`SELECT id, title, blocker_type
     FROM blockers
     WHERE workflow_id = $1 AND status = 'open'
     ORDER BY opened_at ASC
     LIMIT 10`, [workflowId]);
    return result.rows;
}
/**
 * Retrieve decisions relevant to the files Claude Code is currently touching.
 * Matches on tags and title keywords extracted from file paths.
 * No semantic search — purely structural matching on file path tokens.
 */
async function getRelevantDecisions(db, workflowId, recentFiles, limit) {
    if (!recentFiles.length) {
        // Fall back to most recent decisions
        const result = await db.query(`SELECT id, title, decision
       FROM decisions
       WHERE workflow_id = $1
       ORDER BY created_at DESC
       LIMIT $2`, [workflowId, limit]);
        return result.rows;
    }
    // Extract meaningful tokens from file paths (strip extensions, path separators)
    const tokens = extractFileTokens(recentFiles);
    if (!tokens.length) {
        const result = await db.query(`SELECT id, title, decision FROM decisions WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT $2`, [workflowId, limit]);
        return result.rows;
    }
    // Build ILIKE conditions for each token across title and tags
    const conditions = tokens
        .slice(0, 5) // max 5 tokens to keep query sane
        .map((_, i) => `(title ILIKE $${i + 3} OR tags ILIKE $${i + 3} OR decision ILIKE $${i + 3})`)
        .join(" OR ");
    const values = [workflowId, limit, ...tokens.slice(0, 5).map((t) => `%${t}%`)];
    const result = await db.query(`SELECT id, title, decision
     FROM decisions
     WHERE workflow_id = $1 AND (${conditions})
     ORDER BY created_at DESC
     LIMIT $2`, values);
    // If relevance search returned nothing, fall back to recent
    if (!result.rows.length) {
        const fallback = await db.query(`SELECT id, title, decision FROM decisions WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT $2`, [workflowId, limit]);
        return fallback.rows;
    }
    return result.rows;
}
async function getTeammateActivity(db, workflowId, currentEngineerId) {
    // Tasks started by others in the last 8 hours
    // engineer_id isn't on tasks yet — this is a TODO for v2 multi-user
    // For now returns empty — the hook is ready when sync is added
    return [];
}
function buildSessionHint(activeTasks, openBlockers, teammates) {
    const parts = [];
    if (openBlockers.length) {
        parts.push(`${openBlockers.length} open blocker${openBlockers.length > 1 ? "s" : ""} need attention`);
    }
    const blocked = activeTasks.filter((t) => t.status === "blocked");
    if (blocked.length) {
        parts.push(`${blocked.length} task${blocked.length > 1 ? "s" : ""} currently blocked`);
    }
    const inProgress = activeTasks.filter((t) => t.status === "in_progress");
    if (inProgress.length) {
        parts.push(`${inProgress.length} task${inProgress.length > 1 ? "s" : ""} in progress`);
    }
    if (teammates.length) {
        parts.push(`${teammates.length} teammate${teammates.length > 1 ? "s" : ""} active in this workflow`);
    }
    if (!parts.length)
        return "No active work. Start a task to begin tracking.";
    return parts.join(". ") + ".";
}
function extractFileTokens(files) {
    const tokens = new Set();
    for (const file of files) {
        // Split on path separators and remove extensions
        const parts = file
            .split(/[/\\.]/)
            .map((p) => p.toLowerCase().trim())
            .filter((p) => p.length > 3 && !NOISE_TOKENS.has(p));
        for (const part of parts)
            tokens.add(part);
    }
    return Array.from(tokens);
}
const NOISE_TOKENS = new Set([
    "src", "lib", "dist", "node", "modules", "index", "test",
    "spec", "types", "utils", "helpers", "common", "shared",
    "ts", "js", "json", "md", "tsx", "jsx", "css", "scss",
]);
//# sourceMappingURL=retrieval.js.map