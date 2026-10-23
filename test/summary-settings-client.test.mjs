import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
const copy = (value) => JSON.parse(JSON.stringify(value));
const ok = (value) => ({ ok: true, value });
const failure = (code, message) => ({ ok: false, error: { code, message } });
const route = (provider, model, extra = {}) => ({
    provider,
    model,
    preferWhenSessionMatches: true,
    useSessionAgent: false,
    ...extra,
});
// Exact ModelCatalog wire shape from dsh-api-session-controller/types.d.ts.
const catalog = {
    default: { provider: "deepseek", model: "flash" },
    routableProviders: ["deepseek", "openai"],
    groups: [
        { id: "deepseek", name: "DeepSeek", models: [{ id: "flash", name: "Flash" }] },
        {
            id: "openai",
            name: "OpenAI",
            models: [
                {
                    id: "gpt",
                    name: "GPT",
                    reasoning: {
                        defaultEffort: "high",
                        efforts: [
                            { id: "low", name: "Low", description: "Less reasoning" },
                            { id: "high", name: "High" },
                        ],
                    },
                },
                { id: "plain", name: "Plain model" },
            ],
        },
    ],
    failures: [],
};
const descriptor = (rows = [], revision = 7, ns = "fold-context-ui") => ({
    ns,
    revision,
    value: { summaryModels: rows, policyOverrides: policyDefaults() },
    schema: {},
    applies: "live",
    secrets: [],
    autoGenerate: false,
});

function load(remote = {}, { served = true } = {}) {
    let plugin,
        hookState,
        effect,
        cleanup,
        language = "en";
    const dictionaries = new Map(),
        seats = new Map(),
        remoteListeners = new Map(),
        localListeners = new Map();
    const imports = [],
        dependencies = [],
        disposers = [];
    const React = {
        Fragment: Symbol("Fragment"),
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useId: () => "summary-settings-test",
        useSyncExternalStore: (_subscribe, get) => get(),
        useState: (initial) => {
            hookState ??= typeof initial === "function" ? initial() : initial;
            return [hookState, () => {}];
        },
        useEffect: (callback) => {
            effect ??= callback;
        },
    };
    runInNewContext(source, {
        window: {
            __ModuleLoader__: {
                load: (module) => {
                    plugin = module.factory((name) => {
                        imports.push(name);
                        assert.equal(name, "react");
                        return React;
                    });
                },
            },
        },
    });
    const listen = (registry, name, callback) => {
        registry.set(name, callback);
        return () => registry.delete(name);
    };
    remote.$on = (name, callback) => listen(remoteListeners, name, callback);
    const ctx = {
        remote,
        effect: (callback) => {
            const dispose = callback();
            if (typeof dispose === "function") disposers.push(dispose);
        },
        inject(names, callback) {
            dependencies.push([...names]);
            if (served) callback(this);
        },
        on: (name, callback) => listen(localListeners, name, callback),
        locale: {
            register: (_namespace, values) => {
                for (const [key, value] of Object.entries(values)) dictionaries.set(key, value);
            },
            bind: () => (key) => dictionaries.get(language)[key] ?? key,
            subscribe: () => () => {},
            getSnapshot: () => language,
        },
        slots: {
            inject(_name, callback) {
                callback();
            },
            register(options, component) {
                seats.set(`${options.name}:${options.key}`, component);
                return () => {};
            },
        },
        uiConversation: { events: { register() {} } },
    };
    plugin.apply(ctx);
    return {
        plugin,
        seats,
        imports,
        dependencies,
        remoteListeners,
        localListeners,
        t: (key) => dictionaries.get(language)[key] ?? key,
        setLanguage(value) {
            language = value;
        },
        render(controller) {
            return plugin.renderSummarySettings(
                controller,
                controller.getSnapshot(),
                this.t,
                "settings",
            );
        },
        page() {
            return seats.get("plugins.bundle.config:dsh-fold-context")({ view: "page" });
        },
        mount() {
            cleanup = effect();
        },
        unmount() {
            cleanup?.();
        },
        dispose() {
            for (const dispose of disposers.reverse()) dispose();
        },
    };
}
function fixture(rows = [], options = {}) {
    let entry = descriptor(copy(rows), options.revision ?? 7, options.ns ?? "fold-context-ui");
    if (options.policies !== undefined) entry.value.policyOverrides = copy(options.policies);
    let directory = copy(options.catalog ?? catalog);
    const calls = [];
    const remote = {
        settings: {
            describe: async () => ok({ writable: options.writable !== false, namespaces: [entry] }),
            mutate: async (ns, ops, revision) => {
                calls.push(copy({ ns, ops, revision }));
                assert.equal(revision, entry.revision);
                entry = {
                    ...entry,
                    revision: entry.revision + 1,
                    value: {
                        ...entry.value,
                        ...Object.fromEntries(ops.map((op) => [op.path[0], copy(op.value)])),
                    },
                };
                return ok(entry);
            },
        },
        session: { modelCatalog: async () => ok(directory) },
    };
    const client = load(remote);
    const controller = new client.plugin.SummarySettingsController(remote);
    return {
        client,
        controller,
        remote,
        calls,
        setEntry(value) {
            entry = value;
        },
        setCatalog(value) {
            directory = value;
        },
        getEntry: () => entry,
    };
}
function nodes(tree) {
    if (tree == null || typeof tree !== "object") return [];
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    return [tree, ...nodes(tree.props?.children)];
}
function visibleText(tree) {
    if (tree == null || typeof tree === "boolean") return "";
    if (typeof tree !== "object") return String(tree);
    if (Array.isArray(tree)) return tree.map(visibleText).join(" ");
    return tree.type === "style" ? "" : visibleText(tree.props?.children);
}
const select = (tree, label) =>
    nodes(tree).find((node) => node.type === "select" && node.props["aria-label"] === label);
const button = (tree, name) =>
    nodes(tree).find(
        (node) =>
            node.type === "button" &&
            (node.props["aria-label"] === name || visibleText(node) === name),
    );
const switchControl = (tree, label) =>
    nodes(tree).find(
        (node) =>
            node.type === "input" &&
            node.props.role === "switch" &&
            node.props["aria-label"] === label,
    );
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
const settle = () => new Promise((done) => setImmediate(done));

test("bundle page waits only for Remote services while all existing tool seats remain independent", () => {
    const c = load();
    assert.deepEqual(c.imports, ["react"]);
    assert.deepEqual(c.dependencies, [["remote", "remote.settings", "remote.session"]]);
    assert.equal(c.seats.size, 7);
    assert.ok(c.seats.has("plugins.bundle.config:dsh-fold-context"));
    const withoutSettings = load({}, { served: false });
    assert.equal(withoutSettings.seats.size, 6);
    for (const tool of [
        "context_release",
        "context_expand",
        "context_search",
        "context_compact",
        "context_status",
    ])
        assert.ok(withoutSettings.seats.has(`tool.call.toolview:${tool}`));
});

test("settings namespace chooses the exact root patch id or a unique include suffix and refuses ambiguity", () => {
    const { plugin } = load();
    const exact = descriptor(),
        included = descriptor([], 3, "include:fold-context-ui");
    assert.equal(plugin.summarySettingsNamespace({ namespaces: [included, exact] }), exact);
    assert.equal(plugin.summarySettingsNamespace({ namespaces: [included] }), included);
    assert.throws(
        () =>
            plugin.summarySettingsNamespace({
                namespaces: [included, descriptor([], 0, "other:fold-context-ui")],
            }),
        (error) => error.key === "summarySettingsAmbiguous",
    );
    assert.throws(
        () => plugin.summarySettingsNamespace({ namespaces: [descriptor([], 0, "fold-context")] }),
        (error) => error.key === "summarySettingsMissing",
    );
    assert.throws(
        () => plugin.summarySettingsNamespace({ namespaces: [{ ...exact, revision: undefined }] }),
        (error) => error.key === "summarySettingsInvalid",
    );
});

test("catalog uses provider group ids and nested reasoning.efforts with no hardcoded effort vocabulary", () => {
    const { plugin } = load();
    const value = plugin.summarySettingsCatalog(catalog);
    assert.deepEqual(copy(value.groups[1].models[0].efforts), [
        { id: "low", name: "Low", description: "Less reasoning" },
        { id: "high", name: "High", description: "" },
    ]);
    assert.deepEqual(copy(value.groups[0].models[0].efforts), []);
    assert.throws(
        () => plugin.summarySettingsCatalog({ groups: [], failures: undefined }),
        (error) => error.key === "summarySettingsResponse",
    );
});

test("omitted session-Agent flags default to off without changing saved settings", async () => {
    const legacy = {
        provider: "openai",
        model: "gpt",
        reasoningEffort: "low",
        preferWhenSessionMatches: false,
    };
    const f = fixture([legacy], { revision: 11 });
    await f.controller.start();
    assert.deepEqual(copy(f.controller.getSnapshot().rows), [
        route("openai", "gpt", { reasoningEffort: "low", preferWhenSessionMatches: false }),
    ]);
    assert.equal(f.controller.getSnapshot().dirty, false);
    assert.equal(f.controller.canSave(), false);
    assert.deepEqual(f.getEntry().value.summaryModels, [legacy]);
    assert.equal(Object.hasOwn(f.getEntry().value.summaryModels[0], "useSessionAgent"), false);
    const control = switchControl(
        f.client.render(f.controller),
        "Summary model 1 · Use the session Agent for summaries",
    );
    assert.equal(control.props.checked, false);
    assert.equal(control.props["aria-checked"], false);
    assert.equal(f.calls.length, 0, "loading settings must not write the normalized default");
    f.controller.change(0, "preferWhenSessionMatches", true);
    assert.equal(await f.controller.save(), true);
    assert.equal(f.calls[0].revision, 11);
    assert.deepEqual(f.calls[0].ops[0].value, [route("openai", "gpt", { reasoningEffort: "low" })]);
    assert.equal(f.controller.getSnapshot().revision, 12);
});

test("session-Agent toggles save real booleans with revision fencing and preserve other route fields", async () => {
    const initial = [
        route("openai", "gpt", { reasoningEffort: "low", preferWhenSessionMatches: false }),
        route("deepseek", "flash"),
    ];
    const f = fixture(initial, { revision: 19, ns: "include:fold-context-ui" });
    await f.controller.start();
    const rowKeys = copy(f.controller.getSnapshot().rowKeys);
    const label = "Summary model 1 · Use the session Agent for summaries";
    switchControl(f.client.render(f.controller), label).props.onChange({
        target: { checked: true },
    });
    const enabled = [{ ...initial[0], useSessionAgent: true }, initial[1]];
    assert.deepEqual(copy(f.controller.getSnapshot().rows), enabled);
    assert.deepEqual(copy(f.controller.getSnapshot().rowKeys), rowKeys);
    assert.equal(f.controller.getSnapshot().revision, 19);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[0], {
        ns: "include:fold-context-ui",
        revision: 19,
        ops: [
            { op: "set", path: ["summaryModels"], value: enabled },
            { op: "set", path: ["policyOverrides"], value: policyDefaults() },
        ],
    });
    assert.deepEqual(f.getEntry().value.summaryModels, enabled);
    assert.equal(typeof f.getEntry().value.summaryModels[0].useSessionAgent, "boolean");
    assert.equal(f.controller.getSnapshot().revision, 20);
    assert.equal(f.controller.getSnapshot().dirty, false);
    const control = switchControl(f.client.render(f.controller), label);
    assert.equal(control.props.checked, true);
    assert.equal(control.props["aria-checked"], true);
    control.props.onChange({ target: { checked: false } });
    assert.deepEqual(copy(f.controller.getSnapshot().rows), initial);
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[1], {
        ns: "include:fold-context-ui",
        revision: 20,
        ops: [
            { op: "set", path: ["summaryModels"], value: initial },
            { op: "set", path: ["policyOverrides"], value: policyDefaults() },
        ],
    });
    assert.deepEqual(f.getEntry().value.summaryModels, initial);
    assert.equal(typeof f.getEntry().value.summaryModels[0].useSessionAgent, "boolean");
    assert.equal(f.calls[0].ops[0].value[0].useSessionAgent, true);
    assert.deepEqual(copy(f.controller.getSnapshot().rowKeys), rowKeys);
    assert.equal(f.controller.getSnapshot().revision, 21);
    assert.equal(f.controller.getSnapshot().dirty, false);
});

test("nonboolean session-Agent flags reject settings without coercing or overwriting them", async (t) => {
    for (const value of ["true", "false", 1, 0, null, {}, []]) {
        await t.test(JSON.stringify(value), async () => {
            const invalid = route("deepseek", "flash", { useSessionAgent: value });
            const f = fixture([invalid]);
            await f.controller.start();
            assert.equal(f.controller.getSnapshot().settingsStatus, "error");
            assert.match(visibleText(f.client.render(f.controller)), /Invalid summary settings/);
            assert.equal(f.controller.canSave(), false);
            assert.equal(await f.controller.save(), false);
            assert.deepEqual(f.getEntry().value.summaryModels, [invalid]);
            assert.equal(f.calls.length, 0);
        });
    }
});

test("add, dependent choices, toggle, reorder and delete stage one revision-fenced settings mutation", async () => {
    const f = fixture([route("deepseek", "flash")]);
    await f.controller.start();
    const originalKeys = [...f.controller.getSnapshot().rowKeys];
    f.controller.add();
    assert.equal(f.controller.getSnapshot().rows[1].preferWhenSessionMatches, true);
    assert.equal(f.controller.getSnapshot().rows[1].useSessionAgent, false);
    assert.equal(
        switchControl(
            f.client.render(f.controller),
            "Summary model 2 · Use the session Agent for summaries",
        ).props.checked,
        false,
    );
    assert.equal(f.controller.canSave(), false);
    f.controller.change(1, "provider", "openai");
    f.controller.change(1, "model", "gpt");
    f.controller.change(1, "reasoningEffort", "high");
    f.controller.change(1, "preferWhenSessionMatches", false);
    const secondKey = f.controller.getSnapshot().rowKeys[1];
    f.controller.move(1, -1);
    assert.deepEqual(copy(f.controller.getSnapshot().rowKeys), [secondKey, ...originalKeys]);
    assert.equal(f.calls.length, 0, "draft interactions must not write configuration");
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls, [
        {
            ns: "fold-context-ui",
            revision: 7,
            ops: [
                {
                    op: "set",
                    path: ["summaryModels"],
                    value: [
                        route("openai", "gpt", {
                            reasoningEffort: "high",
                            preferWhenSessionMatches: false,
                        }),
                        route("deepseek", "flash"),
                    ],
                },
                { op: "set", path: ["policyOverrides"], value: policyDefaults() },
            ],
        },
    ]);
    assert.equal(f.controller.getSnapshot().revision, 8);
    assert.equal(f.controller.getSnapshot().dirty, false);
    f.controller.remove(1);
    f.controller.remove(0);
    await f.controller.save();
    assert.deepEqual(f.calls[1].ops[0].value, [], "empty list persists the follow-session policy");
    assert.equal(f.calls[1].revision, 8);
});

test("unavailable persisted routes remain selectable and reorderable through partial catalog failure", async () => {
    const directory = {
        ...copy(catalog),
        failures: [{ id: "offline", name: "Offline provider", message: "Timed out" }],
    };
    const missing = route("offline", "retired", { reasoningEffort: "custom" });
    const f = fixture([missing, route("deepseek", "flash")], { catalog: directory });
    await f.controller.start();
    let view = f.client.render(f.controller);
    assert.match(visibleText(view), /Some provider catalogs failed/);
    assert.match(visibleText(view), /Offline provider: Timed out/);
    assert.match(visibleText(view), /saved configuration is retained/);
    assert.equal(select(view, "Summary model 1 · Provider").props.value, "offline");
    assert.equal(select(view, "Summary model 1 · Model").props.value, "retired");
    assert.equal(select(view, "Summary model 1 · Reasoning effort").props.value, "custom");
    f.controller.move(0, 1);
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[0].ops[0].value[1], missing);
});

test("invalid explicit effort is retained and reported until the user deliberately selects Automatic", async () => {
    const f = fixture([route("openai", "gpt", { reasoningEffort: "retired-effort" })]);
    await f.controller.start();
    f.controller.change(0, "preferWhenSessionMatches", false);
    let tree = f.client.render(f.controller);
    let effort = select(tree, "Summary model 1 · Reasoning effort");
    assert.equal(effort.props.value, "retired-effort");
    assert.equal(effort.props["aria-invalid"], true);
    assert.ok(effort.props["aria-describedby"]);
    assert.match(visibleText(tree), /does not support the selected effort/);
    assert.equal(f.controller.canSave(), false);
    f.controller.change(0, "model", "plain");
    assert.equal(f.controller.getSnapshot().rows[0].reasoningEffort, "retired-effort");
    f.controller.change(0, "provider", "deepseek");
    assert.equal(f.controller.getSnapshot().rows[0].model, "");
    assert.equal(f.controller.getSnapshot().rows[0].reasoningEffort, "retired-effort");
    f.controller.change(0, "model", "flash");
    effort = select(f.client.render(f.controller), "Summary model 1 · Reasoning effort");
    effort.props.onChange({ target: { value: "" } });
    assert.equal(Object.hasOwn(f.controller.getSnapshot().rows[0], "reasoningEffort"), false);
    assert.equal(await f.controller.save(), true);
    assert.equal(Object.hasOwn(f.calls[0].ops[0].value[0], "reasoningEffort"), false);
});

test("page controls have distinct accessible names, matching labels and stable boundary actions in both locales", async () => {
    const f = fixture([route("deepseek", "flash"), route("openai", "gpt")]);
    await f.controller.start();
    const english = f.client.render(f.controller);
    assert.equal(button(english, "Summary model 1 · Move up").props.disabled, true);
    assert.equal(button(english, "Summary model 2 · Move down").props.disabled, true);
    const labels = nodes(english).filter((node) => node.type === "label");
    for (const input of nodes(english).filter((node) => ["input", "select"].includes(node.type)))
        assert.ok(labels.some((label) => label.props.htmlFor === input.props.id));
    const switches = nodes(english).filter((node) => node.props.role === "switch");
    assert.equal(switches.length, 4);
    assert.equal(new Set(switches.map((control) => control.props.id)).size, 4);
    assert.equal(new Set(switches.map((control) => control.props["aria-label"])).size, 4);
    const firstPriority = switchControl(
        english,
        "Summary model 1 · Prioritize when matching the session",
    );
    const secondPriority = switchControl(
        english,
        "Summary model 2 · Prioritize when matching the session",
    );
    assert.equal(firstPriority.props["aria-checked"], true);
    assert.equal(secondPriority.props["aria-checked"], true);
    for (const index of [1, 2])
        assert.equal(
            switchControl(english, `Summary model ${index} · Use the session Agent for summaries`)
                .props["aria-checked"],
            false,
        );
    secondPriority.props.onChange({ target: { checked: false } });
    assert.equal(f.controller.getSnapshot().rows[1].preferWhenSessionMatches, false);
    button(f.client.render(f.controller), "Summary model 2 · Move up").props.onClick();
    assert.equal(f.controller.getSnapshot().rows[0].model, "gpt");
    f.client.setLanguage("zh");
    const chinese = f.client.render(f.controller);
    assert.match(visibleText(chinese), /匹配会话时优先/);
    assert.match(visibleText(chinese), /自动（供应商默认值）/);
    assert.ok(button(chinese, "摘要模型 1 · 删除"));
    assert.doesNotMatch(visibleText(chinese), /summarySettings[A-Z]/);
});

test("session-Agent switches pair distinct ids, labels, checked state and help text in both locales", async () => {
    const f = fixture([
        route("deepseek", "flash"),
        route("openai", "gpt", { useSessionAgent: true, preferWhenSessionMatches: false }),
    ]);
    await f.controller.start();
    for (const locale of ["en", "zh"]) {
        f.client.setLanguage(locale);
        const tree = f.client.render(f.controller);
        const all = nodes(tree);
        const text = locale === "zh" ? "沿用会话生成摘要" : "Use the session Agent for summaries";
        const controls = [1, 2].map((index) =>
            switchControl(
                tree,
                `${locale === "zh" ? "摘要模型" : "Summary model"} ${index} · ${text}`,
            ),
        );
        assert.equal(new Set(controls.map((control) => control.props.id)).size, 2);
        assert.equal(new Set(controls.map((control) => control.props["aria-describedby"])).size, 2);
        for (const [index, control] of controls.entries()) {
            assert.equal(control.props.type, "checkbox");
            assert.equal(control.props.checked, index === 1);
            assert.equal(control.props["aria-checked"], index === 1);
            assert.equal(control.props.disabled, false);
            assert.ok(control.props.id);
            const labels = all.filter(
                (node) => node.type === "label" && node.props.htmlFor === control.props.id,
            );
            assert.equal(labels.length, 1);
            assert.equal(visibleText(labels[0]).trim(), text);
            const help = all.find((node) => node.props?.id === control.props["aria-describedby"]);
            assert.equal(help?.type, "p");
            assert.match(visibleText(help), locale === "zh" ? /默认关闭/ : /Off by default/);
            assert.match(
                visibleText(help),
                locale === "zh" ? /匹配当前会话/ : /session provider and model/,
            );
        }
        assert.doesNotMatch(visibleText(tree), /summarySettings[A-Z]/);
    }
});

test("remote configuration changes retain the draft and original revision until explicit reload", async () => {
    const f = fixture([route("deepseek", "flash")]);
    await f.controller.start();
    f.controller.change(0, "preferWhenSessionMatches", false);
    f.setEntry(descriptor([route("openai", "gpt")], 8));
    await f.controller.loadSettings();
    assert.equal(f.controller.getSnapshot().conflicted, true);
    assert.equal(f.controller.getSnapshot().revision, 7);
    assert.equal(f.controller.getSnapshot().rows[0].provider, "deepseek");
    assert.equal(await f.controller.save(), false);
    assert.equal(f.calls.length, 0);
    const tree = f.client.render(f.controller);
    assert.match(visibleText(tree), /Another page changed these settings/);
    const control = switchControl(tree, "Summary model 1 · Use the session Agent for summaries");
    assert.equal(control.props.disabled, true);
    control.props.onChange({ target: { checked: true } });
    assert.equal(f.controller.getSnapshot().rows[0].useSessionAgent, false);
    await button(tree, "Reload and discard unsaved changes").props.onClick();
    assert.equal(f.controller.getSnapshot().revision, 8);
    assert.equal(f.controller.getSnapshot().rows[0].provider, "openai");
    assert.equal(f.controller.getSnapshot().conflicted, false);
    assert.equal(f.controller.getSnapshot().dirty, false);
});

test("conflicted and rejected saves preserve every draft field and show errors without automatic overwrite", async () => {
    const f = fixture([route("openai", "gpt", { reasoningEffort: "high" })]);
    await f.controller.start();
    f.controller.change(0, "preferWhenSessionMatches", false);
    const before = copy(f.controller.getSnapshot().rows);
    let attempts = 0;
    f.remote.settings.mutate = async () => {
        attempts += 1;
        return failure("settings/conflict", "Expected revision 7, got 8");
    };
    assert.equal(await f.controller.save(), false);
    assert.deepEqual(copy(f.controller.getSnapshot().rows), before);
    assert.equal(f.controller.getSnapshot().conflicted, true);
    assert.equal(await f.controller.save(), false);
    assert.equal(attempts, 1);
    await f.controller.loadSettings(true);
    f.controller.change(0, "preferWhenSessionMatches", false);
    f.remote.settings.mutate = async () =>
        failure("settings/rejected", "Host validation refused this model");
    assert.equal(await f.controller.save(), false);
    assert.match(visibleText(f.client.render(f.controller)), /Host validation refused this model/);
    assert.deepEqual(copy(f.controller.getSnapshot().rows), before);
    assert.equal(f.controller.canSave(), true, "ordinary rejection permits a deliberate retry");
});

test("catalog failure preserves saved rows, shows a retry and permits saving an explicit empty list", async () => {
    const f = fixture([route("offline", "retired", { reasoningEffort: "custom" })]);
    f.remote.session.modelCatalog = async () => failure("provider/unavailable", "Catalog offline");
    await f.controller.start();
    assert.equal(f.controller.getSnapshot().catalogStatus, "error");
    assert.equal(f.controller.getSnapshot().rows[0].reasoningEffort, "custom");
    assert.match(visibleText(f.client.render(f.controller)), /Catalog offline/);
    assert.ok(button(f.client.render(f.controller), "Refresh model catalog"));
    f.controller.remove(0);
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[0].ops[0].value, []);
});

test("suffix namespace is persisted exactly and read-only or malformed settings cannot be overwritten", async () => {
    const f = fixture([route("deepseek", "flash")], { ns: "include:fold-context-ui" });
    await f.controller.start();
    f.controller.remove(0);
    await f.controller.save();
    assert.equal(f.calls[0].ns, "include:fold-context-ui");
    const readOnly = fixture([route("deepseek", "flash")], { writable: false });
    await readOnly.controller.start();
    readOnly.controller.remove(0);
    assert.equal(await readOnly.controller.save(), false);
    assert.equal(readOnly.calls.length, 0);
    assert.match(visibleText(readOnly.client.render(readOnly.controller)), /read-only/);
    const control = switchControl(
        readOnly.client.render(readOnly.controller),
        "Summary model 1 · Use the session Agent for summaries",
    );
    assert.equal(control.props.disabled, true);
    control.props.onChange({ target: { checked: true } });
    assert.equal(readOnly.controller.getSnapshot().rows[0].useSessionAgent, false);
    assert.equal(readOnly.calls.length, 0);
    const malformed = fixture([{ provider: "openai", model: "gpt", reasoningEffort: 42 }]);
    await malformed.controller.start();
    assert.equal(malformed.controller.getSnapshot().settingsStatus, "error");
    assert.match(
        visibleText(malformed.client.render(malformed.controller)),
        /Invalid summary settings/,
    );
    assert.equal(await malformed.controller.save(), false);
});

test("overlapping saves serialize at the UI boundary and cannot mutate the submitted snapshot", async () => {
    const f = fixture([route("deepseek", "flash")]);
    await f.controller.start();
    f.controller.change(0, "preferWhenSessionMatches", false);
    const pending = deferred();
    let request;
    f.remote.settings.mutate = async (ns, ops, revision) => {
        request = { ns, ops, revision };
        return pending.promise;
    };
    const save = f.controller.save();
    assert.equal(f.controller.getSnapshot().saving, true);
    const before = copy(f.controller.getSnapshot().rows);
    const control = switchControl(
        f.client.render(f.controller),
        "Summary model 1 · Use the session Agent for summaries",
    );
    assert.equal(control.props.disabled, true);
    control.props.onChange({ target: { checked: true } });
    assert.deepEqual(copy(f.controller.getSnapshot().rows), before);
    assert.equal(await f.controller.save(), false);
    f.controller.remove(0);
    assert.equal(f.controller.getSnapshot().rows.length, 1);
    pending.resolve(ok(descriptor(copy(request.ops[0].value), 8)));
    assert.equal(await save, true);
    assert.equal(f.controller.getSnapshot().saved, true);
    assert.match(
        visibleText(f.client.render(f.controller)),
        /Saved\. Changes apply at the next safe decision boundary/,
    );
});

test("late reads cannot replace newer catalog state and teardown ignores pending settlements", async () => {
    const f = fixture();
    await f.controller.start();
    const first = deferred(),
        second = deferred();
    let reads = 0;
    f.remote.session.modelCatalog = () => (++reads === 1 ? first : second).promise;
    const oldRead = f.controller.loadCatalog(),
        newRead = f.controller.loadCatalog();
    second.resolve(ok({ ...copy(catalog), groups: [catalog.groups[1]] }));
    await newRead;
    first.resolve(ok({ ...copy(catalog), groups: [catalog.groups[0]] }));
    await oldRead;
    assert.equal(f.controller.getSnapshot().groups[0].id, "openai");
    const late = deferred();
    f.remote.settings.describe = () => late.promise;
    const loadSettings = f.controller.loadSettings();
    const before = f.controller.getSnapshot();
    f.controller.stop();
    late.resolve(
        ok({ writable: true, namespaces: [descriptor([route("deepseek", "flash")], 99)] }),
    );
    await loadSettings;
    assert.equal(f.controller.getSnapshot(), before);
});

test("reconnect fences an in-flight save and preserves a draft even when another Host reuses the revision", async () => {
    const f = fixture([route("deepseek", "flash")]);
    await f.controller.start();
    f.controller.change(0, "preferWhenSessionMatches", false);
    const pending = deferred();
    f.remote.settings.mutate = () => pending.promise;
    const oldSave = f.controller.save();
    f.setEntry(descriptor([route("openai", "gpt")], 7));
    await f.controller.reconnect();
    assert.equal(f.controller.getSnapshot().conflicted, true);
    assert.equal(f.controller.getSnapshot().saving, false);
    assert.equal(f.controller.getSnapshot().rows[0].provider, "deepseek");
    pending.resolve(
        ok(descriptor([route("deepseek", "flash", { preferWhenSessionMatches: false })], 8)),
    );
    assert.equal(await oldSave, false);
    assert.equal(f.controller.getSnapshot().revision, 7);
    assert.equal(f.controller.getSnapshot().conflicted, true);
    await f.controller.loadSettings(true);
    assert.equal(f.controller.getSnapshot().rows[0].provider, "openai");
    assert.equal(f.controller.getSnapshot().conflicted, false);
});

test("loading states are visible and refreshing the catalog cannot bypass a known invalid effort", async () => {
    const f = fixture([route("openai", "gpt", { reasoningEffort: "unsupported" })]);
    assert.match(visibleText(f.client.render(f.controller)), /Loading summary settings/);
    assert.match(visibleText(f.client.render(f.controller)), /Loading model catalog/);
    await f.controller.start();
    f.controller.change(0, "preferWhenSessionMatches", false);
    const pending = deferred();
    f.remote.session.modelCatalog = () => pending.promise;
    const refresh = f.controller.loadCatalog();
    assert.equal(f.controller.canSave(), false);
    assert.match(
        visibleText(f.client.render(f.controller)),
        /does not support the selected effort/,
    );
    pending.resolve(ok(catalog));
    await refresh;
    assert.equal(f.controller.getSnapshot().rows[0].reasoningEffort, "unsupported");
    assert.equal(f.calls.length, 0);
});

test("mounted page subscribes to configuration, adapter and reconnect events and cleans up on unmount", async () => {
    const f = fixture([route("deepseek", "flash")]);
    f.client.page();
    f.client.mount();
    await settle();
    assert.equal(f.client.remoteListeners.size, 2);
    assert.equal(f.client.localListeners.size, 1);
    assert.match(visibleText(f.client.page()), /Flash/);
    f.setEntry(descriptor([route("openai", "gpt")], 8));
    f.client.remoteListeners.get("settings/document-updated")("fold-context-ui", 8);
    await settle();
    assert.match(visibleText(f.client.page()), /GPT/);
    f.setCatalog({
        ...copy(catalog),
        failures: [{ id: "offline", name: "Offline", message: "Unavailable" }],
    });
    f.client.remoteListeners.get("llm/adapters-updated")();
    await settle();
    assert.match(visibleText(f.client.page()), /Some provider catalogs failed/);
    f.client.unmount();
    assert.equal(f.client.remoteListeners.size, 0);
    assert.equal(f.client.localListeners.size, 0);
    f.client.dispose();
    assert.equal(f.calls.length, 0, "mounting, refreshing and unmounting must never save settings");
});

function policyDefaults() {
    return copy(load().plugin.normalizePolicyOverrides({}));
}

test("all policy controls render inherited, editable and localized without group switches", async () => {
    const f = fixture([route("deepseek", "flash"), route("openai", "gpt")]);
    await f.controller.start();
    assert.equal(f.controller.getSnapshot().dirty, false);
    for (const locale of ["en", "zh"]) {
        f.client.setLanguage(locale);
        const tree = f.client.render(f.controller);
        const all = nodes(tree);
        assert.equal(all.filter((node) => node.type === "details").length, 4);
        const controls = all.filter(
            (node) =>
                ["input", "select"].includes(node.type) && node.props.id?.includes("-policy-"),
        );
        assert.equal(controls.length, 10);
        assert.equal(new Set(controls.map((node) => node.props.id)).size, 10);
        assert.equal(new Set(controls.map((node) => node.props["aria-label"])).size, 10);
        for (const control of controls) {
            assert.ok(
                all.some(
                    (node) => node.type === "label" && node.props.htmlFor === control.props.id,
                ),
            );
            assert.equal(control.props.disabled, false);
            assert.equal(control.props.value, "");
            if (control.type === "input") assert.equal(control.props.required, false);
        }
        assert.doesNotMatch(visibleText(tree), /policy_[a-z]|policySettingsTitle/);
        assert.match(
            visibleText(tree),
            locale === "zh" ? /窗口与自动摘要/ : /Window and automation/,
        );
    }
    f.controller.changePolicy("compaction", "targetTokens", "170000");
    assert.equal(f.controller.canSave(), true);
    f.controller.resetPolicy("compaction");
    assert.deepEqual(copy(f.controller.getSnapshot().policyOverrides.compaction), {});
    assert.equal(f.controller.getSnapshot().dirty, false);
});

test("boolean, enum and numeric overrides round-trip and clearing restores field inheritance", async () => {
    const f = fixture([route("deepseek", "flash")]);
    await f.controller.start();
    const control = (id) =>
        nodes(f.client.render(f.controller)).find((node) => node.props.id === id);
    control("settings-policy-compaction-auto").props.onChange({ target: { value: "false" } });
    control("settings-policy-summary-images").props.onChange({ target: { value: "references" } });
    control("settings-policy-compaction-cacheReadRatio").props.onChange({ target: { value: "0" } });
    f.controller.changePolicy("scheduling", "cacheTtlMs", "0");
    f.controller.changePolicy("reminders", "enabled", false);
    assert.equal(control("settings-policy-compaction-auto").props.value, "false");
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[0].ops[1].value, {
        compaction: { auto: false, cacheReadRatio: 0 },
        scheduling: { cacheTtlMs: 0 },
        summary: { images: "references" },
        reminders: { enabled: false },
    });
    assert.equal(f.calls[0].revision, 7);
    assert.deepEqual(f.calls[0].ops[0].value, [route("deepseek", "flash")]);
    assert.equal(f.controller.getSnapshot().revision, 8);
    assert.equal(f.controller.getSnapshot().dirty, false);
    assert.match(visibleText(f.client.render(f.controller)), /next safe decision boundary/);
    for (const [group, key] of [
        ["compaction", "auto"],
        ["compaction", "cacheReadRatio"],
        ["summary", "images"],
        ["scheduling", "cacheTtlMs"],
        ["reminders", "enabled"],
    ])
        f.controller.changePolicy(group, key, "");
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[1].ops[1].value, policyDefaults());
    assert.equal(Object.hasOwn(f.calls[1].ops[1].value.compaction, "modelPolicies"), false);
});

test("unrelated model edits never turn inherited policy fields or model lists into explicit overrides", async () => {
    const f = fixture([route("deepseek", "flash")]);
    await f.controller.start();
    f.controller.change(0, "preferWhenSessionMatches", false);
    f.controller.change(0, "preferWhenSessionMatches", true);
    assert.equal(f.controller.getSnapshot().dirty, false);
    f.controller.changePolicy("compaction", "targetTokens", "   ");
    assert.equal(f.controller.getSnapshot().dirty, false);
    f.controller.change(0, "useSessionAgent", true);
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[0].ops[1].value, policyDefaults());
    assert.equal(Object.hasOwn(f.calls[0].ops[1].value.compaction, "modelPolicies"), false);
});

test("policy validation retains invalid drafts and blocks saves", async () => {
    const f = fixture();
    await f.controller.start();
    for (const invalid of ["0", "-1", "1.5", "Infinity", "NaN", "not-a-number"]) {
        f.controller.changePolicy("compaction", "targetTokens", invalid);
        assert.equal(f.controller.canSave(), false, invalid);
        assert.equal(f.controller.getSnapshot().policyOverrides.compaction.targetTokens, invalid);
        assert.equal(await f.controller.save(), false);
    }
    assert.match(visibleText(f.client.render(f.controller)), /Target window/);
    assert.equal(f.calls.length, 0);
    f.controller.changePolicy("compaction", "targetTokens", "170000");
    assert.equal(f.controller.canSave(), true);
    f.controller.changePolicy("compaction", "cacheReadRatio", "1.01");
    assert.equal(f.controller.canSave(), false);
    f.controller.changePolicy("compaction", "cacheReadRatio", "0.1");
    assert.equal(f.controller.canSave(), true);
});

test("per-model policies preserve unavailable routes, restrict fields and retain row identity", async () => {
    const policies = policyDefaults();
    policies.compaction.modelPolicies = [{ provider: "offline", model: "old", cacheReadRatio: 0 }];
    const f = fixture([], { policies });
    await f.controller.start();
    assert.match(visibleText(f.client.render(f.controller)), /offline.*unavailable/i);
    const originalKey = f.controller.getSnapshot().policyRowKeys[0];
    f.controller.addPolicyModel();
    assert.equal(f.controller.canSave(), false);
    f.controller.changePolicyModel(1, "provider", "openai");
    f.controller.changePolicyModel(1, "model", "gpt");
    f.controller.changePolicyModel(1, "targetTokens", "170000");
    f.controller.changePolicyModel(1, "cacheReadRatio", "");
    f.controller.changePolicyModel(1, "auto", false);
    assert.equal(
        Object.hasOwn(
            f.controller.getSnapshot().policyOverrides.compaction.modelPolicies[1],
            "auto",
        ),
        false,
    );
    f.controller.movePolicyModel(1, -1);
    assert.equal(f.controller.getSnapshot().policyRowKeys[1], originalKey);
    const modelControls = nodes(f.client.render(f.controller)).filter(
        (node) =>
            ["input", "select"].includes(node.type) && node.props.id?.startsWith("settings-model-"),
    );
    assert.equal(
        modelControls.length,
        8,
        "each route has provider/model and only the two per-model fields",
    );
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[0].ops[1].value.compaction.modelPolicies, [
        { provider: "openai", model: "gpt", targetTokens: 170000 },
        { provider: "offline", model: "old", cacheReadRatio: 0 },
    ]);
    f.controller.removePolicyModel(0);
    f.controller.changePolicyModel(0, "provider", "deepseek");
    assert.equal(f.controller.getSnapshot().policyOverrides.compaction.modelPolicies[0].model, "");
});

test("empty model lists explicitly override presets and list reset restores inheritance only", async () => {
    const policies = policyDefaults();
    policies.compaction = {
        targetTokens: 170000,
        modelPolicies: [{ provider: "offline", model: "old" }],
    };
    const f = fixture([], { policies });
    await f.controller.start();
    f.controller.removePolicyModel(0);
    assert.match(visibleText(f.client.render(f.controller)), /empty list disables preset/);
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[0].ops[1].value.compaction, {
        targetTokens: 170000,
        modelPolicies: [],
    });
    button(f.client.render(f.controller), "Inherit preset model policies").props.onClick();
    assert.deepEqual(copy(f.controller.getSnapshot().policyRowKeys), []);
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[1].ops[1].value.compaction, { targetTokens: 170000 });
});

test("duplicate per-model routes block save until corrected", async () => {
    const f = fixture();
    await f.controller.start();
    for (let i = 0; i < 2; i++) {
        f.controller.addPolicyModel();
        f.controller.changePolicyModel(i, "provider", "openai");
        f.controller.changePolicyModel(i, "model", "gpt");
    }
    assert.equal(f.controller.canSave(), false);
    assert.match(visibleText(f.client.render(f.controller)), /Session model policy 2/);
    f.controller.changePolicyModel(1, "model", "plain");
    assert.equal(f.controller.canSave(), true);
});

test("policy-only remote conflicts retain draft and revision until explicit reload", async () => {
    const f = fixture();
    await f.controller.start();
    f.controller.changePolicy("compaction", "targetTokens", "170000");
    const remote = descriptor([], 8);
    remote.value.policyOverrides.summary.images = "references";
    f.setEntry(remote);
    await f.controller.loadSettings();
    assert.equal(f.controller.getSnapshot().conflicted, true);
    assert.equal(f.controller.getSnapshot().revision, 7);
    assert.equal(f.controller.getSnapshot().policyOverrides.compaction.targetTokens, "170000");
    assert.equal(f.controller.canSave(), false);
    await f.controller.loadSettings(true);
    assert.equal(f.controller.getSnapshot().revision, 8);
    assert.equal(f.controller.getSnapshot().policyOverrides.summary.images, "references");
    assert.equal(f.controller.getSnapshot().dirty, false);
});

test("policy changes are frozen during save and rejected revision receipts retain the draft", async () => {
    const f = fixture();
    await f.controller.start();
    f.controller.changePolicy("compaction", "targetTokens", "170000");
    const pending = deferred();
    let request;
    f.remote.settings.mutate = async (ns, ops, revision) => {
        request = copy({ ns, ops, revision });
        return pending.promise;
    };
    const saving = f.controller.save();
    f.controller.changePolicy("compaction", "targetTokens", "180000");
    f.controller.resetPolicy("compaction");
    f.controller.inheritPolicyModels();
    assert.equal(f.controller.getSnapshot().policyOverrides.compaction.targetTokens, "170000");
    assert.equal(request.ops[1].value.compaction.targetTokens, 170000);
    pending.resolve(ok(descriptor([], 6)));
    assert.equal(await saving, false);
    assert.equal(f.controller.getSnapshot().revision, 7);
    assert.equal(f.controller.getSnapshot().dirty, true);
});

for (const [kind, invalidate] of [
    ["missing", (entry) => delete entry.value.policyOverrides],
    ["undefined", (entry) => (entry.value.policyOverrides = undefined)],
    ["null", (entry) => (entry.value.policyOverrides = null)],
    ["array", (entry) => (entry.value.policyOverrides = [])],
    ["invalid value", (entry) => (entry.value.policyOverrides.summary.images = "invalid")],
    [
        "legacy wrapper",
        (entry) => (entry.value.policyOverrides.compaction = { enabled: true, values: {} }),
    ],
    ["legacy field", (entry) => (entry.value.policyOverrides.scheduling.paybackTurns = 24)],
]) {
    test(`${kind} policy documents reject load without saving defaults`, async () => {
        const f = fixture([route("deepseek", "flash")]);
        invalidate(f.getEntry());
        await f.controller.start();
        const state = f.controller.getSnapshot();
        assert.equal(state.settingsStatus, "error");
        assert.equal(state.policyOverrides, null);
        assert.equal(f.controller.canEdit(), false);
        assert.equal(f.controller.canSave(), false);
        assert.equal(await f.controller.save(), false);
        assert.equal(f.calls.length, 0);
        if (["missing", "undefined", "null", "array"].includes(kind)) {
            assert.equal(state.settingsError.key, "summarySettingsResponse");
            assert.match(
                visibleText(f.client.render(f.controller)),
                /unrecognized settings response/,
            );
        }
    });
    test(`${kind} policy save receipts preserve draft and revision`, async () => {
        const f = fixture();
        await f.controller.start();
        f.controller.changePolicy("compaction", "targetTokens", "170000");
        f.remote.settings.mutate = async () => {
            const entry = descriptor([], 8);
            invalidate(entry);
            return ok(entry);
        };
        assert.equal(await f.controller.save(), false);
        const state = f.controller.getSnapshot();
        assert.equal(state.dirty, true);
        assert.equal(state.revision, 7);
        assert.equal(state.saved, false);
        assert.equal(state.policyOverrides.compaction.targetTokens, "170000");
        assert.match(visibleText(f.client.render(f.controller)), /Could not save/);
        if (["missing", "undefined", "null", "array"].includes(kind))
            assert.equal(state.saveError.key, "summarySettingsResponse");
    });
}

test("remote canonical values matching a numeric draft acknowledge the new revision without false conflict", async () => {
    const f = fixture();
    await f.controller.start();
    f.controller.changePolicy("compaction", "targetTokens", "170000");
    const remote = descriptor([], 8);
    remote.value.policyOverrides.compaction.targetTokens = 170000;
    f.setEntry(remote);
    await f.controller.loadSettings();
    assert.equal(f.controller.getSnapshot().conflicted, false);
    assert.equal(f.controller.getSnapshot().dirty, false);
    assert.equal(f.controller.getSnapshot().revision, 8);
    assert.equal(f.controller.getSnapshot().policyOverrides.compaction.targetTokens, 170000);
    assert.equal(f.calls.length, 0);
});
