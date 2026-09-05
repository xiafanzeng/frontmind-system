---
name: frontmind-astro-company-site-workflow
description: FrontMind AI-building adapter for producing canonical-order design and source-grounded page-content wire results for Dashboard-owned JSON-data and Astro-template materialization after a verified 21st Hero is selected.
---

# FrontMind Astro Company Site Workflow 1.6.0

This package is attached to one FrontMind AI-building task only after Dashboard
has selected and frozen a real Hero reference. It does not run 21st, generate
Astro source, execute QA, operate ESA, purchase domains, change DNS or publish.

## Trust boundary

- Dashboard owns credentials, knowledge snapshots, 21st search, preview
  mirroring, Hero eligibility, customer selection, canonical contracts, Astro
  source, build, QA and release.
- The selected Hero and up to two section or motion previews are design
  references only. They are not customer website assets and must not be copied
  into the generated site.
- 21st is search-only in the normal SiteOps path. Component code, demo code,
  install commands and dependencies are never requested, accepted or reused.
- Verified knowledge is supplied in manifest- and hash-bound JSON attachments.
  Do not ask for the same knowledge in message text and do not invent facts.
- Never return HTML, CSS, JavaScript, Astro files, package manifests, paths,
  dependencies, scripts or executable code.
- Asset decisions are keyed by immutable asset ID. Two IDs may point to the
  same SHA-256 and may independently be `publish` and `omit`; the omitted alias
  does not suppress the exact published brand asset. A quarantined SHA-256 can
  never be emitted.

## Phase one — SiteDesignWireV2

Read the frozen source dossier and selected Hero reference. Return exactly the
flat schema requested by Dashboard and attach the identical JSON value as
`frontmind-site-design-wire-v2.json`:

- one allowlisted layout archetype and Hero variant;
- density, surface, type scale, image treatment and bounded motion;
- palette indexes only, never invented colors;
- flat `routeSlots` in canonical display order: route groups follow the frozen
  SiteBrief route order and entries inside each group are the section order;
- a concise site title and SEO description grounded in verified company facts.

Do not include `organizationType` or an `order` field. Array order is the only
route-slot ordering coordinate. The wire result is not the canonical design
contract. Dashboard strictly validates it and fixes SEO organization type to
`Organization` while producing SiteDesignSpecV1.

## Phase two — PageContentWireV2

Dashboard validates phase one, creates BuildContractV2 and attaches that
contract to this same task. Return exactly one flat PageContentWireV2 and attach
the identical JSON value as `frontmind-page-content-wire-v2.json`:

- every frozen route exactly once in `routes`;
- every design slot exactly once in `sections`;
- headings, summaries and paragraphs only;
- sourceDocumentIds for every section;
- no repeated SEO plan and no facts outside the supplied dossier.

Dashboard strictly validates the result as PageContentSpecV1. Repair messages
continue this same task at most three times and use the same exact phase output
filename. Do not return arbitrary prose in place of either JSON contract.

## Trusted host materialization

Dashboard serializes the validated canonical specifications and frozen public
asset projection as host-owned JSON data. Customer and provider text is never
interpolated into Astro source. Versioned, host-owned Astro templates read that
data and render the allowlisted layout, Hero and section variants.

Dashboard derives semantic `canvas`, `ink`, `accent` and `muted` roles from the
selected palette. It verifies text/background contrast for each semantic use
and applies deterministic host fallbacks when the requested indexes cannot
form an accessible pair. The provider does not choose final CSS colors.

Materialization failures retain one typed host phase and retry class from the
versioned materialization-stage schema. Content repair is only valid for a
content-owned contract failure; deterministic host failures are never sent
back to the AI task as content repairs.

## Completion

Dashboard maps the two canonical specifications to trusted JSON data and Astro
templates, generates source.zip and dist.zip, and runs static, accessibility,
visual and SEO QA. Only a customer-approved build may proceed to ESA and
DNS/TLS.
