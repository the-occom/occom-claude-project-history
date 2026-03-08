#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { writeFileSync, unlinkSync, existsSync, statSync, readdirSync } from "fs";
import { registerSessionTools } from "./tools/session.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerBlockerTools } from "./tools/blockers.js";
import { registerDecisionTools } from "./tools/decisions.js";
import { getDb, SCHEMA_VERSION } from "./db.js";
import { bus } from "./services/notify.js";
import { unregisterSession } from "./services/context.js";
import { createDebugRouter } from "./debug/router.js";

const PKG_VERSION = "0.3.0";

function createServer(sessionId: string = "stdio"): McpServer {
  const server = new McpServer({
    name: "occom-claude-project-history",
    version: "0.3.0"
  });

  registerSessionTools(server, sessionId);
  registerWorkflowTools(server);
  registerTaskTools(server);
  registerBlockerTools(server);
  registerDecisionTools(server);

  return server;
}

const mode = process.argv[2];

async function main(): Promise<void> {
  // Fix 6A: warn if any src/*.ts is newer than dist/index.js
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const srcDir = join(__dir, "..", "src");
    const distEntry = join(__dir, "..", "dist", "index.js");
    if (existsSync(srcDir) && existsSync(distEntry)) {
      const distMtime = statSync(distEntry).mtimeMs;
      const srcFiles = readdirSync(srcDir).filter(f => f.endsWith(".ts"));
      const stale = srcFiles.some(f => statSync(join(srcDir, f)).mtimeMs > distMtime);
      if (stale) {
        console.error("[cph] WARNING: src/ has files newer than dist/index.js — run 'npm run build'");
      }
    }
  } catch {}

  const db = await getDb();
  await bus.start(db);

  if (mode === "--serve") {
    const app = express();
    const port = Number(process.env.CPH_PORT ?? 3741);

    interface ActiveSession {
      server: McpServer;
      transport: SSEServerTransport;
    }

    const sessions = new Map<string, ActiveSession>();

    app.get("/sse", async (_req, res) => {
      const transport = new SSEServerTransport("/message", res);
      const server = createServer(transport.sessionId);
      sessions.set(transport.sessionId, { server, transport });
      res.on("close", () => {
        unregisterSession(transport.sessionId);
        sessions.delete(transport.sessionId);
      });
      await server.connect(transport);
    });

    app.post("/message", express.json(), async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) { res.status(404).end(); return; }
      await session.transport.handlePostMessage(req, res, req.body);
    });

    app.get("/health", (_req, res) => res.json({ status: "ok", pid: process.pid, version: PKG_VERSION, schema_version: SCHEMA_VERSION }));

    // ── Hook + install endpoints ─────────────────────────────────────────────
    app.post("/api/workflows", express.json(), async (req, res) => {
      try {
        const { id, name, description } = req.body;
        if (!id || !name) { res.status(400).json({ error: "id and name required" }); return; }
        await db.query(
          `INSERT INTO workflows (id, name, description) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET name = $2, description = COALESCE($3, workflows.description), updated_at = NOW()`,
          [id, name, description ?? null]
        );
        res.json({ ok: true });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get("/hooks/active-tasks", async (req, res) => {
      try {
        const wid = req.query.workflow_id as string;
        if (!wid) { res.status(400).json({ error: "workflow_id required" }); return; }
        const result = await db.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM tasks WHERE workflow_id = $1 AND status = 'in_progress'`,
          [wid]
        );
        res.json({ count: parseInt(result.rows[0]?.count ?? "0") });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get("/hooks/session-summary", async (req, res) => {
      try {
        const wid = req.query.workflow_id as string;
        if (!wid) { res.status(400).json({ error: "workflow_id required" }); return; }
        const [ip, bl, ob] = await Promise.all([
          db.query(`SELECT id, title FROM tasks WHERE workflow_id = $1 AND status = 'in_progress' ORDER BY updated_at DESC`, [wid]),
          db.query(`SELECT id, title FROM tasks WHERE workflow_id = $1 AND status = 'blocked' ORDER BY updated_at DESC`, [wid]),
          db.query(`SELECT id, title, blocker_type FROM blockers WHERE workflow_id = $1 AND status = 'open' ORDER BY opened_at ASC`, [wid]),
        ]);
        res.json({ in_progress: ip.rows, blocked: bl.rows, open_blockers: ob.rows });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post("/hooks/attach-commit", express.json(), async (req, res) => {
      try {
        const { workflow_id, commit_hash, diff_stat } = req.body;
        if (!workflow_id || !commit_hash) { res.status(400).json({ error: "workflow_id and commit_hash required" }); return; }
        const result = await db.query<{ count: string }>(
          `WITH updated AS (
             UPDATE decisions SET commit_hash = $1, diff_stat = $2, updated_at = NOW()
             WHERE workflow_id = $3 AND commit_hash IS NULL AND created_at > NOW() - INTERVAL '30 minutes'
             RETURNING id
           ) SELECT COUNT(*) as count FROM updated`,
          [commit_hash, diff_stat ?? null, workflow_id]
        );
        res.json({ linked: parseInt(result.rows[0]?.count ?? "0") });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post("/hooks/task-complete", express.json(), async (req, res) => {
      try {
        const { task_id } = req.body;
        if (!task_id) { res.status(400).json({ error: "task_id required" }); return; }
        const { rows } = await db.query<{ status: string; updated_at: string }>(
          `SELECT status, updated_at FROM tasks WHERE id = $1`, [task_id]
        );
        if (!rows[0]) { res.status(404).json({ error: `Task ${task_id} not found` }); return; }
        if (rows[0].status !== "in_progress" && rows[0].status !== "blocked") {
          res.status(409).json({ error: `Task is '${rows[0].status}', expected in_progress or blocked` });
          return;
        }
        await db.query(
          `UPDATE tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND updated_at = $2`,
          [task_id, rows[0].updated_at]
        );
        res.json({ ok: true, task_id, status: "completed" });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post("/hooks/task-cancel", express.json(), async (req, res) => {
      try {
        const { task_id, reason } = req.body;
        if (!task_id) { res.status(400).json({ error: "task_id required" }); return; }
        const { rows } = await db.query<{ status: string; updated_at: string }>(
          `SELECT status, updated_at FROM tasks WHERE id = $1`, [task_id]
        );
        if (!rows[0]) { res.status(404).json({ error: `Task ${task_id} not found` }); return; }
        if (rows[0].status === "completed" || rows[0].status === "cancelled") {
          res.status(409).json({ error: `Task is already '${rows[0].status}'` });
          return;
        }
        await db.query(
          `UPDATE tasks SET status = 'cancelled', completion_notes = $1, completed_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND updated_at = $3`,
          [reason ?? null, task_id, rows[0].updated_at]
        );
        res.json({ ok: true, task_id, status: "cancelled" });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    app.listen(port, "127.0.0.1", () => {
      console.error(`[cph] daemon ready on :${port}`);
    });

    // Fix 1B: Heartbeat — write timestamp every 30s so staleness can be detected
    const cphDir = join(homedir(), ".cph");
    const heartbeatFile = join(cphDir, "daemon.heartbeat");
    writeFileSync(heartbeatFile, String(Date.now()));
    setInterval(() => {
      try { writeFileSync(heartbeatFile, String(Date.now())); } catch {}
    }, 30_000);

    // Fix 1C: Graceful shutdown — clean up PID + heartbeat files on signal
    const pidFile = join(cphDir, "daemon.pid");
    const cleanup = () => {
      try { unlinkSync(pidFile); } catch {}
      try { unlinkSync(heartbeatFile); } catch {}
      process.exit(0);
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    // Debug UI — separate port
    const debugPort = Number(process.env.CPH_DEBUG_PORT ?? 3742);
    const debugApp = express();
    debugApp.use(express.json());
    const __dirname = dirname(fileURLToPath(import.meta.url));
    debugApp.use(express.static(join(__dirname, "../debug")));
    debugApp.use("/api", createDebugRouter());
    debugApp.listen(debugPort, "127.0.0.1", () => {
      console.error(`[cph] debug UI → http://localhost:${debugPort}`);
    });
  } else {
    // Existing stdio path
    const server = createServer("stdio");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[cph] MCP server running. DB at ~/.cph/db");
  }
}

main().catch((error: unknown) => {
  console.error("[cph] Fatal error:", error);
  process.exit(1);
});
