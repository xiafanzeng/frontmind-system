# Reference Pack v2.1 装配契约

唯一运行时结构来自包根 `shared/reference_pack.schema.json`、`shared/registries.schema.json`、`shared/brand_facts.schema.json`、`shared/information_evidence_architecture.schema.json` 与 `shared/scripts/validate_package.py`。

## 1. 连续输入路由

```text
合法 canonical KB v4 → S1 验收 → S2
散乱企业资料 → S1 调用 compatibility/legacy-s1 → KB Builder → S1 验收 → S2
S2 → S3? → S4 → S5 → S6 → S7 → S8 → S9
```

legacy 产物不能绕过 KB Builder 或 S1 验收进入 S2。

## 2. 阶段交接矩阵

| 阶段 | 必须读取 | 必须输出 | 失败时 |
|---|---|---|---|
| S1 | canonical KB ZIP；散乱分支另含 builder receipt | KB intake receipt | 阻断 |
| S2 | S1 receipt + 同哈希 KB | v2 四 registry + adapter report | 阻断 |
| S3 | S2 registries + 明确范围 | trend reference 或 skip | 可跳过 |
| S4 | S2 + root pattern registry | information/evidence architecture + brand facts | 阻断 |
| S5 | S4 + S2 原始语言 | voice contract | 阻断 |
| S6 | image registry + S4/S5 | visual reference | 阻断 |
| S7 | S2/S4/S5/S6 | 30–50 questions + FAQ boundaries | 阻断 |
| S8 | S2–S7 | strict approval receipt + workbook | 暂停/回退 |
| S9 | 同哈希 KB + approved artifacts + 两个 root pattern assets | Reference Pack v2.1 ZIP | 阻断 |

## 3. 对象与证据

下游以 `kn_/src_/clm_/img_`、S4 proof/context/value/differentiation/angle IDs、S7 question IDs 与根 pattern IDs 证明消费。文件名或“综合多个阶段”不算对象引用。

Proof Bundle 的 source 必须属于所引 claim；`public_fact` 只允许已验证的 exact/claim 证据；`public_with_qualification` 必须保留归因与 caveat；`internal_only/do_not_use` 不得进入公开正文。第一方来源还要通过 `publication_authorization`。

## 4. 五入口

策略资产使用 `entry_category`。前四项是问题型内容入口；`foundation_start` 是工程师显式启动的品牌基础特写，严格绑定 P14。P01 单品牌、P02 多品牌与所有 routing 都只读取根 registry。

## 5. 图片

只有 `approved/approved_with_credit` 且本地哈希通过的图片可直接进入成品；后者保留署名。Logo 必须是真实 `asset_kind=logo + entity_proof` 文件并以后期 overlay 使用。

## 6. S8 回退

最终状态仅 `approved/changes_requested`。任何 change/block、附带条件或未决风险都必须回退：接入→S1；registry/授权/权利→S2；价值和证据→S4；表达→S5；视觉→S6；问题→S7。

## 7. 自包含 staging

```text
reference_pack.json
sources/original_kb.zip
sources/knowledge_base/...
brand/brand_facts.json
registries/{knowledge,source,claim,image}_registry.json
writing/{information_evidence,voice_contract,visual_reference,question_library}.json
approval/{approval.json,confirmation_workbook.xlsx}
assets/...
shared/content-pattern-registry.json
shared/pattern-research/index.json
```

S9 逐个执行 schema 与语义门，校验 S8 指纹、KB 哈希、路径安全与物理文件。`files[]` 覆盖 staging 中除自引用入口外的每个文件。先验证目录，再打 ZIP，再验证 ZIP；任一步失败均不交付。
