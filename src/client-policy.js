// Injected into the Client factory at build time; only Host theme tokens are shared.
Object.assign(zh, {
    policySettingsTitle: "上下文压缩设置",
    policyTitle: "运行策略",
    policyDescription:
        "每个字段可继承 Agent 预设。留空或选择继承时不写入覆盖值；运行时状态显示最终生效策略。",
    policyApplies: "修改在下一次安全决策边界生效；进行中的摘要继续使用原配置。",
    policyInherit: "继承 Agent 预设",
    policyCustom: "使用自定义配置",
    policyReset: "恢复本组继承",
    policyOn: "开启",
    policyOff: "关闭",
    policyOptional: "留空继承 Agent 预设",
    policyModelOptional: "留空继承本组设置",
    policyModelsInherit: "继承预设的模型策略",
    policyModelsExplicit: "使用此模型策略列表（空列表表示禁用预设的模型策略）",
    policyInvalid: "配置有误，请检查：",
    policyFieldInvalid: "请输入符合范围和格式要求的值。",
    policyModelsTitle: "按会话模型覆盖",
    policyModelsHelp:
        "按供应商和模型精确匹配，同一路由不能重复；只填写需要覆盖的值。供应商或模型暂不可用时保留原值。",
    policyModelsEmpty: "尚无模型专属策略。",
    policyModelsAdd: "添加模型策略",
    policyModelRow: "会话模型策略 {index}",
    summarySettingsSavedAll: "已保存。修改在下一次安全决策边界生效。",
});
Object.assign(en, {
    policySettingsTitle: "Context compression settings",
    policyTitle: "Runtime policies",
    policyDescription:
        "Each omitted field inherits the Agent preset. Runtime status reports the effective policy.",
    policyApplies:
        "Changes apply at the next safe decision boundary; active summaries keep their configuration.",
    policyInherit: "Inherit Agent preset",
    policyCustom: "Use custom settings",
    policyReset: "Reset group inheritance",
    policyOn: "On",
    policyOff: "Off",
    policyOptional: "Leave blank to inherit the Agent preset",
    policyModelOptional: "Leave blank to inherit this group",
    policyModelsInherit: "Inherit preset model policies",
    policyModelsExplicit:
        "Use this model policy list (an empty list disables preset model policies)",
    policyInvalid: "Check these settings:",
    policyFieldInvalid: "Enter a value within the allowed range and format.",
    policyModelsTitle: "Per-session-model overrides",
    policyModelsHelp:
        "Match provider and model exactly, with no duplicate routes. Fill only values to override. Saved routes remain intact when unavailable.",
    policyModelsEmpty: "No per-model policies yet.",
    policyModelsAdd: "Add model policy",
    policyModelRow: "Session model policy {index}",
    summarySettingsSavedAll: "Saved. Changes apply at the next safe decision boundary.",
});
const policyTextKey = (group, field, suffix = "label") => `policy_${group}_${field}_${suffix}`;
for (const group of POLICY_GROUPS) {
    for (const [language, dictionary] of [
        ["zh", zh],
        ["en", en],
    ]) {
        dictionary[policyTextKey(group.key, "group")] = group.label[language];
        dictionary[policyTextKey(group.key, "group", "help")] = group.help[language];
        for (const field of group.fields) {
            dictionary[policyTextKey(group.key, field.key)] = field.label[language];
            dictionary[policyTextKey(group.key, field.key, "help")] = field.help[language];
            for (const choice of field.choices ?? [])
                dictionary[policyTextKey(group.key, field.key, choice.value)] =
                    choice.label[language];
        }
    }
}
function policyDraftPayload(draft) {
    const result = {};
    const convert = (fields, values, inherited) => {
        const converted = { ...values };
        for (const field of fields) {
            const value = converted[field.key];
            if (
                (field.optional || inherited) &&
                (value === undefined || (typeof value === "string" && value.trim() === ""))
            )
                delete converted[field.key];
            else if (typeof value === "string" && ["number", "integer"].includes(field.type))
                converted[field.key] = Number(value);
        }
        return converted;
    };
    for (const group of POLICY_GROUPS) {
        const entry = draft[group.key] ?? {};
        const values = convert(group.fields, entry, true);
        if (group.key === "compaction" && entry.modelPolicies !== undefined)
            values.modelPolicies = entry.modelPolicies.map((row) =>
                convert(
                    group.fields.filter((field) => field.perModel),
                    row,
                    true,
                ),
            );
        result[group.key] = values;
    }
    return normalizePolicyOverrides(result);
}
function policyDraftDirty(draft, baseline) {
    try {
        return JSON.stringify(policyDraftPayload(draft)) !== JSON.stringify(baseline);
    } catch {
        return true;
    }
}
function policyErrorLabel(error, t) {
    const parts = (error?.path ?? "").split(".");
    const group = POLICY_GROUPS.find((group) => group.key === parts[0]);
    if (!group) return t("policyFieldInvalid");
    const prefix = t(policyTextKey(group.key, "group"));
    if (parts[1] === "modelPolicies") {
        const row = t("policyModelRow").replace("{index}", String(Number(parts[2] ?? 0) + 1));
        return `${prefix} · ${row}${parts[3] ? ` · ${t(policyTextKey(group.key, parts[3]))}` : ""}`;
    }
    return `${prefix}${parts[1] ? ` · ${t(policyTextKey(group.key, parts[1]))}` : ""}`;
}
function renderPolicySettings(controller, state, t, id) {
    if (!state.policyOverrides) return null;
    const editable = controller.canEdit();
    const error = controller.policyError();
    const renderField = (
        group,
        field,
        value,
        disabled,
        onChange,
        prefix,
        inherited = false,
        path = `${group.key}.${field.key}`,
    ) => {
        const inputId = `${prefix}-${field.key}`;
        const title = t(policyTextKey(group.key, field.key));
        const invalid = error?.path === path;
        const attributes = {
            id: inputId,
            disabled,
            value:
                field.type === "boolean" && typeof value === "boolean"
                    ? String(value)
                    : (value ?? ""),
            "aria-label": `${t(policyTextKey(group.key, "group"))} · ${prefix.includes("-model-") ? `${t("policyModelRow").replace("{index}", String(Number(prefix.split("-model-").at(-1)) + 1))} · ` : ""}${title}`,
            "aria-describedby": `${inputId}-help${invalid ? ` ${inputId}-error` : ""}`,
            "aria-invalid": invalid || undefined,
            onChange: (event) =>
                onChange(
                    event.target.value === ""
                        ? ""
                        : field.type === "boolean"
                          ? event.target.value === "true"
                          : event.target.value,
                ),
        };
        const control =
            field.type === "boolean" || field.type === "enum"
                ? h(
                      "select",
                      attributes,
                      h("option", { value: "" }, t("policyInherit")),
                      ...(field.type === "boolean"
                          ? [
                                h("option", { key: "on", value: "true" }, t("policyOn")),
                                h("option", { key: "off", value: "false" }, t("policyOff")),
                            ]
                          : field.choices.map((choice) =>
                                h(
                                    "option",
                                    { key: choice.value, value: choice.value },
                                    t(policyTextKey(group.key, field.key, choice.value)),
                                ),
                            )),
                  )
                : h("input", {
                      ...attributes,
                      type: field.type === "steps" ? "text" : "number",
                      value: Array.isArray(value) ? value.join(", ") : (value ?? ""),
                      min: field.min,
                      max: field.max,
                      step: field.type === "integer" ? 1 : "any",
                      required: !field.optional && !inherited,
                      placeholder: t(
                          prefix.includes("-model-") ? "policyModelOptional" : "policyOptional",
                      ),
                  });
        return h(
            "div",
            { className: "fc-settings-field", key: field.key },
            h("label", { htmlFor: inputId }, title),
            control,
            h(
                "p",
                { id: `${inputId}-help`, className: "fc-settings-help" },
                t(policyTextKey(group.key, field.key, "help")),
            ),
            invalid
                ? h(
                      "p",
                      { id: `${inputId}-error`, role: "alert", className: "fc-settings-error" },
                      t("policyFieldInvalid"),
                  )
                : null,
        );
    };
    const renderModels = (group, disabled) => {
        const rows = state.policyOverrides.compaction.modelPolicies ?? [];
        return h(
            "div",
            { className: "fc-policy-models" },
            h("h4", null, t("policyModelsTitle")),
            h("p", { className: "fc-settings-note" }, t("policyModelsHelp")),
            h(
                "p",
                { className: "fc-settings-note" },
                t(
                    state.policyOverrides.compaction.modelPolicies === undefined
                        ? "policyModelsInherit"
                        : "policyModelsExplicit",
                ),
            ),
            h(
                "button",
                {
                    type: "button",
                    disabled:
                        disabled || state.policyOverrides.compaction.modelPolicies === undefined,
                    onClick: () => controller.inheritPolicyModels(),
                },
                t("policyModelsInherit"),
            ),
            !rows.length ? h("p", { className: "fc-settings-note" }, t("policyModelsEmpty")) : null,
            ...rows.map((row, index) => {
                const rowId = `${id}-model-${index}`;
                const rowTitle = t("policyModelRow").replace("{index}", String(index + 1));
                const provider = state.groups.find((group) => group.id === row.provider);
                const models = provider?.models ?? [];
                const routeSelect = (key, options, label) =>
                    h(
                        "div",
                        { className: "fc-settings-field", key },
                        h("label", { htmlFor: `${rowId}-${key}` }, t(label)),
                        h(
                            "select",
                            {
                                id: `${rowId}-${key}`,
                                value: row[key],
                                disabled: disabled || state.catalogStatus !== "ready",
                                "aria-label": `${rowTitle} · ${t(label)}`,
                                onChange: (event) =>
                                    controller.changePolicyModel(index, key, event.target.value),
                            },
                            h(
                                "option",
                                { value: "" },
                                t(
                                    key === "provider"
                                        ? "summarySettingsChooseProvider"
                                        : "summarySettingsChooseModel",
                                ),
                            ),
                            row[key] && !options.some((option) => option.id === row[key])
                                ? h(
                                      "option",
                                      { value: row[key] },
                                      `${row[key]} (${t("summarySettingsUnavailable")})`,
                                  )
                                : null,
                            ...options.map((option) =>
                                h("option", { key: option.id, value: option.id }, option.name),
                            ),
                        ),
                    );
                return h(
                    "fieldset",
                    { key: state.policyRowKeys[index], className: "fc-settings-row", disabled },
                    h("legend", null, rowTitle),
                    h(
                        "div",
                        { className: "fc-settings-fields" },
                        routeSelect("provider", state.groups, "summarySettingsProvider"),
                        routeSelect("model", models, "summarySettingsModel"),
                        ...group.fields
                            .filter((field) => field.perModel)
                            .map((field) =>
                                renderField(
                                    group,
                                    field,
                                    row[field.key],
                                    disabled,
                                    (value) =>
                                        controller.changePolicyModel(index, field.key, value),
                                    rowId,
                                    true,
                                    `compaction.modelPolicies.${index}.${field.key}`,
                                ),
                            ),
                    ),
                    h(
                        "div",
                        { className: "fc-settings-actions fc-settings-row-actions" },
                        ...[
                            [
                                "summarySettingsUp",
                                () => controller.movePolicyModel(index, -1),
                                index === 0,
                            ],
                            [
                                "summarySettingsDown",
                                () => controller.movePolicyModel(index, 1),
                                index === rows.length - 1,
                            ],
                            [
                                "summarySettingsDelete",
                                () => controller.removePolicyModel(index),
                                false,
                            ],
                        ].map(([label, onClick, boundary]) =>
                            h(
                                "button",
                                {
                                    key: label,
                                    type: "button",
                                    disabled: disabled || boundary,
                                    "aria-label": `${rowTitle} · ${t(label)}`,
                                    onClick,
                                },
                                t(label),
                            ),
                        ),
                    ),
                );
            }),
            h(
                "button",
                {
                    type: "button",
                    disabled:
                        disabled ||
                        rows.length >= 128 ||
                        state.catalogStatus !== "ready" ||
                        !state.groups.some((group) => group.models.length),
                    onClick: () => controller.addPolicyModel(),
                },
                t("policyModelsAdd"),
            ),
        );
    };
    return h(
        "div",
        { className: "fc-policy-settings" },
        h("h3", null, t("policyTitle")),
        h("p", { className: "fc-settings-note" }, t("policyDescription")),
        h("p", { className: "fc-settings-note" }, t("policyApplies")),
        error
            ? h(
                  "p",
                  { role: "alert", className: "fc-settings-error" },
                  `${t("policyInvalid")} ${policyErrorLabel(error, t)}`,
              )
            : null,
        ...POLICY_GROUPS.map((group) => {
            const entry = state.policyOverrides[group.key];
            const title = t(policyTextKey(group.key, "group"));
            const groupId = `${id}-policy-${group.key}`;
            const disabled = !editable;
            return h(
                "details",
                { key: group.key, className: "fc-policy-group" },
                h(
                    "summary",
                    null,
                    h("span", null, title),
                    h(
                        "span",
                        { className: "fc-settings-note" },
                        t(Object.keys(entry).length ? "policyCustom" : "policyInherit"),
                    ),
                ),
                h(
                    "div",
                    { className: "fc-policy-body" },
                    h(
                        "p",
                        { className: "fc-settings-note" },
                        t(policyTextKey(group.key, "group", "help")),
                    ),
                    h(
                        "div",
                        { className: "fc-settings-fields" },
                        ...group.fields.map((field) =>
                            renderField(
                                group,
                                field,
                                entry[field.key],
                                disabled,
                                (value) => controller.changePolicy(group.key, field.key, value),
                                groupId,
                                true,
                            ),
                        ),
                    ),
                    group.key === "compaction" ? renderModels(group, disabled) : null,
                    h(
                        "button",
                        {
                            type: "button",
                            disabled: !editable,
                            "aria-label": `${title} · ${t("policyReset")}`,
                            onClick: () => controller.resetPolicy(group.key),
                        },
                        t("policyReset"),
                    ),
                ),
            );
        }),
    );
}
const policySettingsCss = `
.fc-policy-settings,.fc-policy-body,.fc-policy-models{display:grid;gap:14px;min-width:0}.fc-policy-settings{padding-top:8px}.fc-settings h4{margin:0;font:inherit;font-weight:500}
.fc-policy-group{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.fc-policy-group>summary{cursor:pointer;padding:12px 16px;font-weight:500}.fc-policy-group>summary>span:last-child{float:right;margin-inline-start:8px;font-size:12px;font-weight:400}.fc-policy-body{padding:0 16px 16px}
.fc-settings input:is([type=number],[type=text]){box-sizing:border-box;min-width:0;max-width:100%;width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit}.fc-settings input:disabled{opacity:.55;cursor:default}.fc-settings-help{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}.fc-settings input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.fc-settings-footer{position:sticky;bottom:0;padding:12px 0;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l1)}
@media(max-width:600px){.fc-policy-group>summary>span:last-child{float:none;display:block;margin:4px 0 0}}
`;
