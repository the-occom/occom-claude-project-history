#!/usr/bin/env node
/**
 * Claude Project History — Observability Dispatcher
 *
 * Single hook entry point for all 17 Claude Code hookable events.
 * Reads stdin, extracts relevant fields (strips PII/content),
 * POSTs to daemon, and always exits 0 (never blocks).
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { request } from "http";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_SCRIPT = join(__dirname, "..", "scripts", "daemon.js");
const CPH_DIR = join(homedir(), ".cph");
const PORT_FILE = join(CPH_DIR, "daemon.port");

function ensureDaemon() {
  try {
    execFileSync(process.execPath, [DAEMON_SCRIPT, "ensure"], {
      stdio: "ignore", timeout: 10_000,
    });
  } catch {}
}

function readPort() {
  try { return parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10); }
  catch { return null; }
}

function readWorkflowId(cwd) {
  try {
    const file = join(cwd || process.cwd(), ".cph-workflow");
    return readFileSync(file, "utf8").trim();
  } catch { return null; }
}

function extract(event, p) {
  switch (event) {

    case "SessionStart":
      return {
        model:      p.model,
        agent_type: p.agent_type,
        source:     p.source,
      };

    case "SessionEnd":
      return { exit_reason: p.exit_reason };

    case "UserPromptSubmit":
      return {
        prompt_length: (p.prompt || "").length,
        turn: true,
      };

    case "PreToolUse": {
      const tool = p.tool_name;
      const base = { tool_name: tool };

      if (tool === "TodoWrite") {
        return { ...base, todos: p.tool_input?.todos || [] };
      }
      if (["Write", "Edit", "MultiEdit"].includes(tool)) {
        return { ...base, file_path: p.tool_input?.file_path };
      }
      if (tool === "Bash") {
        return { ...base, command: (p.tool_input?.command || "").slice(0, 200) };
      }
      if (["Read", "Glob", "Grep", "LS"].includes(tool)) {
        return { ...base, path: p.tool_input?.file_path || p.tool_input?.pattern };
      }
      if (tool === "Task") {
        return { ...base, description: (p.tool_input?.description || "").slice(0, 300) };
      }
      return base;
    }

    case "PostToolUse": {
      const tool = p.tool_name;
      const base = {
        tool_name: tool,
        duration_ms: p.duration_ms,
        success: !p.tool_response?.error,
      };
      if (["Write", "Edit", "MultiEdit"].includes(tool)) {
        return { ...base, file_path: p.tool_input?.file_path };
      }
      if (tool === "Bash") {
        return { ...base, exit_code: p.tool_response?.exit_code };
      }
      return base;
    }

    case "PostToolUseFailure":
      return {
        tool_name:   p.tool_name,
        interrupted: p.interrupted,
        error_type:  (p.tool_response?.error || "").slice(0, 100),
      };

    case "PermissionRequest":
      return { tool_name: p.tool_name };

    case "Stop":
      return {
        turn_complete: true,
        has_summary: !!p.summary,
      };

    case "SubagentStart":
      return {
        agent_id:   p.agent_id,
        agent_type: p.agent_type,
        prompt_len: (p.prompt || "").length,
      };

    case "SubagentStop":
      return {
        agent_id:      p.agent_id,
        agent_type:    p.agent_type,
        files_created: p.new_files     || [],
        files_edited:  p.edited_files  || [],
        files_deleted: p.deleted_files || [],
      };

    case "PreCompact":
      return { trigger: p.trigger };

    case "Notification":
      return { notification_type: p.notification_type };

    default:
      return null;
  }
}

async function main() {
  let raw;
  try { raw = readFileSync("/dev/stdin", "utf8"); }
  catch { process.exit(0); }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { process.exit(0); }

  const event = payload.hook_event_name;
  const sessionId = payload.session_id;

  const extracted = extract(event, payload);
  if (!extracted) process.exit(0);

  const workflowId = readWorkflowId(payload.cwd);

  ensureDaemon();

  const port = readPort();
  if (!port) process.exit(0);

  const body = JSON.stringify({
    event,
    session_id: sessionId,
    workflow_id: workflowId,
    cwd: payload.cwd,
    timestamp: new Date().toISOString(),
    ...extracted,
  });

  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/hooks/event",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    timeout: 1500,
  });
  req.on("error", () => {});
  req.write(body);
  req.end();
}

main().catch(() => process.exit(0));
