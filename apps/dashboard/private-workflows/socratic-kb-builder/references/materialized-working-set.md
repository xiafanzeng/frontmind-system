# Materialized working-set contract

## Initial bundle

Return `frontmind-kb-bundle-<operationId>.zip` with `BUNDLE.json` at the root.
Extra top-level fields are forbidden.

```json
{
  "kind": "frontmind.kb-working-set",
  "schemaVersion": 1,
  "operationId": "operation-coordinate-from-input",
  "buildId": "uuid-from-input",
  "generation": 1,
  "contentVersion": 1,
  "skill": {
    "name": "socratic-kb-builder",
    "version": "5",
    "contentHash": "64-lowercase-hex"
  },
  "treePolicyVersion": 2,
  "company": { "name": "Example", "website": "https://example.com" },
  "researchCoverage": {
    "officialPages": {
      "discovered": 18,
      "attempted": 16,
      "succeeded": 14,
      "failed": 2
    },
    "publicQueries": 6,
    "officialDocuments": 4,
    "uploadsRead": 2,
    "sourceCount": 1,
    "productFamilies": [
      { "id": "primary-service", "name": "核心服务", "leafIds": ["1.1"] }
    ],
    "dimensions": [
      { "id": "enterprise_identity", "status": "covered", "leafIds": ["1.1"] },
      {
        "id": "team_and_organization",
        "status": "covered",
        "leafIds": ["1.1"]
      },
      {
        "id": "products_and_services",
        "status": "covered",
        "leafIds": ["1.1"]
      },
      {
        "id": "capabilities_and_delivery",
        "status": "covered",
        "leafIds": ["1.1"]
      },
      {
        "id": "industries_scenarios_and_cases",
        "status": "covered",
        "leafIds": ["1.1"]
      },
      {
        "id": "differentiation_and_evidence",
        "status": "covered",
        "leafIds": ["1.1"]
      },
      {
        "id": "cooperation_delivery_and_support",
        "status": "covered",
        "leafIds": ["1.1"]
      }
    ],
    "stopReason": "coverage_complete"
  },
  "branches": [{ "branchId": "identity", "title": "企业身份", "ordinal": 0 }],
  "evidenceLedger": [
    {
      "path": "evidence/1.1/source.md",
      "sha256": "64-lowercase-hex",
      "leafId": "1.1",
      "sourceUrl": "https://example.com/",
      "retrievedAt": "2026-08-14T00:00:00.000Z"
    }
  ],
  "leaves": [
    {
      "leafId": "1.1",
      "branchId": "identity",
      "branchTitle": "企业身份",
      "title": "企业概况",
      "ordinal": 0,
      "contentPath": "nodes/0001.md",
      "contentSha256": "64-lowercase-hex",
      "evidencePaths": ["evidence/1.1/source.md"],
      "assetIds": []
    }
  ],
  "assets": [],
  "logo": { "status": "missing", "assetId": null },
  "counts": { "leaves": 30, "evidenceFiles": 30, "assets": 0 }
}
```

Requirements:

- `operationId`, `buildId`, `generation`, Skill coordinates and company
  identity equal the application instructions exactly.
- `skill.contentHash` is copied byte-for-byte from the application's frozen
  `skillContentHash`. It is a logical content hash, not the attached Skill
  ZIP's physical SHA-256; never calculate or infer it.
- `contentVersion` is `1` for an initial bundle.
- Branch ordinals and leaf ordinals are contiguous from zero.
- Leaf count is 30–115; every leaf has a non-empty declared body.
- Every node is UTF-8 customer-visible Markdown in `nodes/*.md` with exactly
  one first-level heading `# {leaf.title}` and a non-empty body. The heading
  must equal the bound manifest leaf title. Formal markers, `## 资料元数据`,
  `## 证据与核验说明`, evidence appendices and internal metadata keys are
  forbidden.
- Every `branchId` resolves and `branchTitle` equals the branch title.
- `references/working-set-policy.json` is the canonical machine-readable
  source for ZIP limits, accepted evidence extensions/MIME, authority gates,
  soft-drop dispositions and warning codes.
- Every content/evidence/asset path is safe, unique and present.
- Every declared SHA-256 equals the exact uncompressed file bytes.
- Every `evidencePaths` entry resolves to exactly one `evidenceLedger` row for
  that leaf. Evidence without an exact hash is invalid.
- Evidence files are non-empty UTF-8 Markdown (`.md`) only. Never copy customer
  PDF, Office, image, archive or other binary uploads into `evidence/`; use a
  policy-listed UTF-8 text extension for extracted evidence, cite
  their extracted facts in Markdown evidence and leave the frozen originals
  in Dashboard upload storage.
- `counts` equals the actual manifest/file inventory.
- `logo.status` is `available` only when `assetId` resolves to the sole valid
  official Logo; otherwise it is `missing` and `assetId` is null.
- No ZIP entry may be undeclared except `BUNDLE.json`.

`researchCoverage` uses exactly the shape above:

- `officialPages.discovered` is 0–10,000; `attempted` and `failed` are 0–200;
  `succeeded` is 0–120. `attempted <= discovered` and
  `succeeded + failed == attempted`.
- `publicQueries` is 6–30, `officialDocuments` is 0–30,
  `uploadsRead` is 0–100, and `sourceCount` is 1–2,000.
- `uploadsRead` equals the application-provided `--expected-uploads-read`.
  Count only real customer uploads, never the Skill, instructions, prefill or
  another application attachment.
- `sourceCount` equals the retained `evidenceLedger` row count.
- `productFamilies` contains 1–115 unique IDs. Every family has exactly
  `id/name/leafIds`; each `leafIds` array contains 1–115 unique IDs that resolve
  to real manifest leaves.
- `dimensions` contains each of the seven IDs shown above exactly once. Every
  item has exactly `id/status/leafIds`, `status` is `covered` or `gap`, and its
  non-empty unique leaf IDs resolve to real manifest leaves.
- `stopReason` is `coverage_complete`, `source_limited` or `budget_reached`.
  `coverage_complete` requires at least 12 successful official pages and no
  `limitationReason`. `source_limited` requires an exhausted discovered page
  queue and a specific 8–2,000-character `limitationReason`. `budget_reached`
  requires at least 12 successful pages, a specific limitation, and at least
  one reached cap: 120 successful pages, 200 attempted pages, 30 public
  queries, or 30 official documents.

Asset entries use:

```json
{
  "assetId": "asset-company-logo",
  "path": "assets/company-logo.png",
  "sha256": "64-lowercase-hex",
  "mimeType": "image/png",
  "bytes": 12345,
  "width": 512,
  "height": 512,
  "provenance": {
    "sourceKind": "official_web",
    "sourcePageUrl": "https://example.com/",
    "sourceAssetUrl": "https://example.com/logo.png"
  },
  "documentIds": ["1.1"],
  "assetType": "brand_identity",
  "displayRole": "badge",
  "caption": "企业官方主 Logo"
}
```

`documentIds` and leaf `assetIds` are bidirectional.

The optional presentation fields share one vocabulary across the Skill,
portable Python validator and Dashboard TypeScript validator:

- `assetType`: `brand_identity`, `product_ui`, `product_diagram`,
  `case_photo`, `team_photo`, `environment_photo`, `certificate_badge`,
  `document_figure`, `customer_supplied`, or `other`.
- `displayRole`: `hero`, `inline`, or `badge`.
- `caption`: a short human label, never an imported path or upload filename.

An official Logo is always `brand_identity/badge`. An exact Dashboard-frozen
customer upload is always `customer_supplied/inline`; its source kind,
ownership, internal asset ID, canonical path and upload proof are derived by
Dashboard from the frozen bytes, not trusted from Provider-authored fields.
Unknown presentation values or additional presentation fields are omitted by
the canonicalizer and do not invalidate otherwise safe content.

## Leaf patch

Return `frontmind-kb-patch-<operationId>.zip` with `PATCH.json` at the root.

```json
{
  "kind": "frontmind.kb-node-patch",
  "schemaVersion": 1,
  "operationId": "operation-coordinate-from-input",
  "buildId": "uuid-from-input",
  "generation": 1,
  "baseContentVersion": 1,
  "baseWorkingSetSha256": "64-lowercase-hex",
  "targetLeafId": "1.1",
  "contentPath": "node/1.1.md",
  "contentSha256": "64-lowercase-hex",
  "evidence": {
    "add": [
      { "path": "evidence/1.1/new-source.md", "sha256": "64-lowercase-hex" }
    ],
    "remove": []
  },
  "assets": { "add": [], "remove": [] }
}
```

Requirements:

- All base and target coordinates equal the operation instructions.
- The replacement body is non-empty and its hash matches.
- The replacement body is customer-visible UTF-8 Markdown with one non-empty
  first-level title and a non-empty body. Formal markers, metadata/evidence
  headings, evidence appendices and internal metadata keys are forbidden.
- Added evidence stays under `evidence/<targetLeafId>/`.
- Added assets name only `targetLeafId` in `documentIds`.
- Removed evidence paths and asset IDs already belong to the target leaf.
- The patch contains no branch list, leaf list, other node, global report,
  progress state or confirmation state.
- No ZIP entry may be undeclared except `PATCH.json`.

`PATCH.json` may be ordinary UTF-8 JSON (with an optional UTF-8 BOM), exactly
one otherwise-empty `json` Markdown fence, or JSON serialized as a string
exactly once. Explanatory prose, nested fences, duplicate object keys, multiple
JSON values and a second string unwrap are invalid.

Dashboard applies Patch results by component after the ZIP safety and frozen
coordinate checks pass:

- invalid or empty replacement Markdown keeps the previous clean body;
- one invalid optional evidence item or non-frozen image is dropped without
  dropping valid siblings;
- a safe new image/evidence/remove still creates a new content version even if
  the body text is unchanged;
- no valid content/evidence/asset delta completes as `no_effective_change`;
- ZIP/path/symlink/compression safety, operation/build/generation/base/leaf
  coordinates, CAS/removal ownership, duplicate asset identities, and any
  Dashboard-frozen upload SHA/byte/MIME mismatch remain hard failures.

The canonical `PATCH.json` is rebuilt from the canonical DTO. Raw extra fields,
original upload filenames, Provider URLs and untrusted provenance are never
copied into the activated Working Set.

Dashboard assembles a new immutable working set and independently validates the
whole result. Never emit the assembled result in a revision task.

Always run `scripts/validate_working_set.py` with the complete named
`--expected-*` flags printed in the operation instructions. Initial validation
must include `--expected-uploads-read`; a structural-only validation without
frozen coordinates is invalid.
