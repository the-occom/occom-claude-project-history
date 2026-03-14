// ── In-memory session-to-agent/developer maps ──────────────────────────────
// Shared by thinking.ts, tool handlers, and routeEvent.
// Set during SessionStart, read on every tool event.

const sessionAgents = new Map<string, string>();     // sessionId → agentId
const sessionDevelopers = new Map<string, string>(); // sessionId → developerId

export function setSessionAgent(sessionId: string, agentId: string): void {
  sessionAgents.set(sessionId, agentId);
}

export function getSessionAgent(sessionId: string): string | null {
  return sessionAgents.get(sessionId) ?? null;
}

export function setSessionDeveloper(sessionId: string, developerId: string): void {
  sessionDevelopers.set(sessionId, developerId);
}

export function getSessionDeveloper(sessionId: string): string | null {
  return sessionDevelopers.get(sessionId) ?? null;
}
