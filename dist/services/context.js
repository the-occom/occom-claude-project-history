import { getDb } from "../db.js";
import { getGitContext } from "./git.js";
import { buildSessionContext } from "./retrieval.js";
import { bus } from "./notify.js";
const TOKEN_BUDGETS = {
    minimal: 300,
    standard: 600,
    deep: 1200,
};
const sessions = new Map();
export function registerSession(sessionId) {
    if (sessions.has(sessionId))
        return;
    const state = {
        sessionId,
        workflowId: null,
        depth: "standard",
        pendingDeltas: [],
        lastSyncAt: new Date(),
    };
    sessions.set(sessionId, state);
    bus.addListener(sessionId, (event) => {
        const s = sessions.get(sessionId);
        if (!s)
            return;
        if (s.workflowId && event.workflow_id !== s.workflowId)
            return;
        s.pendingDeltas.push({
            table: event.table,
            op: event.op,
            id: event.id,
            workflow_id: event.workflow_id,
            timestamp: new Date().toISOString(),
        });
    });
}
export function unregisterSession(sessionId) {
    sessions.delete(sessionId);
    bus.removeListener(sessionId);
}
export async function contextSync(sessionId, workflowId, cwd, depth = "standard", fullRefresh = false) {
    const db = await getDb();
    let state = sessions.get(sessionId);
    if (!state) {
        registerSession(sessionId);
        state = sessions.get(sessionId);
    }
    const isFirstSync = state.workflowId === null;
    state.workflowId = workflowId;
    state.depth = depth;
    if (isFirstSync || fullRefresh) {
        const gitContext = getGitContext(cwd);
        const context = await buildSessionContext(db, workflowId, depth, gitContext, gitContext.engineer_id);
        state.pendingDeltas = [];
        state.lastSyncAt = new Date();
        return {
            context,
            deltas: [],
            synced_at: state.lastSyncAt.toISOString(),
        };
    }
    // Delta sync — return accumulated deltas within token budget
    const budget = TOKEN_BUDGETS[depth];
    const deltas = evictDeltas(state.pendingDeltas, budget);
    state.pendingDeltas = [];
    state.lastSyncAt = new Date();
    return {
        context: null,
        deltas,
        synced_at: state.lastSyncAt.toISOString(),
    };
}
function evictDeltas(deltas, budget) {
    if (!deltas.length)
        return [];
    const scored = deltas.map((d) => ({
        delta: d,
        score: scoreDelta(d),
        tokens: Math.ceil(JSON.stringify(d).length / 4),
    }));
    scored.sort((a, b) => b.score - a.score);
    const result = [];
    let used = 0;
    for (const item of scored) {
        if (used + item.tokens > budget)
            continue;
        result.push(item.delta);
        used += item.tokens;
    }
    return result;
}
function scoreDelta(delta) {
    let score = 0;
    // Recency: up to 40 pts, decays per hour
    const ageHours = (Date.now() - new Date(delta.timestamp).getTime()) / (1000 * 60 * 60);
    score += Math.max(0, 40 - ageHours);
    // Inserts are more important than updates
    if (delta.op === "INSERT")
        score += 20;
    if (delta.op === "DELETE")
        score += 15;
    // Tasks and blockers are higher priority
    if (delta.table === "tasks" || delta.table === "blockers")
        score += 10;
    return score;
}
//# sourceMappingURL=context.js.map