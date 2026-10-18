import test from "node:test";
import assert from "node:assert/strict";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { admissionLedger, previousAdmissionLedger } from "../lib/domain/admission-ledger.js";
import { ledgerProjection } from "../lib/domain/ledger.js";
import { fixture } from "./fixture.mjs";

const policy = { catalogLimit: 32 };
const user = (text) =>
    createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text }],
    });
const textOf = (message) => message.content.map((block) => block.text ?? "").join("");
const entry = (number, status = "available") => ({
    id: String(number),
    role: "assistant",
    ownerId: null,
    blockIndex: null,
    sourceSeq: number,
    currentSeq: status === "available" ? number : null,
    messageId: `message-${number}`,
    callId: null,
    tool: null,
    preview: "evidence",
    status,
    queuedAt: status === "queued" ? number + 10 : null,
    reason: null,
});
const stateWith = (entries) => ({ ...ledgerProjection.init(), entries });
async function propose(f, messages, step = 1, base = { kind: "enter", messages }) {
    return f.ctx.waterfall(
        "agent/pre-step",
        {
            agent: f.agent,
            messages,
            turn: 1,
            step,
            signal: new AbortController().signal,
        },
        async () => base,
    );
}
async function commit(f, decision, step = 1) {
    f.advanceSteps(step);
    f.session.append("step/start", { turn: 1, step });
    await f.ctx.waterfall(
        "agent/request",
        { agent: f.agent, turn: 1, step, signal: new AbortController().signal },
        async () => ({ provider: "test", model: "fixture" }),
    );
    for (const message of decision.messages)
        f.session.append("user/message", message, { surfaceOp: "append" });
    f.session.append("step/end", { turn: 1, step });
}

test("admission previews are pure, bounded and carry only displayed fingerprints", () => {
    const state = stateWith(Array.from({ length: 20 }, (_, index) => entry(index + 1, "released")));
    state.lastSummary = {
        seq: 90,
        ids: state.entries.map((item) => item.id),
        excludedIds: state.entries.map((item) => item.id),
        projection: null,
    };
    const original = JSON.stringify(state);
    const notice = admissionLedger(state, policy, null);
    assert.equal(notice.view.rows.length, 8);
    assert.equal(notice.omitted, 12);
    assert.match(notice.text, /12 semantic rows omitted/);
    assert.match(notice.text, /coverage .*\(\+12 omitted\)/);
    assert.match(notice.text, /excluded .*\(\+12 omitted\)/);
    assert.match(notice.text, /context_status/);
    assert.deepEqual(JSON.parse(JSON.stringify(notice.view)), notice.view);
    assert.equal(JSON.stringify(state), original);
    assert.deepEqual(admissionLedger(state, policy, null), notice);
    const next = admissionLedger(state, policy, { seq: 91, view: notice.view });
    assert.equal(next.view.rows.length, 8);
    assert.equal(next.omitted, 0);
    assert.deepEqual(
        next.view.rows,
        notice.view.rows,
        "omitted rows are not recorded as delivered",
    );
    let previous = { seq: 92, view: next.view };
    for (let round = 0; round < 4; round++) {
        const stable = admissionLedger(state, policy, previous);
        assert.equal(
            stable.text,
            "",
            "evicted terminal fingerprints must not create fresh changes",
        );
        previous = { seq: previous.seq + 1, view: stable.view };
    }
    state.entries.push(entry(200));
    const fresh = admissionLedger(state, policy, previous);
    assert.match(fresh.text, /200 available/);
    assert.doesNotMatch(fresh.text, /(?:^|; )(?:[1-9]|1\d|20) released/);
    assert.doesNotMatch(next.text, /lastSummary/);
    assert.equal(admissionLedger(state, { catalogLimit: 2 }, null).view.rows.length, 2);
});

test("semantic deltas suppress stable rows and declaration duplication", () => {
    const state = stateWith([entry(1), entry(2), entry(3)]);
    const first = admissionLedger(state, policy, null, ["3"]);
    assert.doesNotMatch(first.text, /(?:^|; )3 available/);
    const previous = { seq: 5, view: first.view };
    assert.equal(admissionLedger(state, policy, previous).text, "");
    state.entries[0] = { ...state.entries[0], status: "released", currentSeq: null };
    state.lastSummary = { seq: 20, ids: ["1"], excludedIds: ["1"], projection: null };
    const changed = admissionLedger(state, policy, previous);
    assert.match(changed.text, /1 released/);
    assert.match(changed.text, /lastSummary: coverage 1; excluded 1/);
    assert.doesNotMatch(changed.text, /message-1|currentSeq|reservation/);
});

test("previous view lookup is bounded to current surface and newest relevant notice", () => {
    let reads = 0;
    const fake = {
        surface: { nodes: Array.from({ length: 1000 }, (_, index) => index) },
        eventAt: (seq) => {
            reads += 1;
            return { type: "user/message", data: user(`node ${seq}`) };
        },
        snapshotEvents: () => {
            throw new Error("historical log must not be scanned");
        },
    };
    assert.equal(previousAdmissionLedger(fake), null);
    assert.equal(reads, 64);
    const valid = { version: 1, rows: [], summaryWatermark: null };
    fake.surface.nodes = [1, 2];
    fake.eventAt = (seq) => ({
        type: "user/message",
        data: {
            source: {
                kind: "fold-context-allocation",
                ...(seq === 1 ? { ledgerView: valid } : {}),
            },
        },
    });
    assert.equal(previousAdmissionLedger(fake), null, "legacy newest notice forces bootstrap");
    fake.surface.nodes = [1];
    assert.deepEqual(previousAdmissionLedger(fake), { seq: 1, view: valid });
    fake.eventAt = () => ({
        type: "user/message",
        data: {
            source: {
                kind: "fold-context-allocation",
                ledgerView: {
                    ...valid,
                    rows: Array(9).fill({ id: "1", fingerprint: "available:" }),
                },
            },
        },
    });
    assert.equal(previousAdmissionLedger(fake), null);
});

test("one plain notice preserves raw input and cold/fork replay without a runtime ledger", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const input = user("Persist the numbering");
    const decision = await propose(f, [input], 1, {
        kind: "enter",
        messages: [input],
        startsRequestSeries: true,
    });
    assert.equal(decision.startsRequestSeries, true);
    assert.equal(decision.messages.length, 2);
    assert.equal(decision.messages[0], input);
    assert.equal(textOf(decision.messages[0]), "Persist the numbering");
    const notice = decision.messages[1];
    assert.equal(notice.source.kind, "fold-context-allocation");
    assert.equal(textOf(notice), "prev: 1\nnext: 2");
    assert.equal(notice.source.allocation.assistantId, "2");
    await commit(f, decision);
    const seed = JSON.parse(JSON.stringify(f.session.snapshotEvents()));
    const cold = Session.create(f.session.id, seed, f.session.header);
    const fork = f.sessions.fork(f.session);
    assert.equal(previousAdmissionLedger(cold), null);
    assert.equal(previousAdmissionLedger(fork), null);
    assert.deepEqual(f.engine.state(cold).numbering, f.engine.state(fork).numbering);
    assert.deepEqual(f.engine.state(fork).numbering, f.engine.state(f.session).numbering);
});

test("rejected, empty and cancelled admissions commit no ledger or numbering", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const input = user("Reject this input");
    const before = JSON.stringify(f.engine.state(f.session));
    const seq = f.session.seq;
    const rejection = { kind: "reject" };
    assert.equal(await propose(f, [input], 1, rejection), rejection);
    const empty = { kind: "enter", messages: [] };
    assert.equal(await propose(f, [], 1, empty), empty);
    assert.equal(await propose(f, [input], 2, empty), empty);
    await assert.rejects(
        f.ctx.waterfall(
            "agent/pre-step",
            {
                agent: f.agent,
                messages: [input],
                turn: 1,
                step: 1,
                signal: AbortSignal.abort(),
            },
            async () => ({ kind: "enter", messages: [input] }),
        ),
        { name: "AbortError" },
    );
    assert.equal(f.session.seq, seq);
    assert.equal(JSON.stringify(f.engine.state(f.session)), before);
    assert.equal(previousAdmissionLedger(f.session), null);
});
