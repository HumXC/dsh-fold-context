import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { commitForcedReleases } from "./release-batch-fixture.mjs";
import { releaseControlProjection } from "../lib/domain/release-controls.js";

test("release control v2 rejects retired PTC and native tracking shapes", () => {
    assert.equal(releaseControlProjection.stateVersion, 2);
    for (const name of ["context_release", "run_code"]) {
        assert.equal(
            releaseControlProjection.stateSchema.safeParse({
                surface: [1],
                groups: [
                    {
                        assistantSeq: 1,
                        turn: 1,
                        step: 1,
                        calls: [
                            {
                                id: "old-control",
                                name,
                                resultSeq: null,
                                ids: [],
                                children: [],
                                proofHash: null,
                            },
                        ],
                    },
                ],
            }).success,
            false,
        );
    }
});

test("PTC dispatches queue releases without becoming cleanup candidates", async (t) => {
    let ids;
    const f = await fixture({
        ptc: async (tools) => ({
            value: await tools.context_release({ ids, reason: "Consumed evidence" }),
        }),
    });
    t.after(f.close);
    const id = f.idFor(f.toolRound("read", "Source evidence"));
    ids = [Number(id)];
    const outcome = await f.invoke("run_code", {
        code: "return await tools.context_release(args)",
        description: "Release evidence",
    });
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "queued",
    );
    const events = f.session.snapshotEvents();
    const assistant = events.findLast((event) => event.type === "assistant/message");
    const result = events.findLast((event) => event.type === "tool/result");
    assert.equal(events.filter((event) => event.type === "tool/ptc-dispatch").length, 1);
    assert.equal(
        events.some(
            (event) =>
                event.type === "developer/message" &&
                event.data.message.source.kind === "fold-context-release-cleanup",
        ),
        false,
    );
    const cold = events.reduce(
        (state, event) => releaseControlProjection.apply(state, event),
        releaseControlProjection.init(),
    );
    assert.deepEqual(cold.groups, []);
    commitForcedReleases(f);
    await f.engine.compactIfNeeded(f.agent, "pressure", new AbortController().signal);
    const step =
        1 +
        Math.max(
            ...events
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
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === id).status,
        "released",
    );
    assert.ok(f.session.surface.nodes.includes(assistant.seq));
    assert.ok(f.session.surface.nodes.includes(result.seq));
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

for (const fault of ["message-identity", "metadata"])
    test(`a native result replacement with changed ${fault} revokes cleanup eligibility`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const ids = [Number(f.idFor(f.toolRound("read", "Source evidence")))];
        await f.invoke("context_release", { ids, reason: "Consumed evidence" });
        const original = f.session
            .snapshotEvents()
            .findLast((event) => event.type === "tool/result");
        const bytes = JSON.stringify(original);
        const state = f.ctx.sessionProjections.stateOf(f.session, "contextReleaseControls");
        assert.equal(state.groups.length, 1);
        const replacement = {
            ...original,
            seq: f.session.seq + 1,
            surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq },
            data: {
                ...original.data,
                ...(fault === "message-identity"
                    ? { message: { ...original.data.message, toolCallId: "different-control-id" } }
                    : {
                          meta: {
                              ...original.data.meta,
                              policyFeedback: "Preserve policy metadata",
                          },
                      }),
            },
        };
        assert.deepEqual(releaseControlProjection.apply(state, replacement).groups, []);
        assert.equal(JSON.stringify(f.session.eventAt(original.seq)), bytes);
    });

test("multiple concurrent release subcalls settle their targets and retain the PTC array result", async (t) => {
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
    assert.ok(f.session.surface.nodes.includes(assistant.seq));
    assert.ok(f.session.surface.nodes.includes(result.seq));
    assert.ok(
        ids.every(
            (id) =>
                f.engine.state(f.session).entries.find((entry) => entry.id === String(id))
                    .status === "released",
        ),
    );
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
