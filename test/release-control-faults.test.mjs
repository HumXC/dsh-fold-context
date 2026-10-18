import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";
import { releaseControlProjection } from "../lib/domain/release-controls.js";

for (const fault of [
    "missing",
    "duplicate",
    "orphan",
    "mismatch",
    "error",
    "rejected",
    "empty-id",
    "parent-mismatch",
    "unrelated",
])
    test(`PTC ${fault} dispatch evidence is classified conservatively`, async (t) => {
        let f;
        let ids;
        f = await fixture({
            ptc: async (tools) => {
                const value = await tools.context_release({ ids, reason: "Consumed evidence" });
                return { value };
            },
        });
        t.after(f.close);
        ids = [Number(f.idFor(f.toolRound("read", "Source evidence")))];
        f.ctx.on("tools/ptc-dispatch-log", async (dispatch, next) => {
            const content = await next();
            const start = f.session
                .snapshotEvents()
                .findLast(
                    (event) =>
                        event.type === "tool/ptc-dispatch-start" &&
                        event.data.subCallId === dispatch.subCallId,
                ).data;
            const completion = { ...start, isError: dispatch.isError, content };
            if (fault === "missing")
                f.session.append("tool/ptc-dispatch-start", {
                    rootCallId: completion.rootCallId,
                    parentCallId: completion.parentCallId,
                    subCallId: "missing-child",
                    name: completion.name,
                    arguments: completion.arguments,
                });
            else if (fault === "duplicate") f.session.append("tool/ptc-dispatch", completion);
            else if (fault === "orphan")
                f.session.append("tool/ptc-dispatch", { ...completion, subCallId: "orphan" });
            else if (fault === "mismatch")
                f.session.append("tool/ptc-dispatch", {
                    ...completion,
                    arguments: { ids, reason: "Different arguments" },
                });
            else if (fault === "error")
                f.session.append("tool/ptc-dispatch", { ...completion, isError: true });
            else if (fault === "rejected")
                f.session.append("tool/ptc-dispatch", {
                    ...completion,
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                accepted: false,
                                queued: [],
                                settled: [],
                                unknown: ids,
                                unsupported: [],
                            }),
                        },
                    ],
                });
            else if (fault === "empty-id" || fault === "parent-mismatch") {
                const extra = {
                    ...start,
                    subCallId: fault === "empty-id" ? "" : `${start.rootCallId}:ptc:extra`,
                    parentCallId:
                        fault === "parent-mismatch" ? "different-parent" : start.parentCallId,
                };
                f.session.append("tool/ptc-dispatch-start", extra);
                f.session.append("tool/ptc-dispatch", { ...extra, isError: false, content });
            } else
                f.session.append("tool/ptc-dispatch", {
                    ...completion,
                    rootCallId: "unrelated-root",
                });
            return content;
        });
        const outcome = await f.invoke("run_code", {
            code: "return await tools.context_release(args)",
            description: "Release evidence",
        });
        assert.equal(outcome.isError, false, JSON.stringify(outcome));
        const assistant = f.session
            .snapshotEvents()
            .findLast((event) => event.type === "assistant/message");
        const events = f.session.snapshotEvents();
        const proofs = events.filter(
            (event) =>
                event.type === "developer/message" &&
                event.data.message.source.releaseControl !== undefined,
        );
        assert.equal(proofs.length, fault === "unrelated" ? 1 : 0);
        // Historical wrappers without a canonical-value proof cannot be established as pure from rendered JSON.
        const cold = events
            .filter((event) => !proofs.includes(event))
            .reduce(
                (state, event) => releaseControlProjection.apply(state, event),
                releaseControlProjection.init(),
            );
        assert.equal(
            cold.groups.some((group) => group.assistantSeq === assistant.seq),
            false,
        );
        commitForcedReleases(f);
        await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal);
        const step =
            1 +
            Math.max(
                ...f.session
                    .snapshotEvents()
                    .filter((event) => event.type === "step/start")
                    .map((event) => event.data.step),
            );
        f.session.append("step/start", { turn: 1, step });
        await f.ctx.waterfall(
            "agent/request",
            { agent: f.agent, turn: 1, step, signal: new AbortController().signal },
            async () => ({ provider: "test", model: "fixture" }),
        );
        f.session.append("step/end", { turn: 1, step });
        assert.equal(f.session.surface.nodes.includes(assistant.seq), fault !== "unrelated");
    });

test("policy feedback added to a native release result is preserved", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const ids = [Number(f.idFor(f.toolRound("read", "Source evidence")))];
    f.ctx.on("tools/post-execute", async (exec, result, next) => {
        const decision = await next();
        return exec.name === "context_release"
            ? {
                  kind: "accept",
                  content: [
                      ...result.content,
                      { type: "text", text: "Keep this policy feedback." },
                  ],
              }
            : decision;
    });
    const result = await f.invoke("context_release", { ids, reason: "Consumed evidence" });
    assert.equal(result.content.at(-1).text, "Keep this policy feedback.");
    const assistant = f.session
        .snapshotEvents()
        .findLast((event) => event.type === "assistant/message");
    assert.equal(
        f.ctx.sessionProjections
            .stateOf(f.session, "contextReleaseControls")
            .groups.some((group) => group.assistantSeq === assistant.seq),
        false,
    );
});

test("multiple concurrent release subcalls and a returned receipt array are removed together", async (t) => {
    let ids;
    const f = await fixture({
        ptc: async (tools) => ({
            value: await Promise.all(
                ids.map((id) =>
                    tools.context_release({ ids: [id], reason: "Concurrent consumed evidence" }),
                ),
            ),
        }),
    });
    t.after(f.close);
    ids = [
        Number(f.idFor(f.toolRound("read", "First evidence"))),
        Number(f.idFor(f.toolRound("grep", "Second evidence"))),
    ];
    const outcome = await f.invoke("run_code", {
        code: "return await Promise.all(releases)",
        description: "Release two consumed results",
    });
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    const assistant = f.session
        .snapshotEvents()
        .findLast((event) => event.type === "assistant/message");
    const result = f.session.snapshotEvents().findLast((event) => event.type === "tool/result");
    assert.equal(
        f.session.snapshotEvents().filter((event) => event.type === "tool/ptc-dispatch").length,
        2,
    );
    assert.equal(JSON.stringify(outcome.value).includes("reason"), false);
    commitForcedReleases(f);
    await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal);
    const step =
        1 +
        Math.max(
            ...f.session
                .snapshotEvents()
                .filter((event) => event.type === "step/start")
                .map((event) => event.data.step),
        );
    f.session.append("step/start", { turn: 1, step });
    await f.ctx.waterfall(
        "agent/request",
        { agent: f.agent, turn: 1, step, signal: new AbortController().signal },
        async () => ({ provider: "test", model: "fixture" }),
    );
    f.session.append("step/end", { turn: 1, step });
    assert.equal(f.session.surface.nodes.includes(assistant.seq), false);
    assert.equal(f.session.surface.nodes.includes(result.seq), false);
});

for (const mode of ["native", "ptc"])
    test(`a later ${mode} result replacement with business content revokes cleanup eligibility`, async (t) => {
        let ids;
        const f = await fixture(
            mode === "native"
                ? {}
                : {
                      ptc: async (tools) => ({
                          value: await tools.context_release({ ids, reason: "Consumed evidence" }),
                      }),
                  },
        );
        t.after(f.close);
        ids = [Number(f.idFor(f.toolRound("read", "Source evidence")))];
        const outcome = await f.invoke(
            mode === "native" ? "context_release" : "run_code",
            mode === "native"
                ? { ids, reason: "Consumed evidence" }
                : {
                      code: "return await tools.context_release(args)",
                      description: "Release consumed evidence",
                  },
        );
        assert.equal(outcome.isError, false, JSON.stringify(outcome));
        const assistant = f.session
            .snapshotEvents()
            .findLast((event) => event.type === "assistant/message");
        const original = f.session
            .snapshotEvents()
            .findLast((event) => event.type === "tool/result");
        const replacement = f.session.append(
            "tool/result",
            {
                ...original.data,
                message: {
                    ...original.data.message,
                    content: [{ type: "text", text: "BUSINESS POLICY FEEDBACK MUST SURVIVE" }],
                },
            },
            {
                surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq },
                sourceEventSeqs: [original.seq],
            },
        );
        commitForcedReleases(f);
        await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal);
        const step =
            1 +
            Math.max(
                ...f.session
                    .snapshotEvents()
                    .filter((event) => event.type === "step/start")
                    .map((event) => event.data.step),
            );
        f.session.append("step/start", { turn: 1, step });
        await f.ctx.waterfall(
            "agent/request",
            { agent: f.agent, turn: 1, step, signal: new AbortController().signal },
            async () => ({ provider: "test", model: "fixture" }),
        );
        f.session.append("step/end", { turn: 1, step });
        assert.ok(f.session.surface.nodes.includes(assistant.seq));
        assert.ok(f.session.surface.nodes.includes(replacement.seq));
        assert.ok(
            JSON.stringify(f.session.deriveMessages()).includes(
                "BUSINESS POLICY FEEDBACK MUST SURVIVE",
            ),
        );
    });
