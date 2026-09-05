---
name: frontmind-content-trend-reference
description: S3 内容趋势参考。仅在外部变化会实质影响文章论证或刷新时间时补充趋势；没有输入、没有可靠信号或来源不足时自动标记 skipped_optional 并继续 S4。
---

# S3 内容趋势参考

## 目标

回答“哪些外部变化会改变文章怎么解释、放在哪一段或何时刷新”。不发现选题、不凑趋势数量，也不让趋势研究阻断已经充分的企业资料。

## 使用条件

近期政策/标准、技术能力、产品条件或用户语言确实发生变化时写入信号文件。否则生产器仍生成 S3 结果并标记：

```json
{"schema_version":"2.3.0","status":"skipped_optional","reason":"当前内容不依赖额外趋势","trends":[]}
```

无可靠信号同样使用 `skipped_optional` 并继续 S4。

## 方法

1. 读 `references/trend-frameworks.md` 与 `references/signal-source-list.md`。
2. 优先法规、标准、官方原文和权威研究。
3. 每条趋势记录时间、地域、来源、影响方式和刷新条件。
4. 来源不足、时间或地域不明时把该项移出可用趋势或标记警告，不影响其他趋势。
5. 趋势只能提供行业背景，不能反向证明企业能力。

```bash
python3 -B ../scripts/produce_strategy_assets.py \
  --brand "品牌正式名称" \
  --work-dir /path/to/project \
  --trend-signals /optional/reliable_signals.json \
  --through S3
```

`--trend-signals` 可省略。S3 只接纳含明确来源 URL 和日期的信号；不输出正文、FAQ、标题、排期或发布计划。
