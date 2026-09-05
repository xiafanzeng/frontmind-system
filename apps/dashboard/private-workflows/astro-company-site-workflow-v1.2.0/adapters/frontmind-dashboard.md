# FrontMind Dashboard Adapter 1.2.0

## 1. Dashboard visual preparation

Dashboard reads an immutable knowledge snapshot, produces SiteBrief, calls
21st directly and mirrors safe HTTPS previews. Manus is not created during this
stage. Valid catalog metadata plus a safe preview is sufficient; an upstream
Prompt is not required.

## 2. Customer choice

Dashboard displays up to nine real candidates. A click or explicit delegation
freezes the selected evidence and creates one SiteOps build operation.

## 3. One Manus task, two structured phases

Dashboard creates one task with:

1. this manifest-verified workflow ZIP;
2. the selected normalized preview;
3. SiteBrief, safe taxonomy and verified public documents.

The 1.2 producer does not emit supporting previews; its frozen support evidence
list is therefore exactly empty rather than inferred from optional metadata.

Manus returns SiteDesignSpecV1. Dashboard validates route, slot and palette
bindings and creates BuildContractV2. Dashboard sends that contract back to the
same task. Manus then returns PageContentSpecV1 with exact route and slot
bindings. Manus never returns source code or a source archive.

## 4. Trusted host materialization

Dashboard maps allowlisted design enums to the versioned host component
library, writes native Astro source, builds in a clean environment and runs
static, Playwright, axe and Lighthouse QA. Private preview remains noindex.
Production materialization adds the exact approved canonical hostname before
ESA and DNS/TLS verification.
