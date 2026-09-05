# Adaptive knowledge-tree contract

## Coverage model

Derive top-level branches from evidence rather than forcing a fixed count.
Cover every applicable business question:

| Business question              | Candidate dimension                    |
| ------------------------------ | -------------------------------------- |
| Who is the enterprise?         | 企业身份                               |
| Who delivers?                  | 团队与组织                             |
| What is offered?               | 产品与服务                             |
| How is it achieved?            | 技术、研发、制造、质量、合规或交付能力 |
| For whom and with what result? | 行业、场景与案例                       |
| Why choose it?                 | 差异化与证据                           |
| How does cooperation work?     | 合作、交付与支持                       |

Merge overlapping dimensions and split materially different business lines.
Add evidence-backed branches such as compliance or R&D. Omit only dimensions
that are genuinely inapplicable and explain the omission in the evidence
report.

## Leaf inventory

Build 30–115 stable leaves before returning the initial working-set bundle:

| Enterprise scope                      | Typical leaves |
| ------------------------------------- | -------------: |
| 1–3 product/service families          |          40–55 |
| 4–6 families                          |          60–80 |
| 7+ families or several business lines |         85–115 |

Keep every real product/service family represented. Consolidate large SKU,
news, pagination, and language-version inventories into family leaves. Give
core families deeper leaves for positioning, capabilities/parameters,
applications, proof/cases, and FAQs. A typical enterprise with one to three
families should use 40–55 leaves. A sparse enterprise must still reach 30 by
auditing applicable unanswered business questions and creating distinct
`needs_verification` gap leaves. Never invent facts, duplicate prose, split one
fact mechanically, or repeat a generic disclaimer to meet the floor.

Use stable `id`, `title`, `branchId`, and `branchTitle` values. Never rename an
ID after it is declared in `BUNDLE.json`.

## Research coverage gate

Before fixing the inventory, read every initial upload and audit all seven
business questions above. A normal complete run executes at least six public
queries and successfully parses at least 12 official pages. A genuinely small
official site may finish with fewer successful pages only after its discovered
official queue is exhausted and the exact limitation is recorded.

Hard ceilings are 120 successfully parsed official pages, 200 visited links,
30 public queries and 30 useful official documents. The production manifest's
`researchCoverage` must use actual counters, list every product/service family
with real leaf IDs, and represent all seven dimensions as evidence-backed
coverage or a specific gap. A Website prefill contributes evidence but never
supplies the Dashboard branch/leaf structure, IDs, depth or traversal state.

## Required formal layer

Create one branch overview plus the associated leaf documents. The overview:

- Synthesizes the branch into coherent customer-ready prose.
- Connects facts rather than enumerating page titles.
- Has no image asset. The sole official company Logo belongs only to the first
  leaf and must not be repeated in an overview. If that Logo is unavailable,
  record the explicit missing-Logo state without inventing an image; Dashboard
  owns any later upload requirement.
- Points to leaves for detail without copying their full text.

Assess evidence sufficiency while drafting, but do not serialize internal
status or evidence metadata into customer node Markdown. Use the
evidence-proportional formula in `SKILL.md`; do not delete applicable business
breadth or pad a sparse branch merely to reach a writing target.
A white-label or early-stage enterprise can legitimately have short prose
after uploads, official pages, documents, and public sources have been checked.
Sparse leaves state the verified facts in customer-visible prose and retain
unresolved research notes only in declared evidence files. Status labels and
source tables never belong in node content.

## Traversal boundary

The bundle declares content and ordering, not interactive traversal state.
Dashboard activates the first leaf, advances confirmations, records
`needs_verification`, calculates progress and builds the final customer
archive locally. Never emit progress UI, mark a leaf confirmed/current, or
withhold pending leaf bodies for a later task.
