import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

async function world(t, { request = false, ready = true } = {}) {
    const f = await fixture({
        compaction: { auto: true, targetTokens: 100000 },
        summaryModels: [{ provider: "test", model: "fixture", useSessionAgent: true }],
    });
    t.after(f.close);
    Object.assign(f.agent, { steer() {}, inject() {}, whenIdle() {} });
    const counts = { prepare: 0, projection: 0, images: 0, tail: 0 };
    f.llm.prepareCall = async (config) => {
        counts.prepare++;
        if (!ready) throw new Error("Model preparation unavailable");
        return { config, context: { contextWindow: 131072 } };
    };
    for (const [name, counter] of [
        ["summaryProjection", "projection"],
        ["summaryImages", "images"],
        ["protectedTailStart", "tail"],
    ]) {
        const original = f.engine[name].bind(f.engine);
        f.engine[name] = (...args) => {
            counts[counter]++;
            return original(...args);
        };
    }
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Historical objective. ".repeat(800));
    f.toolRound("read", "Source evidence. ".repeat(1600));
    f.appendUser("Protected current work. ".repeat(8000));
    if (request) await f.invoke("context_compact", { reason: "Preserve completed work." });
    return { ...f, counts };
}

test("below-target ordinary checks avoid summary admission and projection", async (t) => {
    const f = await world(t);
    assert.equal(
        await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal),
        null,
    );
    assert.equal(f.counts.prepare, 0);
    assert.equal(f.counts.projection, 0);
    assert.equal(f.counts.images, 0);
    assert.equal(f.calls.length, 0);
});

test("admitted session estimates skip independent projection and scan the protected tail once", async (t) => {
    const f = await world(t, { request: true });
    const before = f.session.seq;
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.summaryInput.execution, "session");
    assert.equal(f.counts.prepare, 1);
    assert.equal(f.counts.projection, 0);
    assert.equal(f.counts.images, 0);
    assert.equal(f.counts.tail, 1);
    assert.equal(f.session.seq, before);
    assert.equal(f.calls.length, 0);
});

test("unavailable session admission still estimates the independent fallback", async (t) => {
    const f = await world(t, { request: true, ready: false });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.summaryInput.execution, "independent");
    assert.equal(f.counts.prepare, 1);
    assert.equal(f.counts.projection, 1);
    assert.equal(f.counts.images, 1);
    assert.equal(f.counts.tail, 1);
    assert.equal(f.calls.length, 0);
});
