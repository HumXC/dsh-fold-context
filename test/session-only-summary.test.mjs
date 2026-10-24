import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../lib/index.js";
import { resolveSummaryModels, summaryCandidates } from "../lib/domain/summary-models.js";
import { fixture } from "./fixture.mjs";
import { assertTestRoot, call, loopFixture } from "./loop-fixture.mjs";

const signal = () => new AbortController().signal;
const route = { provider: "test", model: "fixture" };
const only = { ...route, onlyWhenSessionMatches: true };
const failureText = (error) => `${error.message} ${error.cause ? failureText(error.cause) : ""}`;

test("session-only configuration defaults and mutual exclusion agree across schemas", () => {
    for (const parse of [
        (row) => resolveSummaryModels([row])[0],
        (row) => Config({ summaryModels: [row] }).summaryModels.get()[0],
    ]) {
        const strict = parse(only);
        assert.equal(strict.onlyWhenSessionMatches, true);
        assert.equal(strict.preferWhenSessionMatches, false);
        assert.equal(strict.useSessionAgent, false);
        assert.equal(parse(route).onlyWhenSessionMatches, false);
        assert.equal(parse(route).preferWhenSessionMatches, true);
        assert.throws(
            () => parse({ ...only, preferWhenSessionMatches: true }),
            /mutually exclusive/,
        );
        assert.throws(() => parse({ ...only, useSessionAgent: true }), /mutually exclusive/);
    }
});

test("session-only candidates require both provider and model and never restore an empty filtered list", () => {
    const models = resolveSummaryModels([
        { provider: "test", model: "fallback" },
        only,
        { ...only, provider: "another" },
    ]);
    assert.deepEqual(
        summaryCandidates(models, route).map((row) => row.model),
        ["fixture", "fallback"],
    );
    assert.equal(
        summaryCandidates(resolveSummaryModels([only]), { ...route, model: "other" }).length,
        0,
    );
    assert.equal(
        summaryCandidates(resolveSummaryModels([only]), { ...route, provider: "other" }).length,
        0,
    );
    assert.equal(summaryCandidates([], route).length, 1);
});

async function world(t, { matches = true, fallback = false, admission = "missing-driver" } = {}) {
    const f = await fixture({
        compaction: { auto: false, targetTokens: 100000 },
        summaryModels: [
            { ...only, model: matches ? "fixture" : "another" },
            ...(fallback ? [{ provider: "test", model: "fallback" }] : []),
        ],
    });
    t.after(f.close);
    if (admission !== "missing-driver") {
        Object.assign(f.agent, { steer() {}, inject() {}, whenIdle() {} });
        f.llm.prepareCall = async (config) => {
            if (admission === "failed-prepare") throw new Error("unavailable");
            return {
                config,
                context: { contextWindow: admission === "small-window" ? 100 : 131072 },
            };
        };
    }
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Historical objective. ".repeat(800));
    f.toolRound("read", "Source evidence. ".repeat(1600));
    f.appendUser("Protected current work. ".repeat(8000));
    await f.invoke("context_compact", { reason: "Preserve completed work." });
    return f;
}

for (const admission of ["missing-driver", "failed-prepare", "small-window"]) {
    test(`session-only ${admission} waits and refuses independent fallback`, async (t) => {
        const f = await world(t, { admission });
        const status = await f.engine.schedulingStatus(f.agent);
        assert.equal(status.decision, "wait");
        assert.equal(status.reason, "session_summary_unavailable");
        f.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
        const before = [...f.session.surface.nodes];
        await assert.rejects(f.engine.compactNow(f.agent, signal()), (error) => {
            assert.match(failureText(error), /session-only summary unavailable/);
            return true;
        });
        assert.equal(f.calls.length, 0);
        assert.deepEqual(f.session.surface.nodes, before);
        assert.equal(f.engine.state(f.session).activeStart, null);
    });
}

test("nonmatching session-only list reports no match without implicit current-model fallback", async (t) => {
    const f = await world(t, { matches: false });
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.reason, "no_matching_summary_model");
    f.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await assert.rejects(f.engine.compactNow(f.agent, signal()), (error) => {
        assert.match(failureText(error), /no summary model matches/);
        return true;
    });
    assert.equal(f.calls.length, 0);
});

for (const matches of [false, true]) {
    test(`skipped session-only model uses the configured independent fallback (matches=${matches})`, async (t) => {
        const f = await world(t, { matches, fallback: true });
        const status = await f.engine.schedulingStatus(f.agent);
        assert.equal(status.summaryInput.execution, "independent");
        f.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
        assert.ok(await f.engine.compactNow(f.agent, signal()));
        assert.deepEqual(
            f.calls.map((request) => request.model),
            ["fallback"],
        );
    });
}

test("session-only admission retains native pricing without starting a transaction", async (t) => {
    const f = await world(t, { admission: "ready" });
    const seq = f.session.seq;
    const status = await f.engine.schedulingStatus(f.agent);
    assert.equal(status.summaryInput.execution, "session");
    assert.equal(f.session.seq, seq);
    assert.equal(f.engine.hasSessionSummaryWork(f.session), false);
    assert.equal(f.calls.length, 0);
});

test("session-only model completes the real Agent submission and official checkpoint transaction", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    let f;
    t.after(async () => {
        await f?.close();
        await assertTestRoot(root);
        await rm(root, { recursive: true, force: true });
    });
    let handle;
    f = await loopFixture(root, {
        strictSession: true,
        summaryModels: [{ provider: "test", model: "mock", onlyWhenSessionMatches: true }],
        responses: [
            { blocks: [{ type: "text", text: "Verified the initial evidence." }] },
            (_request, world) => {
                const active = world.ctx.sessionProjections.stateOf(
                    handle.agent.session,
                    "contextSessionSummary",
                ).active;
                return call(
                    "context_submit_summary",
                    {
                        checkpointId: active.plan.checkpointId,
                        summary:
                            "Preserve the user's objective, verified source evidence, and next unfinished implementation step.",
                    },
                    "session-only-submit",
                );
            },
        ],
    });
    handle = await f.create({ agentOptions: { provider: "test", model: "mock", maxTokens: 512 } });
    await f.followup(
        handle,
        "Preserve the original objective and supporting evidence. ".repeat(300),
    );
    assert.ok(await f.engine.compactNow(handle.agent, signal()));
    await handle.agent.whenIdle();
    assert.equal(f.summaries.length, 0);
    const events = handle.agent.session.snapshotEvents();
    assert.equal(events.filter((event) => event.type === "compaction/summary").length, 1);
    assert.equal(
        events.filter((event) => event.type === "compaction/end" && !event.data.error).length,
        1,
    );
});
