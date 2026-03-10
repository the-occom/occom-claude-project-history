# CPH — Claude Project History

**Version:** 0.5.0
**Schema Version:** 5

## Overview

Invisible project intelligence for Claude Code. Tracks workflows, tasks, blockers, decisions, sessions, tool events, and inferred thinking time locally with PGlite.

## Architecture

- **MCP Server** — Exposes tools via stdio or SSE transport
- **Daemon** — Express server on `:3741` (MCP + hooks + REST API)
- **Debug UI** — Express server on `:3742` (read-only dashboard)
- **Database** — PGlite (embedded Postgres) at `~/.cph/db`
- **Notifications** — `pg_notify` channel `cph_changes` for real-time updates

## Tables (11)

| Table | Purpose |
|-------|---------|
| `workflows` | Project-level grouping |
| `tasks` | Work items within workflows |
| `blockers` | Impediments linked to tasks/workflows |
| `decisions` | Architectural decision records |
| `engineer_preferences` | Per-engineer retrieval depth |
| `sessions` | Claude Code session tracking |
| `tool_events` | Per-tool-call observability (pre/post timestamps, execution_ms, gap_after_ms) |
| `subagents` | Subagent lifecycle tracking |
| `compaction_events` | Context compaction events |
| `thinking_estimates` | Per-turn inferred thinking time breakdown |
| `tool_baselines` | Rolling avg/p50/p95 per tool (auto-updated) |

## MCP Tools (26)

### Core
| Tool | Description |
|------|-------------|
| `cph_session_init` | Initialize session, detect workflow, return context |
| `cph_context_sync` | Refresh context mid-session |
| `cph_set_depth` | Set retrieval depth (minimal/standard/deep) |
| `cph_status` | Quick status summary |
| `cph_detect_workflow` | Auto-detect workflow from git branch |

### Workflows
| Tool | Description |
|------|-------------|
| `cph_workflow_create` | Create a new workflow |
| `cph_workflow_list` | List all workflows |
| `cph_workflow_summary` | Detailed workflow summary with stats |
| `cph_workflow_update` | Update workflow fields |

### Tasks
| Tool | Description |
|------|-------------|
| `cph_task_create` | Create a task in a workflow |
| `cph_task_get` | Get full task details |
| `cph_task_list` | List tasks with filters |
| `cph_task_start` | Move task to in_progress |
| `cph_task_complete` | Complete a task with notes |
| `cph_task_cancel` | Cancel a task |
| `cph_task_update` | Update task fields |

### Blockers
| Tool | Description |
|------|-------------|
| `cph_blocker_create` | Create a blocker |
| `cph_blocker_list` | List blockers with filters |
| `cph_blocker_resolve` | Resolve a blocker |
| `cph_blocker_escalate` | Escalate a blocker |

### Decisions
| Tool | Description |
|------|-------------|
| `cph_decision_record` | Record a decision |
| `cph_decision_search` | Search decisions by keyword |
| `cph_decision_get` | Get full decision details |
| `cph_decision_list` | List decisions for a workflow |
| `cph_decision_attach_commit` | Attach commit hash (called by git hook) |

### Thinking
| Tool | Description |
|------|-------------|
| `cph_thinking_summary` | Get inferred thinking-time breakdown |

## Thinking Time Inference (v0.5.0)

Claude Code's extended thinking is not hookable. The observability system captures timestamps for every tool boundary. The time between `PostToolUse` and the next `PreToolUse` (or `Stop`) is inferred thinking time.

### How it works

1. **UserPromptSubmit** — Increments turn counter, records prompt timestamp
2. **PreToolUse** — INSERTs a `tool_events` row with `phase='pre'` and `pre_timestamp`. Fills `gap_after_ms` on the previous row.
3. **PostToolUse** — UPDATEs the matching pre row to `phase='complete'`, sets `post_timestamp`, computes `execution_ms`. Fallback INSERT if no match.
4. **Stop** — Seals the turn: computes initial gap (prompt -> first tool), interleaved gaps (between tools + final gap), stores in `thinking_estimates`, updates `tool_baselines`.

### In-memory state

`Map<sessionId, TurnState>` tracks per-session turn progress. Lost on daemon restart (acceptable -- only affects the current turn).

### Baselines

Tool baselines (avg/p50/p95) are computed from all completed tool events with `execution_ms`. Requires min 3 samples per tool. Seeded with reasonable defaults for 10 common tools.

### Caveats

- Inferred thinking time includes network latency, user approval wait time, and non-tool processing
- Actual extended thinking time may differ
- Baselines improve with more data
- Turn state is lost on daemon restart

## Hook Events

The daemon accepts POST `/hooks/event` with:
- `SessionStart` / `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse` / `PostToolUse` / `PostToolUseFailure`
- `Stop`
- `SubagentStart` / `SubagentStop`
- `PreCompact`

## Debug UI

Available at `http://localhost:3742` with panels:
- Overview, Workflows, Tasks, Blockers, Decisions
- Sessions, Timeline, Events, **Thinking**, Insights
- SQL Query (read-only)

The Thinking panel shows:
- Aggregate stats (turns analyzed, total thinking, total tool time, thinking %)
- Per-turn stacked horizontal bars (blue=initial gap, purple=interleaved, teal=tool)
- Tool baselines table
- Caveat text

## Changelog

### v0.5.0 — Thinking Time Inference
- Added `thinking_estimates` and `tool_baselines` tables
- Added `pre_timestamp`, `post_timestamp`, `execution_ms`, `gap_after_ms` to `tool_events`
- New `src/thinking.ts` core module with in-memory turn state
- New `cph_thinking_summary` MCP tool
- Thinking panel in debug UI
- Schema version 4 -> 5

### v0.4.0 — Observability
- Added `sessions`, `tool_events`, `subagents`, `compaction_events` tables
- Session tracking, tool event capture
- Debug UI with timeline, sessions, events panels

### v0.3.0 — Real-time Notifications
- Added `pg_notify` triggers on all tables
- Debug UI with live refresh

### v0.2.0 — Decisions & Blockers
- Decision recording with commit attachment
- Blocker lifecycle tracking

### v0.1.0 — Initial
- Workflows and tasks
- Engineer preferences
