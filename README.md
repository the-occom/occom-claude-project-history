# Claude Project History MCP Server

Invisible project intelligence for Claude Code. Tracks workflows, tasks, blockers, and decisions locally. Zero Docker. Zero cloud. Just works.

Data lives in PGlite (Postgres WASM) at `~/.cph/db`.

---

## Install

```bash
git clone <repo>
cd occom-claude-project-history
npm install
npm run build
npm run install-hooks   # wires Claude Code hooks + git hook + CLAUDE.md
```

## Register with Claude Code

Add to `~/.claude.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "cph": {
      "command": "node",
      "args": ["/absolute/path/to/occom-claude-project-history/dist/index.js"]
    }
  }
}
```

---

## How it works

**You do nothing.** Claude Code does everything.

At session start, Claude Code calls `cph_session_init` automatically (via CLAUDE.md).
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
| `cph_session_init` | Start of every session — auto via CLAUDE.md |
| `cph_detect_workflow` | When on a new branch with no workflow yet |
| `cph_set_depth` | Once, to set your preferred context depth |
| `cph_status` | To verify the plugin is working |

### Workflows
| Tool | Description |
|------|-------------|
| `cph_workflow_create` | Create workflow — do this once per project/branch |
| `cph_workflow_list` | List all workflows |
| `cph_workflow_summary` | Task counts, blocker count, estimation accuracy |
| `cph_workflow_update` | Update name, status, branch pattern |

### Tasks
| Tool | When |
|------|------|
| `cph_task_create` | Before starting any discrete piece of work |
| `cph_task_start` | Immediately after create — sets status + start time |
| `cph_task_complete` | When done — provide actual_minutes |
| `cph_task_get` | Full details including subtasks + blockers |
| `cph_task_list` | List tasks (paginated, summaries only) |
| `cph_task_update` | Update title/description/priority |

### Blockers
| Tool | When |
|------|------|
| `cph_blocker_create` | **Immediately** when blocked — before asking for help |
| `cph_blocker_resolve` | When unblocked — always provide resolution text |
| `cph_blocker_escalate` | When blocker needs urgent human attention |
| `cph_blocker_list` | List open/resolved blockers |

### Decisions
| Tool | When |
|------|------|
| `cph_decision_record` | When choosing between approaches |
| `cph_decision_search` | **Before** any architectural choice |
| `cph_decision_get` | Full details on a specific decision |
| `cph_decision_list` | List decisions (summaries only) |
| `cph_decision_attach_commit` | Called by git hook automatically |

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
cph_set_depth with depth="minimal"
```

---

## Retrieval design

**Lists return IDs + titles only.** Full content requires a specific ID lookup.
This is intentional — prevents context flood on large projects.

Pattern for using decisions:
1. `cph_decision_search` with keyword → get IDs
2. `cph_decision_get` with specific ID → get full record

Never load all decisions. Pull what you need.

---

## Data

```
~/.cph/db/    ← PGlite database
.cph-workflow ← current project's workflow ID (gitignored)
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
