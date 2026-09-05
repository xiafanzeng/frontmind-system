---
name: frontmind-article-blueprint-v23
description: E4 用户确认后的文章蓝图。校验唯一 P 模式，读取预研 Pattern Research Index，融合 0–5 篇同 P Top20 标杆，输出自然章节与 blueprint_review.md。
---

# E4 文章蓝图师

## 内容优先决策

E4 不要求独立 `e4_pattern_decision.json`。它直接读取 E1 Content Job、E3 working context、P01–P16 Pattern Registry 和 Pattern Research Index。普通文章必须通过 `--selected-pattern` 传入用户在 E2 确认的模式；E4 不自动采用或覆盖。

决定顺序为：

1. 入口与产品子意图的合法路由；
2. 当前问题实际需要回答什么；
3. 现有可用内容能否诚实支撑该模式；
4. E2 推荐、用户确认与问题是否一致；
5. 预研模板最低骨架与同 P 标杆能否共同承接。

用户确认的模式若不合法或硬条件不足，E4 返回 `awaiting_pattern_confirmation` 与可识别 `code`，不写蓝图、不静默降级。没有同 P 可访问标杆时，签名预研模板独立承接结构。

## 仍然保留的专业边界

- `foundation_start ⇔ P14`；
- P01 只有客户品牌一个候选；
- P02 至少三家真实候选、客户品牌首先出现并使用共同维度；监控提及或引用 URL 仍为 `discovery_only`，只有带明确公开事实的 `publicly_supported` 竞品才计数；
- P03 需要至少两个明确对象的可比较资料；
- P10 需要实际研究或数据；
- P12 需要真实案例或项目记录；
- 缺少这些模式专属条件时返回 E2 模式确认，不要求用户制作证明账本。

预研模板的 required structure components 继续构成最低专业骨架；运行时标杆只能补充子问题、判断维度和章节顺序，不能复制原文或删除限制、FAQ 和结论。

```bash
python3 -B E4.文章蓝图师.skill/scripts/build_article_blueprint.py \
  --content-job /path/to/job/00_input/content_job.json \
  --working-context /path/to/job/E3/editorial_context.json \
  --pattern-registry /path/to/workflow/shared/content-pattern-registry.json \
  --pattern-research-index /path/to/workflow/shared/pattern-research/index.json \
  --selected-pattern P02 \
  --blueprint-review /path/to/job/04_blueprint/blueprint_review.md \
  --output /path/to/job/04_blueprint/article_blueprint.json
```

用户在 P3 修改蓝图时，可传 `--blueprint-edits edits.json`。允许调整同 P 标杆排名、候选顺序、章节顺序、自然标题、章节编辑任务、读者收获、视觉角色、FAQ 与品牌重点角度；不能借此改变 P 模式或删除必需结构。

输出满足根 `shared/article_blueprint.schema.json` v2.3，并同步生成 `blueprint_review.md`。章节只使用对读者自然的 `display_heading`；“为什么先介绍客户”“有哪些可核验信息”“需要说明哪些事实”等内部审稿标题禁止进入蓝图。活动产物不含 Registry SHA、receipt、exact-set、组件账本或 section provenance。
