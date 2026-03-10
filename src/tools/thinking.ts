import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db.js";
import type { ThinkingEstimate, ToolBaseline } from "../types.js";

export function registerThinkingTools(server: McpServer): void {

  server.registerTool(
    "cph_thinking_summary",
    {
      title: "Thinking Time Summary",
      description: `Get inferred thinking-time breakdown for recent turns.

Claude Code's extended thinking is not directly observable. This tool infers
thinking time from the gaps between tool calls:
  - Initial gap: time from user prompt to first tool use
  - Interleaved gaps: time between consecutive tool calls
  - Final gap: time from last tool to response

Returns per-turn breakdowns, aggregate stats, tool baselines, and a caveat
explaining inference limitations.

Args:
  - session_id: Filter to a specific session (optional)
  - workflow_id: Filter to a specific workflow (optional)
  - limit: Number of recent turns to return (default 10)`,
      inputSchema: {
        session_id: z.string().optional().describe("Filter to specific session"),
        workflow_id: z.string().uuid().optional().describe("Filter to specific workflow"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id, workflow_id, limit }) => {
      try {
        const db = await getDb();

        // Build query conditions
        const conditions: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (session_id) { conditions.push(`session_id = $${idx++}`); values.push(session_id); }
        if (workflow_id) { conditions.push(`workflow_id = $${idx++}`); values.push(workflow_id); }

        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        values.push(limit);

        const estimates = await db.query<ThinkingEstimate>(
          `SELECT * FROM thinking_estimates ${where}
           ORDER BY created_at DESC LIMIT $${idx}`,
          values
        );

        const baselines = await db.query<ToolBaseline>(
          `SELECT * FROM tool_baselines ORDER BY sample_count DESC`
        );

        // Compute aggregates
        const rows = estimates.rows;
        const totalThinkingMs = rows.reduce(
          (sum, r) => sum + (r.initial_gap_ms ?? 0) + r.interleaved_ms, 0
        );
        const totalWallMs = rows.reduce((sum, r) => sum + r.total_wall_ms, 0);
        const totalToolMs = rows.reduce((sum, r) => sum + r.total_tool_ms, 0);
        const avgThinkingPct = totalWallMs > 0
          ? Math.round((totalThinkingMs / totalWallMs) * 100)
          : 0;

        const result = {
          turns: rows.map(r => ({
            turn: r.turn_number,
            session_id: r.session_id,
            initial_gap_ms: r.initial_gap_ms,
            interleaved_ms: r.interleaved_ms,
            total_tool_ms: r.total_tool_ms,
            total_wall_ms: r.total_wall_ms,
            gap_count: r.gap_count,
            thinking_pct: r.total_wall_ms > 0
              ? Math.round(((r.initial_gap_ms ?? 0) + r.interleaved_ms) / r.total_wall_ms * 100)
              : 0,
            prompt: r.prompt_timestamp,
            stop: r.stop_timestamp,
          })),
          aggregates: {
            turns_analyzed: rows.length,
            total_thinking_ms: totalThinkingMs,
            total_tool_ms: totalToolMs,
            total_wall_ms: totalWallMs,
            thinking_pct: avgThinkingPct,
          },
          baselines: baselines.rows.map(b => ({
            tool: b.tool_name,
            avg_ms: b.avg_ms,
            p50_ms: b.p50_ms,
            p95_ms: b.p95_ms,
            samples: b.sample_count,
          })),
          caveat: "Thinking time is inferred from gaps between tool calls. " +
            "It includes network latency, user approval wait time, and any " +
            "non-tool processing. Actual extended thinking time may differ. " +
            "Baselines improve with more data (min 3 samples per tool).",
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
