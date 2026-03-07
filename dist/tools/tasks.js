import { z } from "zod";
import { getDb, newId, findOne, PRIORITY_ORDER, withTransaction, ConflictError } from "../db.js";
export function registerTaskTools(server) {
    server.registerTool("cph_task_create", {
        title: "Create Task",
        description: `Create a task within a workflow.

Call this when beginning any discrete piece of work that will take more than ~5 minutes.
Create BEFORE starting work, not after.

Args:
  - workflow_id: Which workflow
  - title: What you're doing (e.g. "Implement JWT refresh token rotation")
  - description: Acceptance criteria and requirements (optional)
  - parent_task_id: If this is a subtask (optional)
  - priority: low | medium | high | critical
  - estimated_minutes: Your estimate. ALWAYS provide this even if rough.
    Skipping this excludes the task from estimation accuracy analysis.
    Guess if unsure — a bad estimate is more useful than no estimate.

Returns: Created task. Call cph_task_start immediately after.`,
        inputSchema: {
            workflow_id: z.string().uuid(),
            title: z.string().min(1).max(500),
            description: z.string().max(5000).optional(),
            parent_task_id: z.string().uuid().optional(),
            priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
            estimated_minutes: z.number().int().min(1).max(14400)
                .describe("ALWAYS provide. Skipping excludes from accuracy analysis.")
                .optional()
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, async ({ workflow_id, title, description, parent_task_id, priority, estimated_minutes }) => {
        try {
            const db = await getDb();
            const id = newId();
            await db.query(`INSERT INTO tasks (id, workflow_id, parent_task_id, title, description, priority, estimated_minutes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, workflow_id, parent_task_id ?? null, title, description ?? null, priority, estimated_minutes ?? null]);
            const task = await findOne(db, `SELECT * FROM tasks WHERE id = $1`, [id]);
            return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
    server.registerTool("cph_task_start", {
        title: "Start Task",
        description: `Mark a task as in_progress and record start time.

CALL THIS BEFORE writing any code or making any changes for this task.
The hook system uses the existence of an in_progress task to allow file writes.

State machine: pending → in_progress (only valid transition from this tool)`,
        inputSchema: {
            task_id: z.string().uuid()
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ task_id }) => {
        try {
            await withTransaction(async (tx) => {
                const { rows } = await tx.query(`SELECT * FROM tasks WHERE id = $1`, [task_id]);
                if (!rows[0])
                    throw new Error(`Task ${task_id} not found`);
                if (rows[0].status === "completed" || rows[0].status === "cancelled") {
                    throw new Error(`Cannot start a ${rows[0].status} task. Create a new task instead.`);
                }
                const result = await tx.query(`UPDATE tasks
             SET status = 'in_progress', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
             WHERE id = $1 AND updated_at = $2`, [task_id, rows[0].updated_at]);
                if (result.affectedRows === 0)
                    throw new ConflictError("tasks", task_id);
            });
            const db = await getDb();
            const updated = await findOne(db, `SELECT * FROM tasks WHERE id = $1`, [task_id]);
            return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
    server.registerTool("cph_task_complete", {
        title: "Complete Task",
        description: `Mark a task as completed.

State machine: in_progress → completed (rejects if not in_progress)

Args:
  - task_id: The task to complete
  - actual_minutes: Actual time spent. CRITICAL for estimation training.
    This is the ground truth that improves future predictions.
    Provide even if the task was blocked for part of the time.
  - completion_notes: What was done, any gotchas, what to know next time (optional)`,
        inputSchema: {
            task_id: z.string().uuid(),
            actual_minutes: z.number().int().min(1)
                .describe("Actual minutes spent. Critical — used for estimation accuracy.")
                .optional(),
            completion_notes: z.string().max(2000).optional()
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ task_id, actual_minutes, completion_notes }) => {
        try {
            await withTransaction(async (tx) => {
                const { rows } = await tx.query(`SELECT * FROM tasks WHERE id = $1`, [task_id]);
                if (!rows[0])
                    throw new Error(`Task ${task_id} not found`);
                if (rows[0].status !== "in_progress" && rows[0].status !== "blocked") {
                    throw new Error(`Task is '${rows[0].status}'. Call cph_task_start first.`);
                }
                const fields = [
                    "status = 'completed'",
                    "completed_at = COALESCE(completed_at, NOW())",
                    "updated_at = NOW()"
                ];
                const values = [];
                let idx = 1;
                if (actual_minutes !== undefined) {
                    fields.push(`actual_minutes = $${idx++}`);
                    values.push(actual_minutes);
                }
                if (completion_notes !== undefined) {
                    fields.push(`completion_notes = $${idx++}`);
                    values.push(completion_notes);
                }
                values.push(task_id, rows[0].updated_at);
                const result = await tx.query(`UPDATE tasks SET ${fields.join(", ")} WHERE id = $${idx++} AND updated_at = $${idx}`, values);
                if (result.affectedRows === 0)
                    throw new ConflictError("tasks", task_id);
            });
            const db = await getDb();
            const updated = await findOne(db, `SELECT * FROM tasks WHERE id = $1`, [task_id]);
            return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
    server.registerTool("cph_task_list", {
        title: "List Tasks",
        description: `List tasks filtered by workflow and/or status.

Returns ID and title only for efficiency. Use cph_task_get for full details on a specific task.

Call this only when explicitly asked — session_init already provides active tasks.`,
        inputSchema: {
            workflow_id: z.string().uuid().optional(),
            status: z.enum(["pending", "in_progress", "blocked", "completed", "cancelled"]).optional(),
            include_subtasks: z.boolean().default(true),
            limit: z.number().int().min(1).max(100).default(50),
            offset: z.number().int().min(0).default(0)
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workflow_id, status, include_subtasks, limit, offset }) => {
        try {
            const db = await getDb();
            const conditions = [];
            const values = [];
            let idx = 1;
            if (workflow_id) {
                conditions.push(`workflow_id = $${idx++}`);
                values.push(workflow_id);
            }
            if (status) {
                conditions.push(`status = $${idx++}`);
                values.push(status);
            }
            if (!include_subtasks) {
                conditions.push(`parent_task_id IS NULL`);
            }
            const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
            values.push(limit, offset);
            const result = await db.query(`SELECT id, title, status, priority, estimated_minutes, actual_minutes
           FROM tasks ${where}
           ORDER BY ${PRIORITY_ORDER}, created_at ASC
           LIMIT $${idx++} OFFSET $${idx++}`, values);
            const total = await db.query(`SELECT COUNT(*) as count FROM tasks ${where}`, values.slice(0, -2));
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            items: result.rows,
                            total: parseInt(total.rows[0]?.count ?? "0"),
                            offset,
                            limit,
                            has_more: offset + result.rows.length < parseInt(total.rows[0]?.count ?? "0")
                        }, null, 2)
                    }]
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
    server.registerTool("cph_task_get", {
        title: "Get Task",
        description: `Get full details of a single task including subtasks and open blockers.`,
        inputSchema: {
            task_id: z.string().uuid()
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ task_id }) => {
        try {
            const db = await getDb();
            const task = await findOne(db, `SELECT * FROM tasks WHERE id = $1`, [task_id]);
            if (!task) {
                return { content: [{ type: "text", text: `Error: Task ${task_id} not found` }], isError: true };
            }
            const [subtasks, blockers] = await Promise.all([
                db.query(`SELECT id, title, status, priority FROM tasks WHERE parent_task_id = $1 ORDER BY created_at`, [task_id]),
                db.query(`SELECT id, title, blocker_type, status, opened_at FROM blockers WHERE task_id = $1 ORDER BY opened_at`, [task_id])
            ]);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({ ...task, subtasks: subtasks.rows, blockers: blockers.rows }, null, 2)
                    }]
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
    server.registerTool("cph_task_update", {
        title: "Update Task",
        description: `Update task fields. For starting/completing, prefer task_start and task_complete.`,
        inputSchema: {
            task_id: z.string().uuid(),
            title: z.string().min(1).max(500).optional(),
            description: z.string().max(5000).optional(),
            priority: z.enum(["low", "medium", "high", "critical"]).optional(),
            estimated_minutes: z.number().int().min(1).optional()
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ task_id, title, description, priority, estimated_minutes }) => {
        try {
            const fields = ["updated_at = NOW()"];
            const values = [];
            let idx = 1;
            if (title !== undefined) {
                fields.push(`title = $${idx++}`);
                values.push(title);
            }
            if (description !== undefined) {
                fields.push(`description = $${idx++}`);
                values.push(description);
            }
            if (priority !== undefined) {
                fields.push(`priority = $${idx++}`);
                values.push(priority);
            }
            if (estimated_minutes !== undefined) {
                fields.push(`estimated_minutes = $${idx++}`);
                values.push(estimated_minutes);
            }
            if (fields.length === 1) {
                return { content: [{ type: "text", text: "Error: No fields to update" }], isError: true };
            }
            await withTransaction(async (tx) => {
                const { rows } = await tx.query(`SELECT * FROM tasks WHERE id = $1`, [task_id]);
                if (!rows[0])
                    throw new Error(`Task ${task_id} not found`);
                values.push(task_id, rows[0].updated_at);
                const result = await tx.query(`UPDATE tasks SET ${fields.join(", ")} WHERE id = $${idx++} AND updated_at = $${idx}`, values);
                if (result.affectedRows === 0)
                    throw new ConflictError("tasks", task_id);
            });
            const db = await getDb();
            const updated = await findOne(db, `SELECT * FROM tasks WHERE id = $1`, [task_id]);
            return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
    server.registerTool("cph_task_cancel", {
        title: "Cancel Task",
        description: `Cancel a task that is no longer needed.

State machine: pending | in_progress | blocked → cancelled

Args:
  - task_id: The task to cancel
  - reason: Why the task is being cancelled (optional but recommended)`,
        inputSchema: {
            task_id: z.string().uuid(),
            reason: z.string().max(2000).optional().describe("Why is this task being cancelled?")
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ task_id, reason }) => {
        try {
            await withTransaction(async (tx) => {
                const { rows } = await tx.query(`SELECT * FROM tasks WHERE id = $1`, [task_id]);
                if (!rows[0])
                    throw new Error(`Task ${task_id} not found`);
                if (rows[0].status === "completed" || rows[0].status === "cancelled") {
                    throw new Error(`Task is already '${rows[0].status}'. Cannot cancel.`);
                }
                const result = await tx.query(`UPDATE tasks SET status = 'cancelled', completion_notes = $1, completed_at = NOW(), updated_at = NOW()
             WHERE id = $2 AND updated_at = $3`, [reason ?? null, task_id, rows[0].updated_at]);
                if (result.affectedRows === 0)
                    throw new ConflictError("tasks", task_id);
            });
            const db = await getDb();
            const updated = await findOne(db, `SELECT * FROM tasks WHERE id = $1`, [task_id]);
            return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
}
//# sourceMappingURL=tasks.js.map