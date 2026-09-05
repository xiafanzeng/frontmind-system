---
name: frontmind-title-map-and-delivery
description: >
  E10 回归选稿、标题映射与双格式交付师。先比较 E8 安全正本和 E9 HarnessGEO 整篇候选并选定唯一正文，
  再暂停询问标题数量，输出无标题 DOCX/HTML、自然标题集和轻量 delivery_index。
---

# E10 标题映射与双格式交付师

## 先完成整篇选稿

```bash
python scripts/select_final_body.py \
  --editorial-master E8_editorial_master.json \
  --harnessgeo-candidate E9_harnessgeo_candidate.json \
  --working-context E3_editorial_context.json \
  --output E10_final_content_model.json \
  --summary E10_body_selection.json \
  --job-state job_state.json
```

实体、候选顺序、数字、日期、价格、能力、适用对象、来源、限制、适用条件、FAQ 或医疗安全语义任一漂移，整篇沿用 E8；医疗品类术语替换（如玻尿酸变成 Collagen）、监管地域漂移（如中国注册语境变成 FDA/HIPAA）、语言脚本混杂和高风险操作步骤新增均属于明确回退条件。同时按 E3 Fact Cards 对每个正文槽复查能力与适用对象。全部通过才整篇采用 HarnessGEO 候选。禁止段落混拼。

## 标题数量暂停

整篇选稿完成后立即运行：

```bash
python scripts/set_title_count.py --job-state job_state.json
```

脚本把状态写为 `awaiting_title_count`，并询问：

> 这篇文章需要生成多少个标题选项？请输入 1–20。

收到回答后运行：

```bash
python scripts/set_title_count.py --job-state job_state.json --count 5
```

数量直接进入唯一的 `job_state.json`，不生成 title-count receipt，不绑定正文哈希。

## 标题制作

根据已经选定的最终正文自动生成恰好 N 个标题：

- `title_text`、`h1_suggestion` 和 `meta_description` 不得引入正文没有的实体、数字、年份、价格或结论；
- P01 不承诺 Top-N、多品牌榜单或客观第一；P02 可写编辑推荐榜，但不得写“第一名、榜首、得分最高”；
- 标题采用不同的决策问题、场景、候选、流程或风险角度，不使用“原问题＋固定后缀”；
- 必须读取 Content Model 的 `pattern_id`，并消费 Pattern Registry 中该 P 模式自己的 `editorial_template.title_formulas`；不得让 16 个模式共用一套通用标题模板；
- 每项保留 `title_formula`、单个 `angle_tag`、`temporal_basis` 和正文中真实出现的 `referenced_entity_names`；
- 正文模型保持无 Title/H1/Meta 字段，标题不能反向改写正文。

```bash
python scripts/generate_title_map.py \
  --content-model E10_final_content_model.json \
  --job-state job_state.json \
  --pattern-registry ../../shared/content-pattern-registry.json \
  --output title_map.json
```

使用根标题验证器：

```bash
python ../../shared/scripts/validate_title_map.py title_map.json \
  --content-model E10_final_content_model.json
```

## 交付

```bash
python scripts/render_delivery.py \
  --content-model E10_final_content_model.json \
  --title-map title_map.json \
  --job-state job_state.json \
  --output-dir delivery \
  --visual-selection E7_visual_selection.json \
  --asset-root article_job
```

`--visual-selection` 可省略；提供视觉时，`--asset-root` 限定所有可读取图片的任务目录。缺图、坏图、越界路径或权利不清时只丢弃对应图片，继续纯文字交付。

公开目录包含：

```text
article_body.docx
article_body.html
title_options.md
title_map.json
publishing_metadata_map.json
structured_data_template.json
images/*                 # 仅实际使用时
delivery_index.json
```

DOCX 从直接答案自然段开始且没有 Title 段；HTML 是不含 `html/head/title/h1/script/table` 的 `<article>` 片段。DOCX 必须使用高保真渲染器，保留中文字体、链接和实际视觉；渲染器不可用时显式阻断，禁止静默降级为丢链接或图片的简易 DOCX。`delivery_index.json` 只列角色、相对路径和媒体类型，不含 SHA、exact-set、审计回执或本机绝对路径。

渲染器只验证最终正文、标题、标题数量和实际图片。不读取 E4/E6/E8 receipt，不生成 regression audit、render audit、final quality report 或 `internal_audit/`。
