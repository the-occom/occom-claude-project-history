import { Router } from "express";
import { getDb } from "../db.js";

export function createDebugRouter(): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    try {
      const db = await getDb();
      await db.query("SELECT 1");
      res.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
    } catch {
      res.status(503).json({ status: "error" });
    }
  });

  router.get("/all", async (_req, res) => {
    try {
      const db = await getDb();
      const [workflows, tasks, blockers, decisions] = await Promise.all([
        db.query("SELECT * FROM workflows ORDER BY updated_at DESC"),
        db.query("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 500"),
        db.query("SELECT * FROM blockers ORDER BY created_at DESC LIMIT 200"),
        db.query("SELECT * FROM decisions ORDER BY created_at DESC LIMIT 200"),
      ]);
      res.json({
        workflows: workflows.rows,
        tasks: tasks.rows,
        blockers: blockers.rows,
        decisions: decisions.rows,
        events: [], // events table not yet implemented
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/query", async (req, res) => {
    const { sql } = req.body as { sql?: string };
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  return router;
}
