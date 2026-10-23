import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "@deepseek-ai/dsh-session";
import {
    createAssistantMessage,
    createToolResultMessage,
    createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { ALLOCATION_SOURCE } from "../lib/domain/numbering.js";
import { fixture } from "./fixture.mjs";

const signal = () => new AbortController().signal;
const stateOf = (f) => f.engine.state(f.session);
const preview = (f) => f.engine.releaseReminder(f.agent, signal());
const body = (label = "Consumed evidence") => `${label} `.repeat(10000);
const textOf = (message) => message.content.map((block) => block.text ?? "").join("");
const nextStep = (f) =>
    f.session.snapshotEvents().filter((event) => event.type === "step/start").length + 1;
const entryFor = (f, id) => stateOf(f).entries.find((entry) => entry.id === id);
const noticeOf = (decision) => {
    const notices = decision.messages.filter(
        (message) => message.source.kind === ALLOCATION_SOURCE,
    );
    assert.equal(notices.length, 1);
    return notices[0];
};
const valueOf = (outcome) => {
    assert.equal(outcome.isError, false);
    return JSON.parse(
        outcome.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
};

function beginAssistantStep(f, content) {
    const step = nextStep(f);
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
    f.session.append(
        "assistant/message",
        {
            turn: 1,
            step,
            message: createAssistantMessage({
                source: { provider: "test", model: "fixture" },
                content,
            }),
            stream: [],
        },
        { surfaceOp: "append" },
    );
    return step;
}

function businessStep(f) {
    const step = beginAssistantStep(f, [
        { type: "text", text: "The next piece of work is complete." },
    ]);
    f.session.append("step/end", { turn: 1, step });
}

function businessSteps(f, count) {
    for (let index = 0; index < count; index += 1) businessStep(f);
}

function transcriptToolStep(f, tools, text) {
    const calls = tools.map((name, index) => ({
        type: "tool-call",
        id: `transcript-${f.session.seq}-${index}`,
        name,
        arguments: "{}",
    }));
    const step = beginAssistantStep(f, [...(text ? [{ type: "text", text }] : []), ...calls]);
    for (const call of calls) {
        f.session.append("tool/call", {
            turn: 1,
            step,
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
        });
        f.session.append(
            "tool/result",
            {
                turn: 1,
                step,
                message: createToolResultMessage({
                    callId: call.id,
                    content: [{ type: "text", text: "Finished." }],
                    isError: false,
                }),
            },
            { surfaceOp: "append" },
        );
    }
    f.session.append("step/end", { turn: 1, step });
}

function propose(f, messages = [], abortSignal = signal(), decision) {
    return f.ctx.waterfall(
        "agent/pre-step",
        { agent: f.agent, messages, turn: 1, step: nextStep(f), signal: abortSignal },
        async () => decision ?? { kind: "enter", messages, startsRequestSeries: true },
    );
}

async function commit(f, decision, reply = false) {
    const step = nextStep(f);
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
    await f.ctx.waterfall(
        "agent/request",
        { agent: f.agent, turn: 1, step, signal: new AbortController().signal },
        async () => ({ provider: "test", model: "fixture" }),
    );
    for (const message of decision.messages) {
        f.session.append("user/message", message, { surfaceOp: "append" });
    }
    if (reply) {
        f.session.append(
            "assistant/message",
            {
                turn: 1,
                step,
                message: createAssistantMessage({
                    source: { provider: "test", model: "fixture" },
                    content: [{ type: "text", text: "The next piece of work is complete." }],
                }),
                stream: [],
            },
            { surfaceOp: "append" },
        );
    }
    f.session.append("step/end", { turn: 1, step });
}

function readyEvidence(f, label) {
    const event = f.toolRound("read", body(label));
    businessSteps(f, 2);
    return { event, id: f.idFor(event) };
}

test("candidate age counts completed business steps, not unfinished work", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const event = f.toolRound("read", body());
    const id = f.idFor(event);
    assert.equal(entryFor(f, id).admittedAtBusinessStep, 1);
    assert.deepEqual((await preview(f)).candidates, []);
    businessStep(f);
    const step = beginAssistantStep(f, [{ type: "text", text: "Work in progress" }]);
    assert.equal(stateOf(f).businessSteps, 2);
    assert.deepEqual((await preview(f)).candidates, []);
    f.session.append("step/end", { turn: 1, step });
    const plan = await preview(f);
    assert.equal(plan.decision, "remind");
    assert.equal(plan.candidates[0].ageSteps, 2);
    assert.equal(
        plan.candidateTokens,
        f.meter.measure(f.session).nodes.find((node) => node.seq === event.seq).tokens,
    );
});

test("management calls and empty replies never age evidence; mixed business calls count once", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const event = f.toolRound("read", body());
    const id = f.idFor(event);
    for (let i = 0; i < 3; i++) {
        valueOf(await f.invoke("context_status", { ids: [Number(id)] }));
        valueOf(await f.invoke("context_expand", { id: Number(id), limit: 30 }));
        assert.equal(
            valueOf(await f.invoke("context_release", { ids: [999999], reason: "Unknown target" }))
                .accepted,
            false,
        );
    }
    transcriptToolStep(
        f,
        [
            "context_status",
            "context_expand",
            "context_release",
            "context_search",
            "context_compact",
        ],
        "Only context management.",
    );
    assert.equal(stateOf(f).businessSteps, 1);
    assert.deepEqual((await preview(f)).candidates, []);
    transcriptToolStep(f, ["context_status", "read", "grep"], "Business work.");
    assert.equal(stateOf(f).businessSteps, 2);
    const step = beginAssistantStep(f, [{ type: "text", text: " \n " }]);
    f.session.append("step/end", { turn: 1, step });
    assert.equal(stateOf(f).businessSteps, 2);
});

test("previews and proposals remain pure until admission, then identical reminders stay suppressed", async (t) => {
    const f = await fixture();
    t.after(f.close);
    readyEvidence(f);
    const before = JSON.stringify(stateOf(f));
    const seq = f.session.seq;
    const first = await preview(f);
    assert.equal(first.decision, "remind");
    let decision;
    for (let i = 0; i < 4; i++) {
        assert.deepEqual(await preview(f), first);
        decision = await propose(f);
        assert.deepEqual(noticeOf(decision).source.releaseReminderState, first.state);
        assert.equal(JSON.stringify(stateOf(f)), before);
        assert.equal(f.session.seq, seq);
    }
    await commit(f, decision);
    assert.deepEqual(stateOf(f).reminderState, first.state);
    assert.equal((await preview(f)).reason, "unchanged");
    businessSteps(f, 30);
    assert.equal((await preview(f)).reason, "unchanged");
    assert.equal(stateOf(f).reminderState.ignoredCount, 0);
});

test("durable reminder state replays in a fresh registry without periodic nags", async (t) => {
    const f = await fixture();
    t.after(f.close);
    readyEvidence(f);
    await commit(f, await propose(f), true);
    businessSteps(f, 6);
    readyEvidence(f, "Substantial new evidence");
    const second = await propose(f);
    assert.equal(noticeOf(second).source.releaseReminderState.ignoredCount, 1);
    await commit(f, second);
    const expected = stateOf(f);
    const fresh = await fixture();
    t.after(fresh.close);
    const replay = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    const cold = { ...fresh, session: replay, agent: { ...fresh.agent, session: replay } };
    assert.deepEqual(stateOf(cold), expected);
    assert.deepEqual(await preview(cold), await preview(f));
    businessSteps(cold, 30);
    assert.equal((await preview(cold)).reason, "unchanged");
    assert.equal(stateOf(cold).reminderState.ignoredCount, 1);
});

test("small backlog never becomes reminder-worthy merely by aging", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const event = f.toolRound("read", "Small consumed evidence. ".repeat(20));
    businessSteps(f, 2);
    const first = await preview(f);
    assert.equal(first.reason, "below_threshold");
    await commit(f, await propose(f));
    const id = f.idFor(event);
    for (let i = 0; i < 3; i++) valueOf(await f.invoke("context_status", { ids: [Number(id)] }));
    businessSteps(f, 30);
    assert.equal((await preview(f)).reason, "below_threshold");
    assert.equal(stateOf(f).reminderState.lastReminderStep, null);
});

test("reminder admission never authorizes release or a summary", async (t) => {
    const f = await fixture({ compaction: { auto: false } });
    t.after(f.close);
    const { event, id } = readyEvidence(f);
    await commit(f, await propose(f));
    const seq = f.session.seq;
    const nodes = [...f.session.surface.nodes];
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.session.seq, seq);
    assert.deepEqual(f.session.surface.nodes, nodes);
    assert.equal(entryFor(f, id).status, "available");
    assert.equal(stateOf(f).lastReleaseProgressSeq, 0);
    assert.equal(stateOf(f).lastSummary, null);
    assert.equal(stateOf(f).summaryRequests.length, 0);
    assert.deepEqual(f.session.deriveEventMessage(event).content, event.data.message.content);
    assert.equal(f.calls.length, 0);
});

test("semantic release resets ignored state but duplicate and compact requests do not", async (t) => {
    const f = await fixture({ compaction: { auto: false } });
    t.after(f.close);
    const first = readyEvidence(f, "First consumed evidence");
    await commit(f, await propose(f));
    businessSteps(f, 6);
    readyEvidence(f, "New consumed evidence");
    await commit(f, await propose(f));
    assert.equal(stateOf(f).reminderState.ignoredCount, 1);
    const previousStep = stateOf(f).reminderState.lastReminderStep;
    valueOf(await f.invoke("context_compact", { reason: "Checkpoint requested" }));
    assert.equal(stateOf(f).lastReleaseProgressSeq, 0);
    assert.equal((await preview(f)).state.ignoredCount, 1);
    valueOf(
        await f.invoke("context_release", {
            ids: [Number(first.id)],
            reason: "Preserved findings",
        }),
    );
    const progress = stateOf(f).lastReleaseProgressSeq;
    assert.ok(progress > 0);
    const next = await preview(f);
    assert.equal(next.reason, "min_interval");
    assert.equal(next.state.ignoredCount, 0);
    assert.equal(next.state.lastProgressSeq, progress);
    assert.equal(next.state.lastReminderStep, previousStep);
    assert.equal(stateOf(f).reminderState.ignoredCount, 1, "preview is not persistence");
    valueOf(await f.invoke("context_release", { ids: [Number(first.id)], reason: "Duplicate" }));
    valueOf(await f.invoke("context_compact", { reason: "Duplicate checkpoint request" }));
    assert.equal(stateOf(f).lastReleaseProgressSeq, progress);
});

test("queued release leaves candidate pool; recovery does not reauthorize it", async (t) => {
    const f = await fixture({ compaction: { auto: false } });
    t.after(f.close);
    const old = f.toolRound("read", body("First evidence"));
    const kept = f.toolRound("grep", body("Keep evidence"));
    businessSteps(f, 2);
    const id = f.idFor(old);
    const keptId = f.idFor(kept);
    assert.equal(
        valueOf(
            await f.invoke("context_release", { ids: [Number(id)], reason: "Findings preserved" }),
        ).accepted,
        true,
    );
    assert.equal(entryFor(f, id).status, "queued");
    assert.deepEqual(
        (await preview(f)).candidates.map((c) => c.id),
        [keptId],
    );
    const progress = stateOf(f).lastReleaseProgressSeq;
    valueOf(await f.invoke("context_release", { ids: [Number(id)], reason: "Repeated request" }));
    valueOf(await f.invoke("context_release", { ids: [999999], reason: "Unknown target" }));
    valueOf(await f.invoke("context_compact", { reason: "Checkpoint request" }));
    assert.equal(stateOf(f).lastReleaseProgressSeq, progress);
    assert.equal(
        valueOf(await f.invoke("context_expand", { id: Number(id), limit: 30 })).status,
        "found",
    );
    assert.deepEqual(
        (await preview(f)).candidates.map((c) => c.id),
        [keptId],
    );
    assert.equal(entryFor(f, keptId).status, "available");
});

for (const compaction of [
    { targetTokens: 1000 },
    {
        targetTokens: 100000,
        modelPolicies: [{ provider: "test", model: "fixture", targetTokens: 1000 }],
    },
])
    test("pressure reminders follow effective soft target including model override", async (t) => {
        const f = await fixture({ compaction });
        t.after(f.close);
        f.toolRound("read", "Reviewable evidence. ".repeat(250));
        businessSteps(f, 2);
        const plan = await preview(f);
        assert.equal(plan.thresholdTokens, 1000);
        assert.equal(plan.decision, "remind");
        assert.equal(plan.reason, "pressure");
        await commit(f, await propose(f));
        businessSteps(f, 20);
        assert.equal((await preview(f)).reason, "unchanged");
    });

test("unknown or invalid capacity does not invent pressure urgency", async (t) => {
    const f = await fixture();
    t.after(f.close);
    f.toolRound("read", "Small evidence. ".repeat(30));
    businessSteps(f, 2);
    for (const context of [
        undefined,
        {},
        { contextWindow: 0 },
        { contextWindow: NaN },
        { contextWindow: Infinity },
        { contextWindow: -1 },
        { contextWindow: 1.5 },
    ]) {
        f.llm.resolveModelInfo = async () => ({
            context,
            defaultMaxTokens: 1024,
            inputModalities: ["text"],
        });
        const plan = await preview(f);
        assert.equal(plan.thresholdTokens, null);
        assert.equal(plan.decision, "wait");
        assert.equal(plan.reason, "below_threshold");
    }
});

test("candidate estimates use pruned visible body, not archived original", async (t) => {
    const f = await fixture({ pruner: {} });
    t.after(f.close);
    const original = "HEAD\n" + "ORIGINAL_MIDDLE_EVIDENCE ".repeat(4000) + "\nTAIL";
    const event = f.toolRound("read", original);
    businessSteps(f, 2);
    const before = await preview(f);
    assert.equal(before.decision, "remind");
    assert.equal(f.ctx.toolResultPruner.pruneSession(f.session).pruned.length, 1);
    const entry = entryFor(f, f.idFor(event));
    const visible = f.meter.measure(f.session).nodes.find((node) => node.seq === entry.currentSeq);
    const after = await preview(f);
    assert.equal(after.candidates[0].tokens, visible.tokens);
    assert.equal(after.candidateTokens, visible.tokens);
    assert.ok(after.candidateTokens < before.candidateTokens);
    assert.equal(f.session.eventAt(event.seq).data.message.content[0].text, original);
    assert.equal(entry.status, "available");
});

test("rejected, empty and cancelled admissions cannot persist a proposal", async (t) => {
    const f = await fixture();
    t.after(f.close);
    readyEvidence(f);
    assert.equal((await preview(f)).decision, "remind");
    const user = createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "Continue" }],
    });
    const before = JSON.stringify(stateOf(f));
    const seq = f.session.seq;
    const reject = { kind: "reject" };
    const empty = { kind: "enter", messages: [] };
    assert.equal(await propose(f, [user], signal(), reject), reject);
    assert.equal(await propose(f, [user], signal(), empty), empty);
    await assert.rejects(propose(f, [user], AbortSignal.abort()), { name: "AbortError" });
    const controller = new AbortController();
    const resolve = f.llm.resolveModelInfo;
    f.llm.resolveModelInfo = async (...args) => {
        const info = await resolve(...args);
        controller.abort();
        return info;
    };
    await assert.rejects(propose(f, [user], controller.signal), { name: "AbortError" });
    assert.equal(f.session.seq, seq);
    assert.equal(JSON.stringify(stateOf(f)), before);
});

test("notices contain bounded numeric IDs, with previews confined to status", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const marker = "PREVIEW_SUFFIX";
    const original = "p".repeat(80) + marker + " remaining evidence".repeat(1000);
    const events = Array.from({ length: 7 }, () => f.toolRound("read", original));
    businessSteps(f, 2);
    const before = JSON.stringify(stateOf(f));
    const plan = await preview(f);
    assert.equal(plan.decision, "remind");
    assert.equal(plan.candidates.length, 5);
    for (const candidate of plan.candidates) {
        assert.ok(Array.from(candidate.preview).length <= 100);
        assert.ok(candidate.preview.includes(marker));
    }
    const seqs = new Set(events.map((event) => event.seq));
    assert.equal(
        plan.candidateTokens,
        f.meter
            .measure(f.session)
            .nodes.filter((node) => seqs.has(node.seq))
            .reduce((sum, node) => sum + node.tokens, 0),
    );
    const text = textOf(noticeOf(await propose(f)));
    assert.equal(text.includes(marker), false);
    assert.ok(text.length < 6000);
    assert.equal(
        text.split("\n").find((line) => line.startsWith("try_release:")),
        `try_release: ${plan.candidates.map((c) => c.id).join(" ")}`,
    );
    assert.match(text, /Review try_release/);
    assert.equal(JSON.stringify(stateOf(f)), before);
});

test("disabled reminders neither establish cooldown nor release evidence", async (t) => {
    const f = await fixture({ reminders: { enabled: false } });
    t.after(f.close);
    const { id } = readyEvidence(f);
    assert.equal((await preview(f)).reason, "disabled");
    const decision = await propose(f);
    assert.doesNotMatch(textOf(noticeOf(decision)), /try_release:|Review try_release/);
    await commit(f, decision, true);
    assert.equal(stateOf(f).reminderState.lastReminderStep, null);
    assert.equal(entryFor(f, id).status, "available");
    assert.equal(f.calls.length, 0);
});
