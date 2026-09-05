# Brand Question Portfolio Output Contract

Serialize this JSON object exactly once into the Manus v2 structured-output
`payload` string. The application-provided `modelProfile` must be echoed as
`skill.model`:

```json
{
  "schemaVersion": 1,
  "skill": {
    "name": "brand-question-portfolio",
    "version": "2",
    "model": "frontmind-base"
  },
  "knowledgeSnapshot": {
    "id": "server-supplied-id",
    "version": 3,
    "archiveHash": "server-supplied-sha256"
  },
  "enterprise": {
    "identityHash": "server-supplied-sha256",
    "canonicalName": "server-supplied-enterprise-name"
  },
  "planCode": "advanced",
  "quotaPeriodId": "server-supplied-period-id",
  "candidateTargets": {
    "industry": 3,
    "competitor_comparison": 3,
    "reputation": 3,
    "product_scenario": 15
  },
  "categories": {
    "industry": [],
    "competitor_comparison": [],
    "reputation": [],
    "product_scenario": []
  },
  "shortfalls": [],
  "risks": []
}
```

Each category item must have this exact shape:

```json
{
  "candidateId": "stable-lowercase-id",
  "question": "客户会直接提出的完整问题？",
  "intent": "这个问题背后的具体决策需求",
  "rationale": "为什么它适合当前企业和该类别",
  "evidence": [
    {
      "documentPath": "知识库内的精确 Markdown 路径",
      "excerpt": "支持该候选问题的简短原文摘录",
      "relevance": "该证据与问题之间的明确关系"
    }
  ],
  "risks": []
}
```

Contract rules:

- The four category keys are required even when a category has no defensible
  candidate.
- `candidateTargets` must echo the four server-supplied targets exactly. Each
  target equals three times the remaining selection quota; a zero target
  requires an empty category.
- A category may contain fewer than its target only when `shortfalls` contains
  exactly one matching record with `{category, target, generated, reason}`.
  It may never contain more than its target.
- `candidateId` is unique within this result, contains only lowercase ASCII
  letters, digits, and hyphens, and is at most 80 characters.
- `question`, `intent`, and `rationale` must be non-empty customer-visible
  Chinese text.
- Every `question` must contain the server-supplied `canonicalName` verbatim.
- Every candidate has one to eight evidence records.
- Every `documentPath` must exactly match a path supplied in the current
  knowledge snapshot.
- `excerpt` is at most 500 characters. After NFKC and whitespace
  normalization, it must be a contiguous substring of the cited document.
- Top-level and candidate `risks` contain concise customer-visible strings.
- Echo the server-supplied snapshot ID, version, archive hash, enterprise
  identity, plan code, quota period ID, model profile, and candidate targets
  exactly.
  Mismatches make the result invalid.
- This contract is valid only for an application-authorized `advanced` or
  `luxury` invocation. Rejected Basic or inactive access has no model output.
- Do not include selected state, quota usage, prices, user IDs, administrator
  data, credentials, Markdown fences, `output_text`, `output_file`, or
  additional keys.
