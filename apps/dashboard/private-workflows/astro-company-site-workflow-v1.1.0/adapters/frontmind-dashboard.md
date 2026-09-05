# FrontMind Dashboard Adapter

The adapter is executed by the Dashboard SiteOps worker, not by a browser and
not by a customer's generated website.

## Stage 1 — host preparation

1. Resolve and verify the immutable `knowledgeSnapshotId` and archive SHA.
2. Produce a source-linked SiteBrief and ask only for material unknowns in the
   server-owned SiteOps conversation.
3. Resolve the pinned `site_builder_21st` credential in memory.
4. Call the fixed MCP endpoint `https://21st.dev/api/mcp` with `x-api-key`.
   Require `search` and `get_component`; use neither code returned by those
   tools nor any mutation/generation capability.
5. Normalize with the shared TypeScript workflow and persist only its safe
   projection. Download previews through the server's bounded SSRF-safe asset
   importer and serve them from an authenticated same-origin URL.

## Stage 2 — one user choice

Write one `visual_board` action card containing one to nine real A-I options.
The server validates the active message, project revision, candidate ID, and
selection revision. Continue only after a click or an explicit delegation
action. Free text never counts as a visual selection, publish approval, paid
domain consent, DNS authorization, or rollback instruction.

## Stage 3 — same remote task

Create one remote Manus task with the safe run envelope, verified SiteBrief,
same-origin selected preview, and this package. Request only the strict design
system and SEO manifest first. Validate both. Reacquire the exact selected
Prompt transiently, compare its SHA, compose the canonical build contract in
Dashboard, discard the Prompt, and send the contract to that same task.

The returned source archive is untrusted. Extract into the build-ID work root,
reject traversal/symlinks/collisions, overlay only allowlisted content paths on
the trusted starter, build with the image-pinned toolchain and a clean
environment, and write artifacts only through the immutable local asset store.

## Stage 4 — QA and preview

Run native Astro/static/SEO checks, then loopback-only Playwright, axe, and
Lighthouse checks at 390, 768, and 1440 widths. Serve successful output through
the authenticated Dashboard preview route. The customer may approve or send
revision feedback. Feedback creates an immutable child build and continues the
same selected Foundation unless the customer explicitly requests a new visual
search.
