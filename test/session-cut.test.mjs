import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { observeSessionCut, withSessionCut } from "../lib/integration/session-cut.js";

// These tests use the public query fixture, including its observation lease accounting.
test("an exact cut uses the last observed seq plus one and retains its lease through async reads", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = f.toolRound("read", "Exact observed evidence.");
    assert.equal(f.query.activeLeases, 0);
    const result = await withSessionCut(f.ctx, f.session, async (cut) => {
        assert.equal(cut.sessionId, f.session.id);
        assert.equal(cut.revision, f.session.seq);
        assert.equal(cut.current(f.session), true);
        assert.deepEqual(cut.surface, [...f.session.surface.nodes]);
        assert.equal(
            cut.events.get(original.seq).data.message.content[0].text,
            "Exact observed evidence.",
        );
        assert.equal(f.query.activeLeases, 1);
        await Promise.resolve();
        assert.equal(f.query.activeLeases, 1);
        return cut.revision;
    });
    assert.equal(result, f.session.seq);
    assert.equal(f.query.activeLeases, 0);
});

test("a cut that became stale while the query resolved cannot borrow the newer surface", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.toolRound("read", "Observed before the new input.");
    const observe = f.query.observeSession.bind(f.query);
    let observed;
    f.query.observeSession = async (...args) => {
        const lease = await observe(...args);
        observed = Number(lease.cursor) + 1;
        f.appendUser("New protected input arrives while observation resolves.");
        return lease;
    };
    const cut = await observeSessionCut(f.ctx, f.session);
    try {
        assert.equal(cut.revision, observed);
        assert.ok(cut.revision < f.session.seq);
        assert.equal(cut.current(f.session), false);
        assert.deepEqual(cut.surface, []);
        assert.equal(cut.events.has(f.session.surface.nodes.at(-1)), false);
    } finally {
        cut[Symbol.dispose]();
    }
    assert.equal(f.query.activeLeases, 0);
});

test("cancellation while an observation resolves disposes the acquired lease", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const controller = new AbortController();
    const reason = new Error("cancel the pending cut");
    const observe = f.query.observeSession.bind(f.query);
    f.query.observeSession = async (...args) => {
        const lease = await observe(...args);
        controller.abort(reason);
        return lease;
    };
    await assert.rejects(
        observeSessionCut(f.ctx, f.session, controller.signal),
        (error) => error === reason,
    );
    assert.equal(f.query.activeLeases, 0);
});

test("read callback failures dispose their lease without changing the session", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const revision = f.session.seq;
    const failure = new Error("failed exact read");
    await assert.rejects(
        withSessionCut(f.ctx, f.session, () => {
            throw failure;
        }),
        (error) => error === failure,
    );
    assert.equal(f.session.seq, revision);
    assert.equal(f.query.activeLeases, 0);
});
