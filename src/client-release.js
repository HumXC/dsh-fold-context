// Injected into the Client factory by build-client.mjs; uses its React singleton and helpers.
function groupReleaseItems(report) {
    const groups = new Map();
    for (const status of ["released", "pending"]) {
        for (const item of list(report?.[status])) {
            if (!object(item)) continue;
            const reason = typeof item.reason === "string" && item.reason.trim() ? item.reason : "";
            if (!groups.has(reason)) groups.set(reason, { reason, rows: [] });
            const group = groups.get(reason);
            const pendingReason = status === "pending" ? text(item.pendingReason) : "";
            let row = group.rows.find(
                (candidate) =>
                    candidate.status === status && candidate.pendingReason === pendingReason,
            );
            if (!row) {
                row = { status, pendingReason, items: [] };
                group.rows.push(row);
            }
            row.items.push(item);
        }
    }
    return [...groups.values()];
}

function releaseRowLimit(width, itemWidth, count) {
    if (!Number.isFinite(width) || !Number.isFinite(itemWidth) || !(width > 0) || !(itemWidth > 0))
        return Math.min(count, 2);
    return Math.min(count, Math.max(1, Math.floor((width + 8) / (itemWidth + 8))) * 2);
}

function observeReleaseLayout(element, measure, otherElements = []) {
    const view = element.ownerDocument.defaultView;
    const fonts = element.ownerDocument.fonts;
    let active = true;
    const update = () => {
        if (active) measure();
    };
    const observer =
        typeof view.ResizeObserver === "function" ? new view.ResizeObserver(update) : null;
    observer?.observe(element);
    for (const other of otherElements) if (other) observer?.observe(other);
    view.addEventListener("resize", update);
    fonts?.addEventListener("loadingdone", update);
    fonts?.ready.then(update);
    update();
    return () => {
        active = false;
        observer?.disconnect();
        view.removeEventListener("resize", update);
        fonts?.removeEventListener("loadingdone", update);
    };
}

function ReleaseReason({ reason, t }) {
    const [expanded, setExpanded] = React.useState(false);
    const [overflow, setOverflow] = React.useState(false);
    const ref = React.useRef(null);
    const id = React.useId();
    React.useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        setExpanded(false);
        return observeReleaseLayout(element, () => {
            const lineHeight = parseFloat(
                element.ownerDocument.defaultView.getComputedStyle(element).lineHeight,
            );
            if (lineHeight > 0) setOverflow(element.scrollHeight > lineHeight * 2 + 1);
        });
    }, [reason]);
    return h(
        "div",
        { className: "fc-release-reason" },
        h(
            "p",
            { id, ref, className: expanded ? "" : "fc-release-clamp" },
            reason || t("missingMarkReason"),
        ),
        overflow
            ? h(
                  "button",
                  {
                      type: "button",
                      className: "fc-text-action",
                      "aria-expanded": expanded,
                      "aria-controls": id,
                      onClick: () => setExpanded((value) => !value),
                  },
                  t(expanded ? "collapseReason" : "expandReason"),
              )
            : null,
    );
}

function ReleaseItemDetail({ item, status, pendingReason, t, id, close }) {
    const fields = [
        ["targets", displayId(item.id)],
        ["result", t(status)],
        ["source", text(item.tool) || (text(item.kind) ? t(item.kind) : "")],
        ["attachmentOwner", item.ownerId ? displayId(item.ownerId) : ""],
        ["waitingReason", pendingReason ? t(pendingReason) : ""],
    ].filter(([, value]) => value);
    const preview = text(item.preview) || text(item.snippet);
    return h(
        "div",
        {
            id,
            className: "fc-release-detail",
            role: "region",
            "aria-label": `${t("itemDetails")} ${displayId(item.id)}`,
            onKeyDown: (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                }
            },
        },
        h(
            "dl",
            null,
            ...fields.flatMap(([key, value]) => [
                h("dt", { key: `${key}-label` }, t(key)),
                h("dd", { key }, value),
            ]),
        ),
        preview ? h("p", { className: "fc-preview" }, preview) : null,
        h(
            "button",
            { type: "button", className: "fc-text-action", onClick: close },
            t("closeDetails"),
        ),
    );
}

function CompactReleaseIds({
    items,
    label,
    t,
    active,
    select,
    detailId,
    status,
    pendingReason,
    scope,
}) {
    const [expanded, setExpanded] = React.useState(false);
    const [limit, setLimit] = React.useState(2);
    const rowRef = React.useRef(null);
    const flowRef = React.useRef(null);
    const moreRef = React.useRef(null);
    const buttonRefs = React.useRef(new Map());
    const focusMore = React.useRef(false);
    const latest = React.useRef(null);
    const id = React.useId();
    const itemId = (item) => displayId(typeof item === "string" ? item : item.id);
    const itemKey = (item, index) => JSON.stringify([scope, itemId(item), index]);
    const digits = items.reduce((max, item) => Math.max(max, itemId(item).length), 1);
    const firstIdentifier = items.length ? itemId(items[0]) : "";
    const selectedIndex = select
        ? items.findIndex((item, index) => itemKey(item, index) === active)
        : -1;
    const visible = expanded ? items : items.slice(0, limit);
    latest.current = { expanded, selectedIndex };
    React.useLayoutEffect(() => {
        const element = flowRef.current;
        if (!element) return;
        return observeReleaseLayout(element, () => {
            const nextLimit = releaseRowLimit(
                Math.min(element.clientWidth, element.getBoundingClientRect().width),
                element.firstElementChild?.getBoundingClientRect().width,
                items.length,
            );
            const focused = element.ownerDocument.activeElement;
            const focusedIndex =
                focused?.parentElement === element
                    ? Number(focused.getAttribute("data-release-index"))
                    : -1;
            const current = latest.current;
            if (
                !current.expanded &&
                (focusedIndex >= nextLimit ||
                    (current.selectedIndex >= nextLimit && rowRef.current.contains(focused)))
            )
                focusMore.current = true;
            setLimit(nextLimit);
        }, [element.firstElementChild]);
    }, [items.length, digits, firstIdentifier]);
    React.useLayoutEffect(() => {
        if (focusMore.current) {
            moreRef.current?.focus();
            focusMore.current = false;
        }
        if (selectedIndex >= 0 && selectedIndex >= visible.length) select(null);
    }, [active, limit, expanded, selectedIndex]);
    const close = () => {
        buttonRefs.current.get(active)?.focus();
        select(null);
    };
    return h(
        "div",
        { ref: rowRef, className: "fc-release-row", "data-release-status": status },
        h("div", { className: "fc-release-label" }, `${label} · ${items.length}`),
        h(
            "div",
            { className: "fc-release-identifiers" },
            h(
                "div",
                {
                    id,
                    ref: flowRef,
                    className: "fc-release-flow",
                    "data-release-ids": true,
                    style: { "--fc-release-id-width": `calc(${digits}ch + 0.75rem)` },
                },
                ...visible.map((item, index) => {
                    const identifier = itemId(item);
                    const key = itemKey(item, index);
                    return select
                        ? h(
                              "button",
                              {
                                  key,
                                  ref: (element) => {
                                      if (element) buttonRefs.current.set(key, element);
                                      else buttonRefs.current.delete(key);
                                  },
                                  type: "button",
                                  className: "fc-release-id",
                                  "data-release-id": identifier,
                                  "data-release-index": index,
                                  "aria-label": `${t("itemDetails")} ${identifier}`,
                                  "aria-expanded": active === key,
                                  "aria-controls": detailId,
                                  onClick: () => select(active === key ? null : key),
                              },
                              identifier,
                          )
                        : h(
                              "span",
                              { key, className: "fc-release-id", "data-release-id": identifier },
                              identifier,
                          );
                }),
            ),
            items.length > limit
                ? h(
                      "button",
                      {
                          ref: moreRef,
                          type: "button",
                          className: "fc-text-action",
                          "aria-label": `${label}: ${t(expanded ? "collapseIds" : "moreIds").replace("{count}", String(items.length - limit))}`,
                          "aria-expanded": expanded,
                          "aria-controls": id,
                          onClick: () => {
                              setExpanded((value) => !value);
                              if (expanded && selectedIndex >= limit) select(null);
                          },
                      },
                      expanded
                          ? t("collapseIds")
                          : t("moreIds").replace("{count}", String(items.length - limit)),
                  )
                : null,
        ),
        selectedIndex >= 0 && selectedIndex < visible.length
            ? h(ReleaseItemDetail, {
                  item: items[selectedIndex],
                  status,
                  pendingReason,
                  t,
                  id: detailId,
                  close,
              })
            : null,
    );
}

function ReleaseRequestDetails({ model, t }) {
    return h(
        "div",
        { className: "fc-release-content" },
        model.args.reason ? h(ReleaseReason, { reason: model.args.reason, t }) : null,
        ...[
            ["queued", "pending"],
            ["settled", "settled"],
            ["unknown", "unknown"],
            ["unsupported", "unsupported"],
        ].map(([key, label]) =>
            model.value[key].length
                ? h(CompactReleaseIds, {
                      key,
                      t,
                      label: t(label),
                      status: key,
                      items: model.value[key],
                  })
                : null,
        ),
    );
}

function ReleaseReportDetails({ report, t }) {
    const [active, select] = React.useState(null);
    const detailId = React.useId();
    return h(
        "div",
        { className: "fc-release-content" },
        ...groupReleaseItems(report).map((group, index) =>
            h(
                "section",
                {
                    key: JSON.stringify(["reason", group.reason]),
                    className: "fc-release-group",
                    "data-release-group": index,
                },
                h(ReleaseReason, { reason: group.reason, t }),
                ...group.rows.map((row) =>
                    h(CompactReleaseIds, {
                        key: JSON.stringify([row.status, row.pendingReason]),
                        scope: JSON.stringify([group.reason, row.status, row.pendingReason]),
                        items: row.items,
                        status: row.status,
                        pendingReason: row.pendingReason,
                        label: row.pendingReason
                            ? `${t(row.status)} · ${t(row.pendingReason)}`
                            : t(row.status),
                        t,
                        active,
                        select,
                        detailId,
                    }),
                ),
            ),
        ),
        h("p", { className: "fc-note" }, t("retained")),
    );
}

const releaseCss = `
.fc-card.fc-release-card .fc-body{border:0;border-radius:0;background:none;padding:0 0 0 12px;border-left:1px solid var(--dsw-alias-border-l1)}
.fc-release-group{padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}.fc-release-group:first-child{padding-top:0;border-top:0}
.fc-release-reason{margin:0 0 8px}.fc-release-reason p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.fc-release-clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.fc-release-row{display:grid;grid-template-columns:fit-content(40%) minmax(0,1fr);gap:4px 12px;align-items:start;margin:5px 0}.fc-release-label{min-width:0;overflow-wrap:anywhere;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.fc-release-identifiers{min-width:0}.fc-release-flow{display:flex;flex-wrap:wrap;gap:4px 8px;min-width:0}
.fc-release-id{box-sizing:border-box;display:inline-block;flex:none;width:var(--fc-release-id-width);max-width:100%;min-width:0;border:0;border-radius:3px;background:none;color:inherit;padding:0 .375rem;font-family:ui-monospace,monospace;font-size:inherit;line-height:calc(24px + var(--dsh-content-font-delta,0px));text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text}
button.fc-release-id{cursor:pointer}button.fc-release-id:hover,button.fc-release-id[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.fc-text-action{border:0;background:none;padding:2px 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.fc-text-action:hover{color:var(--dsw-alias-label-primary)}
.fc-release-id:focus-visible,.fc-text-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fc-release-detail{grid-column:1/-1;margin:2px 0 4px;padding:6px 0;color:var(--dsw-alias-label-secondary);font-size:12px}.fc-release-detail dl{margin:0;gap:3px 12px}.fc-release-detail .fc-preview{color:var(--dsw-alias-label-primary)}
@media(max-width:480px){.fc-release-row{grid-template-columns:minmax(0,1fr);gap:0}.fc-card.fc-release-card .fc-body{margin-left:16px;padding-left:8px}}
`;
