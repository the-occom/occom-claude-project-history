import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, newId, findOne } from "../db.js";
import { getGitContext, inferWorkflowNameFromBranch, branchMatchesPattern } from "../services/git.js";
import { buildSessionContext } from "../services/retrieval.js";
import { runCompression, getStorageSummary } from "../services/compressor.js";
import { contextSync, registerSession } from "../services/context.js";
import type { Workflow, RetrievalDepth, EngineerPreference } from "../types.js";

export function registerSessionTools(server: McpServer, sessionId: string): void {
  registerSession(sessionId);

  // ── SESSION INIT ─────────────────────────────────────────────────────────────
  server.registerTool(
    "cph_session_init",
    {
      title: "Initialize Claude Project History Session",
      description: `CALL THIS FIRST at the start of every Claude Code session.

Returns the minimum context needed to orient yourself: active tasks, open blockers,
and decisions relevant to the files you're currently working on.

This is the ONLY tool you need to call proactively. Everything else is on-demand.

Args:
  - workflow_id: The workflow for this project (from CLAUDE.md)
  - cwd: Current working directory (pass process.cwd() equivalent)
  - depth: How much context to load
      minimal  = active tasks + open blockers only (~300 tokens)
      standard = + relevant decisions (~600 tokens, DEFAULT)
      deep     = + teammate activity + patterns (~1200 tokens)

Returns: SessionContext with workflow state, active work, open blockers, relevant decisions, and a hint.

After calling this, DO NOT call workflow_summary, task_list, or decision_list
unless the user explicitly asks. Pull individual records on demand with their ID.`,
      inputSchema: {
        workflow_id: z.string().uuid().describe("Workflow ID from CLAUDE.md"),
        cwd: z.string().optional().describe("Current working directory for git context"),
        depth: z.enum(["minimal", "standard", "deep"]).default("standard")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id, cwd, depth }) => {
      try {
        const db = await getDb();
        const gitContext = getGitContext(cwd);

        let resolvedDepth: RetrievalDepth = depth;
        if (gitContext.engineer_id) {
          const pref = await findOne<EngineerPreference>(
            db,
            `SELECT * FROM engineer_preferences WHERE engineer_id = $1`,
            [gitContext.engineer_id]
          );
          if (pref) resolvedDepth = pref.retrieval_depth;
        }

        const context = await buildSessionContext(
          db,
          workflow_id,
          resolvedDepth,
          gitContext,
          gitContext.engineer_id
        );

        runCompression(db).catch(() => {});

        return {
          content: [{ type: "text", text: JSON.stringify(context, null, 2) }]
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true
        };
      }
    }
  );

  // ── AUTO DETECT WORKFLOW ─────────────────────────────────────────────────────
  server.registerTool(
    "cph_detect_workflow",
    {
      title: "Detect Workflow from Git Context",
      description: `Detect which workflow matches the current git branch.

Call this if you don't have a workflow_id in CLAUDE.md yet, or if you're
on an unfamiliar branch and want to know if a workflow already exists for it.

Returns either a matched workflow or a suggestion to create one.`,
      inputSchema: {
        cwd: z.string().optional().describe("Working directory for git detection")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ cwd }) => {
      try {
        const db = await getDb();
        const gitContext = getGitContext(cwd);

        if (!gitContext.branch) {
          return {
            content: [{ type: "text", text: JSON.stringify({ matched: false, reason: "Not in a git repository" }) }]
          };
        }

        const workflows = await db.query<Workflow>(
          `SELECT * FROM workflows WHERE status = 'active' AND git_branch_pattern IS NOT NULL`
        );

        for (const wf of workflows.rows) {
          if (wf.git_branch_pattern && branchMatchesPattern(gitContext.branch, wf.git_branch_pattern)) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  matched: true,
                  workflow: { id: wf.id, name: wf.name, status: wf.status },
                  branch: gitContext.branch
                }, null, 2)
              }]
            };
          }
        }

        const suggestedName = inferWorkflowNameFromBranch(gitContext.branch);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              matched: false,
              branch: gitContext.branch,
              suggestion: {
                name: suggestedName,
                git_branch_pattern: `${gitContext.branch.split("/")[0]}/*`,
                action: "Call cph_workflow_create with this name to start tracking"
              }
            }, null, 2)
          }]
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── SET PREFERENCE ───────────────────────────────────────────────────────────
  server.registerTool(
    "cph_set_depth",
    {
      title: "Set Retrieval Depth Preference",
      description: `Set your personal retrieval depth preference for session init.

This is saved by your git email and applied automatically on every future session.

minimal  = active tasks + open blockers only (fastest, smallest context cost)
standard = + relevant decisions (default, recommended)
deep     = + teammate activity + historical patterns (use when debugging complex issues)`,
      inputSchema: {
        depth: z.enum(["minimal", "standard", "deep"]),
        engineer_id: z.string().optional().describe("Your git email. Auto-detected if omitted.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ depth, engineer_id }) => {
      try {
        const db = await getDb();
        const gitContext = getGitContext();
        const resolvedId = engineer_id ?? gitContext.engineer_id;

        if (!resolvedId) {
          return {
            content: [{ type: "text", text: "Error: Could not detect engineer ID. Pass engineer_id explicitly or set git config user.email" }],
            isError: true
          };
        }

        const id = newId();
        await db.query(
          `INSERT INTO engineer_preferences (id, engineer_id, retrieval_depth)
           VALUES ($1, $2, $3)
           ON CONFLICT (engineer_id) DO UPDATE SET retrieval_depth = $3, updated_at = NOW()`,
          [id, resolvedId, depth]
        );

        return {
          content: [{ type: "text", text: JSON.stringify({ engineer_id: resolvedId, depth, saved: true }, null, 2) }]
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── STATUS ───────────────────────────────────────────────────────────────────
  server.registerTool(
    "cph_status",
    {
      title: "Claude Project History Status",
      description: `Get overall Claude Project History status: storage summary and active workflow count.

Use this to check that the plugin is working, not to get project context.
For project context, use cph_session_init.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const db = await getDb();
        const storage = await getStorageSummary(db);
        const activeWfs = await db.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM workflows WHERE status = 'active'`
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "ok",
              storage,
              active_workflows: parseInt(activeWfs.rows[0]?.count ?? "0"),
              db_location: `~/.cph/db`
            }, null, 2)
          }]
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── CONTEXT SYNC ────────────────────────────────────────────────────────────
  server.registerTool(
    "cph_context_sync",
    {
      title: "Sync Context",
      description: `Synchronize project context with the database.

Call this at the start of every session and after completing each task.

First call (or full_refresh=true): returns full context snapshot like session_init.
Subsequent calls: returns only changes (deltas) since last sync, within token budget.

If a tool returns a conflict error, call this to get current state before retrying.

Args:
  - workflow_id: The workflow for this project (from CLAUDE.md)
  - cwd: Current working directory for git context
  - depth: How much context to load (minimal | standard | deep)
  - full_refresh: Force a full snapshot instead of deltas

Returns: { context, deltas, synced_at }`,
      inputSchema: {
        workflow_id: z.string().uuid().describe("Workflow ID from CLAUDE.md"),
        cwd: z.string().optional().describe("Current working directory for git context"),
        depth: z.enum(["minimal", "standard", "deep"]).default("standard"),
        full_refresh: z.boolean().default(false).describe("Force full snapshot instead of deltas")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workflow_id, cwd, depth, full_refresh }) => {
      try {
        const result = await contextSync(sessionId, workflow_id, cwd, depth, full_refresh);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
