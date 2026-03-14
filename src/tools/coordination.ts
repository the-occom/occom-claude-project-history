import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db.js";

export function registerCoordinationTools(server: McpServer): void {

  server.registerTool(
    "cph_who_is_working",
    {
      title: "Who Is Working",
      description: `Show active agents/developers and what they're working on.

Returns annotated list of active sessions with:
  - Developer name and identity
  - Current task (if any)
  - Current blocker (if any)
  - Status: active | blocked | idle_with_task | available
  - Summary counts

Use this to understand team state before starting work.`,
      inputSchema: {
        workflow_id: z.string().uuid().optional().describe("Filter by workflow")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id }) => {
      try {
        const db = await getDb();

        const wfClause = workflow_id ? `AND s.workflow_id = $1` : "";
        const params = workflow_id ? [workflow_id] : [];

        const result = await db.query<{
          session_id: string;
          developer_id: string | null;
          developer_name: string | null;
          agent_id: string | null;
          agent_type: string | null;
          model: string | null;
          started_at: string | null;
          workflow_id: string | null;
          workflow_name: string | null;
          current_task_id: string | null;
          current_task_title: string | null;
          current_task_status: string | null;
          current_blocker_id: string | null;
          current_blocker_title: string | null;
          last_tool_event: string | null;
        }>(
          `SELECT
             s.id AS session_id,
             s.developer_id,
             d.name AS developer_name,
             s.agent_id,
             a.agent_type,
             s.model,
             s.started_at,
             s.workflow_id,
             w.name AS workflow_name,
             t.id AS current_task_id,
             t.title AS current_task_title,
             t.status AS current_task_status,
             b.id AS current_blocker_id,
             b.title AS current_blocker_title,
             te.created_at AS last_tool_event
           FROM sessions s
           LEFT JOIN developers d ON d.id = s.developer_id
           LEFT JOIN agents a ON a.id = s.agent_id
           LEFT JOIN workflows w ON w.id = s.workflow_id
           LEFT JOIN LATERAL (
             SELECT id, title, status FROM tasks
             WHERE workflow_id = s.workflow_id AND status = 'in_progress'
             ORDER BY updated_at DESC LIMIT 1
           ) t ON true
           LEFT JOIN LATERAL (
             SELECT id, title FROM blockers
             WHERE workflow_id = s.workflow_id AND status = 'open'
             ORDER BY opened_at DESC LIMIT 1
           ) b ON true
           LEFT JOIN LATERAL (
             SELECT created_at FROM tool_events
             WHERE session_id = s.id
             ORDER BY created_at DESC LIMIT 1
           ) te ON true
           WHERE s.ended_at IS NULL ${wfClause}
           ORDER BY s.started_at DESC`,
          params
        );

        const agents = result.rows.map(r => {
          let status = "available";
          if (r.current_blocker_id) status = "blocked";
          else if (r.current_task_status === "in_progress") status = "active";
          else if (r.current_task_id) status = "idle_with_task";

          return {
            session_id: r.session_id,
            developer: r.developer_id ? { id: r.developer_id, name: r.developer_name } : null,
            agent: r.agent_id ? { id: r.agent_id, type: r.agent_type, model: r.model } : null,
            workflow: r.workflow_id ? { id: r.workflow_id, name: r.workflow_name } : null,
            current_task: r.current_task_id ? { id: r.current_task_id, title: r.current_task_title, status: r.current_task_status } : null,
            current_blocker: r.current_blocker_id ? { id: r.current_blocker_id, title: r.current_blocker_title } : null,
            status,
            started_at: r.started_at,
            last_activity: r.last_tool_event,
          };
        });

        const counts = {
          total: agents.length,
          active: agents.filter(a => a.status === "active").length,
          blocked: agents.filter(a => a.status === "blocked").length,
          idle_with_task: agents.filter(a => a.status === "idle_with_task").length,
          available: agents.filter(a => a.status === "available").length,
        };

        return { content: [{ type: "text", text: JSON.stringify({ agents, counts }, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cph_activity_stream",
    {
      title: "Activity Stream",
      description: `Get recent activity events for team awareness.

Shows what's been happening: tasks started/completed, decisions recorded,
blockers created/resolved, sessions started.

Filter by workflow, time range, and event types.`,
      inputSchema: {
        workflow_id: z.string().uuid().optional().describe("Filter by workflow"),
        since_minutes: z.number().int().min(1).max(10080).default(60)
          .describe("How far back to look (default: 60 minutes, max: 7 days)"),
        event_types: z.array(z.string()).optional()
          .describe("Filter by event types (e.g. ['task_started', 'decision_recorded'])"),
        limit: z.number().int().min(1).max(100).default(50)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id, since_minutes, event_types, limit }) => {
      try {
        const db = await getDb();

        const conditions = [`a.created_at > NOW() - INTERVAL '${since_minutes} minutes'`];
        const values: unknown[] = [];
        let idx = 1;

        if (workflow_id) {
          conditions.push(`a.workflow_id = $${idx++}`);
          values.push(workflow_id);
        }

        if (event_types && event_types.length > 0) {
          const placeholders = event_types.map((_, i) => `$${idx + i}`).join(",");
          conditions.push(`a.event_type IN (${placeholders})`);
          values.push(...event_types);
          idx += event_types.length;
        }

        values.push(limit);

        const result = await db.query<{
          id: string;
          developer_name: string | null;
          event_type: string;
          subject_type: string | null;
          subject_title: string | null;
          detail: unknown;
          created_at: string;
        }>(
          `SELECT a.id, d.name AS developer_name, a.event_type,
                  a.subject_type, a.subject_title, a.detail, a.created_at
           FROM activity_stream a
           LEFT JOIN developers d ON d.id = a.developer_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY a.created_at DESC
           LIMIT $${idx}`,
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
