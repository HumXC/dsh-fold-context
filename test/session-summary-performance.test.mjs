import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

async function world(t) {
    const f = await fixture({
        summaryModels: [{ provider: "test", model: "fixture", onlyWhenSessionMatches: true }],
    });
    t.after(f.close);
    Object.assign(f.agent, { steer() {}, inject() {}, whenIdle() {} });
    f.appendUser("Historical evidence to preserve.");
    const range = await f.engine.manualSessionSummaryRange(f.session);
    assert.ok(range);
    return { ...f, range };
}

test("read-only admission freezes after preparation and does not reuse stale adapter results", async (t) => {
    const f = await world(t);
    let prepared = false;
    let derivedBeforePreparation = 0;
    const derive = f.session.deriveEventMessage.bind(f.session);
    f.session.deriveEventMessage = (event) => {
        if (!prepared) derivedBeforePreparation++;
        return derive(event);
    };
    let calls = 0;
    f.llm.prepareCall = async (config) => {
        calls++;
        prepared = true;
        return { config, context: { contextWindow: calls === 1 ? 131072 : 1 } };
    };
    assert.ok(
        await f.engine.sessionSummaries.estimate(f.agent, f.range, new AbortController().signal),
    );
    assert.equal(derivedBeforePreparation, 0);
    assert.equal(
        await f.engine.sessionSummaries.estimate(f.agent, f.range, new AbortController().signal),
        null,
    );
    assert.equal(calls, 2);
    assert.equal(f.engine.hasSessionSummaryWork(f.session), false);
});

test("registered preparation still rejects derived content changed during adapter preparation", async (t) => {
    const f = await world(t);
    let changed = false;
    const derive = f.session.deriveEventMessage.bind(f.session);
    f.session.deriveEventMessage = (event) => {
        const message = derive(event);
        return changed && message?.role === "user"
            ? { ...message, content: [{ type: "text", text: "Changed without a session event." }] }
            : message;
    };
    const seq = f.session.seq;
    f.llm.prepareCall = async (config) => {
        changed = true;
        return { config, context: { contextWindow: 131072 } };
    };
    assert.equal(
        await f.engine.sessionSummaries.prepare(f.agent, f.range, new AbortController().signal),
        null,
    );
    assert.equal(f.session.seq, seq);
    assert.equal(f.engine.hasSessionSummaryWork(f.session), false);
});

test("read-only admission preserves cancellation after asynchronous preparation", async (t) => {
    const f = await world(t);
    const controller = new AbortController();
    f.llm.prepareCall = async (config) => {
        controller.abort();
        return { config, context: { contextWindow: 131072 } };
    };
    await assert.rejects(f.engine.sessionSummaries.estimate(f.agent, f.range, controller.signal), {
        name: "AbortError",
    });
    assert.equal(f.engine.hasSessionSummaryWork(f.session), false);
});
