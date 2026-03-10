# Context Injection Robustness — TODO

## The Problem

CPH's entire bootstrap depends on Claude reading CLAUDE.md and choosing to
call `cph_session_init`. If Claude skips it — due to context compression,
instruction deprioritization, or model quirks — CPH is completely blind for
that session.

There is no MCP lifecycle event CPH can register for. MCP servers are passive.
They cannot push context into Claude's conversation unprompted.

## The Solution

`UserPromptSubmit` hooks fire before Claude processes every prompt and can
inject plain text into Claude's context via stdout. This is deterministic —
it does not depend on Claude reading or remembering anything.

CPH registers a `UserPromptSubmit` hook that:
1. Queries the daemon for current session state
2. Injects a compact context block into every prompt
3. Falls back gracefully if the daemon is down

Claude receives CPH context on every single prompt. `cph_session_init` becomes
a way to get *rich* context on demand, not the only way to get *any* context.

---

## Known Bugs to Work Around

**Bug 1: `SessionStart` hook output is never injected on new sessions.**
GitHub issue #10373 — open, unfixed. `SessionStart` hooks execute but their
stdout is silently discarded on new sessions. Do not rely on `SessionStart`
for context injection. Use `UserPromptSubmit` only.

**Bug 2: `hookSpecificOutput` JSON errors on first message.**
GitHub issue #17550. `UserPromptSubmit` hooks that output `hookSpecificOutput`
JSON show a hook error on the first message of a new session. The workaround:
output plain text only, never JSON. Plain text stdout is reliably injected.

---

## Hook: `hooks/context-inject.js`

Installed as a `UserPromptSubmit` hook. Fires on every prompt. Outputs plain
text that becomes part of Claude's context before it processes the prompt.

```javascript
#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');

const CPH_DIR   = path.join(os.homedir(), '.cph');
const PORT_FILE = path.join(CPH_DIR, 'daemon.port');

async function main() {
  // Read hook payload from stdin
  const raw = fs.readFileSync('/dev/stdin', 'utf8');
  let payload;
  try { payload = JSON.parse(raw); }
  catch { process.exit(0); }

  const cwd        = payload.cwd || process.cwd();
  const sessionId  = payload.session_id;

  // Read workflow ID
  const workflowId = readWorkflowId(cwd);

  // Get context from daemon
  const context = await fetchContext(workflowId, sessionId);

  // Output plain text only — never JSON (bug workaround)
  if (context) {
    process.stdout.write(context);
  }

  process.exit(0);
}

async function fetchContext(workflowId, sessionId) {
  const port = readPort();
  if (!port) return daemonDownMessage();

  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/hooks/context-inject?workflow_id=${workflowId ?? ''}&session_id=${sessionId ?? ''}`,
      method: 'GET',
      timeout: 1500,   // must be fast — UserPromptSubmit blocks the prompt
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(daemonDownMessage()));
    req.on('timeout', () => { req.destroy(); resolve(null); }); // silent timeout
    req.end();
  });
}

function daemonDownMessage() {
  return [
    '[cph] ⚠️  CPH daemon is not running.',
    'Run: node ~/.cph/scripts/daemon.js start',
    'Then call cph_session_init to load project context.',
  ].join('\n');
}

function readWorkflowId(cwd) {
  try { return fs.readFileSync(path.join(cwd, '.cph-workflow'), 'utf8').trim(); }
  catch { return null; }
}

function readPort() {
  try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10); }
  catch { return null; }
}

main().catch(() => process.exit(0));
```

---

## Daemon Endpoint: `GET /hooks/context-inject`

Returns a compact plain-text context block. Must respond in < 1500ms.
This is on the critical path of every prompt — keep it fast.

```typescript
app.get('/hooks/context-inject', async (req, res) => {
  const workflowId = req.query.workflow_id as string | undefined;
  const sessionId  = req.query.session_id  as string | undefined;

  res.setHeader('Content-Type', 'text/plain');

  if (!workflowId) {
    res.send(noWorkflowMessage());
    return;
  }

  try {
    const db = await getDb();
    const context = await buildContextBlock(workflowId, sessionId, db);
    res.send(context);
  } catch (err) {
    // Never error on this endpoint — silent fail is better than blocking prompts
    res.send('');
  }
});

async function buildContextBlock(
  workflowId: string,
  sessionId: string | undefined,
  db: PGlite
): Promise<string> {

  // Parallel queries — keep total under 200ms
  const [workflow, activeTasks, blockers, recentDecisions, sessionInit] =
    await Promise.all([
      db.query(
        `SELECT name, status FROM workflows WHERE id = $1`,
        [workflowId]
      ),
      db.query(
        `SELECT id, title, status, priority FROM tasks
         WHERE workflow_id = $1 AND status IN ('in_progress','pending')
         ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END,
                  CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END
         LIMIT 5`,
        [workflowId]
      ),
      db.query(
        `SELECT title, severity FROM blockers
         WHERE workflow_id = $1 AND status = 'open'
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END
         LIMIT 3`,
        [workflowId]
      ),
      db.query(
        `SELECT title FROM decisions
         WHERE workflow_id = $1
         ORDER BY created_at DESC LIMIT 3`,
        [workflowId]
      ),
      // Has cph_session_init been called this session?
      sessionId ? db.query(
        `SELECT id FROM sessions WHERE id = $1 AND workflow_id = $2`,
        [sessionId, workflowId]
      ) : Promise.resolve({ rows: [] }),
    ]);

  if (workflow.rows.length === 0) {
    return noWorkflowMessage();
  }

  const wf = workflow.rows[0];
  const sessionInitialized = (sessionInit as any).rows?.length > 0;

  const lines: string[] = [
    `[cph] ${wf.name} (${wf.status})`,
  ];

  // Active tasks
  const inProgress = activeTasks.rows.filter((t: any) => t.status === 'in_progress');
  const pending    = activeTasks.rows.filter((t: any) => t.status === 'pending');

  if (inProgress.length > 0) {
    lines.push(`Active: ${inProgress.map((t: any) => t.title).join(', ')}`);
  } else {
    lines.push(`Active: none`);
  }

  if (pending.length > 0) {
    lines.push(`Up next: ${pending.slice(0, 3).map((t: any) => t.title).join(', ')}`);
  }

  // Blockers
  if (blockers.rows.length > 0) {
    lines.push(`Blockers: ${blockers.rows.map((b: any) => `${b.title} [${b.severity}]`).join(', ')}`);
  }

  // Recent decisions (only if session not yet initialized — avoid noise on every prompt)
  if (!sessionInitialized && recentDecisions.rows.length > 0) {
    lines.push(`Recent decisions: ${recentDecisions.rows.map((d: any) => d.title).join(', ')}`);
  }

  // Call to action if session not initialized
  if (!sessionInitialized) {
    lines.push(`Call cph_session_init for full context.`);
  }

  return lines.join('\n');
}

function noWorkflowMessage(): string {
  return [
    '[cph] No workflow detected for this project.',
    'Call cph_workflow_create to set up project memory.',
  ].join('\n');
}
```

---

## What Claude Sees

On every prompt, before its own processing, Claude receives something like:

```
[cph] auth-refactor (active)
Active: Implement token refresh endpoint
Up next: Add refresh token rotation, Write integration tests
Blockers: Redis connection pooling issue [high]
```

Or on first prompt of a new session before `cph_session_init`:

```
[cph] auth-refactor (active)
Active: none
Up next: Implement token refresh endpoint, Add refresh token rotation
Recent decisions: Use Redis for token storage, JWT RS256 signing
Call cph_session_init for full context.
```

Or if daemon is down:

```
[cph] ⚠️  CPH daemon is not running.
Run: node ~/.cph/scripts/daemon.js start
Then call cph_session_init to load project context.
```

This appears in Claude's context on every single prompt — silently, without
any tool call, without Claude needing to remember anything.

---

## Design Constraints

**Must be fast.** `UserPromptSubmit` blocks the prompt until the hook exits.
Target: < 200ms end-to-end. The 1500ms timeout is a hard ceiling, not a goal.
Parallel DB queries, no sequential awaits in `buildContextBlock`.

**Must never error.** Any exception → exit 0, no output. A broken hook that
exits non-zero will show an error on every prompt. That is far worse than
missing context.

**Must be small.** The context block adds tokens to every single prompt in the
session. Keep it under ~100 tokens. The current format is ~30-60 tokens.
Full context (all tasks, all decisions, full text) belongs in `cph_session_init`
— not here.

**Plain text only.** No JSON output. See Bug 2 above. The `hookSpecificOutput`
format errors on first message. Plain text is always safe.

**Silent on timeout.** If the daemon takes > 1500ms, output nothing. Slow
daemon = no context injection for that prompt. This is acceptable. Hanging
the prompt indefinitely is not.

---

## Session Initialization State

The endpoint checks whether `cph_session_init` has been called this session
by looking for a `sessions` row with both `session_id` and `workflow_id` set.

This determines what to inject:
- **Not initialized** → include recent decisions + CTA to call session_init
- **Initialized** → omit decisions and CTA (Claude already has full context)

This means the injection is adaptive. Early in a session it nudges Claude
toward full initialization. After initialization it provides only the live
operational state (active tasks, blockers) as a lightweight running reminder.

---

## `enforce-task.js` Upgrade

The existing enforce-task hook blocks file writes without an active task but
its error message currently just says "no active task." Upgrade it to
reference the injected context:

```javascript
// In enforce-task.js, when blocking:
const output = {
  decision: 'block',
  reason: [
    '[cph] No active task.',
    'You have context from cph in your conversation.',
    'Call cph_task_start to begin a task, or cph_task_create if none exist.',
    'Check the [cph] lines at the top of your context for current state.',
  ].join('\n'),
};
process.stdout.write(JSON.stringify(output));
process.exit(0);
```

Now the block message references the injected context directly, creating a
coherent loop: Claude sees the CPH state at the top of every prompt, and the
enforce-task hook references it when something goes wrong.

---

## Installing the Hook

`scripts/install.js` — add `UserPromptSubmit` entry:

```javascript
const settings = readSettings(); // reads .claude/settings.json

// Add to UserPromptSubmit array (don't overwrite existing entries)
const hookEntry = {
  hooks: [{
    type: 'command',
    command: 'node ~/.cph/hooks/context-inject.js',
  }]
};

if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

// Check not already installed
const alreadyInstalled = settings.hooks.UserPromptSubmit
  .some(h => h.hooks?.some(c => c.command?.includes('context-inject')));

if (!alreadyInstalled) {
  settings.hooks.UserPromptSubmit.push(hookEntry);
  writeSettings(settings);
}
```

---

## Interaction with Existing Hooks

| Hook | Purpose | Relation to context-inject |
|---|---|---|
| `context-inject.js` | **Inject CPH state into every prompt** | New — this TODO |
| `dispatcher.js` | Observe all events, send to daemon | Separate, unaffected |
| `enforce-task.js` | Block writes without active task | Updated to reference injected context |
| `session-end.js` | Block stop if tasks in_progress | Unaffected |
| `post-commit.js` | Attach commit to task | Unaffected |

The dispatcher and context-inject hooks both fire on some of the same events
but do completely different things. Dispatcher is observation-only outbound.
Context-inject is injection-only inbound. No conflict.

---

## Files Changed

| File | Change |
|---|---|
| `hooks/context-inject.js` | New — UserPromptSubmit context injector |
| `src/index.ts` | New endpoint: `GET /hooks/context-inject` |
| `hooks/enforce-task.js` | Updated block message to reference injected context |
| `scripts/install.js` | Add context-inject to UserPromptSubmit hooks |
| `dist/` | Rebuild |

---

## Implementation Order

1. `GET /hooks/context-inject` — daemon endpoint, parallel queries, plain text output
2. Unit test: query performance < 50ms on a DB with 100 tasks
3. `hooks/context-inject.js` — hook script, 1500ms timeout, silent failure
4. `scripts/install.js` — add to UserPromptSubmit
5. `hooks/enforce-task.js` — updated block message
6. Build + update `dist/`
7. Install, start a new session, verify `[cph]` line appears before first response
8. Kill daemon, verify hook outputs warning message not an error
9. Verify hook adds < 200ms to prompt latency (check with Ctrl+O verbose mode)
10. Verify after `cph_session_init` is called, the CTA line disappears from
    subsequent prompts

---

## Future: PreCompact Injection

`PreCompact` fires before context compaction and also supports `additionalContext`.
This is the second critical injection point — when Claude's context is about
to be compressed, CPH should inject a compact summary of current state so it
survives the compaction.

This is a separate TODO but shares the same `buildContextBlock` endpoint.
The PreCompact version should include slightly more (recent decisions, full
task list) since this is a one-time preservation opportunity, not a
per-prompt injection.
