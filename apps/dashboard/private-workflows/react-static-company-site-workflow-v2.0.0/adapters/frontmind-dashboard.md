# FrontMind Dashboard Adapter 2.0.0

## 1. Hero reference and blueprint

Dashboard calls 21st through search only, mirrors eligible Hero previews and
maps each candidate to one trusted component family. The selected family is
frozen in ReferenceBlueprintV2. Unsupported references never enter the board.
Provider code and imagery are never installed, copied or published.

## 2. One AI task, two bounded phases

Dashboard creates one customer-owned AI task with this manifest-verified
workflow, source dossier parts, selected Hero preview and optional supporting
previews. Phase one emits SiteDesignWireV3 without any Hero-family fields.
Dashboard injects the frozen ReferenceBlueprintV2 and creates strict
SiteDesignSpecV2 plus a pre-materialization BuildPlanContractV3. Phase two on
the same task emits PageContentWireV2. Repairs reuse that task. After source
and dist exist, Dashboard creates the final non-null BuildContractV3 hashes.

## 3. React static materialization

Dashboard writes validated design, content, reference blueprint and public
assets to canonical JSON. A host-owned React 19 component library renders each
route with react-dom/server. The materializer emits complete HTML documents,
CSS and approved assets. It emits no client bundle, hydration, runtime fetch or
external script.

The trusted component library implements independent DOM structures for its
Hero and section families. `floating_orbit` includes centered content plus an
original host-generated DNA, molecule, cell and time-track SVG composition. It
never copies the selected provider preview.

## 4. Build, QA and release

Dashboard stores a complete trusted React project in source.zip and pure-static
documents in dist.zip. QA verifies route HTML, disabled-JavaScript readability,
the selected family/component-manifest match, three viewports, accessibility,
SEO and content provenance. Private preview remains noindex and omits canonical,
sitemap and llms.txt. Production materialization adds the exact approved
hostname before ESA and DNS/TLS verification.

Historical Astro artifacts and their versioned materializers remain immutable.
New builds and child builds use this React Static 2.0 contract.
