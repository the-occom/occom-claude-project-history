export class NotificationBus {
    listeners = new Map();
    unsub = null;
    async start(db) {
        this.unsub = await db.listen("cph_changes", (payload) => {
            try {
                const event = JSON.parse(payload);
                for (const listener of this.listeners.values()) {
                    listener(event);
                }
            }
            catch {
                // Ignore malformed payloads
            }
        });
    }
    addListener(sessionId, listener) {
        this.listeners.set(sessionId, listener);
    }
    removeListener(sessionId) {
        this.listeners.delete(sessionId);
    }
    async stop() {
        if (this.unsub) {
            await this.unsub();
            this.unsub = null;
        }
        this.listeners.clear();
    }
}
export const bus = new NotificationBus();
//# sourceMappingURL=notify.js.map