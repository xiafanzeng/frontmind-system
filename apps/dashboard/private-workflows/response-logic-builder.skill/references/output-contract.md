# Dashboard structured-output contract

The v2 task schema requires exactly these string fields:

- `concern`
- `conclusion`
- `facts`
- `boundaries`

`pending` and `references` remain only as backward-compatible persisted fields for older records. New model output does not create or display either section.

Every field must contain customer-ready Simplified Chinese and serve a different purpose:

- `concern` is the customer's decision and primary risk in 1–2 sentences.
- `conclusion` opens with the direct answer and gives 3–5 ordered actions.
- `facts` keeps only 3–8 facts that materially support this answer.
- `boundaries` merges the relevant unsupported or prohibited claims into 3–6 concise items.

Across all four fields, each fact, recommendation, or limitation appears once. The normal target is 800–1600 Chinese characters in total unless the user explicitly requests a detailed version. Prefer short sentences, concrete verbs, and plain explanations over research-report, audit, legalistic, or jargon-heavy prose.

Never expose internal knowledge-base paths, filenames, archive names, extensions, inventories, or versions. Dashboard renders provenance once in the fixed title `企业材料/官方依据（引自知识库文档）`. The model must put no provenance label, heading, prefix, or parenthetical note inside the body of `concern`, `conclusion`, `facts`, or `boundaries`. Uploaded images and files are incorporated directly and must not trigger a placement, caption, copyright, public-scope, or authorization question.

The structured result is the only accepted result. Assistant prose, code fences, task metadata, and output attachments are never parsed as a fallback.
