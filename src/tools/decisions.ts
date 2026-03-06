import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, newId, findOne } from "../db.js";
import type { Decision } from "../types.js";

export function registerDecisionTools(server: McpServer): void {

  server.registerTool(
    "cph_decision_record",
    {
      title: "Record Decision",
      description: `Record an architectural, design, or process decision.

This is the institutional memory of the project. Future sessions — and future engineers —
will use this to understand why things are built the way they are.

Record a decision when:
  - You chose between two or more approaches
  - You made an assumption about requirements
  - The word "because" appears in your reasoning
  - You're doing something non-obvious that someone will question later

The post-commit hook will automatically attach the commit hash to recent decisions —
you don't need to provide it manually.

Args:
  - workflow_id, title, decision: Required
  - context: What problem were you solving? What constraints existed?
  - rationale: Why this option over the alternatives?
  - alternatives_considered: What else did you evaluate?
  - trade_offs: What does this choice cost or foreclose?
  - tags: Comma-separated (e.g. "auth,database,performance")`,
      inputSchema: {
        workflow_id: z.string().uuid(),
        title: z.string().min(1).max(300),
        decision: z.string().min(1).max(5000).describe("The actual choice made"),
        context: z.string().max(5000).optional(),
        rationale: z.string().max(5000).optional(),
        alternatives_considered: z.string().max(5000).optional(),
        trade_offs: z.string().max(3000).optional(),
        task_id: z.string().uuid().optional(),
        tags: z.string().max(500).optional().describe("Comma-separated tags")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ workflow_id, title, decision, context, rationale, alternatives_considered, trade_offs, task_id, tags }) => {
      try {
        const db = await getDb();
        const id = newId();

        await db.query(
          `INSERT INTO decisions
             (id, workflow_id, task_id, title, context, decision, rationale, alternatives_considered, trade_offs, tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, workflow_id, task_id ?? null, title, context ?? null, decision,
            rationale ?? null, alternatives_considered ?? null, trade_offs ?? null, tags ?? null]
        );

        const dec = await findOne<Decision>(db, `SELECT * FROM decisions WHERE id = $1`, [id]);
        return { content: [{ type: "text", text: JSON.stringify(dec, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cph_decision_search",
    {
      title: "Search Decisions",
      description: `Search decisions by keyword across title, decision, context, and rationale.

CALL THIS before making any significant architectural choice to check if it was already decided.
This is the primary anti-repetition tool.

Returns summary view (id + title + decision only) to preserve context budget.
Use cph_decision_get for full details on a specific result.`,
      inputSchema: {
        query: z.string().min(2).max(200).describe("Keyword or phrase to search for"),
        workflow_id: z.string().uuid().optional().describe("Limit to specific workflow. Omit to search all."),
        limit: z.number().int().min(1).max(20).default(5)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ query, workflow_id, limit }) => {
      try {
        const db = await getDb();
        const pattern = `%${query}%`;

        const result = workflow_id
          ? await db.query<Pick<Decision, "id" | "title" | "decision" | "tags" | "created_at">>(
              `SELECT id, title, decision, tags, created_at FROM decisions
               WHERE workflow_id = $1
                 AND (title ILIKE $2 OR decision ILIKE $2 OR context ILIKE $2 OR rationale ILIKE $2 OR tags ILIKE $2)
               ORDER BY created_at DESC LIMIT $3`,
              [workflow_id, pattern, limit]
            )
          : await db.query<Pick<Decision, "id" | "title" | "decision" | "tags" | "created_at">>(
              `SELECT id, title, decision, tags, created_at FROM decisions
               WHERE title ILIKE $1 OR decision ILIKE $1 OR context ILIKE $1 OR rationale ILIKE $1 OR tags ILIKE $1
               ORDER BY created_at DESC LIMIT $2`,
              [pattern, limit]
            );

        if (!result.rows.length) {
          return { content: [{ type: "text", text: `No decisions found matching "${query}"` }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cph_decision_get",
    {
      title: "Get Decision",
      description: `Get full details of a single decision including rationale and alternatives.

Use after cph_decision_search returns relevant IDs.`,
      inputSchema: {
        decision_id: z.string().uuid()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ decision_id }) => {
      try {
        const db = await getDb();
        const dec = await findOne<Decision>(db, `SELECT * FROM decisions WHERE id = $1`, [decision_id]);
        if (!dec) {
          return { content: [{ type: "text", text: `Error: Decision ${decision_id} not found` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(dec, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cph_decision_list",
    {
      title: "List Decisions",
      description: `List decisions for a workflow. Returns summary view only.

Call this when user explicitly asks to see decisions. session_init surfaces relevant ones automatically.`,
      inputSchema: {
        workflow_id: z.string().uuid(),
        tag: z.string().max(100).optional().describe("Filter by tag (partial match)"),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id, tag, limit, offset }) => {
      try {
        const db = await getDb();
        const conditions = [`workflow_id = $1`];
        const values: unknown[] = [workflow_id];
        let idx = 2;

        if (tag) { conditions.push(`tags ILIKE $${idx++}`); values.push(`%${tag}%`); }
        values.push(limit, offset);

        const result = await db.query<Pick<Decision, "id" | "title" | "decision" | "tags" | "created_at">>(
          `SELECT id, title, decision, tags, created_at FROM decisions
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT $${idx++} OFFSET $${idx++}`,
          values
        );

        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cph_decision_attach_commit",
    {
      title: "Attach Commit to Recent Decisions",
      description: `Internal: Called by the post-commit git hook to link recent decisions to a commit.

Do NOT call this manually. The hook calls it automatically after every commit.

Attaches commit_hash and diff_stat to decisions recorded in the last 30 minutes
that don't already have a commit attached.`,
      inputSchema: {
        workflow_id: z.string().uuid(),
        commit_hash: z.string().min(4).max(64),
        diff_stat: z.string().max(500).optional()
          .describe("Structural summary only: '3 files changed, 45 insertions'")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id, commit_hash, diff_stat }) => {
      try {
        const db = await getDb();

        const result = await db.query<{ count: string }>(
          `WITH updated AS (
             UPDATE decisions
             SET commit_hash = $1, diff_stat = $2, updated_at = NOW()
             WHERE workflow_id = $3
               AND commit_hash IS NULL
               AND created_at > NOW() - INTERVAL '30 minutes'
             RETURNING id
           )
           SELECT COUNT(*) as count FROM updated`,
          [commit_hash, diff_stat ?? null, workflow_id]
        );

        const count = parseInt(result.rows[0]?.count ?? "0");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ attached: count, commit_hash, workflow_id }, null, 2)
          }]
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
