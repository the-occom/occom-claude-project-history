# Identity, Coordination & Decision Graph — TODO

## Context

CPH v0.5.0 has strong single-developer observability. This TODO specifies the
foundational changes required for team coordination, multi-agent task execution,
and retrospective workflow understanding.

Three things are being added together because they share a schema foundation:
- **Identity layer** — who is doing what (developer_id, agent_id)
- **Decision graph** — why things are the way they are (enriched decisions)
- **Progressive coordination** — multi-instance awareness that works from day 1

All three degrade gracefully to zero prior context. Nothing requires upfront
planning or workflow declaration to function.

---

## Design Principles

**In medias res** — CPH starts recording from the first action. Workflows emerge
from work, they don't precede it. Classification is retrospective, not prospective.

**Progressive value** — useful on day 1 with one developer and zero history.
Gets dramatically better with more sessions, more developers, more decisions.
Every feature has a cold-state fallback.

**Identity without accounts** — developer identity comes from `git config user.email`.
No registration, no passwords, no accounts. CI pipelines get a special sentinel value.

**Decisions as connective tissue** — not documentation, not reference material.
The structural glue that lets agents understand why the codebase is the way it is
and make autonomous decisions without asking the user.

---

## Schema Changes (v0.5.0 → v0.6.0)

### New table: `developers`

```sql
CREATE TABLE IF NOT EXISTS developers (
  id              TEXT PRIMARY KEY,  -- git config user.email
  name            TEXT,              -- git config user.name
  first_seen_at   TIMESTAMPTZ DEFAULT now(),
  last_seen_at    TIMESTAMPTZ DEFAULT now(),
  session_count   INTEGER DEFAULT 0,
  preferences     JSONB DEFAULT '{}'
);
```

### New table: `agents`

One row per agent instance — both main session agents and subagents.

```sql
CREATE TABLE IF NOT EXISTS agents (
  id               TEXT PRIMARY KEY,  -- stable UUID for this agent instance
  session_id       TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  developer_id     TEXT REFERENCES developers(id) ON DELETE SET NULL,
  parent_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
                   -- null = main session agent
                   -- set = subagent spawned by parent

  agent_type       TEXT NOT NULL DEFAULT 'main',
                   -- 'main' | 'explore' | 'code' | 'validator' | 'ci' | 'external'
  model            TEXT,              -- claude-opus-4-6 | claude-sonnet-4-6 etc
  spawned_at       TIMESTAMPTZ DEFAULT now(),
  ended_at         TIMESTAMPTZ,

  -- Aggregate stats (updated incrementally)
  tool_call_count  INTEGER DEFAULT 0,
  task_count       INTEGER DEFAULT 0,
  decision_count   INTEGER DEFAULT 0,
  files_written    INTEGER DEFAULT 0,
  files_read       INTEGER DEFAULT 0,

  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agents_session   ON agents(session_id);
CREATE INDEX idx_agents_developer ON agents(developer_id);
CREATE INDEX idx_agents_parent    ON agents(parent_agent_id);
```

### Alter existing tables — add identity columns

```sql
-- sessions: add developer identity
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS developer_id TEXT REFERENCES developers(id),
  ADD COLUMN IF NOT EXISTS agent_id     TEXT REFERENCES agents(id);
  -- agent_id = the main session agent for this session

-- tasks: add agent ownership
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS agent_id     TEXT REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS developer_id TEXT REFERENCES developers(id);
  -- who created and who is working on this task

-- decisions: add agent ownership
ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS agent_id     TEXT REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS developer_id TEXT REFERENCES developers(id);

-- tool_events: add agent identity
ALTER TABLE tool_events
  ADD COLUMN IF NOT EXISTS agent_id     TEXT REFERENCES agents(id);

-- blockers: add agent ownership
ALTER TABLE blockers
  ADD COLUMN IF NOT EXISTS agent_id     TEXT REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS developer_id TEXT REFERENCES developers(id);
```

### Enrich `decisions` table

Current decision schema is a document store. Enrich it to be a decision graph.

```sql
ALTER TABLE decisions
  -- What was not chosen and why
  ADD COLUMN IF NOT EXISTS alternatives_considered  JSONB DEFAULT '[]',
  -- [{ "option": "Redis", "rejected_because": "ops overhead" }]

  -- What constraint or evidence forced this choice
  ADD COLUMN IF NOT EXISTS forcing_constraint  TEXT,

  -- What this decision makes easier downstream
  ADD COLUMN IF NOT EXISTS unlocks  TEXT,

  -- What this decision makes harder or impossible
  ADD COLUMN IF NOT EXISTS constrains  TEXT,

  -- What would need to change for this to be revisited
  ADD COLUMN IF NOT EXISTS revisit_if  TEXT,

  -- Structural links
  ADD COLUMN IF NOT EXISTS blocker_id   TEXT REFERENCES blockers(id),
  ADD COLUMN IF NOT EXISTS files_affected  JSONB DEFAULT '[]',
  -- ["src/auth/session.ts", "src/middleware/auth.ts"]

  -- Confidence and reversibility
  ADD COLUMN IF NOT EXISTS reversibility  TEXT DEFAULT 'reversible',
  -- 'reversible' | 'costly' | 'irreversible'
  ADD COLUMN IF NOT EXISTS confidence     TEXT DEFAULT 'medium';
  -- 'low' | 'medium' | 'high'
```

### New table: `file_areas`

Semantic map of the codebase. Populated by Claude Code during plan mode or
on-demand via `cph_codebase_index`. Never auto-populated by CPH itself.

```sql
CREATE TABLE IF NOT EXISTS file_areas (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  path_pattern    TEXT NOT NULL UNIQUE,  -- "src/auth/*"
  responsibility  TEXT,     -- "JWT issuance, session management, token refresh"
  depends_on      JSONB DEFAULT '[]',   -- ["src/db/users", "src/config"]
  depended_on_by  JSONB DEFAULT '[]',   -- ["src/payments", "src/api/middleware"]
  last_indexed_at TIMESTAMPTZ,
  indexed_by      TEXT REFERENCES agents(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### New table: `activity_stream`

Lightweight append-only log of all meaningful events across all agents. The
foundation for progressive coordination — any agent can read the stream to
understand what every other agent is doing without querying multiple tables.

```sql
CREATE TABLE IF NOT EXISTS activity_stream (
  id            TEXT PRIMARY KEY,
  developer_id  TEXT REFERENCES developers(id),
  agent_id      TEXT REFERENCES agents(id),
  session_id    TEXT REFERENCES sessions(id),
  workflow_id   TEXT REFERENCES workflows(id),

  event_type    TEXT NOT NULL,
  -- 'task_started' | 'task_completed' | 'task_blocked'
  -- 'decision_recorded' | 'file_written' | 'file_area_entered'
  -- 'blocker_created' | 'blocker_resolved'
  -- 'session_started' | 'session_ended' | 'agent_spawned'
  -- 'plan_entered' | 'plan_exited'

  subject_type  TEXT,     -- 'task' | 'decision' | 'file' | 'blocker' etc
  subject_id    TEXT,     -- the ID of the subject
  subject_title TEXT,     -- denormalized for fast display
  detail        JSONB DEFAULT '{}',   -- event-specific payload

  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_activity_developer ON activity_stream(developer_id);
CREATE INDEX idx_activity_agent     ON activity_stream(agent_id);
CREATE INDEX idx_activity_workflow  ON activity_stream(workflow_id);
CREATE INDEX idx_activity_created   ON activity_stream(created_at DESC);
CREATE INDEX idx_activity_type      ON activity_stream(event_type);

-- Retention: keep 30 days, prune on daemon start
```

---

## Developer Identity Resolution

### `src/identity.ts`

```typescript
import { execSync } from 'child_process';
import { PGlite } from '@electric-sql/pglite';

export interface DeveloperIdentity {
  id:   string;   // git email — primary key
  name: string;   // git name
}

export function resolveIdentity(cwd: string): DeveloperIdentity {
  try {
    const id   = execSync('git config user.email', { cwd }).toString().trim();
    const name = execSync('git config user.name',  { cwd }).toString().trim();
    if (id) return { id, name };
  } catch {}

  // CI / no git config fallback
  const ciEnv = process.env.CI_COMMIT_AUTHOR
    ?? process.env.GITHUB_ACTOR
    ?? process.env.GITLAB_USER_EMAIL;

  if (ciEnv) return { id: `ci:${ciEnv}`, name: ciEnv };

  // Last resort — machine hostname
  const hostname = execSync('hostname').toString().trim();
  return { id: `unknown:${hostname}`, name: hostname };
}

export async function upsertDeveloper(
  identity: DeveloperIdentity,
  db: PGlite
): Promise<void> {
  await db.query(
    `INSERT INTO developers (id, name, last_seen_at, session_count)
     VALUES ($1, $2, now(), 1)
     ON CONFLICT (id) DO UPDATE SET
       name         = EXCLUDED.name,
       last_seen_at = now(),
       session_count = developers.session_count + 1`,
    [identity.id, identity.name]
  );
}
```

---

## Agent Lifecycle

### On `SessionStart`

```typescript
// In routeEvent() SessionStart handler:
const identity = resolveIdentity(data.cwd as string);
await upsertDeveloper(identity, db);

// Create main session agent
const agentId = newId();
await db.query(
  `INSERT INTO agents
   (id, session_id, developer_id, agent_type, model, spawned_at)
   VALUES ($1,$2,$3,'main',$4,$5)`,
  [agentId, sessionId, identity.id, data.model, timestamp]
);

// Update session with developer and agent identity
await db.query(
  `UPDATE sessions SET developer_id=$1, agent_id=$2 WHERE id=$3`,
  [identity.id, agentId, sessionId]
);

// Emit to activity stream
await emitActivity({
  developer_id:  identity.id,
  agent_id:      agentId,
  session_id:    sessionId,
  event_type:    'session_started',
  subject_type:  'session',
  subject_id:    sessionId,
  subject_title: `${identity.name} started session`,
  detail: { model: data.model, cwd: data.cwd },
}, db);
```

### On `SubagentStart`

```typescript
// Map subagent type from Claude Code's agent_type field
const agentType = mapAgentType(data.agent_type as string);
// 'Explore' → 'explore', 'Plan' → 'main', 'Code' → 'code' etc

const parentAgentId = await getMainAgentForSession(sessionId, db);

await db.query(
  `INSERT INTO agents
   (id, session_id, developer_id, parent_agent_id, agent_type, model, spawned_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [data.agent_id, sessionId, developerId, parentAgentId,
   agentType, data.model ?? 'unknown', timestamp]
);
```

### On `SubagentStop`

```typescript
await db.query(
  `UPDATE agents SET
     ended_at     = $1,
     files_written = (
       SELECT COUNT(*) FROM tool_events
       WHERE agent_id=$2 AND tool_name IN ('Write','Edit','MultiEdit')
     ),
     files_read = (
       SELECT COUNT(*) FROM tool_events
       WHERE agent_id=$2 AND tool_name = 'Read'
     )
   WHERE id = $2`,
  [timestamp, data.agent_id]
);
```

---

## New & Updated MCP Tools

### `cph_session_init` — add identity resolution

```typescript
// At start of cph_session_init:
const identity = resolveIdentity(cwd);
await upsertDeveloper(identity, db);

// Include in returned context:
return {
  developer: { id: identity.id, name: identity.name },
  // ... rest of existing context
};
```

### `cph_who_is_working` — new tool

Returns current activity across all active sessions. The team dashboard primitive.

```typescript
server.tool('cph_who_is_working', {
  workflow_id: z.string().optional(),
}, async ({ workflow_id }) => {
  const rows = await db.query(
    `SELECT
       d.name                          as developer,
       d.id                            as developer_id,
       a.agent_type,
       a.model,
       s.started_at,
       t.title                         as current_task,
       t.status                        as task_status,
       te.tool_name                    as last_tool,
       te.created_at                   as last_active,
       EXTRACT(EPOCH FROM (now() - te.created_at))/60
                                       as idle_minutes,
       b.title                         as open_blocker
     FROM agents a
     JOIN sessions s    ON s.id = a.session_id
     JOIN developers d  ON d.id = a.developer_id
     LEFT JOIN tasks t  ON t.agent_id = a.id AND t.status = 'in_progress'
     LEFT JOIN blockers b ON b.agent_id = a.id AND b.status = 'open'
     LEFT JOIN LATERAL (
       SELECT tool_name, created_at FROM tool_events
       WHERE agent_id = a.id ORDER BY created_at DESC LIMIT 1
     ) te ON true
     WHERE s.ended_at IS NULL
       AND a.agent_type = 'main'
       AND ($1::text IS NULL OR s.workflow_id = $1)
     ORDER BY te.created_at DESC NULLS LAST`,
    [workflow_id ?? null]
  );

  // Flag idle agents (no activity > 5 min with open task)
  const annotated = rows.rows.map((r: any) => ({
    ...r,
    status: r.open_blocker ? 'blocked'
          : r.idle_minutes > 5 && r.current_task ? 'idle_with_task'
          : r.current_task ? 'active'
          : 'available',
  }));

  return result({
    agents: annotated,
    summary: {
      total:         annotated.length,
      active:        annotated.filter((a: any) => a.status === 'active').length,
      blocked:       annotated.filter((a: any) => a.status === 'blocked').length,
      idle_with_task:annotated.filter((a: any) => a.status === 'idle_with_task').length,
      available:     annotated.filter((a: any) => a.status === 'available').length,
    },
  });
});
```

### `cph_activity_stream` — new tool

Recent activity across all agents. The coordination feed.

```typescript
server.tool('cph_activity_stream', {
  workflow_id:  z.string().optional(),
  since_minutes:z.number().optional().default(30),
  event_types:  z.array(z.string()).optional(),
  limit:        z.number().optional().default(20),
}, async ({ workflow_id, since_minutes, event_types, limit }) => {
  const rows = await db.query(
    `SELECT
       a.event_type,
       a.subject_type,
       a.subject_title,
       a.detail,
       a.created_at,
       d.name as developer,
       ag.agent_type
     FROM activity_stream a
     JOIN developers d ON d.id = a.developer_id
     JOIN agents ag    ON ag.id = a.agent_id
     WHERE ($1::text IS NULL OR a.workflow_id = $1)
       AND a.created_at > now() - ($2 || ' minutes')::INTERVAL
       AND ($3::text[] IS NULL OR a.event_type = ANY($3))
     ORDER BY a.created_at DESC
     LIMIT $4`,
    [workflow_id ?? null, since_minutes, event_types ?? null, limit]
  );

  return result({ events: rows.rows });
});
```

### `cph_decision_record` — enriched input schema

```typescript
server.tool('cph_decision_record', {
  workflow_id:               z.string(),
  title:                     z.string(),
  decision:                  z.string(),
  rationale:                 z.string(),

  // New fields
  alternatives_considered:   z.array(z.object({
    option:            z.string(),
    rejected_because:  z.string(),
  })).optional(),
  forcing_constraint:        z.string().optional(),
  unlocks:                   z.string().optional(),
  constrains:                z.string().optional(),
  revisit_if:                z.string().optional(),
  files_affected:            z.array(z.string()).optional(),
  blocker_id:                z.string().optional(),
  reversibility:             z.enum(['reversible','costly','irreversible']).optional(),
  confidence:                z.enum(['low','medium','high']).optional(),
  tags:                      z.array(z.string()).optional(),
}, async (input) => {
  // ... insert with all fields
  // emit to activity_stream
  await emitActivity({
    event_type:    'decision_recorded',
    subject_type:  'decision',
    subject_title: input.title,
    detail: {
      reversibility: input.reversibility,
      confidence:    input.confidence,
      has_alternatives: (input.alternatives_considered?.length ?? 0) > 0,
    },
  });
});
```

### `cph_workflow_reconstruct` — new tool

The retrospective narrative. Given a workflow or time range, reconstruct the
full arc: problem → decisions → dead ends → resolution.

```typescript
server.tool('cph_workflow_reconstruct', {
  workflow_id:   z.string().optional(),
  since_date:    z.string().optional(),  // ISO date
  developer_id:  z.string().optional(),
}, async ({ workflow_id, since_date, developer_id }) => {

  // Parallel queries for full reconstruction
  const [tasks, decisions, blockers, sessions, activity] = await Promise.all([
    db.query(`SELECT * FROM tasks
              WHERE ($1::text IS NULL OR workflow_id=$1)
                AND ($2::text IS NULL OR developer_id=$2)
                AND ($3::text IS NULL OR created_at > $3::timestamptz)
              ORDER BY created_at`,
      [workflow_id ?? null, developer_id ?? null, since_date ?? null]),

    db.query(`SELECT * FROM decisions
              WHERE ($1::text IS NULL OR workflow_id=$1)
                AND ($2::text IS NULL OR developer_id=$2)
              ORDER BY created_at`,
      [workflow_id ?? null, developer_id ?? null]),

    db.query(`SELECT * FROM blockers
              WHERE ($1::text IS NULL OR workflow_id=$1)
              ORDER BY created_at`,
      [workflow_id ?? null]),

    db.query(`SELECT s.*, d.name as developer_name, a.model
              FROM sessions s
              JOIN developers d ON d.id = s.developer_id
              JOIN agents a ON a.id = s.agent_id
              WHERE ($1::text IS NULL OR s.workflow_id=$1)
              ORDER BY s.started_at`,
      [workflow_id ?? null]),

    db.query(`SELECT * FROM activity_stream
              WHERE ($1::text IS NULL OR workflow_id=$1)
              ORDER BY created_at`,
      [workflow_id ?? null]),
  ]);

  // Dead ends: cancelled tasks + resolved blockers
  const deadEnds = [
    ...tasks.rows.filter((t: any) => t.status === 'cancelled'),
    ...blockers.rows.filter((b: any) => b.status === 'resolved'),
  ].sort((a: any, b: any) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  return result({
    workflow_id,
    reconstruction: {
      sessions:    sessions.rows.length,
      developers:  [...new Set(sessions.rows.map((s: any) => s.developer_name))],
      date_range: {
        from: sessions.rows[0]?.started_at,
        to:   sessions.rows[sessions.rows.length - 1]?.ended_at,
      },
      tasks: {
        total:     tasks.rows.length,
        completed: tasks.rows.filter((t: any) => t.status === 'completed').length,
        cancelled: tasks.rows.filter((t: any) => t.status === 'cancelled').length,
      },
      decisions:    decisions.rows,
      dead_ends:    deadEnds,
      blockers:     blockers.rows,
      activity:     activity.rows,
    },
  });
});
```

### `cph_codebase_index` — new tool

Called by Claude Code after exploring the codebase. Stores semantic module map.

```typescript
server.tool('cph_codebase_index', {
  workflow_id:  z.string().optional(),
  areas: z.array(z.object({
    path_pattern:    z.string(),     // "src/auth/*"
    responsibility:  z.string(),     // what this area does
    depends_on:      z.array(z.string()),
    depended_on_by:  z.array(z.string()),
  })),
}, async ({ workflow_id, areas }) => {
  for (const area of areas) {
    await db.query(
      `INSERT INTO file_areas
       (id, workflow_id, path_pattern, responsibility,
        depends_on, depended_on_by, last_indexed_at, indexed_by)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
       ON CONFLICT (path_pattern) DO UPDATE SET
         responsibility  = EXCLUDED.responsibility,
         depends_on      = EXCLUDED.depends_on,
         depended_on_by  = EXCLUDED.depended_on_by,
         last_indexed_at = now(),
         indexed_by      = EXCLUDED.indexed_by,
         updated_at      = now()`,
      [newId(), workflow_id ?? null, area.path_pattern, area.responsibility,
       JSON.stringify(area.depends_on), JSON.stringify(area.depended_on_by),
       currentAgentId()]
    );
  }
  return result({ indexed: areas.length });
});
```

---

## Context Injection Upgrade

`GET /hooks/context-inject` — add team awareness to the injected block.

```typescript
async function buildContextBlock(...): Promise<string> {
  // Existing queries (workflow, active tasks, blockers, recent decisions)
  // ...

  // New: other active agents
  const otherAgents = await db.query(
    `SELECT d.name, t.title as task, b.title as blocker,
            EXTRACT(EPOCH FROM (now() - te.created_at))/60 as idle_min
     FROM agents a
     JOIN sessions s    ON s.id = a.session_id
     JOIN developers d  ON d.id = a.developer_id
     LEFT JOIN tasks t  ON t.agent_id = a.id AND t.status = 'in_progress'
     LEFT JOIN blockers b ON b.agent_id = a.id AND b.status = 'open'
     LEFT JOIN LATERAL (
       SELECT created_at FROM tool_events
       WHERE agent_id = a.id ORDER BY created_at DESC LIMIT 1
     ) te ON true
     WHERE s.ended_at IS NULL
       AND a.agent_type = 'main'
       AND a.id != $1   -- exclude self
       AND s.workflow_id = $2`,
    [currentAgentId(), workflowId]
  );

  if (otherAgents.rows.length > 0) {
    const others = otherAgents.rows.map((r: any) => {
      if (r.blocker)    return `${r.name} → blocked: ${r.blocker}`;
      if (r.idle_min > 5 && r.task) return `${r.name} → idle ${Math.round(r.idle_min)}m on: ${r.task}`;
      if (r.task)       return `${r.name} → ${r.task}`;
      return `${r.name} → available`;
    });
    lines.push(`Team: ${others.join(' | ')}`);
  }
}
```

---

## Shared Postgres — Architecture Note

**Current:** PGlite at `~/.cph/db` — local only, single developer.

**Team requirement:** shared Postgres instance all developers connect to.

This is a prerequisite for real team coordination. The schema is already
Postgres-compatible (PGlite is a WASM Postgres). Migration path:

```
CPH_DATABASE_URL=postgresql://... node ~/.cph/scripts/daemon.js start
```

When `CPH_DATABASE_URL` is set, daemon connects to remote Postgres instead
of local PGlite. Schema migrations run on first connection. All tools and
hooks work identically.

**Without this:** developer identity works locally, but cross-developer
coordination requires the shared DB. The `cph_who_is_working` tool returns
only the local developer's sessions without it.

Add to `scripts/daemon.js`:
```javascript
const db = process.env.CPH_DATABASE_URL
  ? await connectPostgres(process.env.CPH_DATABASE_URL)
  : await connectPGlite(CPH_DIR);
```

This is the single most impactful change for team use and the least amount
of code to implement given the schema is already Postgres.

---

## CLAUDE.md Template Updates

```markdown
## Identity
CPH automatically detects your identity from git config.
No setup required. Your decisions, tasks, and activity are
attributed to your git email across all sessions.

## Team Awareness
Call cph_who_is_working to see what other agents are doing.
The [cph] line injected before each prompt shows team state.
If you see a teammate is blocked and you are touching the
same area, call cph_activity_stream to understand the context
before proceeding.

## Decisions
When recording decisions, always include:
- alternatives_considered: what you chose not to do and why
- revisit_if: what would need to change for this to be wrong
- files_affected: which files this decision constrains
- reversibility: reversible | costly | irreversible

A decision without alternatives_considered is half a decision.
The rejected alternatives are often more useful than the choice.

## Codebase Index
At the start of a new project or after major restructuring,
enter plan mode and call cph_codebase_index with a map of
module responsibilities and dependencies. This enables accurate
workflow classification and task routing for all future sessions.
```

---

## Files Changed

| File | Change |
|---|---|
| `src/db.ts` | Schema v6: `developers`, `agents`, `file_areas`, `activity_stream` tables; alter existing tables |
| `src/identity.ts` | New — `resolveIdentity()`, `upsertDeveloper()` |
| `src/activity.ts` | New — `emitActivity()` helper, retention pruning |
| `src/index.ts` | Wire identity into SessionStart/SubagentStart/SubagentStop; upgrade context-inject endpoint |
| `src/tools/coordination.ts` | New — `cph_who_is_working`, `cph_activity_stream` |
| `src/tools/decisions.ts` | Enrich `cph_decision_record` input schema |
| `src/tools/reconstruct.ts` | New — `cph_workflow_reconstruct` |
| `src/tools/codebase.ts` | New — `cph_codebase_index` |
| `scripts/daemon.js` | Add `CPH_DATABASE_URL` → remote Postgres path |
| `hooks/context-inject.js` | Add team awareness to injected block |
| `CLAUDE.md.template` | Identity, team awareness, enriched decisions, codebase index sections |
| `debug/index.html` | Team panel: developer list, agent activity, activity stream |
| `dist/` | Rebuild |

---

## Implementation Order

1. Schema migration — 4 new tables + alter existing
2. `src/identity.ts` — `resolveIdentity()` + `upsertDeveloper()`
3. Wire identity into `SessionStart` handler — developer + agent creation
4. Wire into `SubagentStart` / `SubagentStop` handlers
5. `src/activity.ts` — `emitActivity()` + retention pruning job
6. Emit activity events from task/decision/blocker mutations
7. `cph_who_is_working` tool
8. `cph_activity_stream` tool
9. Upgrade context-inject endpoint with team block
10. Enrich `cph_decision_record` with new fields
11. `cph_workflow_reconstruct` tool
12. `cph_codebase_index` tool
13. `scripts/daemon.js` — `CPH_DATABASE_URL` remote Postgres path
14. `CLAUDE.md.template` updates
15. Debug UI team panel
16. Build + update `dist/`
17. Test solo: verify developer identity resolves, agents created, activity stream populates
18. Test team: two machines pointing at shared Postgres, verify `cph_who_is_working`
    returns both developers, activity stream shows cross-machine events