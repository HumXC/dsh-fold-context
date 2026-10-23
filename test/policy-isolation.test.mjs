import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { normalizePolicyOverrides } from "../lib/domain/settings-catalog.js";

const signal = () => new AbortController().signal;

test("another session's boundary cannot change an active summary policy or model snapshot", async (t) => {
    const profile = {
        summaryModels: [{ provider: "test", model: "old-summary" }],
        policyOverrides: normalizePolicyOverrides({
            compaction: { auto: false, summaryMaxTokens: 333 },
            summary: { reasoning: "preserve", images: "auto" },
        }),
    };
    const f = await fixture({ profileSettings: profile });
    t.after(f.close);
    f.session.append("turn/start", { turn: 1 });
    const start = f.appendUser("Historical objective. ".repeat(200));
    const end = f.toolRound("read", "Archived evidence. ".repeat(200));
    f.appendUser("Retain the active task.");
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    t.after(() => resume.resolve());
    const images = f.engine.summaryImages.bind(f.engine);
    let captured;
    f.engine.summaryImages = async (...args) => {
        entered.resolve();
        await resume.promise;
        captured = f.engine.summaryPolicy.reasoning;
        return images(...args);
    };
    const pending = f.engine.compactRegion(start.seq, end.seq, f.agent, signal());
    try {
        await entered.promise;
        profile.policyOverrides.summary.reasoning = "omit-from-summary";
        profile.policyOverrides.compaction.summaryMaxTokens = 999;
        profile.summaryModels = [{ provider: "test", model: "new-summary" }];
        const second = f.sessions.create();
        second.append("request/header", {
            header: { config: { provider: "test", model: "fixture", maxTokens: 1024 } },
            reason: "initial",
        });
        await f.engine.compactIfNeeded({ ...f.agent, session: second }, "pressure", signal());
        assert.equal(
            f.engine.summaryPolicy.reasoning,
            "omit-from-summary",
            "idle session adopts new policy",
        );
    } finally {
        resume.resolve();
    }
    await pending;
    assert.equal(captured, "preserve", "suspended operation retains its policy");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].model, "old-summary");
    assert.equal(f.calls[0].maxTokens, 333);
});

for (const totalTokens of [1999, 2000]) {
    test(`safety retry stays eligible at ${totalTokens} tokens despite ordinary failure cooldown`, async (t) => {
        const f = await fixture({ compaction: { auto: false, targetTokens: 1000 } });
        t.after(f.close);
        f.llm.resolveModelInfo = async () => ({ context: { contextWindow: 3000 } });
        f.appendUser("Prior objective. ".repeat(80));
        f.toolRound("read", "Prior evidence. ".repeat(80));
        f.appendUser("Current task. ".repeat(80));
        const measure = f.engine.measurement.bind(f.engine);
        f.engine.measurement = (session) => ({ ...measure(session), totalTokens });
        f.engine.observedGrowth = () => 1;
        f.engine.latestFailure = () => ({
            seq: 1,
            error: "previous failure",
            stepsSinceFailure: 1,
            retryAfterSteps: 3,
        });
        let attempts = 0;
        f.engine.compactSelectedRange = async () => {
            attempts++;
            return null;
        };
        const status = await f.engine.schedulingStatus(f.agent, signal());
        assert.equal(status.reason, "safety_pressure");
        await f.engine.compactIfNeeded(f.agent, "pressure", signal());
        assert.equal(attempts, 1, "one bounded preparation attempt at this boundary");
    });
}
