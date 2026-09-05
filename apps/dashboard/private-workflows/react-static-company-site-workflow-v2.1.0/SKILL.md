---
name: frontmind-react-static-company-site-workflow
description: FrontMind AI-building adapter for canonical design and source-grounded page-content results used by Dashboard-owned React static materialization after a verified 21st Hero is selected.
---

# FrontMind React Static Company Site Workflow 2.1.0

This package is attached to one FrontMind AI-building task only after Dashboard
has selected and frozen a real, host-supported Hero reference. It does not run
21st, generate React source, execute QA, operate ESA, purchase domains, change
DNS or publish.

## Trust boundary

- Dashboard owns credentials, knowledge snapshots, 21st search, preview
  mirroring, Hero eligibility, customer selection, reference blueprints,
  canonical contracts, React source, static rendering, QA and release.
- The selected preview is rendered by FrontMind's trusted React host from the
  same SiteBrief. 21st metadata is inspiration evidence only and no provider
  image is attached as a publishable customer website asset.
- 21st is search-only in the normal SiteOps path. Component code, demo code,
  install commands and dependencies are never requested, accepted or reused.
- Verified knowledge is supplied in manifest- and hash-bound JSON attachments.
  Do not ask for the same knowledge in message text and do not invent facts.
- Never return HTML, CSS, JavaScript, JSX, TSX, React files, package manifests,
  paths, dependencies, scripts or executable code.

## Frozen reference blueprint

Dashboard supplies one immutable `ReferenceBlueprintV3` derived from the
selected reference. Its Hero family, alignment, media strategy, background and
motion are binding. Do not replace the selected family with a generic centered
statement. You may choose only bounded presentation options explicitly left
open by Dashboard.

For a `floating_orbit` reference, preserve centered content surrounded by a
host-generated visual orbit. Never copy provider imagery. Dashboard renders
original procedural brand SVG for this family.

## Phase one — SiteDesignWireV3

Read the frozen source dossier and reference blueprint. Return exactly the flat
schema requested by Dashboard and attach the identical JSON value as
`frontmind-site-design-wire-v3.json`:

- choose bounded density, surface, type and palette indexes;
- provide flat `routeSlots` in canonical display order;
- provide a concise site title and description grounded in verified facts.

The wire intentionally has no Hero family or reference-geometry fields.
Dashboard injects the previously frozen blueprint while converting the result
to strict `SiteDesignSpecV2`, so provider output cannot change the selected
family. Do not include arbitrary component names or styling values.

## Phase two — PageContentWireV2

Dashboard validates phase one, creates `BuildContractV3` and attaches it to
this same task. Return exactly one PageContentWireV2 and attach the identical
JSON value as `frontmind-page-content-wire-v2.json`:

- every frozen route exactly once in `routes`;
- every design slot exactly once in `sections`;
- headings, summaries and paragraphs only;
- sourceDocumentIds for every section;
- no repeated SEO plan and no facts outside the supplied dossier.

Dashboard strictly validates the result. Repair messages continue this same
task at most three times. Do not return arbitrary prose in place of JSON.

## Trusted host materialization

Dashboard serializes the validated specifications, frozen reference blueprint
and public-asset projection as host-owned JSON. Customer and provider text is
never interpolated into source. Versioned, host-owned React components read the
data and render allowlisted Hero and section families at build time with
`renderToStaticMarkup`.

Every route becomes a complete HTML document. There is no client-side React
root, hydration, runtime fetch or required JavaScript. Dashboard owns the
package, lockfile, build scripts, components, CSS and original procedural SVG.
The provider owns none of the generated website source.

## Completion

Dashboard creates a complete trusted React project in source.zip, a pure-static
dist.zip, QA and provenance. Private preview remains noindex. Only a QA-passed, automatically approved build may be re-materialized for its exact canonical hostname
and proceed to ESA and DNS/TLS.
