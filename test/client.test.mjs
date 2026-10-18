import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
function client() {
    let plugin;
    let counter = 0;
    const react = {
        Fragment: Symbol("Fragment"),
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useId: () => `test-${++counter}`,
        useSyncExternalStore: (_subscribe, get) => get(),
        useState: (initial) => [initial, () => {}],
        useEffect: () => {},
    };
    runInNewContext(source, {
        window: {
            __ModuleLoader__: {
                load(value) {
                    plugin = value.factory((name) => {
                        assert.equal(
                            name,
                            "react",
                            "Client must use the supplied React singleton only",
                        );
                        return react;
                    });
                },
            },
        },
    });
    const views = new Map();
    const definitions = [];
    const dictionaries = new Map();
    let language = "zh";
    plugin.apply({
        effect: (callback) => callback(),
        locale: {
            register: (_ns, dicts) => {
                assert.deepEqual(Object.keys(dicts).sort(), ["en", "zh"]);
                for (const [locale, dict] of Object.entries(dicts)) dictionaries.set(locale, dict);
                return () => dictionaries.clear();
            },
            bind: () => (key) => dictionaries.get(language)[key] ?? key,
            subscribe: () => () => {},
            getSnapshot: () => language,
        },
        uiConversation: { events: { register: (definition) => definitions.push(definition) } },
        slots: {
            inject(_name, callback) {
                const out = callback();
                if (out?.next) [...out];
            },
            register: (options, component) => {
                views.set(options.key, component);
                return () => {};
            },
        },
    });
    function render(element) {
        if (element == null || typeof element === "boolean") return null;
        if (typeof element === "string" || typeof element === "number") return element;
        if (Array.isArray(element)) return element.map(render);
        if (typeof element.type === "function") return render(element.type(element.props));
        return {
            ...element,
            props: { ...element.props, children: element.props.children.map(render) },
        };
    }
    function visibleText(node) {
        if (node == null) return "";
        if (typeof node !== "object") return String(node);
        if (Array.isArray(node)) return node.map(visibleText).join(" ");
        return node.type === "style" ? "" : visibleText(node.props.children);
    }
    return {
        plugin,
        views,
        definitions,
        render,
        visibleText,
        setLanguage: (value) => {
            language = value;
        },
    };
}
const outcome = (toolName, args, value, extra = {}) => ({
    toolName,
    phase: "result",
    useDisclosure: () => ({ expanded: true, toggle() {} }),
    block: {
        call: { name: toolName, argsRaw: JSON.stringify(args) },
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError: false,
        ...extra,
    },
});
const queued = { accepted: true, queued: ["§T2§"], settled: [], unknown: [], unsupported: [] };
const normalize = (value) => JSON.parse(JSON.stringify(value));

test("five tool seats and the release node mount without private Client imports", () => {
    const c = client();
    assert.equal(c.views.size, 6);
    assert.equal(c.definitions.length, 1);
    for (const name of [
        "context_release",
        "context_expand",
        "context_search",
        "context_compact",
        "context_status",
    ])
        assert.ok(c.views.has(name));
});

test("real wire argument and result shapes retain queued versus applied semantics", () => {
    const { plugin } = client();
    const request = outcome("context_release", { ids: ["§T2§"], reason: "Evidence used" }, queued);
    assert.equal(plugin.toolModel(request).label, "queued");
    assert.equal(plugin.toolModel(request).summary, "T2");
    assert.deepEqual(normalize(plugin.toolModel(request).args.ids), ["§T2§"]);
    const orphan = plugin.toolModel({ ...request, block: { ...request.block, call: null } });
    assert.equal(orphan.state, "result");
    assert.equal(orphan.summary, "");
    assert.equal(
        plugin.toolModel({ ...request, phase: "preparing", block: { argsRaw: '{"ids":[' } }).label,
        "preparing",
    );
    assert.equal(
        plugin.toolModel({
            ...request,
            phase: "start",
            block: { argsRaw: JSON.stringify({ ids: ["§T2§"] }) },
        }).label,
        "running",
    );
    assert.equal(
        plugin.toolModel(outcome("context_compact", {}, { status: "queued" })).label,
        "compactQueued",
    );
});

test("valid presentation metadata wins; unrecognized metadata falls back to recorded text", () => {
    const { plugin } = client();
    const props = outcome("context_release", {}, queued, { meta: { unrelated: true } });
    assert.equal(plugin.toolModel(props).state, "result");
    props.block.meta = { ...queued, queued: [], settled: ["§T2§"] };
    assert.equal(plugin.toolModel(props).label, "settled");
    props.block.isError = true;
    props.block.error = { reason: "Recorded failure" };
    assert.equal(plugin.toolModel(props).state, "error");
    assert.equal(plugin.toolModel(props).error, "Recorded failure");
});

test("release cards explain individual outcomes, reason and preview in both locales", () => {
    const c = client();
    const props = outcome(
        "context_release",
        { ids: ["§T2§"], reason: "Evidence used" },
        { ...queued, unknown: ["§T999§"] },
    );
    const view = c.views.get("context_release");
    const zh = c.visibleText(c.render({ type: view, props }));
    assert.match(zh, /标记弃用上下文/);
    assert.match(zh, /等待处理/);
    assert.match(zh, /编号不存在/);
    assert.match(zh, /Evidence used/);
    assert.doesNotMatch(zh, /"accepted"/);
    assert.match(zh, /T2/);
    assert.match(zh, /T999/);
    assert.doesNotMatch(zh, /§[UATIF]\d+R?§/);
    c.setLanguage("en");
    assert.match(c.visibleText(c.render({ type: view, props })), /Mark context for release/);
});

test("text, image and file recovery keep released status and original paging", () => {
    const c = client();
    const textProps = outcome(
        "context_expand",
        { id: "§T2R§" },
        {
            id: "§T2§",
            displayId: "§T2R§",
            status: "found",
            text: "original 🧠 §T99§",
            offset: 0,
            totalCharacters: 20,
            nextOffset: 10,
            releaseStatus: "released",
        },
    );
    const rendered = c.visibleText(
        c.render({ type: c.views.get("context_expand"), props: textProps }),
    );
    assert.match(rendered, /original 🧠 §T99§/);
    assert.equal(c.plugin.toolModel(textProps).summary, "T2R");
    assert.equal(c.plugin.toolModel(textProps).args.id, "§T2R§");
    assert.match(rendered, /已释放/);
    assert.match(rendered, /下一页偏移 10/);
    assert.match(rendered, /不会撤销释放状态/);
    const attachment = { attachmentId: "one", mediaType: "image/png", bytes: 1 };
    const imageProps = outcome(
        "context_expand",
        { id: "§I3§" },
        { id: "§I3§", status: "found", representation: "native-image" },
    );
    imageProps.block.content.push({ type: "image", attachment });
    assert.deepEqual(normalize(c.plugin.toolModel(imageProps).images), [
        { type: "image", attachment },
    ]);
    let opened;
    const fileProps = {
        ...outcome(
            "context_expand",
            { id: "§F4§" },
            {
                id: "§F4§",
                status: "found",
                representation: "file-handle",
                path: "/evidence.txt",
                attachment: { name: "evidence.txt" },
                verifiedBytes: 42,
            },
        ),
        openFile: (path) => {
            opened = path;
        },
    };
    const fileTree = c.render({ type: c.views.get("context_expand"), props: fileProps });
    function clickOpen(node) {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(clickOpen);
        if (node.type === "button" && c.visibleText(node) === "打开文件") node.props.onClick();
        node.props.children.forEach(clickOpen);
    }
    clickOpen(fileTree);
    assert.equal(opened, "/evidence.txt");
});

test("search/status use structured lists and unknown old results remain inspectable", () => {
    const c = client();
    for (const [name, value, expected] of [
        [
            "context_search",
            {
                query: "needle",
                hits: [{ id: "§T2§", tool: "read", snippet: "needle evidence", attachments: [] }],
                hasMore: true,
            },
            /needle evidence/,
        ],
        [
            "context_status",
            {
                entries: [
                    {
                        id: "§T2§",
                        status: "queued",
                        pendingReason: "awaiting_step_boundary",
                        preview: "evidence",
                    },
                ],
                scheduling: { decision: "wait", reason: "min_interval" },
            },
            /等待下一处理边界/,
        ],
    ])
        assert.match(
            c.visibleText(c.render({ type: c.views.get(name), props: outcome(name, {}, value) })),
            expected,
        );
    const old = outcome("context_release", {}, { oldFormat: true });
    assert.equal(c.plugin.toolModel(old).state, "fallback");
    assert.match(
        c.visibleText(c.render({ type: c.views.get("context_release"), props: old })),
        /oldFormat/,
    );
});

test("status cards explain payback, cache assumptions and protected constraints in both locales", () => {
    const c = client();
    const value = {
        entries: [],
        scheduling: {
            decision: "wait",
            reason: "not_paid_back",
            limits: { minimumPromptTokens: 1900 },
            diagnostic: {
                nextAction: "Continue working.",
                economics: {
                    breakEvenRequests: 17,
                    expectedFutureRequests: 8,
                    upfrontCost: 10980,
                    cacheBasis: "assumed_cached",
                },
                constraints: [{ code: "fixed_overhead" }],
            },
        },
    };
    for (const language of ["zh", "en"]) {
        c.setLanguage(language);
        const text = c.visibleText(
            c.render({
                type: c.views.get("context_status"),
                props: outcome("context_status", {}, value),
            }),
        );
        assert.match(text, /17 \/ 8/);
        assert.match(text, /10,980/);
        assert.match(text, /1,900/);
        assert.match(text, language === "zh" ? /保守假定已缓存/ : /conservatively assumed cached/);
        assert.match(
            text,
            language === "zh"
                ? /仅压缩历史无法达标/
                : /history summaries alone cannot reach the target/,
        );
        assert.match(text, language === "zh" ? /继续当前任务/ : /Continue the task/);
    }
});

test("release savings stay visible when collapsed, localize, and preserve increases", () => {
    const c = client();
    const render = (tokenEstimate) =>
        c.visibleText(
            c.render({
                type: c.views.get("fold-context-release"),
                props: {
                    node: {
                        data: {
                            released: [{ id: "§T2§", displayId: "§T2R§" }],
                            pending: [],
                            tokenEstimate,
                        },
                    },
                    useDisclosure: () => ({ expanded: false, toggle() {} }),
                },
            }),
        );
    const saving = { beforeTokens: 2000, afterTokens: 766 };
    assert.match(render(saving), /预计减少 1,234 tokens/);
    assert.doesNotMatch(render(saving), /估算/);
    assert.match(render(saving), /1 项/);
    assert.match(render({ beforeTokens: 10, afterTokens: 10 }), /预计减少 0 tokens/);
    assert.match(render({ beforeTokens: 10, afterTokens: 15 }), /预计增加 5 tokens/);
    c.setLanguage("en");
    assert.match(render(saving), /Estimated reduction: 1,234 tokens/);
    assert.match(render({ beforeTokens: 10, afterTokens: 15 }), /Estimated increase: 5 tokens/);
    for (const value of [
        undefined,
        null,
        {},
        { beforeTokens: "2000", afterTokens: 766 },
        { beforeTokens: NaN, afterTokens: 0 },
        { beforeTokens: Infinity, afterTokens: 0 },
        { beforeTokens: -1, afterTokens: 0 },
        { beforeTokens: 10.5, afterTokens: 0 },
    ]) {
        const text = render(value);
        assert.match(text, /Context released/);
        assert.doesNotMatch(text, /tokens|NaN|Infinity/);
    }
});

test("only paired, completed replacements produce replayable standalone release nodes", () => {
    const c = client();
    const receipt = {
        version: 1,
        batchId: "session:42",
        completionSeq: 43,
        targetSeq: 2,
        released: [
            {
                id: "§T2§",
                displayId: "§T2R§",
                tool: "read",
                preview: "prior evidence",
                reason: "Used",
            },
        ],
        pending: [
            { id: "§I3§", displayId: "§I3§", kind: "image", pendingReason: "protocol_protection" },
        ],
    };
    const prune = { seq: 42, type: "compaction/prune", data: { foldContextRelease: receipt } };
    const event = {
        seq: 43,
        type: "tool/result",
        surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
        sourceEventSeqs: [2],
        data: {},
    };
    const def = c.definitions[0];
    assert.equal(def.match({ type: "compaction/prune", data: {} }), null);
    assert.equal(def.match({ ...event, surfaceOp: "append" }), null);
    assert.equal(
        def.match({ ...prune, data: { foldContextRelease: { ...receipt, version: 99 } } }),
        null,
    );
    assert.equal(def.match(prune).id, "43");
    assert.equal(def.match(event).id, "43");
    const location = { kind: "surface", seq: 43 };
    const context = {
        key: "release:43",
        id: "43",
        state: def.start({}, { event: prune, location }),
    };
    assert.equal(
        def.buildViewNode(context),
        null,
        "prune intent alone never reports a completed release",
    );
    assert.equal(
        def.update(context, { event: { ...event, sourceEventSeqs: [99] }, location }),
        context.state,
    );
    context.state = def.update(context, { event, location });
    const node = normalize(def.buildViewNode(context));
    assert.equal(node.anchorSeq, 43);
    assert.equal(node.visibility, "visible");
    assert.deepEqual(node.location, location);
    const rendered = c.visibleText(
        c.render({
            type: c.views.get(node.kind),
            props: { node, useDisclosure: () => ({ expanded: true, toggle() {} }) },
        }),
    );
    assert.match(rendered, /已释放上下文/);
    assert.match(rendered, /prior evidence/);
    assert.match(rendered, /受协议保护/);
    assert.match(rendered, /T2R/);
    assert.doesNotMatch(rendered, /§[UATIF]\d+R?§/);
    assert.equal(receipt.released[0].displayId, "§T2R§");
    assert.equal(def.match({ ...event, type: "user/message" }).id, "43");
});
