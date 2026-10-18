import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loopFixture, assertTestRoot, call } from "./loop-fixture.mjs";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installForcedReleaseBoundary } from "./release-batch-fixture.mjs";

for (const mode of ["native", "ptc", "siblings"])
    test(`real AgentLoop ${mode} removes controls before the immediately next adapter request`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
        let f;
        let ids;
        let checked = false;
        t.after(async () => {
            await f?.close();
            await assertTestRoot(root);
            await rm(root, { recursive: true, force: true });
        });
        f = await loopFixture(root, {
            strictSession: true,
            tools: { probe_read: () => "Consumed source evidence. ".repeat(300) },
            ...(mode === "native"
                ? {}
                : {
                      ptc: async (tools) => ({
                          value: await tools.context_release({
                              ids,
                              reason: "Private PTC release reason",
                          }),
                      }),
                  }),
            responses: [
                call("probe_read", {}, "business-read"),
                (_request, world) => {
                    ids = [
                        Number(
                            world.engine
                                .state(world.sessions.list()[0])
                                .entries.find((entry) => entry.tool === "probe_read").id,
                        ),
                    ];
                    const native = call(
                        "context_release",
                        { ids, reason: "Private native release reason" },
                        "native-control",
                    );
                    const ptc = call(
                        "run_code",
                        {
                            code: "return await tools.context_release(args)",
                            description: "Release consumed evidence",
                        },
                        "ptc-control",
                    );
                    return mode === "native"
                        ? native
                        : mode === "ptc"
                          ? ptc
                          : { blocks: [...native.blocks, ...ptc.blocks] };
                },
                (request, world) => {
                    const session = world.sessions.list()[0];
                    const rootCalls = request.messages.flatMap((message) =>
                        message.content
                            .filter((block) => block.type === "tool-call")
                            .map((block) => block.id),
                    );
                    assert.deepEqual(rootCalls, ["business-read"]);
                    assert.equal(
                        request.messages.some(
                            (message) =>
                                message.role === "tool" &&
                                ["native-control", "ptc-control"].includes(message.source.callId),
                        ),
                        false,
                    );
                    assert.equal(
                        request.messages.some(
                            (message) => message.source.kind === "fold-context-release-cleanup",
                        ),
                        false,
                    );
                    assert.equal(
                        JSON.stringify(request.messages).includes("Private native release reason"),
                        false,
                    );
                    assert.equal(
                        JSON.stringify(request.messages).includes("Private PTC release reason"),
                        false,
                    );
                    assert.equal(
                        world.engine
                            .state(session)
                            .entries.find((entry) => entry.id === String(ids[0])).status,
                        "released",
                    );
                    assert.equal(world.summaries.length, 0);
                    checked = true;
                    return { blocks: [{ type: "text", text: "Business result preserved." }] };
                },
            ],
        });
        installForcedReleaseBoundary(f);
        const handle = await f.create();
        await f.followup(handle, "Preserve A, release consumed evidence, then continue.");
        assert.ok(checked);
        assert.equal(f.requests.length, 3);
        assert.equal(f.summaries.length, 0);
    });

test("a pure PTC call reusing an earlier retained native callId still disappears", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "fold-context-test-"));
    let f;
    let ids;
    let checked = false;
    t.after(async () => {
        await f?.close();
        await assertTestRoot(root);
        await rm(root, { recursive: true, force: true });
    });
    f = await loopFixture(root, {
        strictSession: true,
        tools: { probe_read: () => "Consumed source evidence." },
        ptc: async (tools) => ({
            value: await tools.context_release({ ids, reason: "Already consumed" }),
        }),
        responses: [
            call("probe_read"),
            (_request, world) => {
                ids = [
                    Number(
                        world.engine
                            .state(world.sessions.list()[0])
                            .entries.find((entry) => entry.tool === "probe_read").id,
                    ),
                ];
                return call("context_release", { ids, reason: "Consumed" }, "reused-control-id");
            },
            () =>
                call(
                    "run_code",
                    {
                        code: "return await tools.context_release(args)",
                        description: "Release settled evidence",
                    },
                    "reused-control-id",
                ),
            (request) => {
                const names = request.messages.flatMap((message) =>
                    message.content
                        .filter(
                            (block) =>
                                block.type === "tool-call" && block.id === "reused-control-id",
                        )
                        .map((block) => block.name),
                );
                assert.deepEqual(names, ["context_release"]);
                assert.ok(
                    JSON.stringify(request.messages).includes(
                        "Interleaved business finding must remain.",
                    ),
                );
                checked = true;
                return { blocks: [{ type: "text", text: "Continued successfully." }] };
            },
        ],
    });
    f.ctx.on("tools/result", (exec) => {
        if (exec.name !== "context_release" || exec.parent !== undefined) return;
        const message = createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: "Interleaved business finding must remain." }],
        });
        exec.agent.session.append("user/message", message, { surfaceOp: "append" });
    });
    installForcedReleaseBoundary(f);
    const handle = await f.create();
    await f.followup(handle, "Continue after releasing consumed evidence.");
    assert.ok(checked);
    assert.equal(f.requests.length, 4);
});
