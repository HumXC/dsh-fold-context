import test from "node:test";
import assert from "node:assert/strict";
import {
    projectionStamp,
    readProjectionStamp,
    readSessionSummaryIdentity,
    sessionSummaryStamp,
} from "../lib/domain/summary-policy.js";

const compactionId = "compaction";
const checkpointId = "checkpoint";
const independent = {
    reasoning: "omit-from-summary",
    images: "references",
    execution: "independent",
    compactionId,
};
const session = {
    reasoning: "preserve",
    images: "native",
    execution: "session",
    compactionId,
    checkpointId,
};
const historical = { reasoning: "preserve", images: "native", compactionId };
const stamp = (version, value) => `[fold-context-projection:${version} ${JSON.stringify(value)}]`;
function currentPayload(text) {
    const prefix = "[fold-context-projection:3 ";
    assert.ok(text.startsWith(prefix));
    assert.ok(text.endsWith("]"));
    return JSON.parse(text.slice(prefix.length, -1));
}
function rejects(text, expectedId = compactionId) {
    assert.equal(readProjectionStamp(text, expectedId), null);
    assert.equal(readSessionSummaryIdentity(text, expectedId), null);
}

for (const reasoning of ["preserve", "omit-from-summary"]) {
    for (const images of ["native", "references"]) {
        test(`historical v2 ${reasoning}/${images} remains policy-only`, () => {
            const text = stamp(2, { reasoning, images, compactionId });
            assert.deepEqual(readProjectionStamp(text, compactionId), { reasoning, images });
            assert.equal(readSessionSummaryIdentity(text, compactionId), null);
            rejects(text, "different");
        });
        test(`independent writers use v3 for ${reasoning}/${images} with or without a checkpoint`, () => {
            for (const checkpoint of [undefined, checkpointId]) {
                const text = projectionStamp({ reasoning }, compactionId, images, checkpoint);
                assert.deepEqual(currentPayload(text), {
                    reasoning,
                    images,
                    execution: "independent",
                    compactionId,
                    ...(checkpoint === undefined ? {} : { checkpointId: checkpoint }),
                });
                assert.deepEqual(readProjectionStamp(text, compactionId), {
                    reasoning,
                    images,
                    execution: "independent",
                });
                assert.deepEqual(
                    readSessionSummaryIdentity(text, compactionId),
                    checkpoint === undefined
                        ? null
                        : { checkpointId: checkpoint, execution: "independent" },
                );
                rejects(text, "different");
            }
        });
    }
}

test("session writer keeps the preserve/native v3 two-phase checkpoint identity", () => {
    const text = sessionSummaryStamp(compactionId, checkpointId);
    assert.deepEqual(currentPayload(text), session);
    assert.deepEqual(readProjectionStamp(text, compactionId), {
        reasoning: "preserve",
        images: "native",
        execution: "session",
    });
    assert.deepEqual(readSessionSummaryIdentity(text, compactionId), {
        checkpointId,
        execution: "session",
    });
    rejects(text, "different");
});

test("a compaction-only v3 identity never fabricates a checkpoint from its compaction ID", () => {
    const text = projectionStamp({ reasoning: "preserve" }, checkpointId, "native");
    assert.deepEqual(currentPayload(text), {
        reasoning: "preserve",
        images: "native",
        execution: "independent",
        compactionId: checkpointId,
    });
    assert.equal(readSessionSummaryIdentity(text, checkpointId), null);
});

test("ordinary historical summaries have no projection policy or checkpoint identity", () => {
    for (const text of [undefined, "", "ordinary summary", "[another-projection:3 {}]"]) {
        assert.equal(readProjectionStamp(text, compactionId), undefined);
        assert.equal(readSessionSummaryIdentity(text, compactionId), null);
    }
});

test("malformed and unknown projection versions are rejected by both readers", () => {
    for (const text of [
        "[fold-context-projection:",
        "[fold-context-projection:3 {]",
        stamp(3, independent).slice(0, -1),
        `${stamp(3, independent)} trailing`,
        ...[0, 1, 4, "03", "3.0", "future"].map((version) => stamp(version, independent)),
        ...[null, [], 1, "policy"].map((value) => stamp(3, value)),
    ])
        rejects(text);
});

const invalidCurrent = [
    ["missing recipe", {}],
    ["missing reasoning", { ...independent, reasoning: undefined }],
    ["missing images", { ...independent, images: undefined }],
    ["missing compaction", { ...independent, compactionId: undefined }],
    ["missing execution", { ...independent, execution: undefined }],
    ["unknown reasoning", { ...independent, reasoning: "auto" }],
    ["unknown images", { ...independent, images: "auto" }],
    ["unknown execution", { ...independent, execution: "helper" }],
    ["nonstring execution", { ...independent, execution: null }],
    ["nonstring compaction", { ...independent, compactionId: 1 }],
    ["empty compaction", { ...independent, compactionId: "" }],
    ["blank compaction", { ...independent, compactionId: " \t" }],
    ["unknown field", { ...independent, owner: checkpointId }],
    ["nested fake identity", { ...independent, identity: { checkpointId } }],
    ["prototype-shaped fake identity", { ...independent, ["__proto__"]: { checkpointId } }],
    ["session without checkpoint", { ...session, checkpointId: undefined }],
    ["session unknown field", { ...session, owner: checkpointId }],
    ["session omitting reasoning", { ...session, reasoning: "omit-from-summary" }],
    ["session referencing images", { ...session, images: "references" }],
    [
        "session changing both recipe fields",
        { ...session, reasoning: "omit-from-summary", images: "references" },
    ],
];
for (const execution of ["independent", "session"]) {
    for (const checkpoint of ["", " \n", null, 0, {}, []])
        invalidCurrent.push([
            `${execution} invalid checkpoint ${JSON.stringify(checkpoint)}`,
            { ...(execution === "session" ? session : independent), checkpointId: checkpoint },
        ]);
}
for (const [name, value] of invalidCurrent)
    test(`v3 rejects ${name} without accepting a checkpoint identity`, () =>
        rejects(stamp(3, value)));

test("historical v2 cannot smuggle execution, checkpoint or unknown fields", () => {
    for (const value of [
        { ...historical, execution: "independent" },
        { ...historical, checkpointId },
        { ...historical, execution: "session", checkpointId },
        { ...historical, version: 2 },
        { ...historical, reasoning: "auto" },
        { ...historical, images: "auto" },
        { ...historical, compactionId: "" },
    ])
        rejects(stamp(2, value));
});

test("writers reject invalid identities and recipes instead of emitting invalid stamps", () => {
    for (const id of ["", " \n", undefined, null, 0]) {
        assert.throws(() => projectionStamp({ reasoning: "preserve" }, id, "native"));
        assert.throws(() => sessionSummaryStamp(id, checkpointId));
        assert.throws(() => sessionSummaryStamp(compactionId, id));
    }
    for (const checkpoint of ["", " \n", null, 0, {}, []])
        assert.throws(() =>
            projectionStamp({ reasoning: "preserve" }, compactionId, "native", checkpoint),
        );
    assert.throws(() => projectionStamp({ reasoning: "auto" }, compactionId, "native"));
    assert.throws(() => projectionStamp({}, compactionId, "native"));
    assert.throws(() => projectionStamp({ reasoning: "preserve" }, compactionId, "auto"));
});

test("projection identity matching is exact and does not normalize meaningful IDs", () => {
    const id = " compaction ";
    const text = projectionStamp({ reasoning: "preserve" }, id, "native", " checkpoint ");
    assert.deepEqual(readSessionSummaryIdentity(text, id), {
        checkpointId: " checkpoint ",
        execution: "independent",
    });
    rejects(text, id.trim());
});
