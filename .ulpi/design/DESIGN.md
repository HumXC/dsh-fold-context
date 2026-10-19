# Fold Context message presentation

## Locked design language

Use the existing DSH conversation language: technical, compact, and quiet. The conversation is the primary surface. No separate dashboard, decorative cards, or new visual brand.

- Preserve the native collapsed row, left icon/hover disclosure, inline result placement, icon sizing, and host typography.
- Expanded release content uses text groups and light separators. Never nest cards or allocate one block to each identifier.
- Colors come exclusively from the existing `--dsw-alias-*` theme tokens. Identifiers use the existing monospace treatment.
- Group by exact marking-reason text, preserving original group and item order. Preserve the full reason; long text may disclose on demand.
- Inside a reason group, distinguish released items from pending items. Different pending reasons receive separate compact rows.
- Marking is an intention, not a completed release. Tool receipts must retain accepted/rejected, queued/settled/unknown/unsupported distinctions.
- Identifiers wrap horizontally. Default display occupies at most two rows at the actual available width, with a labelled control to reveal the remaining identifiers.
- Selecting an identifier reveals only that item's existing metadata. Keep at most one item detail open per release view. This is a local view interaction; it does not fetch, restore, release, or rewrite anything.
- Use native buttons with visible focus, accessible names, `aria-expanded`, and `aria-controls`. Hidden identifiers must not remain in the tab sequence. Pure view interactions require no agent tools.
- Search results retain useful previews; recovered text retains its reading layout. Release-specific compactness must not erase information from those surfaces.

Implementation and verification bind to [the release view specification](release-views.md).
