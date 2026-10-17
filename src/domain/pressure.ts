import { z } from "zod";
import type { Message, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { summarySnapshot } from "./summary-evidence.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const routeSchema = z.object({ provider: z.string(), model: z.string() });
const nodeSchema = z.object({
    seq: count,
    tokens: count,
    outputTokens: count,
    replayRoute: routeSchema.nullable(),
    snapshotEvidence: z.boolean().nullable(),
});
export const pressureStateSchema = z.object({
    route: routeSchema.nullable(),
    toolsTokens: count,
    nodes: z.array(nodeSchema),
    snapshots: z.record(z.string(), z.string()),
    nativeAnchor: z.object({ route: routeSchema, replayExtra: count }).nullable(),
    sample: z
        .object({
            seq: count,
            route: routeSchema,
            promptTokens: count,
            surfaceTokens: count,
            toolsTokens: count,
        })
        .nullable(),
    effect: z
        .object({
            seq: count,
            compactionId: z.string(),
            route: routeSchema.nullable(),
            beforeTokens: count,
            afterTokens: count.nullable(),
            afterSurfaceTokens: count.nullable(),
            afterToolsTokens: count.nullable(),
            observedPromptTokens: count.nullable(),
            normalizedObservedTokens: z.number().finite().nullable(),
            observedSavingsTokens: z.number().finite().nullable(),
            status: z.enum([
                "awaiting_replacement",
                "awaiting_usage",
                "effective",
                "ineffective",
                "route_changed",
            ]),
        })
        .nullable(),
    retentionPenalty: count,
});
export type PressureState = z.infer<typeof pressureStateSchema>;
type Route = z.infer<typeof routeSchema>;
export interface NativeMeasurement {
    readonly totalTokens: number;
    readonly nodes: readonly { readonly seq: number; readonly tokens: number }[];
}
const sameRoute = (a: Route | null, b: Route | null) =>
    a !== null && b !== null && a.provider === b.provider && a.model === b.model;
const safe = (value: number) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value)));
function cost(node: PressureState["nodes"][number], route: Route | null): number {
    // Output usage is a conservative selection price, not exact replay billing.
    return sameRoute(node.replayRoute, route)
        ? Math.max(node.tokens, node.outputTokens)
        : node.tokens;
}
function totals(state: PressureState) {
    let surface = 0;
    let replayExtra = 0;
    for (const node of state.nodes) {
        const priced = cost(node, state.route);
        surface += priced;
        replayExtra += priced - node.tokens;
    }
    return { surface: safe(surface), replayExtra: safe(replayExtra) };
}
export function planningPressure(state: PressureState, native?: NativeMeasurement) {
    const { surface, replayExtra } = totals(state);
    const anchored = state.sample !== null && sameRoute(state.sample.route, state.route);
    const removedReplayTokens =
        state.nativeAnchor !== null && sameRoute(state.nativeAnchor.route, state.route)
            ? Math.max(0, state.nativeAnchor.replayExtra - replayExtra)
            : 0;
    const routePrices = new Map(native?.nodes.map((node) => [node.seq, node.tokens]));
    const nodes = state.nodes.map((node) => ({
        seq: node.seq,
        tokens: Math.max(routePrices.get(node.seq) ?? node.tokens, cost(node, state.route)),
    }));
    const pricedSurface = safe(nodes.reduce((sum, node) => sum + node.tokens, 0));
    const calibrated = anchored
        ? state.sample!.promptTokens +
          surface -
          state.sample!.surfaceTokens +
          state.toolsTokens -
          state.sample!.toolsTokens
        : 0;
    return {
        totalTokens: safe(
            Math.max(
                pricedSurface + state.toolsTokens,
                calibrated,
                native === undefined ? 0 : native.totalTokens - removedReplayTokens,
            ),
        ),
        surfaceTokens: pricedSurface,
        replayExtraTokens: replayExtra,
        removedReplayTokens,
        providerPromptTokens: anchored ? state.sample!.promptTokens : null,
        usageSeq: anchored ? state.sample!.seq : null,
        nodes,
    };
}
function messageOf(event: SessionEvent): Message | null {
    switch (event.type) {
        case "user/message":
            return event.data;
        case "system/message":
        case "developer/message":
        case "assistant/message":
        case "tool/result":
            return event.data.message;
        default:
            return null;
    }
}
function usageOf(event: SessionEvent): TokenUsage | null {
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return null;
    if (event.type === "assistant/message" && event.data.usage !== undefined)
        return event.data.usage;
    for (let index = event.data.stream.length - 1; index >= 0; index--) {
        const record = event.data.stream[index];
        if (record?.type === "chunk" && record.chunk.type === "usage") return record.chunk.usage;
    }
    return null;
}
declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionStateMap {
        contextCompressionPressure: PressureState;
    }
}
/** Selection-only prices; never writes native shadow-price claims. */
export function createPressureProjection(
    estimateMessage: (message: Message) => number,
): ProjectionDefinition<"contextCompressionPressure"> {
    return {
        key: "contextCompressionPressure",
        stateVersion: 1,
        stateSchema: pressureStateSchema,
        init: () => ({
            route: null,
            toolsTokens: 0,
            nodes: [],
            snapshots: {},
            nativeAnchor: null,
            sample: null,
            effect: null,
            retentionPenalty: 0,
        }),
        apply(state, event) {
            if (event.type === "request/header") {
                const { config, tools } = event.data.header;
                const route = { provider: config.provider, model: config.model };
                const toolsTokens = tools?.length
                    ? Math.ceil(JSON.stringify(tools).length / 4) + 4
                    : 0;
                const changedRoute = !sameRoute(route, state.route);
                return {
                    ...state,
                    route,
                    toolsTokens,
                    retentionPenalty: changedRoute ? 0 : state.retentionPenalty,
                    effect:
                        changedRoute && state.effect !== null
                            ? { ...state.effect, status: "route_changed" }
                            : state.effect,
                };
            }
            let next = state;
            const usage = usageOf(event);
            if (usage !== null && state.route !== null) {
                const message = messageOf(event);
                const route =
                    message?.role === "assistant"
                        ? { provider: message.source.provider, model: message.source.model }
                        : state.route;
                if (sameRoute(route, state.route)) {
                    const { surface } = totals(state);
                    const promptTokens = safe(
                        usage.inputTokens +
                            (usage.cacheReadTokens ?? 0) +
                            (usage.cacheWriteTokens ?? 0),
                    );
                    let effect = state.effect;
                    let retentionPenalty = state.retentionPenalty;
                    if (
                        effect?.status === "awaiting_usage" &&
                        effect.afterSurfaceTokens !== null &&
                        effect.afterToolsTokens !== null
                    ) {
                        if (sameRoute(effect.route, route)) {
                            const movement =
                                surface -
                                effect.afterSurfaceTokens +
                                state.toolsTokens -
                                effect.afterToolsTokens;
                            const normalizedObservedTokens = promptTokens - movement;
                            const observedSavingsTokens =
                                effect.beforeTokens - normalizedObservedTokens;
                            effect = {
                                ...effect,
                                observedPromptTokens: promptTokens,
                                normalizedObservedTokens,
                                observedSavingsTokens,
                                status: observedSavingsTokens > 0 ? "effective" : "ineffective",
                            };
                            retentionPenalty =
                                observedSavingsTokens > 0 ? 0 : Math.min(4, retentionPenalty + 1);
                        } else effect = { ...effect, status: "route_changed" };
                    }
                    next = {
                        ...next,
                        effect,
                        retentionPenalty,
                        sample: {
                            seq: event.seq,
                            route,
                            promptTokens,
                            surfaceTokens: surface,
                            toolsTokens: state.toolsTokens,
                        },
                    };
                }
            }
            if (event.type === "compaction/summary") {
                return {
                    ...next,
                    effect: {
                        seq: event.seq,
                        compactionId: event.data.compactionId,
                        route: state.route,
                        beforeTokens: planningPressure(state).totalTokens,
                        afterTokens: null,
                        afterSurfaceTokens: null,
                        afterToolsTokens: null,
                        observedPromptTokens: null,
                        normalizedObservedTokens: null,
                        observedSavingsTokens: null,
                        status: "awaiting_replacement",
                    },
                };
            }
            const message = messageOf(event);
            if (message === null || event.surfaceOp === undefined) return next;
            const outputTokens =
                message.role === "assistant" &&
                message.source.replayState !== undefined &&
                usage !== null
                    ? safe(usage.outputTokens)
                    : 0;
            const snapshot = summarySnapshot(message);
            const previous = snapshot === null ? undefined : next.snapshots[snapshot.kind];
            const snapshotEvidence =
                snapshot === null
                    ? null
                    : previous === undefined
                      ? snapshot.initialEvidence
                      : previous !== snapshot.fingerprint;
            const snapshots =
                snapshot === null
                    ? next.snapshots
                    : { ...next.snapshots, [snapshot.kind]: snapshot.fingerprint };
            const node = {
                seq: event.seq,
                tokens: estimateMessage(message),
                outputTokens,
                snapshotEvidence,
                replayRoute:
                    outputTokens > 0 && message.role === "assistant"
                        ? { provider: message.source.provider, model: message.source.model }
                        : null,
            };
            let nodes: PressureState["nodes"];
            if (event.surfaceOp === "append") nodes = [...next.nodes, node];
            else {
                const operation = event.surfaceOp;
                const first = next.nodes.findIndex((item) => item.seq === operation.startSeq);
                const last = next.nodes.findIndex((item) => item.seq === operation.endSeq);
                if (first < 0 || last < first)
                    throw new Error("fold-context pressure: replacement span missing from surface");
                nodes = [...next.nodes.slice(0, first), node, ...next.nodes.slice(last + 1)];
            }
            next = { ...next, nodes, snapshots };
            if (event.type === "assistant/message") {
                // Match the SDK's settled-message anchor; an attempt updates only prompt calibration.
                next = {
                    ...next,
                    nativeAnchor:
                        event.data.usage !== undefined && next.route !== null
                            ? { route: next.route, replayExtra: totals(next).replayExtra }
                            : null,
                };
            }
            if (
                next.effect?.status === "awaiting_replacement" &&
                message.source?.kind === "compact-checkpoint" &&
                (message.source as { compactionId?: string }).compactionId ===
                    next.effect.compactionId
            ) {
                next = {
                    ...next,
                    effect: {
                        ...next.effect,
                        afterTokens: planningPressure(next).totalTokens,
                        afterSurfaceTokens: totals(next).surface,
                        afterToolsTokens: next.toolsTokens,
                        status: "awaiting_usage",
                    },
                };
            }
            return next;
        },
    };
}
