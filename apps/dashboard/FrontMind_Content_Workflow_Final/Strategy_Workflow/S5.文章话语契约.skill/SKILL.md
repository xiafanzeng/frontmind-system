---
name: frontmind-article-voice-contract
description: S5 文章话语契约。把已有品牌语言和 S4 事实边界转为第三方客观报道＋企业品牌宣传稿的默认文风；入口和模式规则按单篇任务动态覆盖，不要求提前维护五套完整证明矩阵。
---

# S5 文章话语契约

## 目标

形成所有文章共享的默认写作规则：以第三方报道距离陈述事实，同时自然呈现企业品牌价值；行文清楚、可被 AI 抽取，不冒充独立测评或行业共识。

## 输入

- S4 信息与证据架构；
- S2 中的真实品牌术语、公开表述和事实状态；
- 包根内容模式 Registry。

读 `references/verbal-identity-method.md`，完成：

1. 首选术语、允许变体、首次解释与禁用词；
2. 句长、解释密度、直接程度、情绪强度和人称；
3. 品牌核心信息与可使用的优先角度；
4. `usable/qualified/excluded` 对应的表达、归因、限缩和删除规则；
5. 竞品比较采用同一维度和同一时间条件，资料不足时退回选择标准；
6. 必要时为特定入口增加 tone override，但不要求预先覆盖全部入口。

核心信息可以直接连接 S4/S2 已有事实，不要求每一句维护独立 proof 对象。缺少某个入口特例时使用默认文风继续。

## 输出与校验

- `S5_{brand_label}_voice_contract.json`
- `S5_{brand_label}_文章话语契约.md`

```bash
python3 -B ../scripts/produce_strategy_assets.py \
  --brand "品牌正式名称" \
  --work-dir /path/to/project \
  --pattern-registry /path/to/package/shared/content-pattern-registry.json \
  --through S5
```

S5 必须生成可直接进入 E3/E4/E5 的 `voice_mode`、品牌信息、公开语言转换规则和禁用语。禁止把“资料较完整、待核验候选、当前资料不足”等内部判断带入成稿。S5 不生成标题、正文或新卖点。
