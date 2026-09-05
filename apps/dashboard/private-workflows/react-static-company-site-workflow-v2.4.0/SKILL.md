---
name: frontmind-react-static-company-site-workflow
description: FrontMind single-stage, source-grounded content-draft workflow for Dashboard-owned static website design, canonicalization, rendering and QA.
---

# FrontMind React Static Company Site Workflow 2.4.0

This package is attached to one new FrontMind SiteOps root build after the
knowledge snapshot, SiteBrief and one visual reference are frozen. The AI task
has one responsibility: return a lossy, source-bound content draft. Dashboard
owns every coordinate that decides what the website is or how it renders.

## Trust boundary

- Dashboard owns credentials, routes, paths, route order, slots, component
  variants, responsive layout, palette, typography, assets, static source,
  rendering, QA, artifact persistence, preview, publishing and reset.
- The selected `ReferenceBlueprintV4` and safe visual taxonomy are immutable
  host input. They are not fields the provider may return or change.
- Knowledge arrives only through manifest-verified source-dossier attachments.
  Do not browse, infer missing company facts or invent content.
- Never return HTML, CSS, JavaScript, JSX, TSX, component names, file paths,
  dependencies, scripts, external resource URLs, colours or layout values.
- Never copy the selected provider reference image into public content. It is
  non-publishable inspiration evidence.

## Single output — SiteContentDraftV1

Return exactly one JSON object matching the flat transport in
`schemas/site-content-draft-v1.schema.json`, and attach the identical object as
`frontmind-site-content-draft-v1.json`. Dashboard projects this transport into
the nested host-only `SiteContentDraftV1` before canonicalization.

`routes` contains only routeId, heading and summary. `sections` is a separate
flat array; each section contains routeId, heading, paragraphs, bullets and
`sourceIds`. Use only route ids and source ids present in the frozen dossier.
Use null or empty arrays for uncertain fields. Partial output is valid because
Dashboard completes every missing route from verified frozen knowledge. This
flat shape is required by the provider's bounded structured-output depth and
does not give the provider any host layout coordinate.

The exact `operationToken` supplied by Dashboard is mandatory. It binds the
draft to this one task. Do not echo it anywhere except the JSON field.

If the inventory lacks `company_news`, do not invent news. Dashboard creates
the fixed legal empty state. Do not create routes, slugs, SEO coordinates,
FAQs, entities, links or contact details outside the supplied sources.

## Trusted host completion

Dashboard deterministically creates `SiteDesignResultV2` from the frozen
SiteBrief, reference blueprint and taxonomy. It canonicalizes this deliberately
lossy draft into `CanonicalPreviewModelV1`, drops unsafe fields individually,
fills gaps from verified knowledge, escapes text and renders host-owned React
static components. If the primary renderer cannot build, Dashboard may emit a
fixed, no-JavaScript trusted fallback. Provider output never becomes source.

Accessibility and performance findings are packaged as preview warnings unless
they indicate an actual safety, binding or artifact-integrity failure. Preview
and release policy remain wholly owned by Dashboard.

## Completion

Return the JSON draft once. Do not run design or repair phases, request a
second task, generate a website archive, operate ESA, change DNS or publish.
