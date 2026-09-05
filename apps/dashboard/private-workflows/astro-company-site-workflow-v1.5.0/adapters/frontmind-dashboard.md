# FrontMind Dashboard Adapter 1.5.0

## 1. Hero-only visual preparation

Dashboard reads an immutable knowledge snapshot, produces SiteBrief and calls
21st directly through the advertised `search` tool. The normal path never calls
`get_component`. Only Hero-eligible normalized previews may appear in the
customer A–I board. Section and motion results remain hidden supporting
references. Dashboard never requests, copies or executes 21st component code.

## 2. Customer choice and attachment-bound knowledge

A click or explicit delegation freezes one Hero reference and up to two
independently mirrored supporting references. Dashboard builds a canonical
SiteOpsSourceDossierV1 from the frozen SiteBrief, customer-visible documents and
source hashes. The dossier travels as one or more hash-bound JSON attachments;
task text contains only the bounded instruction and attachment coordinates.

## 3. One AI task, two Wire V2 phases

Dashboard creates one task with the manifest-verified workflow ZIP, dossier
manifest/parts, selected Hero preview and optional supporting previews.

Phase one must produce SiteDesignWireV2 and the exact attachment
`frontmind-site-design-wire-v2.json`. Dashboard treats `routeSlots` array order
as canonical, rejects legacy `organizationType` and `order` keys, fixes SEO
organization type to `Organization`, and strictly creates SiteDesignSpecV1.

Dashboard attaches BuildContractV2 to the same task. Phase two must produce
PageContentWireV2 and the exact attachment
`frontmind-page-content-wire-v2.json`. Dashboard strictly creates
PageContentSpecV1. Repairs stay in the same task and reuse the phase filename;
they never create a second task. The task never returns source code or an
archive.

## 4. Trusted host materialization

Dashboard maps allowlisted design enums to the versioned host component
library, writes native Astro source, builds in a clean environment and runs
static, Playwright, axe and Lighthouse QA. Private preview remains noindex.
Production materialization adds the exact approved canonical hostname before
ESA and DNS/TLS verification.
