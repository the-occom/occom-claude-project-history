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
import { registerThinkingTools } from "./tools/thinking.js";
import { registerCoordinationTools } from "./tools/coordination.js";
import { registerReconstructTools } from "./tools/reconstruct.js";
import { registerCodebaseTools } from "./tools/codebase.js";
import {
  onUserPrompt, onPreToolUse, onPostToolUse,
  onPostToolUseFailure, sealTurnThinking,
} from "./thinking.js";
import { getDb, SCHEMA_VERSION, newId, PRIORITY_ORDER } from "./db.js";
import type { PGlite } from "@electric-sql/pglite";
import { bus } from "./services/notify.js";
import { unregisterSession } from "./services/context.js";
import { createDebugRouter } from "./debug/router.js";
import { resolveIdentity, upsertDeveloper } from "./identity.js";
import { emitActivity, pruneActivityStream } from "./activity.js";
import { setSessionAgent, getSessionAgent, setSessionDeveloper, getSessionDeveloper } from "./session-state.js";

const PKG_VERSION = "0.6.0";

function createServer(sessionId: string = "stdio"): McpServer {
  const server = new McpServer({
    name: "occom-claude-project-history",
    version: "0.6.0"
  });

  registerSessionTools(server, sessionId);
  registerWorkflowTools(server);
  registerTaskTools(server, sessionId);
  registerBlockerTools(server, sessionId);
  registerDecisionTools(server, sessionId);
  registerThinkingTools(server);
  registerCoordinationTools(server);
  registerReconstructTools(server);
  registerCodebaseTools(server, sessionId);

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
  pruneActivityStream(db).catch(() => {});

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
      try {
        await server.sendLoggingMessage({ level: "info", data: `cph v${PKG_VERSION} (schema v${SCHEMA_VERSION})` });
      } catch {}
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

    // ── Context injection for UserPromptSubmit hook ─────────────────────────
    app.get("/hooks/context-inject", async (req, res) => {
      try {
        const wid = req.query.workflow_id as string;
        const sid = req.query.session_id as string;

        if (!wid) {
          res.type("text/plain").send(
            "[cph] No workflow detected for this project.\nCall cph_workflow_create to set up project memory."
          );
          return;
        }

        const [workflowResult, tasksResult, blockersResult, decisionsResult, sessionInitResult] = await Promise.all([
          db.query<{ name: string; status: string }>(
            `SELECT name, status FROM workflows WHERE id = $1`, [wid]
          ),
          db.query<{ title: string; status: string }>(
            `SELECT title, status FROM tasks WHERE workflow_id = $1 AND status IN ('in_progress', 'pending')
             ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 END,
             ${PRIORITY_ORDER}
             LIMIT 5`, [wid]
          ),
          db.query<{ title: string; blocker_type: string }>(
            `SELECT title, blocker_type FROM blockers WHERE workflow_id = $1 AND status = 'open'
             ORDER BY opened_at ASC LIMIT 3`, [wid]
          ),
          db.query<{ title: string }>(
            `SELECT title FROM decisions WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 3`, [wid]
          ),
          sid
            ? db.query<{ found: number }>(
                `SELECT 1 as found FROM tool_events WHERE session_id = $1 AND tool_name LIKE '%session_init%' LIMIT 1`, [sid]
              )
            : Promise.resolve({ rows: [] }),
        ]);

        const workflow = workflowResult.rows[0];
        if (!workflow) {
          res.type("text/plain").send(
            "[cph] No workflow detected for this project.\nCall cph_workflow_create to set up project memory."
          );
          return;
        }

        const sessionInitialized = sessionInitResult.rows.length > 0;
        const activeTasks = tasksResult.rows.filter(t => t.status === "in_progress");
        const pendingTasks = tasksResult.rows.filter(t => t.status === "pending");

        const lines: string[] = [];
        lines.push(`[cph] ${workflow.name} (${workflow.status})`);

        if (activeTasks.length > 0) {
          lines.push(`Active: ${activeTasks.map(t => t.title).join(", ")}`);
        } else {
          lines.push("Active: none");
        }

        if (pendingTasks.length > 0) {
          lines.push(`Up next: ${pendingTasks.map(t => t.title).join(", ")}`);
        }

        if (blockersResult.rows.length > 0) {
          lines.push(`Blockers: ${blockersResult.rows.map(b => `${b.title} [${b.blocker_type}]`).join(", ")}`);
        }

        if (!sessionInitialized) {
          if (decisionsResult.rows.length > 0) {
            lines.push(`Recent decisions: ${decisionsResult.rows.map(d => d.title).join(", ")}`);
          }
          lines.push("Call cph_session_init for full context.");
        }

        // Team awareness: show other active agents on same workflow
        if (sid && wid) {
          try {
            const selfAgent = await db.query<{ agent_id: string | null }>(
              `SELECT agent_id FROM sessions WHERE id = $1`, [sid]
            );
            const selfAgentId = selfAgent.rows[0]?.agent_id;
            const teamResult = await db.query<{ developer_name: string; task_title: string | null; blocker_title: string | null }>(
              `SELECT d.name AS developer_name,
                      t.title AS task_title,
                      b.title AS blocker_title
               FROM sessions s
               JOIN developers d ON d.id = s.developer_id
               LEFT JOIN LATERAL (
                 SELECT title FROM tasks WHERE workflow_id = s.workflow_id AND status = 'in_progress'
                 ORDER BY updated_at DESC LIMIT 1
               ) t ON true
               LEFT JOIN LATERAL (
                 SELECT title FROM blockers WHERE workflow_id = s.workflow_id AND status = 'open'
                 ORDER BY opened_at DESC LIMIT 1
               ) b ON true
               WHERE s.workflow_id = $1
                 AND s.ended_at IS NULL
                 AND ($2::text IS NULL OR s.agent_id != $2)
                 AND s.id != $3`,
              [wid, selfAgentId ?? null, sid]
            );
            if (teamResult.rows.length > 0) {
              const teamParts = teamResult.rows.map(r => {
                if (r.blocker_title) return `${r.developer_name} → blocked: ${r.blocker_title}`;
                if (r.task_title) return `${r.developer_name} → ${r.task_title}`;
                return `${r.developer_name} → available`;
              });
              lines.push(`Team: ${teamParts.join(" | ")}`);
            }
          } catch {}
        }

        res.type("text/plain").send(lines.join("\n"));
      } catch {
        res.type("text/plain").send("");
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
        const { task_id, actual_minutes, completion_notes } = req.body;
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
          `UPDATE tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
           actual_minutes = COALESCE($3, actual_minutes),
           completion_notes = COALESCE($4, completion_notes)
           WHERE id = $1 AND updated_at = $2`,
          [task_id, rows[0].updated_at, actual_minutes ?? null, completion_notes ?? null]
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

    // ── Observability dispatcher endpoint ─────────────────────────────────
    app.post("/hooks/event", express.json(), async (req, res) => {
      const { event, session_id, workflow_id, timestamp, ...data } = req.body;
      res.json({ ok: true });

      try {
        await routeEvent(event, session_id, workflow_id, timestamp, data);
      } catch (err) {
        process.stderr.write(`[cph] event routing error: ${err}\n`);
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

// ── Observability helpers ──────────────────────────────────────────────────────

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

async function routeEvent(
  event: string,
  sessionId: string,
  workflowId: string | null,
  timestamp: string,
  data: Record<string, unknown>
) {
  const db = await getDb();

  switch (event) {

    case "SessionStart": {
      await db.query(
        `INSERT INTO sessions (id, workflow_id, model, agent_type, source, started_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [sessionId, workflowId, data.model, data.agent_type, data.source, timestamp]
      );
      if (workflowId) {
        await db.query(
          `UPDATE workflows SET last_planning_started_at = $1 WHERE id = $2`,
          [timestamp, workflowId]
        );
      }

      // Identity + agent tracking
      const cwd = (data.cwd as string | undefined) ?? process.cwd();
      const identity = resolveIdentity(cwd);
      await upsertDeveloper(identity, db);

      const agentId = newId();
      await db.query(
        `INSERT INTO agents (id, session_id, developer_id, agent_type, model, spawned_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [agentId, sessionId, identity.id, "main", (data.model as string) ?? null, timestamp]
      );

      await db.query(
        `UPDATE sessions SET developer_id = $1, agent_id = $2 WHERE id = $3`,
        [identity.id, agentId, sessionId]
      );

      setSessionAgent(sessionId, agentId);
      setSessionDeveloper(sessionId, identity.id);

      await emitActivity({
        developer_id: identity.id,
        agent_id: agentId,
        session_id: sessionId,
        workflow_id: workflowId,
        event_type: "session_started",
        subject_type: "session",
        subject_id: sessionId,
        subject_title: `Session by ${identity.name}`,
      }, db).catch(() => {});

      break;
    }

    case "SessionEnd":
      await db.query(
        `UPDATE sessions SET ended_at = $1, exit_reason = $2 WHERE id = $3`,
        [timestamp, data.exit_reason, sessionId]
      );
      break;

    case "UserPromptSubmit":
      onUserPrompt(sessionId, timestamp);
      break;

    case "PreToolUse":
      if (data.tool_name === "TodoWrite" && data.todos) {
        await syncTodos(sessionId, workflowId, data.todos as TodoItem[], timestamp, db);
      }
      if (["Write", "Edit", "MultiEdit"].includes(data.tool_name as string)) {
        await maybeSealPlanPhase(workflowId, timestamp, db);
      }
      await onPreToolUse(sessionId, workflowId, data, timestamp, db);
      break;

    case "PostToolUse":
      await onPostToolUse(sessionId, data, timestamp, db);
      break;

    case "PostToolUseFailure":
      await db.query(
        `INSERT INTO tool_events
         (id, session_id, workflow_id, phase, tool_name, error_type, interrupted, created_at)
         VALUES ($1,$2,$3,'failure',$4,$5,$6,$7)`,
        [newId(), sessionId, workflowId, data.tool_name, data.error_type, data.interrupted, timestamp]
      );
      onPostToolUseFailure(sessionId, timestamp);
      break;

    case "Stop":
      await sealTurnThinking(sessionId, workflowId, timestamp, db);
      break;

    case "SubagentStart": {
      await db.query(
        `INSERT INTO subagents (id, session_id, workflow_id, agent_type, prompt_len, started_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [data.agent_id, sessionId, workflowId, data.agent_type, data.prompt_len, timestamp]
      );

      // Track in agents table
      const subDevId = getSessionDeveloper(sessionId);
      const parentAgentId = getSessionAgent(sessionId);
      const agentTypeMap: Record<string, string> = {
        Explore: "explore", Plan: "main", Code: "code",
        Validator: "validator", CI: "ci",
      };
      const mappedType = agentTypeMap[data.agent_type as string] ?? "external";
      await db.query(
        `INSERT INTO agents (id, session_id, developer_id, parent_agent_id, agent_type, spawned_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [data.agent_id, sessionId, subDevId, parentAgentId, mappedType, timestamp]
      );
      break;
    }

    case "SubagentStop": {
      await db.query(
        `UPDATE subagents
         SET ended_at = $1,
             files_created = $2,
             files_edited  = $3,
             files_deleted = $4
         WHERE id = $5`,
        [timestamp,
         JSON.stringify(data.files_created),
         JSON.stringify(data.files_edited),
         JSON.stringify(data.files_deleted),
         data.agent_id]
      );

      // Update agents table with stats
      const filesWritten = Array.isArray(data.files_created) ? data.files_created : [];
      const filesRead: string[] = [];
      await db.query(
        `UPDATE agents
         SET ended_at = $1,
             files_written = $2,
             files_read = $3
         WHERE id = $4`,
        [timestamp, JSON.stringify(filesWritten), JSON.stringify(filesRead), data.agent_id]
      );
      break;
    }

    case "PreCompact":
      await db.query(
        `INSERT INTO compaction_events (id, session_id, workflow_id, trigger, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId(), sessionId, workflowId, data.trigger, timestamp]
      );
      break;

    default:
      await db.query(
        `INSERT INTO tool_events (id, session_id, workflow_id, phase, tool_name, created_at)
         VALUES ($1,$2,$3,'signal',$4,$5)`,
        [newId(), sessionId, workflowId, event, timestamp]
      );
  }
}

async function syncTodos(
  sessionId: string,
  workflowId: string | null,
  todos: TodoItem[],
  timestamp: string,
  db: PGlite
) {
  if (!workflowId) return;

  for (const todo of todos) {
    const existing = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM tasks
       WHERE session_id = $1 AND title = $2 AND from_plan = true`,
      [sessionId, todo.content]
    );

    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO tasks
         (id, workflow_id, session_id, title, status, from_plan, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,true,$6,$6)`,
        [newId(), workflowId, sessionId, todo.content,
         mapTodoStatus(todo.status), timestamp]
      );
    } else {
      const row = existing.rows[0];
      const newStatus = mapTodoStatus(todo.status);
      if (row.status !== newStatus) {
        await db.query(
          `UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3`,
          [newStatus, timestamp, row.id]
        );
        if (newStatus === "in_progress") {
          await db.query(`UPDATE tasks SET started_at = $1 WHERE id = $2 AND started_at IS NULL`,
            [timestamp, row.id]);
        }
        if (newStatus === "completed") {
          await db.query(`UPDATE tasks SET completed_at = $1 WHERE id = $2`,
            [timestamp, row.id]);
        }
      }
    }
  }
}

function mapTodoStatus(s: string): string {
  return s === "completed" ? "completed"
       : s === "in_progress" ? "in_progress"
       : "pending";
}

async function maybeSealPlanPhase(
  workflowId: string | null,
  timestamp: string,
  db: PGlite
) {
  if (!workflowId) return;
  // Only seal once — clear last_planning_started_at on first write
  await db.query(
    `UPDATE workflows SET last_planning_started_at = NULL
     WHERE id = $1 AND last_planning_started_at IS NOT NULL`,
    [workflowId]
  );
}

main().catch((error: unknown) => {
  console.error("[cph] Fatal error:", error);
  process.exit(1);
});
