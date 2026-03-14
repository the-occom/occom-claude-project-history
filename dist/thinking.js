import { newId } from "./db.js";
import { getSessionAgent } from "./session-state.js";
const turns = new Map();
function getTurn(sessionId) {
    return turns.get(sessionId);
}
// ── Exports ──────────────────────────────────────────────────────────────────
export function onUserPrompt(sessionId, timestamp) {
    const existing = turns.get(sessionId);
    const turnNumber = existing ? existing.turnNumber + 1 : 1;
    turns.set(sessionId, {
        promptTimestamp: timestamp,
        lastToolEventId: null,
        lastPostTimestamp: null,
        turnNumber,
        toolEventIds: [],
    });
}
export async function onPreToolUse(sessionId, workflowId, data, timestamp, db) {
    const turn = getTurn(sessionId);
    // Fill gap_after_ms on the previous tool event row
    if (turn?.lastToolEventId && turn.lastPostTimestamp) {
        const gapMs = msGap(turn.lastPostTimestamp, timestamp);
        await db.query(`UPDATE tool_events SET gap_after_ms = $1 WHERE id = $2`, [gapMs, turn.lastToolEventId]);
    }
    // INSERT new row with phase='pre'
    const id = newId();
    const agentId = getSessionAgent(sessionId);
    await db.query(`INSERT INTO tool_events
     (id, session_id, workflow_id, phase, tool_name, file_path, command, pre_timestamp, agent_id, created_at)
     VALUES ($1,$2,$3,'pre',$4,$5,$6,$7,$8,$9)`, [
        id, sessionId, workflowId,
        data.tool_name,
        data.file_path ?? null,
        data.command ?? null,
        timestamp, agentId, timestamp,
    ]);
    if (turn) {
        turn.lastToolEventId = id;
        turn.toolEventIds.push(id);
    }
}
export async function onPostToolUse(sessionId, data, timestamp, db) {
    const turn = getTurn(sessionId);
    const toolName = data.tool_name;
    // Try to UPDATE the matching pre row
    if (turn?.lastToolEventId) {
        const result = await db.query(`UPDATE tool_events
       SET phase = 'complete',
           post_timestamp = $1,
           execution_ms = EXTRACT(EPOCH FROM ($1::timestamptz - pre_timestamp)) * 1000,
           duration_ms = $2,
           exit_code = $3
       WHERE id = $4 AND phase = 'pre'
       RETURNING id`, [
            timestamp,
            data.duration_ms ?? null,
            data.exit_code ?? null,
            turn.lastToolEventId,
        ]);
        if (result.rows.length > 0) {
            turn.lastPostTimestamp = timestamp;
            return;
        }
    }
    // Fallback INSERT if no matching pre row
    const id = newId();
    const fallbackAgentId = getSessionAgent(sessionId);
    await db.query(`INSERT INTO tool_events
     (id, session_id, workflow_id, phase, tool_name, file_path, command,
      duration_ms, exit_code, post_timestamp, agent_id, created_at)
     VALUES ($1,$2,$3,'complete',$4,$5,$6,$7,$8,$9,$10,$11)`, [
        id, sessionId, null, toolName,
        data.file_path ?? null,
        data.command ?? null,
        data.duration_ms ?? null,
        data.exit_code ?? null,
        timestamp, fallbackAgentId, timestamp,
    ]);
    if (turn) {
        turn.lastPostTimestamp = timestamp;
        if (!turn.toolEventIds.includes(id)) {
            turn.toolEventIds.push(id);
        }
    }
}
export function onPostToolUseFailure(sessionId, timestamp) {
    const turn = getTurn(sessionId);
    if (turn) {
        turn.lastPostTimestamp = timestamp;
    }
}
export async function sealTurnThinking(sessionId, workflowId, timestamp, db) {
    const turn = getTurn(sessionId);
    if (!turn || turn.toolEventIds.length === 0)
        return;
    // Fetch all tool events for this turn, ordered by created_at
    const placeholders = turn.toolEventIds.map((_, i) => `$${i + 1}`).join(",");
    const result = await db.query(`SELECT id, pre_timestamp, post_timestamp, execution_ms
     FROM tool_events WHERE id IN (${placeholders})
     ORDER BY created_at ASC`, turn.toolEventIds);
    const rows = result.rows;
    if (rows.length === 0)
        return;
    const promptMs = new Date(turn.promptTimestamp).getTime();
    const stopMs = new Date(timestamp).getTime();
    // Initial gap: prompt → first tool pre_timestamp
    const firstPre = rows[0]?.pre_timestamp;
    const initialGapMs = firstPre ? new Date(firstPre).getTime() - promptMs : null;
    // Interleaved gaps: sum of post_timestamp[i] → pre_timestamp[i+1]
    let interleavedMs = 0;
    let gapCount = 0;
    for (let i = 0; i < rows.length - 1; i++) {
        const postTs = rows[i]?.post_timestamp;
        const nextPreTs = rows[i + 1]?.pre_timestamp;
        if (postTs && nextPreTs) {
            const gap = new Date(nextPreTs).getTime() - new Date(postTs).getTime();
            if (gap > 0) {
                interleavedMs += gap;
                gapCount++;
            }
        }
    }
    // Final gap: last post → stop
    const lastPost = rows[rows.length - 1]?.post_timestamp;
    if (lastPost) {
        const finalGap = stopMs - new Date(lastPost).getTime();
        if (finalGap > 0) {
            interleavedMs += finalGap;
            gapCount++;
        }
    }
    // Total tool execution time
    const totalToolMs = rows.reduce((sum, r) => sum + (r.execution_ms ?? 0), 0);
    const totalWallMs = stopMs - promptMs;
    await db.query(`INSERT INTO thinking_estimates
     (id, session_id, workflow_id, turn_number, initial_gap_ms, interleaved_ms,
      total_tool_ms, total_wall_ms, gap_count, prompt_timestamp, stop_timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
        newId(), sessionId, workflowId, turn.turnNumber,
        initialGapMs, interleavedMs, totalToolMs,
        totalWallMs, gapCount, turn.promptTimestamp, timestamp,
    ]);
    // Update baselines from completed tool events
    await updateBaselines(turn.toolEventIds, db);
}
// ── Internal helpers ─────────────────────────────────────────────────────────
function msGap(from, to) {
    return Math.max(0, new Date(to).getTime() - new Date(from).getTime());
}
async function updateBaselines(eventIds, db) {
    if (eventIds.length === 0)
        return;
    // Compute fresh baselines from all completed tool events
    const result = await db.query(`
    WITH stats AS (
      SELECT tool_name,
             AVG(execution_ms)::integer AS avg_ms,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY execution_ms)::integer AS p50_ms,
             PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_ms)::integer AS p95_ms,
             COUNT(*)::integer AS cnt
      FROM tool_events
      WHERE execution_ms IS NOT NULL AND phase = 'complete'
      GROUP BY tool_name
      HAVING COUNT(*) >= 3
    )
    SELECT * FROM stats
  `);
    for (const row of result.rows) {
        await db.query(`INSERT INTO tool_baselines (tool_name, avg_ms, p50_ms, p95_ms, sample_count, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (tool_name) DO UPDATE
       SET avg_ms = $2, p50_ms = $3, p95_ms = $4, sample_count = $5, updated_at = NOW()`, [row.tool_name, row.avg_ms, row.p50_ms, row.p95_ms, row.cnt]);
    }
}
//# sourceMappingURL=thinking.js.map