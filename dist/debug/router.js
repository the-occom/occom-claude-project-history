import { Router } from "express";
import { getDb } from "../db.js";
export function createDebugRouter() {
    const router = Router();
    router.get("/health", async (_req, res) => {
        try {
            const db = await getDb();
            await db.query("SELECT 1");
            res.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
        }
        catch {
            res.status(503).json({ status: "error" });
        }
    });
    router.get("/all", async (_req, res) => {
        try {
            const db = await getDb();
            const [workflows, tasks, blockers, decisions, sessions, toolEvents, thinkingEstimates, toolBaselines] = await Promise.all([
                db.query("SELECT * FROM workflows ORDER BY updated_at DESC"),
                db.query("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 500"),
                db.query("SELECT * FROM blockers ORDER BY created_at DESC LIMIT 200"),
                db.query("SELECT * FROM decisions ORDER BY created_at DESC LIMIT 200"),
                db.query("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 100"),
                db.query("SELECT * FROM tool_events ORDER BY created_at DESC LIMIT 500"),
                db.query("SELECT * FROM thinking_estimates ORDER BY created_at DESC LIMIT 200"),
                db.query("SELECT * FROM tool_baselines ORDER BY sample_count DESC"),
            ]);
            res.json({
                workflows: workflows.rows,
                tasks: tasks.rows,
                blockers: blockers.rows,
                decisions: decisions.rows,
                sessions: sessions.rows,
                tool_events: toolEvents.rows,
                thinking_estimates: thinkingEstimates.rows,
                tool_baselines: toolBaselines.rows,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });
    router.get("/tasks/:id", async (req, res) => {
        try {
            const db = await getDb();
            const { rows } = await db.query("SELECT * FROM tasks WHERE id = $1", [req.params.id]);
            if (!rows[0]) {
                res.status(404).json({ error: "Task not found" });
                return;
            }
            const [subtasks, blockers, decisions] = await Promise.all([
                db.query("SELECT id, title, status, priority, estimated_minutes, actual_minutes FROM tasks WHERE parent_task_id = $1 ORDER BY created_at", [req.params.id]),
                db.query("SELECT id, title, blocker_type, status, opened_at, resolved_at, resolution, resolution_minutes FROM blockers WHERE task_id = $1 ORDER BY opened_at", [req.params.id]),
                db.query("SELECT id, title, decision, tags, created_at FROM decisions WHERE task_id = $1 ORDER BY created_at", [req.params.id]),
            ]);
            res.json({ ...rows[0], subtasks: subtasks.rows, blockers: blockers.rows, decisions: decisions.rows });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });
    router.post("/query", async (req, res) => {
        const { sql } = req.body;
        if (!sql || typeof sql !== "string") {
            res.status(400).json({ error: "sql required" });
            return;
        }
        const normalized = sql.trim().toLowerCase();
        const forbidden = [
            "insert", "update", "delete", "drop", "truncate",
            "alter", "create", "replace", "grant", "revoke",
        ];
        if (forbidden.some((kw) => normalized.startsWith(kw) || normalized.includes(` ${kw} `))) {
            res.status(403).json({ error: "read-only: SELECT only" });
            return;
        }
        try {
            const db = await getDb();
            const result = await db.query(sql);
            res.json({ rows: result.rows, count: result.rows.length });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(400).json({ error: msg });
        }
    });
    return router;
}
//# sourceMappingURL=router.js.map