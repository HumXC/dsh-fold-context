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
    value: { summaryModels: rows },
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

test("add, dependent choices, toggle, reorder and delete stage one revision-fenced summaryModels mutation", async () => {
    const f = fixture([route("deepseek", "flash")]);
    await f.controller.start();
    const originalKeys = [...f.controller.getSnapshot().rowKeys];
    f.controller.add();
    assert.equal(f.controller.getSnapshot().rows[1].preferWhenSessionMatches, true);
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
    assert.equal(switches.length, 2);
    assert.equal(switches[1].props["aria-checked"], true);
    switches[1].props.onChange({ target: { checked: false } });
    button(f.client.render(f.controller), "Summary model 2 · Move up").props.onClick();
    assert.equal(f.controller.getSnapshot().rows[0].model, "gpt");
    f.client.setLanguage("zh");
    const chinese = f.client.render(f.controller);
    assert.match(visibleText(chinese), /匹配会话时优先/);
    assert.match(visibleText(chinese), /自动（同模型沿用会话/);
    assert.ok(button(chinese, "摘要模型 1 · 删除"));
    assert.doesNotMatch(visibleText(chinese), /summarySettings[A-Z]/);
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
    assert.equal(await f.controller.save(), false);
    f.controller.remove(0);
    assert.equal(f.controller.getSnapshot().rows.length, 1);
    pending.resolve(ok(descriptor(copy(request.ops[0].value), 8)));
    assert.equal(await save, true);
    assert.equal(f.controller.getSnapshot().saved, true);
    assert.match(visibleText(f.client.render(f.controller)), /The next summary will use/);
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

const policyDefaults = () => copy(load().plugin.normalizePolicyOverrides({}));

test("all runtime policy controls render with unique labels, inheritance and both locales", async () => {
    const f = fixture([route("deepseek", "flash"), route("openai", "gpt")], {
        policies: policyDefaults(),
    });
    await f.controller.start();
    for (const locale of ["en", "zh"]) {
        const tree = f.client.render(f.controller, locale);
        const all = nodes(tree);
        assert.equal(all.filter((node) => node.type === "details").length, 5);
        const controls = all.filter(
            (node) =>
                ["input", "select"].includes(node.type) && node.props.id?.includes("-policy-"),
        );
        assert.equal(controls.filter((node) => !node.props.id.endsWith("-mode")).length, 37);
        assert.equal(new Set(controls.map((node) => node.props.id)).size, controls.length);
        assert.equal(
            new Set(controls.map((node) => node.props["aria-label"])).size,
            controls.length,
        );
        for (const control of controls) {
            assert.ok(
                all.some(
                    (node) => node.type === "label" && node.props.htmlFor === control.props.id,
                ),
            );
            assert.equal(control.props.disabled, !control.props.id.endsWith("-mode"));
        }
        assert.doesNotMatch(visibleText(tree), /policy_[a-z]|policySettingsTitle/);
    }
    f.controller.setPolicyMode("release", true);
    f.controller.changePolicy("release", "catalogLimit", "4");
    assert.equal(f.controller.canSave(), true);
    f.controller.resetPolicy("release");
    assert.equal(f.controller.getSnapshot().policyOverrides.release.values.catalogLimit, 32);
    assert.equal(f.controller.getSnapshot().policyOverrides.release.enabled, true);
    f.controller.setPolicyMode("release", false);
    assert.equal(f.controller.getSnapshot().dirty, false);
});

test("all policy groups and the saved summary models share one revision-fenced save", async () => {
    const routes = [route("deepseek", "flash"), route("openai", "gpt")];
    const f = fixture(routes, { policies: policyDefaults() });
    await f.controller.start();
    f.controller.setPolicyMode("summary", true);
    f.controller.changePolicy("summary", "images", "references");
    f.controller.setPolicyMode("scheduling", true);
    f.controller.changePolicy("scheduling", "cacheTtlMs", "0");
    f.controller.setPolicyMode("reminders", true);
    f.controller.changePolicy("reminders", "ignoredBackoffSteps", "12，24, 48");
    assert.equal(await f.controller.save(), true);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.revision, 7);
    assert.deepEqual(
        call.ops.map((op) => op.path),
        [["summaryModels"], ["policyOverrides"]],
    );
    assert.deepEqual(call.ops[0].value, routes);
    assert.equal(call.ops[1].value.summary.values.images, "references");
    assert.equal(call.ops[1].value.scheduling.values.cacheTtlMs, 0);
    assert.deepEqual(call.ops[1].value.reminders.values.ignoredBackoffSteps, [12, 24, 48]);
    assert.equal(f.controller.getSnapshot().dirty, false);
    assert.equal(f.controller.getSnapshot().revision, 8);
    assert.match(visibleText(f.client.render(f.controller)), /subsequently started sessions/);
});

test("policy validation prevents invalid saves without discarding partially entered values", async () => {
    const f = fixture([], { policies: policyDefaults() });
    await f.controller.start();
    f.controller.setPolicyMode("reminders", true);
    f.controller.changePolicy("reminders", "ignoredBackoffSteps", "24, 12");
    assert.equal(f.controller.canSave(), false);
    assert.equal(
        f.controller.getSnapshot().policyOverrides.reminders.values.ignoredBackoffSteps,
        "24, 12",
    );
    assert.match(visibleText(f.client.render(f.controller)), /Ignored-reminder backoff steps/);
    assert.equal(await f.controller.save(), false);
    assert.equal(f.calls.length, 0);
    f.controller.changePolicy("reminders", "ignoredBackoffSteps", "12, 24");
    f.controller.setPolicyMode("release", true);
    for (const invalid of ["", "0", "129", "1.5", "Infinity"]) {
        f.controller.changePolicy("release", "catalogLimit", invalid);
        assert.equal(f.controller.canSave(), false, invalid);
    }
    f.controller.changePolicy("release", "catalogLimit", "8");
    assert.equal(f.controller.canSave(), true);
});

test("per-model policies preserve unknown routes, inherit blank fields and keep stable row order", async () => {
    const policies = policyDefaults();
    policies.compaction.enabled = true;
    policies.compaction.values.modelPolicies = [
        { provider: "offline", model: "old", retainTokens: 0 },
    ];
    const f = fixture([], { policies });
    await f.controller.start();
    assert.match(visibleText(f.client.render(f.controller)), /offline/);
    const originalKey = f.controller.getSnapshot().policyRowKeys[0];
    f.controller.addPolicyModel();
    assert.equal(f.controller.canSave(), false);
    f.controller.changePolicyModel(1, "provider", "openai");
    f.controller.changePolicyModel(1, "model", "gpt");
    f.controller.changePolicyModel(1, "headroomTokens", "64");
    f.controller.changePolicyModel(1, "retainRatio", "");
    f.controller.movePolicyModel(1, -1);
    assert.equal(f.controller.getSnapshot().policyRowKeys[1], originalKey);
    assert.equal(await f.controller.save(), true);
    assert.deepEqual(f.calls[0].ops[1].value.compaction.values.modelPolicies, [
        { provider: "openai", model: "gpt", headroomTokens: 64 },
        { provider: "offline", model: "old", retainTokens: 0 },
    ]);
    f.controller.removePolicyModel(0);
    f.controller.changePolicyModel(0, "provider", "deepseek");
    assert.equal(
        f.controller.getSnapshot().policyOverrides.compaction.values.modelPolicies[0].model,
        "",
    );
});

test("policy-only remote conflicts retain the whole draft and the original revision", async () => {
    const f = fixture([], { policies: policyDefaults() });
    await f.controller.start();
    f.controller.setPolicyMode("release", true);
    f.controller.changePolicy("release", "catalogLimit", "4");
    const remote = descriptor([], 8);
    remote.value.policyOverrides = policyDefaults();
    remote.value.policyOverrides.summary.enabled = true;
    f.setEntry(remote);
    await f.controller.loadSettings();
    assert.equal(f.controller.getSnapshot().conflicted, true);
    assert.equal(f.controller.getSnapshot().revision, 7);
    assert.equal(f.controller.getSnapshot().policyOverrides.release.values.catalogLimit, "4");
    assert.equal(f.controller.canSave(), false);
    await f.controller.loadSettings(true);
    assert.equal(f.controller.getSnapshot().revision, 8);
    assert.equal(f.controller.getSnapshot().policyOverrides.summary.enabled, true);
    assert.equal(f.controller.getSnapshot().dirty, false);
});

test("missing or malformed policy save receipts preserve the submitted draft", async () => {
    const f = fixture([], { policies: policyDefaults() });
    await f.controller.start();
    f.controller.setPolicyMode("release", true);
    f.controller.changePolicy("release", "catalogLimit", "4");
    f.remote.settings.mutate = async () => ok(descriptor([], 8));
    assert.equal(await f.controller.save(), false);
    assert.equal(f.controller.getSnapshot().dirty, true);
    assert.equal(f.controller.getSnapshot().policyOverrides.release.values.catalogLimit, "4");
    assert.match(visibleText(f.client.render(f.controller)), /Could not save/);
});
