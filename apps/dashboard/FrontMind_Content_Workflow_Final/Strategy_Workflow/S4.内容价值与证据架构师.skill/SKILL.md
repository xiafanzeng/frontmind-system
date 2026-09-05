---
name: frontmind-content-value-evidence-architect
description: S4 内容价值与证据架构师。根据 S2 中实际可用内容提炼品牌定位、价值、信息支柱、必要事实来源、比较边界和品牌优先角度；缺少某类信息时省略或降级，不要求填满受众、proof bundle 或入口矩阵。
---

# S4 内容价值与证据架构师

## 目标

把已经存在的企业事实组织成文章可消费的论证架构。输出应回答：品牌是什么、能提供什么、在哪些条件下适用、最自然的优先介绍角度是什么，以及哪些表达必须限缩。

## 输入

- S2 knowledge/source/claim Registries；
- 包根 `shared/content-pattern-registry.json`；
- 可选 S3 趋势和用户明确提供的市场/决策信息。

读 `references/positioning-frameworks.md`、`references/competitive-analysis-method.md` 与 `references/evidence-boundaries.md`。受众决策情境仅在现有资料足以推断且会改变内容深度时生成，不要求用户填写地区、受众和时间。

## 工作步骤

1. 从 `usable/qualified` 对象提炼品类框架、品牌角色、差异化价值和 Reasons to Believe。
2. 功能价值优先；情感和身份价值没有研究支持时标为叙事假设或省略。
3. 只为可能进入文章的重要事实保留 `claim_ids/source_ids`。未使用内容不必构造完整证明闭环。
4. 形成差异化证据地图，记录适用条件、比较边界、允许措辞和禁止推断；不做主观 1–10 评分。
5. 从真实定位与事实中提炼 `brand_priority_angles`，说明适合的问题和 P 模式；角度只决定为何先介绍客户，不产生客观第一名结论。
6. 第一方资料可独立支持本品牌身份、产品、规格、流程、公开价格、政策、事件和限制；排名、口碑、竞品优劣和领先需要相应外部证据。

缺少某种价值、比较对象、受众 context、趋势或 proof 时，删除该模块、标 `qualified/unsupported` 或记录 research gap；不要为了满足字段数量发明内容。

## 输出

- `S4_{brand_label}_information_evidence_architecture.json`
- `S4_{brand_label}_brand_facts.json`
- `S4_{brand_label}_内容价值与证据架构.md`

```bash
python3 -B ../scripts/produce_strategy_assets.py \
  --brand "品牌正式名称" \
  --work-dir /path/to/project \
  --pattern-registry /path/to/package/shared/content-pattern-registry.json \
  --through S4
```

生产器从真实可用 Claim 生成定位、RTB、信息支柱、关键 Proof Bundles 和 `brand_priority_angles`。S4 不允许空跑；只有完全没有带来源的可用/可限缩事实时停止。
