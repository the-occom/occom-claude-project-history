# FlowMind MCP Server

Invisible project intelligence for Claude Code. Tracks workflows, tasks, blockers, and decisions locally. Zero Docker. Zero cloud. Just works.

Data lives in PGlite (Postgres WASM) at `~/.flowmind/db`.

---

## Install

```bash
git clone <repo>
cd flowmind-mcp-server
npm install
npm run build
npm run install-hooks   # wires Claude Code hooks + git hook + CLAUDE.md
```

## Register with Claude Code

Add to `~/.claude.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "flowmind": {
      "command": "node",
      "args": ["/absolute/path/to/flowmind-mcp-server/dist/index.js"]
    }
  }
}
```

---

## How it works

**You do nothing.** Claude Code does everything.

At session start, Claude Code calls `flowmind_session_init` automatically (via CLAUDE.md).
It gets back a minimal context — active tasks, open blockers, relevant decisions — under 600 tokens.
Then it works. Tasks, blockers, and decisions are recorded silently as side effects.

The hook system enforces this:
- `PreToolUse` on Write/Edit/MultiEdit → **blocks file writes if no active task**
- `Stop` → surfaces incomplete tasks and open blockers at session end
- `post-commit` git hook → silently links commits to recent decisions

---

## Tools

### Session (call these)
| Tool | When |
|------|------|
| `flowmind_session_init` | Start of every session — auto via CLAUDE.md |
| `flowmind_detect_workflow` | When on a new branch with no workflow yet |
| `flowmind_set_depth` | Once, to set your preferred context depth |
| `flowmind_status` | To verify the plugin is working |

### Workflows
| Tool | Description |
|------|-------------|
| `flowmind_workflow_create` | Create workflow — do this once per project/branch |
| `flowmind_workflow_list` | List all workflows |
| `flowmind_workflow_summary` | Task counts, blocker count, estimation accuracy |
| `flowmind_workflow_update` | Update name, status, branch pattern |

### Tasks
| Tool | When |
|------|------|
| `flowmind_task_create` | Before starting any discrete piece of work |
| `flowmind_task_start` | Immediately after create — sets status + start time |
| `flowmind_task_complete` | When done — provide actual_minutes |
| `flowmind_task_get` | Full details including subtasks + blockers |
| `flowmind_task_list` | List tasks (paginated, summaries only) |
| `flowmind_task_update` | Update title/description/priority |

### Blockers
| Tool | When |
|------|------|
| `flowmind_blocker_create` | **Immediately** when blocked — before asking for help |
| `flowmind_blocker_resolve` | When unblocked — always provide resolution text |
| `flowmind_blocker_escalate` | When blocker needs urgent human attention |
| `flowmind_blocker_list` | List open/resolved blockers |

### Decisions
| Tool | When |
|------|------|
| `flowmind_decision_record` | When choosing between approaches |
| `flowmind_decision_search` | **Before** any architectural choice |
| `flowmind_decision_get` | Full details on a specific decision |
| `flowmind_decision_list` | List decisions (summaries only) |
| `flowmind_decision_attach_commit` | Called by git hook automatically |

---

## Context depth

Set once per engineer, remembered forever:

```
minimal  = active tasks + open blockers (~300 tokens)
standard = + relevant decisions (~600 tokens) ← default
deep     = + teammate activity (~1200 tokens)
```

```
# In Claude Code:
flowmind_set_depth with depth="minimal"
```

---

## Retrieval design

**Lists return IDs + titles only.** Full content requires a specific ID lookup.
This is intentional — prevents context flood on large projects.

Pattern for using decisions:
1. `flowmind_decision_search` with keyword → get IDs
2. `flowmind_decision_get` with specific ID → get full record

Never load all decisions. Pull what you need.

---

## Data

```
~/.flowmind/db/    ← PGlite database
.flowmind-workflow ← current project's workflow ID (gitignored)
```

**Compression runs automatically** at session end:
- Decisions > 30 days: rationale/alternatives discarded, title+decision kept
- Completed tasks > 7 days: description discarded, timing data kept
- Resolved blockers > 7 days: description discarded, title+resolution kept

**Upgrade trigger:** When a second engineer joins, this local DB can't be shared.
That's the moment to move to the hosted tier for atomic multi-user writes.

---

## What's deliberately NOT here

- **No GraphQL** — direct PGlite queries until multi-user sync is needed
- **No cloud sync** — single-user local only; team sync is the paid tier
- **No ML inference** — estimation intelligence is server-side (paid tier)
- **No semantic search** — structural matching only; local LLM is enterprise tier
- **No auth** — local tool, no auth needed
