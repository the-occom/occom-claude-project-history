// ── In-memory session-to-agent/developer maps ──────────────────────────────
// Shared by thinking.ts, tool handlers, and routeEvent.
// Set during SessionStart, read on every tool event.
const sessionAgents = new Map(); // sessionId → agentId
const sessionDevelopers = new Map(); // sessionId → developerId
export function setSessionAgent(sessionId, agentId) {
    sessionAgents.set(sessionId, agentId);
}
export function getSessionAgent(sessionId) {
    return sessionAgents.get(sessionId) ?? null;
}
export function setSessionDeveloper(sessionId, developerId) {
    sessionDevelopers.set(sessionId, developerId);
}
export function getSessionDeveloper(sessionId) {
    return sessionDevelopers.get(sessionId) ?? null;
}
//# sourceMappingURL=session-state.js.map