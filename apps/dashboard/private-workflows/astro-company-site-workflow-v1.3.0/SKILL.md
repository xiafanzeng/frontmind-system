---
name: frontmind-astro-company-site-workflow
description: FrontMind Manus adapter for producing strict design, SEO and source-grounded page-content specifications after Dashboard has completed 21st visual selection.
---

# FrontMind Astro Company Site Workflow 1.3.0

This package is attached to one Manus SiteOps task only after Dashboard has
selected and frozen a real visual reference. It does not run 21st, Astro, QA,
ESA, domain purchase, DNS or publication.

## Trust boundary

- Dashboard owns credentials, knowledge snapshots, 21st calls, visual mirrors,
  customer selection, canonical contracts, Astro source, build, QA and release.
- The selected visual is an input reference. It is not a customer website asset
  and its component code, demo code, dependencies and install commands must
  never be copied.
- Dashboard may attach up to two independently frozen section or motion
  previews as supporting references. They are secondary design evidence only,
  are never customer website assets and must not be reproduced.
- Search metadata plus normalized previews are sufficient. `get_component` is
  an optional provider capability and its code is never requested by this
  workflow.
- A 21st Prompt is not required. Use only the safe visual evidence, taxonomy,
  normalized preview attachment and verified knowledge supplied by Dashboard.
- Never return HTML, CSS, JavaScript, Astro files, package manifests, paths,
  dependencies, scripts or executable code.

## Phase one — SiteDesignSpecV1

Return exactly the structured schema requested by Dashboard:

- one allowlisted layout archetype and hero variant;
- density, surface, type scale, image treatment and bounded motion;
- palette indexes only, never invented colors;
- exactly one route composition per supplied route;
- unique stable slot IDs and allowlisted section variants;
- a concise SEO plan grounded in verified company facts.

The design must be usable by the trusted host component library. Natural
language design prose cannot replace the structured fields.

## Phase two — PageContentSpecV1

Dashboard validates phase one, creates BuildContractV2 and sends it back to the
same task. Return exactly one PageContentSpecV1:

- every frozen route exactly once;
- every design slot exactly once and in the same order;
- headings, summaries and paragraphs only;
- sourceDocumentIds for every section;
- no repeated SEO plan and no facts outside the supplied documents.

## Completion

Dashboard maps the two specifications to trusted Astro components, generates
source.zip and dist.zip, then runs static, accessibility, visual and SEO QA.
Repair messages continue this same task at most three times.
