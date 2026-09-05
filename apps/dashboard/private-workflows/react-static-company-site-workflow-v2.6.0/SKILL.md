---
name: frontmind-react-static-company-site-workflow
description: FrontMind single-stage, source-grounded content-patch workflow for Dashboard-owned immutable static website baselines, rendering and QA.
---

# FrontMind React Static Company Site Workflow 2.6.0

This package is attached to one new FrontMind SiteOps root build after the
knowledge snapshot, SiteBrief and one visual reference are frozen. The AI task
has one responsibility: fill the source-bound slots in an immutable baseline.
Dashboard owns every coordinate that decides what the website is or how it renders.

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

## Single output — SiteContentPatchWireV1

Return exactly one JSON object matching the flat transport in
`schemas/site-content-patch-wire-v1.schema.json`, and attach the identical
object as `frontmind-site-content-patch-v1.json`. Dashboard projects this
bounded transport into the nested host-only `SiteContentPatchV1` before
applying values to the immutable baseline.

`slots` is a flat array. Each item contains only routeId, slotId, the frozen
kind (`richText` or `list`), one matching value field and `sourceIds`. Use only
route, slot, kind and source coordinates present in the attached slot manifest.
Use null or empty arrays for uncertain values. Partial output is valid because
Dashboard keeps the trusted default for every missing or invalid slot. This
flat shape is required by the provider's bounded structured-output depth and
does not grant access to host layout or executable source.

The exact `operationToken` and `baseSourceSha256` supplied by Dashboard are
mandatory. They bind the patch to this one task and immutable baseline. Do not
echo them anywhere except the JSON fields.

If the inventory lacks `company_news`, do not invent news. Dashboard creates
the fixed legal empty state. Do not create routes, slugs, SEO coordinates,
FAQs, entities, links or contact details outside the supplied sources.

## Trusted host completion

Dashboard deterministically creates `SiteDesignResultV2` from the frozen
SiteBrief, reference blueprint and taxonomy. It canonicalizes this deliberately
bounded patch into `CanonicalPreviewModelV1`, ignores invalid slots
individually, keeps defaults from verified knowledge, escapes text and renders
host-owned React static components. If the primary renderer cannot build,
Dashboard may emit a fixed, no-JavaScript trusted fallback. Provider output
never becomes source.

Accessibility and performance findings are packaged as preview warnings unless
they indicate an actual safety, binding or artifact-integrity failure. Preview
and release policy remain wholly owned by Dashboard.

## Completion

Return the JSON patch once. Do not run design or repair phases, request a
second task, generate a website archive, operate ESA, change DNS or publish.
