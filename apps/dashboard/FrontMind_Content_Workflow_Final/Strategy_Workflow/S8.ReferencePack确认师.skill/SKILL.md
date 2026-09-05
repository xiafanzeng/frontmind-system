---
name: frontmind-reference-pack-confirmation-summary
description: S8 Reference Pack 确认摘要师。汇总品牌事实、宣传重点、禁写主张、默认文风、视觉和内容可用性，供新建或更新 Pack 时做一次内容确认。
---

# S8 Reference Pack 确认摘要师

## 目标

在构包前确认“这些事实和表达方向是否代表品牌”。S8 只暂停一次，让用户确认品牌事实、宣传重点、禁写主张、默认文风和视觉摘要；不因某一来源、声明或图片不可用而回退整个流程。

## 执行

```bash
python3 -B ../scripts/produce_strategy_assets.py \
  --brand "品牌正式名称" \
  --work-dir "/path/to/project" \
  --through S8
```

生产器读取 S2–S7 并输出：

- `S8_*_usability.json`：内容状态汇总；
- `S8_*_pack_summary.json`：机器可读确认摘要；
- `S8_*_ReferencePack确认摘要.md`：供用户直接确认。

可用性按以下规则整理：

- `usable` 直接保留；
- `qualified` 继续进入 Pack，由正文保留限定；
- `excluded` 记录对象 ID 与排除原因，不进入公开表达或视觉使用。

历史 v2.0/v2.1 Registry 没有 `usage_status` 时，根据现有内容/权利字段宽容映射。缺少图片、问题、趋势或非核心 Registry 内容仅输出 warnings。

S8 只在 knowledge/source/claim 中已经没有任何 `usable` 或 `qualified` 文本时阻断。确认后由总控进入 S9；修正直接更新内容资产，状态只记录当前阶段。
