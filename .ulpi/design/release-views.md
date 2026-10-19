# Release views

Binds to [DESIGN.md](./DESIGN.md). User approved the comparison on 2026-10-18; implementation follows baseline commit `2c455ce`.

## Surface and scope

Keep the existing `tool.call.toolview` seats and `conversation.chat.node` release node. Extend recovery metadata with the recorded release reason requested after the original comparison. Host release reports, numbering, persistence, scheduling, release transactions and installed runtime remain outside this change.

## Marking receipt

- Rename the short title to `标记释放` / `Mark context for release`.
- Show the marking reason once, then compact identifier rows for queued, settled, unknown, and unsupported outcomes. Do not repeat result fields already in the heading.
- A refused request remains refused. Preparing, running, error and unrecognized-payload fallback behavior stay intact.
- Receipt arrays contain identifiers only: render plain selectable identifiers, with no invented per-item tool, preview or metadata.

## Actual release report

- Group released and pending records together by their exact marking reason (including one group for a missing reason), in order of first appearance.
- Within each group show released items in one compact row, then pending items grouped by their pending-reason code. Marking reason is never repeated in the item detail.
- Click a report identifier to toggle its local metadata (source/tool, existing preview, attachment owner, pending reason). Only one item detail may be open in the view. No implicit data read or recovery.
- Keep the existing whole-operation token estimate and archive note. Do not estimate per-group savings.

## Recovered evidence

- Show the recorded `releaseReason` above recovered text and attachments, labelled `释放原因` / `Release reason`, with the same exact-text long-reason disclosure.
- Read only confirmed release provenance from the existing ledger. Attachments prefer their own reason, then the confirmed released owner's reason. Omit the field when no historical reason exists.
- Keep recovery failure `reason` independent. Preserve original content, paging, restored-surface behavior and search response shape.

## Responsive disclosure

- Identifiers wrap, remaining selectable and individually addressable. Render at most two rows by default, measured against actual available width; a labelled button shows the remaining count and reveals all identifiers. Reflow on resize. Hidden items are absent from the tab sequence.
- Long reasons preserve full text with local disclosure. No semantic rewriting or reason similarity matching.
- Every disclosure has a meaningful accessible name, expanded state, controlled element id, keyboard behavior and visible focus. No hover-only information.
- Use existing theme tokens, typography and native collapsed-row styling; light separators replace the bordered nested release panel.

## Test acceptance

Exercise real mounted slot components in both languages: repeated and missing reasons, mixed released/pending outcomes, distinct pending reasons, unknown and unsupported ids, refused and malformed receipts, more than 128 ids, narrow/wide resize, expand/collapse completeness, single active item, long reason disclosure, release-reason recovery provenance and independent failure explanations. Search and original recovery content retain their existing behavior. DOM mocks must implement the real hook/ref lifecycle used by the component. No test-only production fallbacks.

## Engineering handoff

Implementation agent owns only `src/client-release.js`, the integration portions of `src/client.js`, and `scripts/build-client.mjs`. Lead owns tests and documentation. No commit, deployment, runtime relink, service action, or Harness source edit by the implementation agent.
