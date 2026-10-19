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
const body = (label = "Consumed evidence") => `${label} `.repeat(1000);
const textOf = (message) => message.content.map((block) => block.text ?? "").join("");
const lowered = { backlogTokens: 100, staleTokens: 50 };
const pressureOnly = { backlogTokens: 1_000_000_000, staleTokens: 50 };
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

test("mass reminders wait for two subsequent completed business steps", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    const event = f.toolRound("read", body());
    const id = f.idFor(event);
    assert.equal(stateOf(f).businessSteps, 1);
    assert.equal(entryFor(f, id).admittedAtBusinessStep, 1);
    assert.equal((await preview(f)).decision, "wait");
    assert.deepEqual((await preview(f)).candidates, []);

    f.toolRound("grep", "One subsequent business tool call.");
    assert.equal(stateOf(f).businessSteps, 2);
    assert.equal((await preview(f)).decision, "wait");
    const step = beginAssistantStep(f, [
        { type: "text", text: "A subsequent reply is now ready." },
    ]);
    assert.equal(stateOf(f).pendingBusinessStep, true);
    assert.equal(stateOf(f).businessSteps, 2);
    assert.equal((await preview(f)).decision, "wait", "an unfinished step cannot age evidence");
    f.session.append("step/end", { turn: 1, step });

    const ready = await preview(f);
    assert.equal(ready.businessSteps, 3);
    assert.equal(stateOf(f).pendingBusinessStep, false);
    assert.equal(ready.decision, "remind");
    assert.equal(ready.reason, "backlog");
    assert.deepEqual(
        ready.candidates.map((candidate) => candidate.id),
        [id],
    );
    assert.equal(ready.candidates[0].ageSteps, 2);
    assert.ok(ready.candidateTokens >= lowered.backlogTokens);
    assert.equal(
        ready.candidateTokens,
        f.meter.measure(f.session).nodes.find((node) => node.seq === event.seq).tokens,
    );
});

test("status, expand and release management, including explanatory text, cannot age backlog", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    const event = f.toolRound("read", body());
    const id = f.idFor(event);
    for (let index = 0; index < 3; index += 1) {
        valueOf(await f.invoke("context_status", { ids: [Number(id)] }));
        assert.equal(
            valueOf(await f.invoke("context_expand", { id: Number(id), limit: 30 })).status,
            "found",
        );
        assert.equal(
            valueOf(
                await f.invoke("context_release", {
                    ids: [999999],
                    reason: "No matching evidence to release.",
                }),
            ).accepted,
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
        "Inspecting context is not another unit of project work.",
    );
    const plan = await preview(f);
    assert.equal(stateOf(f).businessSteps, 1);
    assert.equal(stateOf(f).pendingBusinessStep, false);
    assert.equal(entryFor(f, id).admittedAtBusinessStep, 1);
    assert.equal(entryFor(f, id).status, "available");
    assert.equal(plan.decision, "wait");
    assert.deepEqual(plan.candidates, []);
    assert.equal(plan.candidateTokens, 0);
    assert.equal(stateOf(f).reminderState.lastReminderStep, null);
});

test("mixed business and control calls count once while empty replies do not advance the clock", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    const { id } = readyEvidence(f);
    const before = stateOf(f).businessSteps;
    transcriptToolStep(f, ["context_status", "read", "grep"], "Checking and completing work.");
    assert.equal(stateOf(f).businessSteps, before + 1);
    const step = beginAssistantStep(f, [{ type: "text", text: " \n " }]);
    assert.equal(stateOf(f).pendingBusinessStep, false);
    f.session.append("step/end", { turn: 1, step });
    assert.equal(stateOf(f).businessSteps, before + 1);
    assert.equal(
        (await preview(f)).candidates.find((candidate) => candidate.id === id).ageSteps,
        3,
    );
});

test("repeated previews and proposals do not consume cooldown before allocation admission", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    readyEvidence(f);
    const before = JSON.stringify(stateOf(f));
    const seq = f.session.seq;
    const nodes = [...f.session.surface.nodes];
    const first = await preview(f);
    assert.equal(first.decision, "remind");
    let decision;
    for (let index = 0; index < 4; index += 1) {
        assert.deepEqual(await preview(f), first);
        decision = await propose(f);
        assert.equal(decision.startsRequestSeries, true);
        const notice = noticeOf(decision);
        assert.deepEqual(notice.source.releaseReminderState, first.state);
        assert.equal(
            textOf(notice)
                .split("\n")
                .find((line) => line.startsWith("try_release:")),
            `try_release: ${first.candidates.map((candidate) => candidate.id).join(" ")}`,
        );
        assert.equal(notice.source.ledgerView, undefined);
        assert.deepEqual(JSON.parse(JSON.stringify(notice.source)), notice.source);
        assert.equal(JSON.stringify(stateOf(f)), before);
        assert.equal(f.session.seq, seq);
        assert.deepEqual(f.session.surface.nodes, nodes);
    }
    await commit(f, decision);
    assert.deepEqual(stateOf(f).reminderState, first.state);
    const admitted = await preview(f);
    assert.equal(admitted.decision, "wait");
    assert.equal(admitted.reason, "min_interval");
    assert.equal(admitted.state.lastReminderStep, first.businessSteps);
    assert.equal(admitted.state.ignoredCount, 0);
});

test("durable allocation metadata replays cooldown, ignored counter and business age in a fresh registry", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    readyEvidence(f);
    const first = await propose(f);
    await commit(f, first, true);
    businessSteps(f, 5);
    const second = await propose(f);
    const notice = noticeOf(second);
    assert.equal(notice.source.releaseReminderState.ignoredCount, 1);
    await commit(f, second);
    const expected = stateOf(f);
    assert.equal(expected.businessSteps, 9);
    assert.equal(expected.reminderState.lastReminderStep, 9);
    const durable = f.session
        .snapshotEvents()
        .find((event) => event.type === "user/message" && event.data.id === notice.id);
    assert.deepEqual(durable.data.source.releaseReminderState, expected.reminderState);
    assert.equal(durable.data.source.ledgerView, undefined);

    const fresh = await fixture({ reminders: lowered });
    t.after(fresh.close);
    const replay = Session.create(
        f.session.id,
        JSON.parse(JSON.stringify(f.session.snapshotEvents())),
        f.session.header,
    );
    const cold = { ...fresh, session: replay, agent: { ...fresh.agent, session: replay } };
    assert.deepEqual(stateOf(cold), expected);
    assert.deepEqual(await preview(cold), await preview(f));
    assert.equal((await preview(cold)).reason, "ignored_backoff");
    businessSteps(cold, 11);
    assert.equal((await preview(cold)).decision, "wait");
    businessStep(cold);
    const due = await preview(cold);
    assert.equal(due.decision, "remind");
    assert.equal(due.state.ignoredCount, 2);
    assert.equal(
        stateOf(cold).reminderState.ignoredCount,
        1,
        "a replayed preview remains uncommitted",
    );
});

test("stale backlog waits eight business steps and control calls cannot advance its timer", async (t) => {
    const f = await fixture({ reminders: pressureOnly });
    t.after(f.close);
    const { id } = readyEvidence(f);
    const start = await preview(f);
    assert.equal(start.decision, "wait");
    assert.equal(start.reason, "below_threshold");
    assert.equal(start.state.backlogSinceStep, 3);
    await commit(f, await propose(f));
    const persisted = JSON.stringify(stateOf(f).reminderState);
    for (let index = 0; index < 3; index += 1) {
        const status = valueOf(await f.invoke("context_status", { ids: [Number(id)] }));
        assert.equal(status.reminders.decision, "wait");
        assert.equal(status.reminders.state.backlogSinceStep, 3);
    }
    assert.equal(JSON.stringify(stateOf(f).reminderState), persisted);
    businessSteps(f, 7);
    assert.equal((await preview(f)).decision, "wait");
    businessStep(f);
    const stale = await preview(f);
    assert.equal(stale.businessSteps, 11);
    assert.equal(stale.decision, "remind");
    assert.equal(stale.reason, "stale");
});

test("a reminder and ordinary boundary never release or summarize available evidence automatically", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    const { event, id } = readyEvidence(f);
    await commit(f, await propose(f));
    const seq = f.session.seq;
    const nodes = [...f.session.surface.nodes];
    const messages = f.session.deriveMessages();
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.session.seq, seq);
    assert.deepEqual(f.session.surface.nodes, nodes);
    assert.deepEqual(f.session.deriveMessages(), messages);
    assert.equal(entryFor(f, id).status, "available");
    assert.equal(stateOf(f).lastReleaseProgressSeq, 0);
    assert.equal(stateOf(f).lastSummary, null);
    assert.equal(stateOf(f).summaryRequests.length, 0);
    assert.deepEqual(f.session.deriveEventMessage(event).content, event.data.message.content);
    assert.equal(f.calls.length, 0);
});

test("queued and applied releases leave reminder candidates while unrelated evidence remains available", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    const released = f.toolRound("read", body("Consumed first output"));
    const kept = f.toolRound("grep", body("Still useful output"));
    businessSteps(f, 2);
    const releasedId = f.idFor(released);
    const keptId = f.idFor(kept);
    assert.deepEqual(
        new Set((await preview(f)).candidates.map((candidate) => candidate.id)),
        new Set([releasedId, keptId]),
    );
    assert.equal(
        valueOf(
            await f.invoke("context_release", {
                ids: [Number(releasedId)],
                reason: "Findings preserved.",
            }),
        ).accepted,
        true,
    );
    assert.equal(entryFor(f, releasedId).status, "queued");
    assert.ok(f.session.surface.nodes.includes(released.seq));
    assert.deepEqual(
        (await preview(f)).candidates.map((candidate) => candidate.id),
        [keptId],
    );
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(entryFor(f, releasedId).status, "released");
    assert.equal(entryFor(f, keptId).status, "available");
    assert.deepEqual(
        (await preview(f)).candidates.map((candidate) => candidate.id),
        [keptId],
    );
    assert.equal(
        valueOf(await f.invoke("context_expand", { id: Number(releasedId), limit: 30 })).status,
        "found",
    );
    assert.deepEqual(
        (await preview(f)).candidates.map((candidate) => candidate.id),
        [keptId],
    );
    assert.equal(f.calls.length, 0);
});

test("only newly accepted releases advance semantic progress; compact requests preserve it and ignored history", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    const first = f.toolRound("read", body("First evidence"));
    f.toolRound("grep", body("Second evidence"));
    businessSteps(f, 2);
    await commit(f, await propose(f));
    businessSteps(f, 6);
    await commit(f, await propose(f));
    assert.equal(stateOf(f).reminderState.ignoredCount, 1);
    assert.equal(stateOf(f).lastReleaseProgressSeq, 0);
    valueOf(await f.invoke("context_compact", { reason: "Request a future checkpoint." }));
    assert.equal(stateOf(f).lastReleaseProgressSeq, 0);
    assert.equal(stateOf(f).reminderState.ignoredCount, 1);
    assert.equal((await preview(f)).state.ignoredCount, 1);
    const lastReminderStep = stateOf(f).reminderState.lastReminderStep;
    const firstId = f.idFor(first);
    assert.equal(
        valueOf(
            await f.invoke("context_release", {
                ids: [Number(firstId)],
                reason: "Consumed first evidence.",
            }),
        ).accepted,
        true,
    );
    const progress = stateOf(f).lastReleaseProgressSeq;
    assert.ok(progress > 0);
    valueOf(
        await f.invoke("context_compact", {
            reason: "The existing checkpoint is still requested.",
        }),
    );
    assert.equal(stateOf(f).lastReleaseProgressSeq, progress);
    valueOf(
        await f.invoke("context_release", {
            ids: [Number(firstId)],
            reason: "Repeated release is a no-op.",
        }),
    );
    assert.equal(stateOf(f).lastReleaseProgressSeq, progress);
    assert.equal(
        valueOf(
            await f.invoke("context_release", {
                ids: [999999],
                reason: "Reject an unknown target.",
            }),
        ).accepted,
        false,
    );
    assert.equal(stateOf(f).lastReleaseProgressSeq, progress);
    const reset = await preview(f);
    assert.equal(reset.decision, "wait");
    assert.equal(reset.reason, "min_interval");
    assert.equal(reset.state.ignoredCount, 0);
    assert.equal(reset.state.lastProgressSeq, progress);
    assert.equal(
        reset.state.lastReminderStep,
        lastReminderStep,
        "semantic progress cannot bypass cooldown",
    );
    assert.equal(stateOf(f).reminderState.ignoredCount, 1, "preview cannot persist the reset");
});

for (const { label, compaction, threshold } of [
    {
        label: "the window ratio despite large output and headroom budgets",
        compaction: { thresholdRatio: 0.008, retainTokens: 1, headroomTokens: 129000 },
        threshold: Math.floor(131072 * 0.008),
    },
    {
        label: "the matching model policy override",
        compaction: {
            thresholdRatio: 1,
            headroomTokens: 0,
            modelPolicies: [
                {
                    provider: "test",
                    model: "fixture",
                    thresholdRatio: 0.01,
                    headroomTokens: 0,
                    retainTokens: 1,
                },
            ],
        },
        threshold: Math.floor(131072 * 0.01),
    },
]) {
    test(`pressure reminders use the shared window threshold with ${label}`, async (t) => {
        const f = await fixture({ reminders: pressureOnly, compaction });
        t.after(f.close);
        readyEvidence(f);
        const measurement = f.meter.measure(f.session);
        assert.ok(measurement.totalTokens >= threshold * 0.8);
        assert.ok(
            measurement.totalTokens < 131072 * 0.8,
            "raw model capacity would not trigger pressure",
        );
        const plan = await preview(f);
        assert.equal(plan.thresholdTokens, threshold);
        assert.equal(plan.decision, "remind");
        assert.equal(plan.reason, "pressure");
        assert.ok(plan.candidateTokens < pressureOnly.backlogTokens);
        assert.equal(stateOf(f).reminderState.lastReminderStep, null);
    });
}

test("admitted pressure reminders use a four-business-step cooldown", async (t) => {
    const f = await fixture({
        reminders: pressureOnly,
        compaction: { thresholdRatio: 0.008, retainTokens: 1, headroomTokens: 129000 },
    });
    t.after(f.close);
    readyEvidence(f);
    const first = await preview(f);
    assert.equal(first.reason, "pressure");
    await commit(f, await propose(f));
    businessSteps(f, 3);
    const early = await preview(f);
    assert.equal(early.decision, "wait");
    assert.equal(early.reason, "min_interval");
    assert.equal(early.state.lastReminderStep, first.businessSteps);
    businessStep(f);
    const due = await preview(f);
    assert.equal(due.decision, "remind");
    assert.equal(due.reason, "pressure");
    assert.equal(due.state.ignoredCount, 1);
    assert.equal(due.businessSteps - first.businessSteps, 4);
});

test("unknown or invalid model capacity disables pressure urgency", async (t) => {
    const f = await fixture({ reminders: pressureOnly });
    t.after(f.close);
    readyEvidence(f);
    for (const context of [
        undefined,
        {},
        { contextWindow: 0 },
        { contextWindow: NaN },
        { contextWindow: Infinity },
        { contextWindow: -1 },
        { contextWindow: 1.5 },
        { contextWindow: Number.MAX_SAFE_INTEGER + 1 },
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
        assert.ok(plan.candidateTokens >= pressureOnly.staleTokens);
    }
    assert.equal(stateOf(f).reminderState.lastReminderStep, null);
});

test("candidate token estimates follow the visible pruned body rather than the large archived original", async (t) => {
    const f = await fixture({
        pruner: {},
        reminders: { backlogTokens: 16000, staleTokens: 1_000_000_000 },
    });
    t.after(f.close);
    const original = "HEAD\n" + "ORIGINAL_MIDDLE_EVIDENCE ".repeat(4000) + "\nTAIL";
    const event = f.toolRound("read", original);
    businessSteps(f, 2);
    const id = f.idFor(event);
    const before = await preview(f);
    assert.equal(before.decision, "remind");
    assert.ok(before.candidateTokens >= 16000);
    assert.equal(f.ctx.toolResultPruner.pruneSession(f.session).pruned.length, 1);
    const entry = entryFor(f, id);
    assert.equal(entry.sourceSeq, event.seq);
    assert.notEqual(entry.currentSeq, event.seq);
    const visible = f.meter.measure(f.session).nodes.find((node) => node.seq === entry.currentSeq);
    const after = await preview(f);
    assert.equal(after.candidates.length, 1);
    assert.equal(after.candidates[0].id, id);
    assert.equal(after.candidates[0].tokens, visible.tokens);
    assert.equal(after.candidateTokens, visible.tokens);
    assert.ok(after.candidateTokens < before.candidateTokens);
    assert.ok(after.candidateTokens < 16000);
    assert.equal(after.decision, "wait");
    assert.equal(f.session.eventAt(event.seq).data.message.content[0].text, original);
    assert.equal(entry.status, "available");
});

test("rejected, empty and cancelled admissions cannot persist a proposed reminder", async (t) => {
    const f = await fixture({ reminders: lowered });
    t.after(f.close);
    readyEvidence(f);
    assert.equal((await preview(f)).decision, "remind");
    const user = createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "Continue." }],
    });
    const before = JSON.stringify(stateOf(f));
    const seq = f.session.seq;
    const rejection = { kind: "reject" };
    assert.equal(await propose(f, [user], signal(), rejection), rejection);
    const empty = { kind: "enter", messages: [] };
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

test("candidate previews stay in status and try_release contains bounded numeric IDs only", async (t) => {
    const f = await fixture({ reminders: { ...lowered, maxCandidates: 2 } });
    t.after(f.close);
    const marker = "PREVIEW_SUFFIX";
    const original = "p".repeat(80) + marker + " remaining evidence".repeat(1000);
    const events = Array.from({ length: 7 }, () => f.toolRound("read", original));
    businessSteps(f, 2);
    const before = JSON.stringify(stateOf(f));
    const plan = await preview(f);
    assert.equal(plan.decision, "remind");
    assert.equal(plan.candidates.length, 2);
    for (const candidate of plan.candidates) {
        assert.ok(Array.from(candidate.preview).length <= 100);
        assert.ok(candidate.preview.includes("PREVIEW_SUFFIX"));
    }
    const seqs = new Set(events.map((event) => event.seq));
    const total = f.meter
        .measure(f.session)
        .nodes.filter((node) => seqs.has(node.seq))
        .reduce((sum, node) => sum + node.tokens, 0);
    assert.equal(plan.candidateTokens, total);
    assert.ok(total > plan.candidates.reduce((sum, candidate) => sum + candidate.tokens, 0));
    const notice = noticeOf(await propose(f));
    const text = textOf(notice);
    assert.ok(text.length < 6000);
    assert.equal(text.includes(marker), false);
    assert.equal(text.includes(original), false);
    const line = text.split("\n").find((line) => line.startsWith("try_release:"));
    assert.equal(
        line,
        `try_release: ${plan.candidates.map((candidate) => candidate.id).join(" ")}`,
    );
    assert.match(line, /^try_release: [1-9]\d*(?: [1-9]\d*)*$/);
    assert.equal(
        text.split("\n").at(-1),
        "Review try_release now; call context_release for consumed items after preserving needed facts.",
    );
    assert.equal(JSON.stringify(stateOf(f)), before);
});

test("disabled reminders never establish a cooldown or cause release", async (t) => {
    const f = await fixture({ reminders: { ...lowered, enabled: false } });
    t.after(f.close);
    const { id } = readyEvidence(f);
    const plan = await preview(f);
    assert.equal(plan.decision, "wait");
    assert.equal(plan.reason, "disabled");
    assert.equal(plan.thresholdTokens, null);
    const decision = await propose(f);
    const notice = noticeOf(decision);
    assert.doesNotMatch(textOf(notice), /try_release:|Review try_release/);
    await commit(f, decision, true);
    assert.equal(stateOf(f).reminderState.lastReminderStep, null);
    assert.equal(entryFor(f, id).status, "available");
    assert.equal(f.calls.length, 0);
});
