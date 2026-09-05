---
name: frontmind-question-faq-reference-library
description: S7 问题与 FAQ 参考库。保存企业已有、可追溯且对后续文章有用的问题和回答边界；不强制 30–50 条、七意图或五入口全覆盖，缺少问题库时让执行层按当前单篇任务生成 FAQ。
---

# S7 问题与 FAQ 参考库

## 目标

复用已经存在的客户咨询、站内搜索、销售记录、监控问题和企业资料中的真实问法。S7 不是选题发现或排期阶段，也不靠品牌替换、地区替换或同义改写凑数量。

## 输入

- 可选 S4 contexts、价值、品牌优先角度和事实边界；
- S2 Registries；
- 可选 S3 趋势、S5 话语和 S6 视觉参考；
- 包根内容模式 Registry。

## 整理方法

1. 优先保留真实观察到的问题及其来源；无法获得的渠道不得声称已观察。
2. 合并同一决策的同义问题，记录主意图、可选入口/P 模式和可用事实。
3. 每题只写简短 `answer_thesis`、必须覆盖、不得声称和必要时效，不写完整答案。
4. 只有已有数据时才填写 provenance；研究假设必须明示为假设。
5. 数量可以为 0 或任何实际有价值的规模；无需覆盖全部意图、入口、context 或 proof。

缺少 S7 文件或问题数组为空时状态为 `skipped_optional`。执行层根据单篇问题、P 模式和正文事实自然生成 5–8 个 FAQ。

## 输出与校验

- `S7_{brand_label}_question_library.json`
- `S7_{brand_label}_问题与FAQ参考库.md`

```bash
python3 -B ../scripts/produce_strategy_assets.py \
  --brand "品牌正式名称" \
  --work-dir /path/to/project \
  --through S7
```

生产器只提取企业资料中实际出现且以问号结束的问句。数量可以为零；为空时生成 `skipped_optional` 文件，执行层再根据单篇正式问题设计 FAQ。
