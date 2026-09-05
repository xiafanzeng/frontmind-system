---
name: frontmind-astro-company-site-workflow
description: FrontMind AI-building adapter for producing flat design and source-grounded page-content wire results after Dashboard has selected a verified 21st Hero reference.
---

# FrontMind Astro Company Site Workflow 1.4.0

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

## Phase one — SiteDesignWireV1

Read the frozen source dossier and the selected Hero reference, then return
exactly the flat schema requested by Dashboard:

- one allowlisted layout archetype and Hero variant;
- density, surface, type scale, image treatment and bounded motion;
- palette indexes only, never invented colors;
- one flat `routeSlots` entry per requested route slot;
- a concise SEO plan grounded in verified company facts.

The wire result is not the canonical design contract. Dashboard groups and
strictly validates it as SiteDesignSpecV1 before materialization.

## Phase two — PageContentWireV1

Dashboard validates phase one, creates BuildContractV2 and attaches that
contract to this same task. Return exactly one flat PageContentWireV1:

- every frozen route exactly once in `routes`;
- every design slot exactly once in `sections`;
- headings, summaries and paragraphs only;
- sourceDocumentIds for every section;
- no repeated SEO plan and no facts outside the supplied dossier.

Dashboard groups and strictly validates the wire result as PageContentSpecV1.
Repair messages continue this same task at most three times.

## Completion

Dashboard maps the two canonical specifications to trusted Astro components,
generates source.zip and dist.zip, and runs static, accessibility, visual and
SEO QA. Only a customer-approved build may proceed to ESA and DNS/TLS.
