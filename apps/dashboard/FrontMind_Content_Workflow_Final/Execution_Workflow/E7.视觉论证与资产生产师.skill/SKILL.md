---
name: frontmind-best-effort-visual-producer
description: >
  E7 视觉选择与制作师。优先使用安全的真实企业图片，也可制作解释性视觉；单图失败即丢弃、无图继续纯文字，
  同时保留 Logo 不生成、AIGC 不冒充真实产品团队案例证书和图片权利检查。
---

# E7 视觉选择与制作师

## 内容优先

视觉是增强项，不是正文交付前置条件。按以下顺序处理：

1. 从 `working_context.images` 选择权利明确且与章节相关的真实资产；Pack 资产已由 E3 物化到 job-local `00_input/reference_assets/`，E7 以 job root 解析该稳定相对路径；
2. 缺少机制、步骤、关系或品牌氛围视觉时，可制作 `brand_editorial`、`navigate` 或 `explain` 图；
3. 客户产品、团队、客户、病例、证书、项目现场和真实事件缺图时直接取消槽位，不用 AIGC 冒充；
4. 单图路径、权利、语义或文件检查失败时丢弃该图并继续；全部图片被丢弃时输出纯文字版本。

## 安全边界

- Logo 永远使用用户提供的原始文件叠加，禁止生成、猜测或重绘。
- `brand_editorial/navigate` 不绑定事实；`explain` 可不绑定事实；`prove` 必须绑定正文正在使用的 `usable/qualified` 事实。
- 权利只接受 `approved/approved_with_credit`；后者在图说中保留署名。
- 对实际选用文件检查 job-local 安全路径、存在性、重复使用和可读尺寸；不从 E3 临时解包目录、Pack 外绝对路径或符号链接读图；不生成图片 Registry、receipt 或 SHA 账本。
- 无图或图片被丢弃只产生 warnings，永不阻断正文。

## 生产顺序

先按 P 模式、真实资产和蓝图生成真实图选择与缺口 Prompt：

```bash
python scripts/build_visual_plan.py \
  --model E6_content_model.json \
  --working-context editorial_context.json \
  --blueprint article_blueprint.json \
  --output-model E7_visual_draft.json \
  --prompt-plan E7_prompt_plan.json
```

对 Prompt Plan 中的 `brand_editorial/navigate/explain` 槽位必须实际调用图像生成工具；禁止生成 `prove` 图。把 `prompt_guidance` 和全部 `negative_constraints` 原样交给工具，生成后用 `aigc_invoker.py --generated-image` 接收真实文件。若 Prompt 指定 Logo，必须同时传入 working context 和 asset root，让脚本把原始 Logo 文件叠加到成图；不得让模型绘制 Logo。生成工具没有返回文件时，本槽位直接记为 `completed_with_limits` 并丢弃，不增加暂停点。

统一 Runner 会把待生成槽位输出为 `frontmind-controller-provider/v1` 的 `generate_images` 内部动作。总控应在同一回合完成全部工具调用；某个槽位无文件时用该 `visual_id=NO_FILE` 续跑。`aigc_invoker.py` 会把它记为一次完成受限的 attempt，后续恢复不会反复请求同一图，也不会让用户补图。

编排器对每个 `visual_id` 调用一次真图工具，并将同一 `--result E7/generated_assets.json` 反复传给 invoker；invoker 按槽位聚合全部实际返回，因此多图任务只产生一份可交给安全过滤器的 `generated_assets.json`。

```bash
python scripts/aigc_invoker.py \
  --prompt-plan E7_prompt_plan.json \
  --visual-id vis_02 \
  --generated-image generated/vis_02.png \
  --working-context editorial_context.json \
  --asset-root article_job \
  --output-dir E7/generated \
  --result E7/generated_assets.json
```

最后验证实际使用文件：

```bash
python scripts/visual_claim_validator.py \
  --model E7_visual_draft.json \
  --working-context editorial_context.json \
  --asset-root article_job \
  --output-model E7_content_model.json \
  --selection E7_visual_selection.json \
  --job-state job_state.json
```

若本阶段生成了解释图，使用 `--generated-assets generated_assets.json` 提供结果。验证器读取真实尺寸、检查文件可读性、在内存中去重，并使用 `supports_fact_ids` 验证 `prove` 图。输出 selection 是渲染所需的实际图片清单，不是上游绑定账本；不得输出文件哈希。
