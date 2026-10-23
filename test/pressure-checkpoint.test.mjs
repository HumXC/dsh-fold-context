import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { fixture } from "./fixture.mjs";
import {
    hasSummaryBusinessEvidence,
    isSummaryControlNotice,
} from "../lib/domain/summary-evidence.js";

const signal = () => new AbortController().signal;
async function pressureWorld(t, tail = "Current task requirements. ".repeat(150)) {
    const f = await fixture({
        compaction: { auto: true, targetTokens: 2048 },
    });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({
        context: { contextWindow: 4096 },
        defaultMaxTokens: 1024,
    });
    f.session.append("turn/start", { turn: 1 });
    const checkpoint = f.session.append(
        "user/message",
        createUserMessage({
            source: { kind: "compact-checkpoint", compactionId: randomUUID() },
            content: [{ type: "text", text: "Previously summarized requirements. ".repeat(1000) }],
        }),
        { surfaceOp: "append" },
    );
    const notice = f.session.append(
        "user/message",
        createUserMessage({
            source: { kind: "fold-context-release-cleanup" },
            content: [{ type: "text", text: "Old release bookkeeping. " }],
        }),
        { surfaceOp: "append" },
    );
    f.appendUser(tail);
    return { ...f, checkpoint, notice };
}

test("automatic pressure never resummarizes only an old checkpoint and management notice", async (t) => {
    const f = await pressureWorld(t);
    const events = f.session.snapshotEvents();
    assert.ok(f.meter.measure(f.session).totalTokens > 4096 * 0.5);
    for (let i = 0; i < 3; i++)
        assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.session.snapshotEvents(), events);
    assert.equal(f.engine.state(f.session).lastSummary, null);
    assert.equal(
        (await f.engine.schedulingStatus(f.agent, signal())).reason,
        "no_business_evidence",
    );
    assert.deepEqual(f.session.snapshotEvents(), events);
    f.appendUser("NEW_WORK_AND_LATEST_USER_REQUEST ".repeat(120));
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    assert.equal(f.calls.length, 1, "new business evidence enables pressure compaction again");
});

test("a pressure retry stops after useful compaction when only its new checkpoint remains selectable", async (t) => {
    const f = await fixture({
        compaction: { auto: true, targetTokens: 2048 },
    });
    t.after(f.close);
    f.llm.resolveModelInfo = async () => ({
        context: { contextWindow: 4096 },
        defaultMaxTokens: 1024,
    });
    f.session.append("turn/start", { turn: 1 });
    f.appendUser("Earlier unsummarized business evidence. ".repeat(1000));
    f.appendUser("LATEST_TAIL_".repeat(1000));
    assert.ok(await f.engine.compactIfNeeded(f.agent, "pressure", signal()));
    assert.equal(f.calls.length, 1, "one useful summary, no repeat summary of that summary");
    assert.ok(f.meter.measure(f.session).totalTokens >= 4096 * 0.5);
    assert.equal(await f.engine.compactIfNeeded(f.agent, "pressure", signal()), null);
    assert.equal(f.calls.length, 1);
});

for (const action of ["manual", "overflow", "explicit-request"]) {
    test(`${action} remains available for checkpoint-only selections`, async (t) => {
        const f = await pressureWorld(t);
        if (action === "manual")
            f.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
        if (action === "explicit-request")
            await f.invoke("context_compact", { reason: "Explicit checkpoint request" });
        const result =
            action === "manual"
                ? await f.engine.compactNow(f.agent, signal())
                : await f.engine.compactIfNeeded(
                      f.agent,
                      action === "overflow" ? "context-overflow" : "pressure",
                      signal(),
                  );
        assert.ok(result);
        assert.equal(f.calls.length, 1);
    });
}

test("management notices and control chatter are distinct from recoverable business evidence", () => {
    const message = (kind, content, role = "user") => ({ role, source: { kind }, content });
    for (const kind of ["fold-context-allocation", "fold-context-release-cleanup"])
        assert.equal(
            isSummaryControlNotice(message(kind, [{ type: "text", text: "ledger" }])),
            true,
        );
    assert.equal(
        hasSummaryBusinessEvidence(
            message("compact-checkpoint", [{ type: "text", text: "old facts" }]),
        ),
        false,
    );
    assert.equal(
        hasSummaryBusinessEvidence(
            message("tool", [{ type: "text", text: "status" }], "tool"),
            "context_status",
        ),
        false,
    );
    assert.equal(
        hasSummaryBusinessEvidence(
            message("tool", [{ type: "text", text: "recovered facts" }], "tool"),
            "context_expand",
        ),
        true,
    );
    assert.equal(
        hasSummaryBusinessEvidence(
            message(
                "assistant",
                [
                    { type: "text", text: "checking ledger" },
                    { type: "tool-call", name: "context_status" },
                ],
                "assistant",
            ),
        ),
        false,
    );
    assert.equal(
        hasSummaryBusinessEvidence(
            message("user", [{ type: "text", text: "New user requirements" }]),
        ),
        true,
    );
});
