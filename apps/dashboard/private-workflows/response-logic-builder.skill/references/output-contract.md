# Dashboard field mapping

The dashboard maps the exact Markdown headings to these persisted fields:

| Markdown heading  | Field        |
| ----------------- | ------------ |
| 用户真实关心      | `concern`    |
| 核心结论/执行口径 | `conclusion` |
| 企业材料/官方依据 | `facts`      |
| 待补充/待确认     | `pending`    |
| 回答边界/禁止表达 | `boundaries` |
| 引用与核验规则    | `references` |

`本轮确认` remains in the conversation only. It is not copied into the
confirmed response record.

Every mapped section must contain only displayable customer-facing text.
