# Dashboard-owned final-package compatibility

This reference describes content invariants only. The v5 Manus task never
creates the final customer archive. Dashboard creates that archive locally
after every materialized node has been confirmed.

## Customer-visible node content

- Every leaf body is non-empty Markdown bound to one stable leaf ID and starts
  with exactly `# {leaf.title}`, followed by a non-empty body.
- Store only polished customer-visible content in `nodes/*.md` and Patch node
  bodies. Do not add formal markers, metadata sections, evidence appendices,
  internal keys, IDs, paths or character counts.
- Keep source inventory, excerpts, conflicts and internal verification notes
  in declared evidence files, linked through `evidenceLedger/evidencePaths`.
- Do not place expiring Provider URLs, task IDs, file IDs, operation markers or
  internal workflow instructions in customer-visible text.

## Stable business structure

The Working Set must retain the business information needed by the existing
Dashboard finalizer: branch/leaf identity and ordering, complete Markdown,
evidence provenance, Logo state and safe image assets. It must not emit a
customer package manifest, provider finalization input or a second ZIP.

Dashboard remains authoritative for the established customer-package schema,
viewer, manifest, SHA-256 readback and publication validation. A v5 task must
not rename, reinterpret or synthesize those downstream fields.

## Assets

- The official Logo is a single safe raster with exact hash, dimensions and
  first-party provenance, or an explicit missing state.
- Customer node images retain exact upload provenance and bind only to their
  declared leaf IDs.
- Every referenced asset exists in the Working Set and every packaged asset is
  declared. Active content, SVG, symlinks and placeholders are forbidden.
