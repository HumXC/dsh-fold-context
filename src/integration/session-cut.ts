import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { SummaryRangeCut } from "../domain/summary-range.js";

/** A short-lived, exact observation. Never retain this in a projection or engine cache. */
export interface SessionCut extends SummaryRangeCut, Disposable {
    readonly events: ReadonlyMap<number, SessionEvent>;
    current(session: Session): boolean;
}

/** Hold the public observation lease until every read/commit using this cut has finished. */
export async function observeSessionCut(
    ctx: Pick<Context, "sessionQuery">,
    session: Session,
    signal?: AbortSignal,
): Promise<SessionCut> {
    signal?.throwIfAborted();
    const observation = await ctx.sessionQuery.observeSession(session.id, {
        projectionMode: "none",
        ...(signal === undefined ? {} : { signal }),
    });
    try {
        signal?.throwIfAborted();
        const revision = Number(observation.cursor) + 1;
        const sessionId = observation.header.id;
        const events = new Map(observation.events.map((event) => [Number(event.seq), event]));
        // The live surface/projections are usable only at this same immutable cut.
        const surface =
            session.id === sessionId && session.seq === revision ? [...session.surface.nodes] : [];
        return {
            sessionId,
            revision,
            surface,
            events,
            current: (current) => current.id === sessionId && current.seq === revision,
            [Symbol.dispose]: () => observation[Symbol.dispose](),
        };
    } catch (error) {
        observation[Symbol.dispose]();
        throw error;
    }
}

/** Keep read ownership through an async boundary without exposing a persistent log cache. */
export async function withSessionCut<T>(
    ctx: Pick<Context, "sessionQuery">,
    session: Session,
    read: (cut: SessionCut) => T | Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    using cut = await observeSessionCut(ctx, session, signal);
    if (!cut.current(session)) throw new Error("fold-context: session observation changed");
    return await read(cut);
}
