/** Real dsh-tools PTC bridge with a deterministic in-process program implementation. */
export function installPtcStub(ctx, program) {
    ctx.provide("ptcRuntime", {
        language: "typescript",
        resolve: (request) => ({ ...request, cwd: request.cwd ?? "/tmp", timeoutMs: null }),
        run: async (spec) => {
            const tools = spec.bindings.find((binding) => binding.global === "tools").functions;
            return { logs: [], ...(await program(tools, spec)) };
        },
    });
}
