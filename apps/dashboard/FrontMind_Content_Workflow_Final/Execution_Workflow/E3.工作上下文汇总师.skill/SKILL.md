---
name: frontmind-editorial-context-builder-v23
description: E3 编辑上下文汇总。把 S4 品牌优先角度、S5 话语合同、AI 答案格局、候选公开事实、Top20 标杆与视觉资产汇成唯一 editorial_context.json。
---

# E3 工作上下文汇总师

## 职责

E3 把现有资料转成 E4–E10 可以直接消费的一份工作上下文。它不再是“生产前总契约门”，也不要求任何上游 receipt。

输入可以是 Content Job 中的 Reference Pack、散乱资料或两者混合。普通文章还必须消费 E2 pattern analysis 与标准化 monitoring context；`foundation_start` 是唯一例外。

E3 自动读取旧 Registry、轻量 Registry 和常见办公文档。用户上传的普通企业事实默认 `usable`；需要范围、时间或专业限定的内容标为 `qualified`；明确内部、保密、个人隐私或禁止公开内容标为 `excluded`。局部排除不能拖住其余内容。

E3 必须把 S5 `voice_mode/editorial_position/style/brand_messages/forbidden_public_phrases` 投影为 `voice_profile`，把 S4 `priority_message/proof/claim_ids/publication_boundary` 投影为 `brand_priority_angle`。监控答案进入 `answer_landscape`、候选发现与 `reader_questions`；同 P Top20 结构进入 `benchmark_moves`。

监控提及与引用 URL 不自动成为竞品事实。P02/P03 候选只有在官网、政府登记或可靠公开来源提供明确事实后才标为 `publicly_supported`。可用 `--supplemental-research` 传入轻量 JSON：`sources[]` 加 `candidate_facts[]`；每条候选事实必须有 `about_entities` 和公网来源。

视觉上下文同时合并 S2 `images` 与 S6 `asset_pool`。E3 在临时解包结束前，只把权利明确且能被渲染器真实解码的 Pack 图片物化到 `00_input/reference_assets/`，`images.file_path` 与 `visual_assets.file_path` 始终是相对 job root 的稳定路径。ZIP 路径逃逸、重复成员、符号链接，以及目录 Pack 中的越界或符号链接资产均不会被复制。`approved_with_credit` 只有携带真实 `attribution_text/credit/credit_line` 时才可用，署名会原样进入 `images` 和 `visual_assets`。缺图、坏图、缺署名或权利不明的单图不进入 E7 候选，正文继续纯文字，不新增用户暂停。

```bash
python3 -B E3.工作上下文汇总师.skill/scripts/build_working_context.py \
  --job-root /path/to/job \
  --content-job /path/to/job/00_input/content_job.json \
  --scope-analysis /path/to/job/00_input/scope_analysis.json \
  --monitoring-context /path/to/job/02_research/monitoring_context.json \
  --e2-analysis /path/to/job/02_research/e2_pattern_analysis.json \
  --supplemental-research /path/to/job/02_research/supplemental_research.json \
  --output /path/to/job/E3/editorial_context.json
```

`--supplemental-research` 可省略；普通文章的 `--monitoring-context` 与 `--e2-analysis` 不可省略。

## 唯一输出

活动产物只有满足根 `shared/working_context.schema.json` v2.3 的 `editorial_context.json`，包括品牌与任务问题、自动范围、话语合同、品牌优先角度、三态事实/来源、已物化可用图片、答案格局、候选画像、标杆动作、真实读者问题、公开约束、安全内容与视觉资产。

不再生成 E3 intake report、runtime source/claim/image Registry、extension、seed receipt、文件指纹或跨阶段 SHA。

只有没有任何可读内容、无法识别品牌或主题、或全部核心事实均明确不可公开时才允许停止。
