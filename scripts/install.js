#!/usr/bin/env node
/**
 * Claude Project History Install Script
 *
 * Run: npm run install-hooks
 *
 * What this does:
 *   1. Creates .claude/settings.json with hook config
 *   2. Installs post-commit git hook
 *   3. Prompts for workflow ID and creates .cph-workflow
 *   4. Generates CLAUDE.md snippet
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const __dirname = typeof import.meta.dirname !== "undefined"
  ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = resolve(__dirname, "..");
const CWD = process.cwd();

async function main() {
  console.log("\n🧠 Claude Project History Install\n");

  // ── 1. Claude Code hooks ───────────────────────────────────────────────────
  const claudeDir = join(CWD, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  mkdirSync(claudeDir, { recursive: true });

  const hookScript = join(HOOKS_DIR, "hooks", "enforce-task.js");
  const contextInjectScript = join(HOOKS_DIR, "hooks", "context-inject.js");
  const sessionEndScript = join(HOOKS_DIR, "hooks", "session-end.js");
  const dispatcherScript = join(HOOKS_DIR, "hooks", "dispatcher.js");

  let existingSettings = {};
  if (existsSync(settingsPath)) {
    try {
      existingSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {}
  }

  // Helper: filter out old dispatcher entries from an event's hook array
  const withoutDispatcher = (arr) =>
    (arr ?? []).filter((h) => !h.hooks?.some?.((hh) => hh.command?.includes("dispatcher")));

  const dispatcherEntry = (matcher) => matcher
    ? { matcher, hooks: [{ type: "command", command: `node ${dispatcherScript}` }] }
    : { hooks: [{ type: "command", command: `node ${dispatcherScript}` }] };

  const existingHooks = existingSettings.hooks ?? {};

  const newSettings = {
    ...existingSettings,
    hooks: {
      ...existingHooks,
      SessionStart: [
        ...withoutDispatcher(existingHooks.SessionStart),
        dispatcherEntry(),
      ],
      SessionEnd: [
        ...withoutDispatcher(existingHooks.SessionEnd),
        dispatcherEntry(),
      ],
      UserPromptSubmit: [
        ...withoutDispatcher(existingHooks.UserPromptSubmit).filter(
          (h) => !h.hooks?.some?.((hh) => hh.command?.includes("context-inject"))
        ),
        { hooks: [{ type: "command", command: `node ${contextInjectScript}` }] },
        dispatcherEntry(),
      ],
      PreToolUse: [
        ...withoutDispatcher(existingHooks.PreToolUse).filter(
          (h) => !h.hooks?.some?.((hh) => hh.command?.includes("enforce-task"))
        ),
        {
          matcher: "Write|Edit|MultiEdit",
          hooks: [{ type: "command", command: `node ${hookScript}` }]
        },
        dispatcherEntry(".*"),
      ],
      PostToolUse: [
        ...withoutDispatcher(existingHooks.PostToolUse),
        dispatcherEntry(".*"),
      ],
      PostToolUseFailure: [
        ...withoutDispatcher(existingHooks.PostToolUseFailure),
        dispatcherEntry(),
      ],
      Stop: [
        ...withoutDispatcher(existingHooks.Stop).filter(
          (h) => !h.hooks?.some?.((hh) => hh.command?.includes("session-end"))
        ),
        {
          hooks: [{ type: "command", command: `node ${sessionEndScript}` }]
        },
        dispatcherEntry(),
      ],
      SubagentStart: [
        ...withoutDispatcher(existingHooks.SubagentStart),
        dispatcherEntry(),
      ],
      SubagentStop: [
        ...withoutDispatcher(existingHooks.SubagentStop),
        dispatcherEntry(),
      ],
      PreCompact: [
        ...withoutDispatcher(existingHooks.PreCompact),
        dispatcherEntry(),
      ],
      Notification: [
        ...withoutDispatcher(existingHooks.Notification),
        dispatcherEntry(),
      ],
    }
  };

  writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));
  console.log(`✓ Claude Code hooks written to .claude/settings.json`);

  // ── 2. Git post-commit hook ────────────────────────────────────────────────
  const gitHooksDir = join(CWD, ".git", "hooks");
  if (existsSync(join(CWD, ".git"))) {
    const postCommitPath = join(gitHooksDir, "post-commit");
    const postCommitContent = `#!/bin/sh\nnode ${join(HOOKS_DIR, "hooks", "post-commit.js")}\n`;
    writeFileSync(postCommitPath, postCommitContent);
    chmodSync(postCommitPath, 0o755);
    console.log(`✓ Git post-commit hook installed`);
  } else {
    console.log(`⚠ No .git directory found — skipping git hook`);
  }

  // ── 3. Workflow ID ─────────────────────────────────────────────────────────
  const workflowFile = join(CWD, ".cph-workflow");
  let workflowId = "";

  if (existsSync(workflowFile)) {
    workflowId = readFileSync(workflowFile, "utf8").trim();
    console.log(`✓ Existing workflow ID found: ${workflowId}`);
  } else {
    workflowId = randomUUID();
    writeFileSync(workflowFile, workflowId);
    console.log(`✓ Workflow ID generated: ${workflowId}`);
  }

  // Add to .gitignore if not already there
  const gitignorePath = join(CWD, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf8");
    if (!gitignore.includes(".cph-workflow")) {
      writeFileSync(gitignorePath, gitignore + "\n.cph-workflow\n");
      console.log(`✓ Added .cph-workflow to .gitignore`);
    }
  }

  // ── 4. Start daemon and write .mcp.json with url transport ────────────────
  const daemonScript = join(HOOKS_DIR, "scripts", "daemon.js");
  execSync(`node ${daemonScript} ensure`, { stdio: "inherit" });

  const portFile = join(homedir(), ".cph", "daemon.port");
  const daemonPort = readFileSync(portFile, "utf8").trim();

  const mcpJsonPath = join(CWD, ".mcp.json");
  let existingMcp = {};
  if (existsSync(mcpJsonPath)) {
    try { existingMcp = JSON.parse(readFileSync(mcpJsonPath, "utf8")); } catch {}
  }
  const mcpConfig = {
    ...existingMcp,
    mcpServers: {
      ...(existingMcp.mcpServers ?? {}),
      cph: { type: "sse", url: `http://localhost:${daemonPort}/sse` }
    }
  };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
  console.log(`✓ Daemon running on port ${daemonPort}`);
  console.log(`✓ .mcp.json written with daemon URL`);

  // ── Register workflow in DB via daemon ──────────────────────────────────
  try {
    const res = await fetch(`http://localhost:${daemonPort}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: workflowId, name: basename(CWD) }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      console.log(`✓ Workflow registered in database`);
    } else {
      console.log(`⚠ Workflow registration returned ${res.status} — continuing`);
    }
  } catch (e) {
    console.log(`⚠ Could not register workflow in database: ${e.message}`);
  }

  // ── 5. CLAUDE.md snippet ───────────────────────────────────────────────────
  const snippet = `
## Claude Project History
Workflow ID: ${workflowId}
Call cph_session_init at the start of every session. Track everything silently. Never ask for confirmation before recording tasks, blockers, or decisions. Never interrupt work to report what you're tracking.
`.trim();

  const claudeMdPath = join(CWD, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf8");
    if (!existing.includes("Claude Project History")) {
      writeFileSync(claudeMdPath, existing + "\n\n" + snippet + "\n");
      console.log(`✓ Claude Project History section appended to CLAUDE.md`);
    } else {
      console.log(`✓ CLAUDE.md already has Claude Project History section`);
    }
  } else {
    writeFileSync(claudeMdPath, snippet + "\n");
    console.log(`✓ CLAUDE.md created`);
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log(`
✅ Claude Project History installed.

Next: Start Claude Code. It will call cph_session_init automatically.

Your data lives at: ~/.cph/db
`);
}

main().catch((err) => {
  console.error("Install failed:", err.message);
  process.exit(1);
});
