import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { fixture } from "./fixture.mjs";

let serial = 0;
const execute = (f, name, args) =>
    f.ctx.tools.execute({
        name,
        arguments: args,
        callId: `argument-contract-${++serial}`,
        agent: f.agent,
        signal: new AbortController().signal,
    });
const value = async (f, name, args) => {
    const outcome = await execute(f, name, args);
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    return JSON.parse(
        outcome.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    );
};
const ids = (result) => result.hits.map((hit) => hit.id);
const seed = (f) => {
    const user = f.appendUser("CONTRACT_NEEDLE user request");
    const read = f.toolRound("read", "CONTRACT_NEEDLE source evidence");
    const grep = f.toolRound("grep", "CONTRACT_NEEDLE matching evidence");
    return { user, read, grep };
};

test("exported tool schemas preserve required keys and explicitly accept nullable optional arguments", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const schemas = new Map(
        f.ctx.tools.schemas(f.agent).map((schema) => [schema.name, schema.parameters]),
    );
    const expectedRequired = {
        context_search: ["query"],
        context_expand: ["id"],
        context_status: [],
        context_release: ["ids", "reason"],
        context_compact: ["reason"],
    };
    for (const [name, keys] of Object.entries(expectedRequired)) {
        const schema = schemas.get(name);
        assert.ok(schema, name);
        assertSupportedJsonSchema(schema);
        assert.deepEqual([...(schema.required ?? [])].sort(), [...keys].sort(), name);
    }
    const optional = {
        context_search: ["roles", "tool", "limit", "cursor"],
        context_expand: ["offset", "limit"],
        context_status: ["ids", "limit"],
    };
    for (const [name, keys] of Object.entries(optional)) {
        for (const key of keys) {
            const property = schemas.get(name).properties[key];
            assert.equal(property.default, null, `${name}.${key}`);
            assert.ok(
                property.oneOf.some((branch) => branch.type === "null"),
                `${name}.${key}`,
            );
        }
    }
    const calls = [
        ["context_search", { query: "needle" }],
        ["context_search", { query: "needle", roles: null, tool: null, limit: null, cursor: null }],
        ["context_search", { query: "needle", roles: [], tool: "", limit: 8, cursor: "" }],
        ["context_status", {}],
        ["context_status", { ids: null, limit: null }],
        ["context_status", { ids: [], limit: 32 }],
        ["context_expand", { id: 1, offset: null, limit: null }],
    ];
    for (const [name, args] of calls)
        assert.deepEqual(validateJsonSchemaValue(schemas.get(name), args), [], name);
    assert.ok(
        validateJsonSchemaValue(schemas.get("context_release"), { ids: null, reason: "Consumed" })
            .length,
    );
    assert.ok(validateJsonSchemaValue(schemas.get("context_expand"), { id: null }).length);
});

test("omitted, null and empty search filters return the same evidence", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const originals = seed(f);
    const baseline = await value(f, "context_search", { query: "CONTRACT_NEEDLE" });
    assert.deepEqual(new Set(ids(baseline)), new Set(Object.values(originals).map(f.idFor)));
    for (const empty of [null, ""]) {
        for (const roles of [null, []]) {
            const result = await value(f, "context_search", {
                query: "CONTRACT_NEEDLE",
                roles,
                tool: empty,
                cursor: empty,
                limit: null,
            });
            assert.deepEqual(ids(result), ids(baseline));
        }
    }
    const filtered = await value(f, "context_search", {
        query: "CONTRACT_NEEDLE",
        roles: ["tool"],
        tool: "read",
        cursor: null,
    });
    assert.deepEqual(ids(filtered), [f.idFor(originals.read)]);
});

test("normalized placeholders preserve cursor identity and the original search snapshot", async (t) => {
    const f = await fixture();
    t.after(f.close);
    seed(f);
    const first = await value(f, "context_search", {
        query: "CONTRACT_NEEDLE",
        roles: [],
        tool: "",
        cursor: "",
        limit: 1,
    });
    assert.ok(first.nextCursor);
    const late = f.toolRound("read", "CONTRACT_NEEDLE added after the snapshot");
    const hits = [...first.hits];
    let cursor = first.nextCursor;
    while (cursor !== null) {
        const page = await value(f, "context_search", {
            query: "CONTRACT_NEEDLE",
            roles: null,
            tool: null,
            cursor,
            limit: 1,
        });
        assert.equal(page.throughSeq, first.throughSeq);
        hits.push(...page.hits);
        cursor = page.nextCursor;
    }
    assert.equal(hits.length, 3);
    assert.ok(!hits.some((hit) => hit.id === f.idFor(late)));
    for (const args of [
        { query: "CONTRACT_NEEDLE", tool: "read", cursor: first.nextCursor },
        { query: "CONTRACT_NEEDLE", roles: ["tool"], cursor: first.nextCursor },
        { query: "different", cursor: first.nextCursor },
    ])
        assert.equal((await execute(f, "context_search", args)).isError, true);
});

test("null and empty status selectors use the bounded catalog without scheduling a release", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const originals = seed(f);
    const baseline = await value(f, "context_status", {});
    for (const selector of [null, []]) {
        const result = await value(f, "context_status", { ids: selector, limit: null });
        assert.deepEqual(result.numbers, baseline.numbers);
        assert.deepEqual(result.entries, baseline.entries);
        assert.ok(result.numbers.length <= f.engine.releasePolicy.catalogLimit);
    }
    const id = Number(f.idFor(originals.read));
    const specific = await value(f, "context_status", { ids: [id], limit: null });
    assert.deepEqual(
        specific.numbers.map((number) => number.id),
        [String(id)],
    );
    const limited = await value(f, "context_status", { ids: [], limit: 1 });
    assert.equal(limited.numbers.length, 1);
    assert.ok(f.engine.state(f.session).entries.every((entry) => entry.status === "available"));
});

test("nullable pagination uses the real defaults and explicit offsets still page exact originals", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = f.toolRound("read", "🧠 exact text\n".repeat(600));
    const id = Number(f.idFor(original));
    const baseline = await value(f, "context_expand", { id });
    const defaults = await value(f, "context_expand", { id, offset: null, limit: null });
    assert.deepEqual(defaults, baseline);
    assert.equal(Array.from(defaults.text).length, 4000);
    const paged = await value(f, "context_expand", { id, offset: defaults.nextOffset, limit: 3 });
    assert.equal(
        paged.text,
        Array.from(original.data.message.content[0].text).slice(4000, 4003).join(""),
    );
    for (let index = 0; index < 9; index++) f.toolRound("read", `DEFAULT_LIMIT_NEEDLE ${index}`);
    const search = await value(f, "context_search", {
        query: "DEFAULT_LIMIT_NEEDLE",
        roles: null,
        tool: null,
        cursor: null,
        limit: null,
    });
    assert.equal(search.hits.length, 8);
    assert.ok(search.nextCursor);
});

test("placeholder compatibility never relaxes required arguments, invalid cursors or numeric bounds", async (t) => {
    const f = await fixture();
    t.after(f.close);
    const original = f.toolRound("read", "Retain this evidence.");
    const id = Number(f.idFor(original));
    const invalid = [
        ["context_search", { query: "" }],
        ["context_search", { query: null }],
        ["context_search", { query: "x".repeat(201) }],
        ["context_search", { query: "evidence", roles: ["system"] }],
        ["context_search", { query: "evidence", roles: ["user", "tool", "assistant", "tool"] }],
        ["context_search", { query: "evidence", tool: "x".repeat(257) }],
        ["context_search", { query: "evidence", cursor: "invalid-nonempty" }],
        ["context_search", { query: "evidence", cursor: "x".repeat(2049) }],
        ["context_search", { query: "evidence", limit: 0 }],
        ["context_search", { query: "evidence", limit: 21 }],
        ["context_expand", { id: null }],
        ["context_expand", { id: 0 }],
        ["context_expand", { id: Number.MAX_SAFE_INTEGER + 1 }],
        ["context_expand", { id, offset: -1 }],
        ["context_expand", { id, offset: Number.MAX_SAFE_INTEGER + 1 }],
        ["context_expand", { id, limit: 0 }],
        ["context_expand", { id, limit: 16001 }],
        ["context_status", { ids: [0] }],
        ["context_status", { ids: [Number.MAX_SAFE_INTEGER + 1] }],
        ["context_status", { ids: Array(129).fill(id) }],
        ["context_status", { ids: [], limit: 0 }],
        ["context_status", { ids: null, limit: 129 }],
        ["context_release", { reason: "Consumed" }],
        ["context_release", { ids: [], reason: "Consumed" }],
        ["context_release", { ids: null, reason: "Consumed" }],
        ["context_release", { ids: [id], reason: null }],
        ["context_release", { ids: [id], reason: "   " }],
        ["context_release", { ids: [id], reason: "x".repeat(1001) }],
        ["context_compact", { reason: null }],
        ["context_compact", { reason: "   " }],
        ["context_compact", { reason: "x".repeat(1001) }],
    ];
    for (const [name, args] of invalid) {
        const outcome = await execute(f, name, args);
        assert.equal(outcome.isError, true, `${name}: ${JSON.stringify(args)}`);
    }
    assert.equal(
        f.engine.state(f.session).entries.find((entry) => entry.id === String(id)).status,
        "available",
    );
    assert.equal(f.engine.hasSummaryRequest(f.session), false);
});
