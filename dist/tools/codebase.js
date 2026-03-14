import { z } from "zod";
import { getDb, newId } from "../db.js";
import { getSessionAgent } from "../session-state.js";
export function registerCodebaseTools(server, sessionId) {
    server.registerTool("cph_codebase_index", {
        title: "Index Codebase Areas",
        description: `Register or update file area ownership for a workflow.

Use this during plan mode to declare which parts of the codebase are relevant
to the current workflow, what their responsibilities are, and their dependencies.

Each area is a path pattern (e.g. "src/auth/**") with an optional responsibility
description and dependency list.

Upserts by workflow_id + path_pattern — safe to call multiple times.`,
        inputSchema: {
            workflow_id: z.string().uuid(),
            areas: z.array(z.object({
                path_pattern: z.string().min(1).max(500).describe("Glob-style path pattern, e.g. 'src/auth/**'"),
                responsibility: z.string().max(2000).optional().describe("What this area is responsible for"),
                depends_on: z.array(z.string()).optional().describe("Path patterns this area depends on"),
                depended_on_by: z.array(z.string()).optional().describe("Path patterns that depend on this area")
            })).min(1).max(50)
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workflow_id, areas }) => {
        try {
            const db = await getDb();
            const agentId = getSessionAgent(sessionId);
            const results = [];
            for (const area of areas) {
                const existing = await db.query(`SELECT id FROM file_areas WHERE workflow_id = $1 AND path_pattern = $2`, [workflow_id, area.path_pattern]);
                if (existing.rows.length > 0) {
                    await db.query(`UPDATE file_areas SET
                 responsibility = COALESCE($1, responsibility),
                 depends_on = $2,
                 depended_on_by = $3,
                 last_indexed_at = NOW(),
                 indexed_by = $4,
                 updated_at = NOW()
               WHERE id = $5`, [
                        area.responsibility ?? null,
                        JSON.stringify(area.depends_on ?? []),
                        JSON.stringify(area.depended_on_by ?? []),
                        agentId,
                        existing.rows[0].id,
                    ]);
                    results.push({ path_pattern: area.path_pattern, action: "updated" });
                }
                else {
                    await db.query(`INSERT INTO file_areas
                 (id, workflow_id, path_pattern, responsibility, depends_on, depended_on_by, last_indexed_at, indexed_by)
               VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`, [
                        newId(), workflow_id, area.path_pattern,
                        area.responsibility ?? null,
                        JSON.stringify(area.depends_on ?? []),
                        JSON.stringify(area.depended_on_by ?? []),
                        agentId,
                    ]);
                    results.push({ path_pattern: area.path_pattern, action: "created" });
                }
            }
            return { content: [{ type: "text", text: JSON.stringify({ indexed: results.length, areas: results }, null, 2) }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
    });
}
//# sourceMappingURL=codebase.js.map