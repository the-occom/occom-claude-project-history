import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, newId, findOne, withTransaction, ConflictError } from "../db.js";
import type { Blocker, Task } from "../types.js";

export function registerBlockerTools(server: McpServer): void {

  server.registerTool(
    "cph_blocker_create",
    {
      title: "Create Blocker",
      description: `Log a blocker that is preventing progress.

CALL THIS IMMEDIATELY when blocked — before asking the user, before trying workarounds.
The timestamp of when you were blocked is important data. Don't record it retroactively.

Blocker types:
  dependency         → waiting on another task, PR, or service to be ready
  waiting_on_human   → needs human decision, approval, or response
  technical          → technical problem with no clear solution yet
  external           → blocked by something outside the team
  unclear_requirements → requirements are ambiguous
  other              → doesn't fit above

Auto-behavior: if task_id is provided, the task status is automatically set to 'blocked'.`,
      inputSchema: {
        workflow_id: z.string().uuid(),
        title: z.string().min(1).max(500)
          .describe("What is blocking you. Be specific: 'Waiting for security team to approve OAuth scopes'"),
        blocker_type: z.enum([
          "dependency", "waiting_on_human", "technical",
          "external", "unclear_requirements", "other"
        ]).default("other"),
        task_id: z.string().uuid().optional()
          .describe("The blocked task. Providing this auto-sets task status to blocked."),
        description: z.string().max(3000).optional()
          .describe("Additional context. What have you tried? What exactly is needed to unblock?")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ workflow_id, title, blocker_type, task_id, description }) => {
      try {
        const id = newId();

        await withTransaction(async (tx) => {
          if (task_id) {
            const { rows } = await tx.query<Task>(
              `SELECT updated_at FROM tasks WHERE id = $1`, [task_id]
            );
            if (rows[0]) {
              const result = await tx.query(
                `UPDATE tasks SET status = 'blocked', updated_at = NOW()
                 WHERE id = $1 AND updated_at = $2`,
                [task_id, rows[0].updated_at]
              );
              if (result.affectedRows === 0) throw new ConflictError("tasks", task_id);
            }
          }

          await tx.query(
            `INSERT INTO blockers (id, task_id, workflow_id, title, description, blocker_type)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, task_id ?? null, workflow_id, title, description ?? null, blocker_type]
          );
        });

        const db = await getDb();
        const blocker = await findOne<Blocker>(db, `SELECT * FROM blockers WHERE id = $1`, [id]);
        return { content: [{ type: "text", text: JSON.stringify(blocker, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cph_blocker_resolve",
    {
      title: "Resolve Blocker",
      description: `Mark a blocker as resolved.

Always provide a resolution note — this is training data for predicting future blockers
and is the most valuable signal in the system after actual_minutes on tasks.

Auto-behavior: if blocker has a task_id and unblock_task=true, task is set back to in_progress.`,
      inputSchema: {
        blocker_id: z.string().uuid(),
        resolution: z.string().min(1).max(2000)
          .describe("How was this resolved? Be specific — this trains blocker prediction."),
        unblock_task: z.boolean().default(true)
          .describe("Reset associated task to in_progress on resolve")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ blocker_id, resolution, unblock_task }) => {
      try {
        await withTransaction(async (tx) => {
          const { rows } = await tx.query<Blocker>(
            `SELECT * FROM blockers WHERE id = $1`, [blocker_id]
          );
          if (!rows[0]) throw new Error(`Blocker ${blocker_id} not found`);
          if (rows[0].status === "resolved") throw new Error(`Blocker is already resolved`);

          const result = await tx.query(
            `UPDATE blockers
             SET status = 'resolved',
                 resolution = $1,
                 resolved_at = NOW(),
                 resolution_minutes = EXTRACT(EPOCH FROM (NOW() - opened_at)) / 60,
                 updated_at = NOW()
             WHERE id = $2 AND updated_at = $3`,
            [resolution, blocker_id, rows[0].updated_at]
          );
          if (result.affectedRows === 0) throw new ConflictError("blockers", blocker_id);

          if (unblock_task && rows[0].task_id) {
            await tx.query(
              `UPDATE tasks SET status = 'in_progress', updated_at = NOW()
               WHERE id = $1 AND status = 'blocked'`,
              [rows[0].task_id]
            );
          }
        });
        const db = await getDb();
        const updated = await findOne<Blocker>(db, `SELECT * FROM blockers WHERE id = $1`, [blocker_id]);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cph_blocker_escalate",
    {
      title: "Escalate Blocker",
      description: `Mark a blocker as escalated — open but needs urgent attention.

Use when a blocker has been open too long and needs to be surfaced to stakeholders.`,
      inputSchema: {
        blocker_id: z.string().uuid(),
        reason: z.string().min(1).max(1000).describe("Why is this being escalated?")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ blocker_id, reason }) => {
      try {
        await withTransaction(async (tx) => {
          const { rows } = await tx.query<Blocker>(
            `SELECT * FROM blockers WHERE id = $1`, [blocker_id]
          );
          if (!rows[0]) throw new Error(`Blocker ${blocker_id} not found`);
          const result = await tx.query(
            `UPDATE blockers
             SET status = 'escalated',
                 description = COALESCE(description, '') || ' [ESCALATED: ' || $1 || ']',
                 updated_at = NOW()
             WHERE id = $2 AND updated_at = $3`,
            [reason, blocker_id, rows[0].updated_at]
          );
          if (result.affectedRows === 0) throw new ConflictError("blockers", blocker_id);
        });
        const db = await getDb();
        const updated = await findOne<Blocker>(db, `SELECT * FROM blockers WHERE id = $1`, [blocker_id]);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cph_blocker_list",
    {
      title: "List Blockers",
      description: `List blockers by workflow and/or status.

Call this when user asks about blockers. session_init already surfaces open blockers — don't duplicate.`,
      inputSchema: {
        workflow_id: z.string().uuid().optional(),
        status: z.enum(["open", "resolved", "escalated"]).default("open"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id, status, limit, offset }) => {
      try {
        const db = await getDb();
        const conditions = [`status = $1`];
        const values: unknown[] = [status];
        let idx = 2;

        if (workflow_id) { conditions.push(`workflow_id = $${idx++}`); values.push(workflow_id); }
        values.push(limit, offset);

        const result = await db.query<Blocker>(
          `SELECT * FROM blockers WHERE ${conditions.join(" AND ")}
           ORDER BY opened_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
          values
        );

        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
