import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, newId, findOne } from "../db.js";
import type { Workflow, WorkflowSummary } from "../types.js";

export function registerWorkflowTools(server: McpServer): void {

  server.registerTool(
    "flowmind_workflow_create",
    {
      title: "Create Workflow",
      description: `Create a new workflow (project container for tasks, blockers, decisions).

Create one per feature branch, sprint, or meaningful engineering effort.

Args:
  - name: Short name (e.g. "OAuth Migration", "API v2", "Payments Refactor")
  - description: Goals and scope (optional)
  - git_branch_pattern: Branch pattern for auto-detection (e.g. "feature/auth-*", "fix/*")
    Set this so flowmind_detect_workflow automatically finds this workflow on matching branches.

Returns: Created workflow with ID. PUT THIS ID IN YOUR CLAUDE.md.`,
      inputSchema: {
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        git_branch_pattern: z.string().max(200).optional()
          .describe("Glob pattern for auto branch detection (e.g. 'feature/auth-*')")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ name, description, git_branch_pattern }) => {
      try {
        const db = await getDb();
        const id = newId();
        await db.query(
          `INSERT INTO workflows (id, name, description, git_branch_pattern)
           VALUES ($1, $2, $3, $4)`,
          [id, name, description ?? null, git_branch_pattern ?? null]
        );
        const wf = await findOne<Workflow>(db, `SELECT * FROM workflows WHERE id = $1`, [id]);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...wf,
              _instruction: `Add this to CLAUDE.md: Workflow ID: ${id}`
            }, null, 2)
          }]
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "flowmind_workflow_list",
    {
      title: "List Workflows",
      description: `List workflows filtered by status.

Returns: Array of workflows with ID, name, status. No task counts (use flowmind_workflow_summary for that).`,
      inputSchema: {
        status: z.enum(["active", "paused", "completed", "archived"]).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ status }) => {
      try {
        const db = await getDb();
        const result = status
          ? await db.query<Workflow>(`SELECT * FROM workflows WHERE status = $1 ORDER BY updated_at DESC`, [status])
          : await db.query<Workflow>(`SELECT * FROM workflows ORDER BY updated_at DESC`);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "flowmind_workflow_summary",
    {
      title: "Get Workflow Summary",
      description: `Get a full status summary of a workflow.

Returns task counts by status, open blocker count, decision count, and estimation accuracy ratio.

Use this when a user explicitly asks for project status. Don't call proactively.`,
      inputSchema: {
        workflow_id: z.string().uuid()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id }) => {
      try {
        const db = await getDb();
        const wf = await findOne<Workflow>(db, `SELECT * FROM workflows WHERE id = $1`, [workflow_id]);
        if (!wf) {
          return { content: [{ type: "text", text: `Error: Workflow ${workflow_id} not found` }], isError: true };
        }

        const [counts, blockers, decisions, accuracy] = await Promise.all([
          db.query<{ status: string; count: string }>(
            `SELECT status, COUNT(*) as count FROM tasks WHERE workflow_id = $1 GROUP BY status`,
            [workflow_id]
          ),
          db.query<{ count: string }>(
            `SELECT COUNT(*) as count FROM blockers WHERE workflow_id = $1 AND status = 'open'`,
            [workflow_id]
          ),
          db.query<{ count: string }>(
            `SELECT COUNT(*) as count FROM decisions WHERE workflow_id = $1`,
            [workflow_id]
          ),
          db.query<{ ratio: string | null }>(
            `SELECT ROUND(AVG(CAST(actual_minutes AS float) / NULLIF(estimated_minutes, 0))::numeric, 2)::text as ratio
             FROM tasks
             WHERE workflow_id = $1
               AND actual_minutes IS NOT NULL
               AND estimated_minutes IS NOT NULL
               AND estimated_minutes > 0`,
            [workflow_id]
          )
        ]);

        const task_counts = { total: 0, pending: 0, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 };
        for (const row of counts.rows) {
          const s = row.status as keyof typeof task_counts;
          const n = parseInt(row.count);
          if (s in task_counts) task_counts[s] = n;
          task_counts.total += n;
        }

        const summary: WorkflowSummary = {
          ...wf,
          task_counts,
          open_blockers: parseInt(blockers.rows[0]?.count ?? "0"),
          decision_count: parseInt(decisions.rows[0]?.count ?? "0"),
          estimation_accuracy: accuracy.rows[0]?.ratio != null
            ? parseFloat(accuracy.rows[0].ratio)
            : null
        };

        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "flowmind_workflow_update",
    {
      title: "Update Workflow",
      description: `Update a workflow's name, description, status, or git branch pattern.`,
      inputSchema: {
        workflow_id: z.string().uuid(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        status: z.enum(["active", "paused", "completed", "archived"]).optional(),
        git_branch_pattern: z.string().max(200).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id, name, description, status, git_branch_pattern }) => {
      try {
        const db = await getDb();
        const fields = ["updated_at = NOW()"];
        const values: unknown[] = [];
        let idx = 1;

        if (name !== undefined)               { fields.push(`name = $${idx++}`);                values.push(name); }
        if (description !== undefined)        { fields.push(`description = $${idx++}`);         values.push(description); }
        if (status !== undefined)             { fields.push(`status = $${idx++}`);              values.push(status); }
        if (git_branch_pattern !== undefined) { fields.push(`git_branch_pattern = $${idx++}`); values.push(git_branch_pattern); }

        if (fields.length === 1) {
          return { content: [{ type: "text", text: "Error: No fields to update" }], isError: true };
        }

        values.push(workflow_id);
        await db.query(`UPDATE workflows SET ${fields.join(", ")} WHERE id = $${idx}`, values);
        const wf = await findOne<Workflow>(db, `SELECT * FROM workflows WHERE id = $1`, [workflow_id]);
        return { content: [{ type: "text", text: JSON.stringify(wf, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
