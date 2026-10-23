import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
const normalize = (value) => JSON.parse(JSON.stringify(value));
const receipt = (extra) => ({
    accepted: true,
    queued: [],
    settled: [],
    unknown: [],
    unsupported: [],
    ...extra,
});
const record = (id, reason = "Used conclusions", extra = {}) => ({
    id: String(id),
    reason,
    tool: "read",
    preview: `Evidence ${id}`,
    kind: "tool",
    ...extra,
});
const wire = (toolName, value, args = {}) => ({
    toolName,
    callId: "client-release-test-call",
    openFile() {},
    loadImage: async () => "blob:client-release-test-image",
    phase: "result",
    useDisclosure: () => ({ expanded: true, toggle() {} }),
    block: {
        call: { name: toolName, argsRaw: JSON.stringify(args) },
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError: false,
    },
});

// A deterministic React commit harness: stable component hooks, DOM refs, layout/passive
// effects and ResizeObserver callbacks. It verifies behavior without claiming browser layout.
function harness({ width = 240, language = "zh" } = {}) {
    let plugin,
        current,
        rootElement,
        tree,
        dirty,
        charWidth = 7;
    const stores = new Map(),
        nodes = new Map(),
        observers = new Set(),
        seats = new Map(),
        dictionaries = new Map();
    let queue = [],
        seen = new Set(),
        seenNodes = new Set(),
        idCounter = 0;
    const hook = (make) => {
        const index = current.index++;
        if (!(index in current.store.hooks)) current.store.hooks[index] = make();
        return [current.store.hooks[index], current.store, index];
    };
    const effect = (callback) => (fn, deps) => {
        const [slot] = hook(() => ({ deps: undefined, cleanup: undefined }));
        if (
            !slot.deps ||
            !deps ||
            deps.some((value, index) => !Object.is(value, slot.deps[index]))
        ) {
            slot.deps = deps;
            queue.push(() => {
                slot.cleanup?.();
                slot.cleanup = fn();
            });
        }
    };
    const React = {
        Fragment: Symbol("Fragment"),
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useState(initial) {
            const [value, store, index] = hook(() =>
                typeof initial === "function" ? initial() : initial,
            );
            return [
                value,
                (next) => {
                    const value = typeof next === "function" ? next(store.hooks[index]) : next;
                    if (!Object.is(value, store.hooks[index])) {
                        store.hooks[index] = value;
                        dirty = true;
                    }
                },
            ];
        },
        useRef: (initial) => hook(() => ({ current: initial }))[0],
        useId: () => hook(() => `release-${++idCounter}`)[0],
        useEffect: effect(),
        useLayoutEffect: effect(),
        useSyncExternalStore: (_subscribe, get) => get(),
    };
    const text = (node) => {
        if (node == null || typeof node === "boolean") return "";
        if (typeof node !== "object") return String(node);
        if (Array.isArray(node)) return node.map(text).join(" ");
        if (node.type === "style" || node.props.hidden) return "";
        return text(node.props.children);
    };
    const all = (node = tree, predicate = () => true) => {
        if (node == null || typeof node !== "object") return [];
        if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
        return [...(predicate(node) ? [node] : []), ...all(node.props.children, predicate)];
    };
    class ResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = new Set();
            observers.add(this);
        }
        observe(target) {
            this.targets.add(target);
        }
        disconnect() {
            observers.delete(this);
        }
    }
    const resizeListeners = new Set(),
        fontListeners = new Set();
    const view = {
        ResizeObserver,
        getComputedStyle: () => ({ lineHeight: "20px" }),
        addEventListener: (event, callback) => {
            if (event === "resize") resizeListeners.add(callback);
        },
        removeEventListener: (event, callback) => {
            if (event === "resize") resizeListeners.delete(callback);
        },
        __ModuleLoader__: {
            load(module) {
                plugin = module.factory((name) => {
                    assert.equal(name, "react");
                    return React;
                });
            },
        },
    };
    const document = {
        defaultView: view,
        activeElement: null,
        fonts: {
            ready: Promise.resolve(),
            addEventListener: (event, callback) => {
                if (event === "loadingdone") fontListeners.add(callback);
            },
            removeEventListener: (event, callback) => {
                if (event === "loadingdone") fontListeners.delete(callback);
            },
        },
    };
    view.document = document;
    runInNewContext(source, { ResizeObserver, window: view, document });
    plugin.apply({
        effect: (fn) => fn(),
        inject() {},
        locale: {
            register: (_namespace, values) => {
                for (const [key, value] of Object.entries(values)) dictionaries.set(key, value);
            },
            bind: () => (key) => dictionaries.get(language)[key] ?? key,
            subscribe: () => () => {},
            getSnapshot: () => language,
        },
        uiConversation: { events: { register() {} } },
        slots: {
            inject: (_name, fn) => fn(),
            register: (options, component) => {
                seats.set(options.key, component);
                return () => {};
            },
        },
    });
    function walk(element, path = "root", idWidth = 0) {
        if (element == null || typeof element !== "object") return element;
        if (Array.isArray(element))
            return element.map((child, index) =>
                walk(child, `${path}/${child?.props?.key ?? index}`, idWidth),
            );
        if (typeof element.type === "function") {
            const identity = `${path}:${element.type.name}`;
            let store = stores.get(identity);
            if (!store) stores.set(identity, (store = { hooks: [] }));
            seen.add(identity);
            const previous = current;
            current = { store, index: 0 };
            const rendered = element.type(element.props);
            current = previous;
            return walk(rendered, `${identity}/render`, idWidth);
        }
        const variable = element.props.style?.["--fc-release-id-width"];
        if (variable) idWidth = parseInt(variable.match(/\d+/)[0], 10);
        let node = nodes.get(path);
        if (!node) {
            node = {
                type: element.type,
                props: {},
                ownerDocument: document,
                getBoundingClientRect() {
                    const identifier = this.props["data-release-id"] !== undefined;
                    return { width: identifier ? this.idWidth * charWidth + 12 : width };
                },
                getAttribute(name) {
                    return this.props[name] === undefined ? null : String(this.props[name]);
                },
                contains(target) {
                    return all(this).includes(target);
                },
                focus() {
                    document.activeElement = this;
                },
            };
            Object.defineProperties(node, {
                clientWidth: { get: () => Math.round(width) },
                scrollHeight: {
                    get: () => Math.ceil(text(node).length / Math.max(1, width / charWidth)) * 20,
                },
                firstElementChild: {
                    get: () =>
                        all(node.props.children).find((child) => typeof child.type === "string"),
                },
            });
            nodes.set(path, node);
        }
        node.idWidth = idWidth;
        node.props = {
            ...element.props,
            children: walk(element.props.children, `${path}/children`, idWidth),
        };
        seenNodes.add(path);
        const attach = (child) => {
            if (Array.isArray(child)) child.forEach(attach);
            else if (child && typeof child === "object") {
                if (typeof child.type === "string") child.parentElement = node;
                else attach(child.props.children);
            }
        };
        attach(node.props.children);
        if (element.props.ref) {
            if (typeof element.props.ref === "function") element.props.ref(node);
            else element.props.ref.current = node;
        }
        return node;
    }
    function flush() {
        for (let count = 0; count < 30; count++) {
            dirty = false;
            seen = new Set();
            seenNodes = new Set();
            queue = [];
            tree = walk(rootElement);
            for (const [identity, store] of stores)
                if (!seen.has(identity)) {
                    for (const slot of store.hooks) slot?.cleanup?.();
                    stores.delete(identity);
                }
            for (const [path, node] of nodes)
                if (!seenNodes.has(path)) {
                    const ref = node.props.ref;
                    if (typeof ref === "function") ref(null);
                    else if (ref?.current === node) ref.current = null;
                    nodes.delete(path);
                }
            const pending = queue;
            queue = [];
            for (const run of pending) run();
            if (!dirty) return tree;
        }
        throw new Error("Render effects did not settle");
    }
    return {
        plugin,
        text: () => text(tree),
        nodes: (predicate) => all(tree, predicate),
        render(key, props) {
            rootElement = { type: seats.get(key), props };
            return flush();
        },
        report(report) {
            return this.render("fold-context-release", {
                node: { data: report },
                useDisclosure: () => ({ expanded: true, toggle() {} }),
            });
        },
        click(node) {
            assert.ok(node, "Expected a visible control");
            node.props.onClick({});
            return flush();
        },
        findButton(pattern) {
            return all(tree, (node) => node.type === "button" && pattern.test(text(node)))[0];
        },
        ids() {
            return all(tree, (node) => node.props["data-release-id"] !== undefined).map(
                (node) => node.props["data-release-id"],
            );
        },
        activeElement: () => document.activeElement,
        keyDown(node, key) {
            node.props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} });
            return flush();
        },
        loadFonts(nextCharWidth) {
            charWidth = nextCharWidth;
            for (const callback of fontListeners) callback();
            return flush();
        },
        resize(nextWidth, nextCharWidth = charWidth) {
            width = nextWidth;
            charWidth = nextCharWidth;
            for (const callback of resizeListeners) callback();
            for (const observer of [...observers])
                observer.callback([...observer.targets].map((target) => ({ target })));
            return flush();
        },
    };
}

test("release grouping preserves exact reasons, first appearance and pending distinctions without mutation", () => {
    const h = harness();
    const value = {
        released: [
            record(1, "A"),
            record(2, "B"),
            record(3, "A"),
            record(4, null),
            record(5, "missing"),
        ],
        pending: [
            record(6, "A", { pendingReason: "protocol_protection" }),
            record(7, "A", { pendingReason: "waiting_boundary" }),
            record(8, null),
        ],
    };
    const before = normalize(value);
    const groups = normalize(h.plugin.groupReleaseItems(value));
    assert.deepEqual(
        groups.map((group) => group.reason),
        ["A", "B", "", "missing"],
    );
    assert.deepEqual(
        groups[0].rows.map((row) => [
            row.status,
            row.pendingReason,
            row.items.map((item) => item.id),
        ]),
        [
            ["released", "", ["1", "3"]],
            ["pending", "protocol_protection", ["6"]],
            ["pending", "waiting_boundary", ["7"]],
        ],
    );
    assert.deepEqual(value, before);
});

for (const language of ["zh", "en"]) {
    test(`mounted release view deduplicates reasons and opens only the selected item's metadata (${language})`, () => {
        const h = harness({ language });
        h.report({
            released: [
                record(101, "SHARED_REASON", { preview: "FIRST_PREVIEW" }),
                record(102, "SHARED_REASON", { preview: "SECOND_PREVIEW" }),
            ],
            pending: [
                record(103, "SHARED_REASON", {
                    pendingReason: "protocol_protection",
                    ownerId: "99",
                }),
            ],
        });
        assert.equal(h.text().split("SHARED_REASON").length - 1, 1);
        assert.doesNotMatch(h.text(), /FIRST_PREVIEW|SECOND_PREVIEW/);
        assert.equal(h.nodes((node) => node.props["data-release-group"] !== undefined).length, 1);
        h.click(
            h.nodes((node) => node.type === "button" && node.props["data-release-id"] === "101")[0],
        );
        assert.match(h.text(), /FIRST_PREVIEW/);
        const first = h.nodes((node) => node.props["data-release-id"] === "101")[0];
        assert.equal(first.props["aria-expanded"], true);
        assert.ok(h.nodes((node) => node.props.id === first.props["aria-controls"]).length);
        h.click(
            h.nodes((node) => node.type === "button" && node.props["data-release-id"] === "102")[0],
        );
        assert.match(h.text(), /SECOND_PREVIEW/);
        assert.doesNotMatch(h.text(), /FIRST_PREVIEW/);
        assert.equal(h.nodes((node) => node.props.role === "region").length, 1);
        assert.equal(h.text().split("SHARED_REASON").length - 1, 1);
    });

    test(`marking receipt stays compact and keeps outcome categories and refusal semantics (${language})`, () => {
        const h = harness({ language });
        const value = receipt({
            accepted: false,
            queued: ["101", "102"],
            settled: ["103"],
            unknown: ["999"],
            unsupported: ["104"],
        });
        h.render(
            "context_release",
            wire("context_release", value, {
                ids: [101, 102, 103, 999, 104],
                reason: "MARK_REASON",
            }),
        );
        assert.equal(h.text().split("MARK_REASON").length - 1, 1);
        assert.match(h.text(), language === "zh" ? /请求未接受/ : /Request rejected/);
        assert.match(h.text(), language === "zh" ? /编号不存在/ : /Unknown ID/);
        assert.match(h.text(), language === "zh" ? /不支持此操作/ : /Operation unsupported/);
        assert.deepEqual(h.ids().sort(), ["101", "102", "103", "104", "999"]);
        assert.equal(
            h.nodes((node) => node.props["data-release-id"] !== undefined && node.type === "button")
                .length,
            0,
        );
        assert.equal(h.nodes((node) => node.props.className === "fc-item").length, 0);
    });

    test(`recovered text and attachments show the recorded release reason independently of failure reason (${language})`, () => {
        const h = harness({ language });
        for (const extra of [
            { text: "EXACT_ORIGINAL" },
            { representation: "native-image" },
            { status: "capability_unsupported", reason: "RECOVERY_FAILURE" },
        ]) {
            h.render(
                "context_expand",
                wire(
                    "context_expand",
                    {
                        id: "11",
                        status: "found",
                        releaseStatus: "released",
                        releaseReason: "RECORDED_RELEASE_REASON",
                        ...extra,
                    },
                    { id: 11 },
                ),
            );
            assert.equal(h.text().split("RECORDED_RELEASE_REASON").length - 1, 1);
            assert.match(h.text(), language === "zh" ? /释放原因/ : /Release reason/);
            if (extra.reason) assert.match(h.text(), /RECOVERY_FAILURE/);
        }
        h.render(
            "context_expand",
            wire(
                "context_expand",
                { id: "11", status: "found", text: "LEGACY_ORIGINAL" },
                { id: 11 },
            ),
        );
        assert.doesNotMatch(h.text(), language === "zh" ? /释放原因/ : /Release reason/);
        assert.match(h.text(), /LEGACY_ORIGINAL/);
    });
}

test("two measured rows respond to available width and font size; all 150 IDs remain revealable", () => {
    const h = harness({ width: 240 });
    const ids = Array.from({ length: 150 }, (_, index) => String(index + 1001));
    h.render(
        "context_release",
        wire("context_release", receipt({ queued: ids }), { ids: ids.map(Number), reason: "Bulk" }),
    );
    assert.equal(h.ids().length, h.plugin.releaseRowLimit(240, 40, 150));
    assert.ok(h.ids().length < 150);
    h.resize(80);
    assert.equal(h.ids().length, 2);
    h.click(h.findButton(/展开其余|Show .* more/));
    assert.deepEqual(h.ids(), ids);
    h.resize(500);
    assert.deepEqual(h.ids(), ids);
    h.click(h.findButton(/收起编号|Collapse IDs/));
    assert.equal(h.ids().length, h.plugin.releaseRowLimit(500, 40, 150));
    h.resize(500, 14);
    assert.equal(h.ids().length, h.plugin.releaseRowLimit(500, 68, 150));
});

test("long reasons retain exact text and disclose locally without duplicating it", () => {
    const h = harness({ width: 120 });
    const reason = "A long preserved reason 🧠\n".repeat(20);
    h.report({ released: [record(101, reason), record(102, reason)], pending: [] });
    const more = h.findButton(/展开完整原因|Show full reason/);
    assert.ok(more);
    assert.equal(more.props["aria-expanded"], false);
    assert.ok(h.nodes((node) => node.props.id === more.props["aria-controls"]).length);
    h.click(more);
    assert.equal(h.findButton(/收起原因|Collapse reason/).props["aria-expanded"], true);
    assert.equal(h.text().split(reason).length - 1, 1);
});

test("unrecognized release receipts retain recorded fallback instead of mounting compact controls", () => {
    const h = harness();
    h.render(
        "context_release",
        wire("context_release", { unexpected: "LEGACY_RAW" }, { reason: "Legacy" }),
    );
    assert.match(h.text(), /LEGACY_RAW/);
    assert.equal(h.ids().length, 0);
});

test("exact whitespace reasons and missing labels remain distinct; duplicate IDs open one detail", () => {
    const h = harness();
    const released = [
        record(101, "Same", { preview: "FIRST_DISTINCT_PREVIEW" }),
        record(101, " Same ", { preview: "SECOND_DISTINCT_PREVIEW" }),
        record(104, null),
        record(105, "missing"),
    ];
    h.report({ released, pending: [] });
    assert.deepEqual(
        normalize(h.plugin.groupReleaseItems({ released })).map((group) => group.reason),
        ["Same", " Same ", "", "missing"],
    );
    assert.equal(h.nodes((node) => node.props["data-release-group"] !== undefined).length, 4);
    h.click(
        h.nodes((node) => node.type === "button" && node.props["data-release-id"] === "101")[0],
    );
    assert.match(h.text(), /FIRST_DISTINCT_PREVIEW/);
    h.click(
        h.nodes((node) => node.type === "button" && node.props["data-release-id"] === "101")[1],
    );
    assert.match(h.text(), /SECOND_DISTINCT_PREVIEW/);
    assert.doesNotMatch(h.text(), /FIRST_DISTINCT_PREVIEW/);
    assert.equal(h.nodes((node) => node.props.role === "region").length, 1);
});

test("Escape restores the selected ID focus and narrowing moves hidden detail focus to disclosure", () => {
    const h = harness({ width: 500 });
    h.report({
        released: Array.from({ length: 20 }, (_, index) => record(1001 + index)),
        pending: [],
    });
    const selected = () => h.nodes((node) => node.props["data-release-id"] === "1008")[0];
    h.click(selected());
    h.keyDown(h.nodes((node) => node.props.role === "region")[0], "Escape");
    assert.equal(h.nodes((node) => node.props.role === "region").length, 0);
    assert.equal(h.activeElement(), selected());
    h.click(selected());
    h.findButton(/关闭详情|Close details/).focus();
    h.resize(80);
    assert.equal(h.nodes((node) => node.props.role === "region").length, 0);
    assert.equal(h.activeElement(), h.findButton(/展开其余|Show .* more/));
    assert.equal(
        h.nodes((node) => node.type === "button" && node.props["data-release-id"] === "1008")
            .length,
        0,
    );
});

test("font loading remeasures visible IDs without a resize callback", () => {
    const h = harness({ width: 240 });
    const ids = Array.from({ length: 30 }, (_, index) => String(1001 + index));
    h.render(
        "context_release",
        wire("context_release", receipt({ queued: ids }), { ids: ids.map(Number), reason: "Bulk" }),
    );
    assert.equal(h.ids().length, 10);
    h.loadFonts(14);
    assert.equal(h.ids().length, 6);
});

test("fractional available width never rounds up to a third identifier row", () => {
    const h = harness({ width: 87.6 });
    const ids = Array.from({ length: 30 }, (_, index) => String(1001 + index));
    h.render(
        "context_release",
        wire("context_release", receipt({ queued: ids }), { ids: ids.map(Number), reason: "Bulk" }),
    );
    assert.equal(h.ids().length, 2);
    h.resize(88);
    assert.equal(h.ids().length, 4);
});
