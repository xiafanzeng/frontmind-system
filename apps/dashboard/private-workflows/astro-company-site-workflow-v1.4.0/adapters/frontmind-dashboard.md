# FrontMind Dashboard Adapter 1.4.0

## 1. Hero-only visual preparation

Dashboard reads an immutable knowledge snapshot, produces SiteBrief and calls
21st directly through the advertised `search` tool. The normal path never calls
`get_component`. Dashboard independently classifies catalog results and only
Hero-eligible normalized previews may appear in the customer A–I board.
Section and motion results remain hidden supporting references. Dashboard never
requests, copies or executes 21st component code.

## 2. Customer choice

A click or explicit delegation freezes one Hero reference. Dashboard may also
freeze up to two independently mirrored section or motion references. All
previews are references only and never enter the public website as assets.

## 3. Attachment-bound knowledge

Dashboard builds a canonical SiteOpsSourceDossierV1 from the frozen SiteBrief,
customer-visible documents and their source hashes. The dossier is transported
as one or more hash-bound JSON attachments; oversized dossiers split only on
deterministic document boundaries. Task message text contains a short operation
instruction and attachment coordinates, never the complete knowledge payload.

## 4. One AI task, two flat wire phases

Dashboard creates one task with:

1. this manifest-verified workflow ZIP;
2. the dossier manifest and JSON part attachments;
3. the selected normalized Hero preview;
4. zero to two normalized supporting previews.

Phase one returns flat SiteDesignWireV1. Dashboard canonicalizes and strictly
validates route, slot and palette bindings as SiteDesignSpecV1, then creates
BuildContractV2. Dashboard attaches the contract to the same task. Phase two
returns flat PageContentWireV1. Dashboard canonicalizes and strictly validates
it as PageContentSpecV1. Repairs stay in the same task and never create a second
task. The AI task never returns source code or a source archive.

## 5. Trusted host materialization

Dashboard maps allowlisted design enums to the versioned host component
library, writes native Astro source, builds in a clean environment and runs
static, Playwright, axe and Lighthouse QA. Private preview remains noindex.
Production materialization adds the exact approved canonical hostname before
ESA and DNS/TLS verification.
