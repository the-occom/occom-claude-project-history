import { z } from "zod";
import { getDb } from "../db.js";
export function registerReconstructTools(server) {
    server.registerTool("cph_workflow_reconstruct", {
        title: "Reconstruct Workflow History",
        description: `Reconstruct the full history of a workflow for handoff or review.

Aggregates tasks, decisions, blockers, sessions, and activity into a
comprehensive reconstruction object. Identifies dead ends (cancelled tasks
and resolved blockers) to show the journey, not just the destination.

Use this when:
  - Handing off a workflow to another developer
  - Reviewing what happened during a project
  - Debugging why certain decisions were made`,
        inputSchema: {
            workflow_id: z.string().uuid()
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workflow_id }) => {
        try {
            const db = await getDb();
            const [workflow, tasks, decisions, blockers, sessions, activity] = await Promise.all([
                db.query(`SELECT id, name, status, created_at, updated_at FROM workflows WHERE id = $1`, [workflow_id]),
                db.query(`SELECT id, title, status, priority, estimated_minutes, actual_minutes,
                    started_at, completed_at, completion_notes, parent_task_id
             FROM tasks WHERE workflow_id = $1
             ORDER BY created_at ASC`, [workflow_id]),
                db.query(`SELECT id, title, decision, rationale, alternatives_considered,
                    reversibility, confidence, tags, files_affected, created_at
             FROM decisions WHERE workflow_id = $1
             ORDER BY created_at ASC`, [workflow_id]),
                db.query(`SELECT id, title, blocker_type, status, resolution,
                    opened_at, resolved_at, resolution_minutes
             FROM blockers WHERE workflow_id = $1
             ORDER BY opened_at ASC`, [workflow_id]),
                db.query(`SELECT s.id, s.started_at, s.ended_at, s.exit_reason,
                    d.name AS developer_name, d.id AS developer_id
             FROM sessions s
             LEFT JOIN developers d ON d.id = s.developer_id
             WHERE s.workflow_id = $1
             ORDER BY s.started_at ASC`, [workflow_id]),
                db.query(`SELECT a.event_type, a.subject_type, a.subject_title, a.created_at,
                    d.name AS developer_name
             FROM activity_stream a
             LEFT JOIN developers d ON d.id = a.developer_id
             WHERE a.workflow_id = $1
             ORDER BY a.created_at DESC LIMIT 50`, [workflow_id]),
            ]);
            if (!workflow.rows[0]) {
                return { content: [{ type: "text", text: `Error: Workflow ${workflow_id} not found` }], isError: true };
            }
            const allTasks = tasks.rows;
            const cancelledTasks = allTasks.filter((t) => t.status === "cancelled");
            const resolvedBlockers = blockers.rows.filter((b) => b.status === "resolved");
            const deadEnds = [
                ...cancelledTasks.map((t) => ({
                    type: "cancelled_task",
                    id: t.id,
                    title: t.title,
                    reason: t.completion_notes,
                })),
                ...resolvedBlockers.map((b) => ({
                    type: "resolved_blocker",
                    id: b.id,
                    title: b.title,
                    resolution: b.resolution,
                    minutes_blocked: b.resolution_minutes,
                })),
            ];
            // Unique developers
            const devMap = new Map();
            for (const s of sessions.rows) {
                if (s.developer_id)
                    devMap.set(s.developer_id, s.developer_name);
            }
            const developers = Array.from(devMap.entries()).map(([id, name]) => ({ id, name }));
            // Date range
            const allDates = [
                ...(allTasks.map((t) => t.started_at).filter(Boolean)),
                ...(sessions.rows.map((s) => s.started_at).filter(Boolean)),
            ];
            const dateRange = allDates.length > 0
                ? { start: allDates[0], end: allDates[allDates.length - 1] }
                : null;
            const taskStats = {
                total: allTasks.length,
                completed: allTasks.filter((t) => t.status === "completed").length,
                cancelled: cancelledTasks.length,
                in_progress: allTasks.filter((t) => t.status === "in_progress").length,
                pending: allTasks.filter((t) => t.status === "pending").length,
                blocked: allTasks.filter((t) => t.status === "blocked").length,
            };
            const reconstruction = {
                workflow: workflow.rows[0],
                date_range: dateRange,
                developers,
                task_stats: taskStats,
                tasks: allTasks,
                decisions: decisions.rows,
                dead_ends: deadEnds,
                blockers: blockers.rows,
                sessions: sessions.rows,
                recent_activity: activity.rows,
            };
            return { content: [{ type: "text", text: JSON.stringify(reconstruction, null, 2) }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
}
//# sourceMappingURL=reconstruct.js.map