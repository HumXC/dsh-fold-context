import { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";

/** Real official exact reads; corpus search is intentionally unavailable in the isolated world. */
export class LocalSessionQuery extends SessionQueryEngine {
    reads = [];
    activeLeases = 0;
    async searchSessions() {
        throw new Error("unexpected cross-session search in test");
    }
    async searchEvents() {
        throw new Error("unexpected backend search in test");
    }
    async readEvent(request, signal) {
        this.reads.push(request.sessionId);
        return super.readEvent(request, signal);
    }
    async observeSession(sessionId, options) {
        this.reads.push(sessionId);
        const lease = await super.observeSession(sessionId, options);
        this.activeLeases += 1;
        let disposed = false;
        return new Proxy(lease, {
            get: (target, key) => {
                if (key === Symbol.dispose)
                    return () => {
                        if (!disposed) {
                            disposed = true;
                            this.activeLeases -= 1;
                        }
                        target[Symbol.dispose]();
                    };
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    }
}
