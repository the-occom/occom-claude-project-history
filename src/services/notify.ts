import type { PGlite } from "@electric-sql/pglite";

export interface ChangeEvent {
  table: "tasks" | "blockers" | "decisions" | "workflows";
  op: "INSERT" | "UPDATE" | "DELETE";
  id: string;
  workflow_id: string;
}

type ChangeListener = (event: ChangeEvent) => void;

export class NotificationBus {
  private listeners = new Map<string, ChangeListener>();
  private unsub: (() => Promise<void>) | null = null;

  async start(db: PGlite): Promise<void> {
    this.unsub = await db.listen("cph_changes", (payload: string) => {
      try {
        const event = JSON.parse(payload) as ChangeEvent;
        for (const listener of this.listeners.values()) {
          listener(event);
        }
      } catch {
        // Ignore malformed payloads
      }
    });
  }

  addListener(sessionId: string, listener: ChangeListener): void {
    this.listeners.set(sessionId, listener);
  }

  removeListener(sessionId: string): void {
    this.listeners.delete(sessionId);
  }

  async stop(): Promise<void> {
    if (this.unsub) {
      await this.unsub();
      this.unsub = null;
    }
    this.listeners.clear();
  }
}

export const bus = new NotificationBus();
