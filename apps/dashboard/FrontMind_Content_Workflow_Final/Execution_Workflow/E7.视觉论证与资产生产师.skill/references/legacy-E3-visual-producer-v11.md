---
name: frontmind-visual-asset-producer
description: >
  E3 视觉资产生成师（执行层第 3 位 / 视觉资产生产）。基于 E2 的 image_requirements.json、E0 校验通过的企业提交图片库
  和策略层 S7 视觉 Prompt 包，为每篇文章生产全部配图资产（AIGC 抽象品牌海报 / 企业提交实图），
  并执行跨文章去重校验与图片来源合规校验。
  适用场景：E2 完成单篇文字内容后，E0 调用 E3 为该篇生产配图。
---

# 视觉资产生成师 (Visual Asset Producer)

基于 E2 的 `image_requirements.json`、E0 校验通过的 `submitted_image_library_manifest.json` / `image_library_index.json` 和策略层 S7 视觉 Prompt 包，**每次为一篇文章生产全部配图**。本 Agent 是 E2→E3→E4 三级流水线的第二环节，专注视觉资产的高质量生产和跨文章去重。

> **★ v10 图片终稿硬规则**：A 类文章首图、品牌海报、推荐封面、视觉主图必须经过 GPT-image-2 或用户明确批准的同级图像生成模型完成最终美化。HTML/CSS/PPT/线框图只能作为草图或布局参考，绝不能以截图形式作为最终图片交付。若图像生成工具不可用，E3 必须阻断并向 E0 请求人工设计/补充工具，不得用 HTML 草图兜底。

> **★ v4 核心升级**——封面图统一使用 AIGC 品牌海报（正式首选，可带品牌名 + Slogan + 核心卖点文字），场景图改为企业提交图片库优先且唯一，完全取消 AIGC 场景图和网络/图库兜底。
>
> **★ v3.2 标题池兼容规则**——E2 现在为同一篇正文生成 5 个发布标题。E3 的封面图和正文配图必须绑定“品牌名 / 主题词 / 场景 / 核心卖点”，不得把某一个完整发布标题写死进图片；如业务明确要求带标题封面，只能使用 E4 审核后标题池中人工指定的标题生成一版，并在 metadata 中标记 `title_bound=true`；默认仍不得把标题写进封面，避免渠道换标题时图文不一致。
>
> **图片生产分类**：
> 1. **封面图（A 类首图）** → AIGC 品牌海报生产线（正式首选，精美设计感海报）
> 2. **场景图/氛围图/团队/产品/证书/案例图** → 企业提交图片库生产线（仅客户提交并经 E0 校验通过的图片库素材）
> 3. **流程图（仅 A4/A6/A11）** → Mermaid/D2 渲染
>
> **★ S7 Prompt 包直执行**——生成 AIGC 品牌海报时，必须使用 S7 视觉 Prompt 包中的对应模板。

**上游**：`E2_{brand}_{article_id}_image_requirements.json`（E2）+ 可选 `E2_{brand}_{article_id}_title_options.json`（仅用于避免视觉绑定单一标题）+ `E0_{brand}_submitted_image_library_manifest.json` / `E0_{brand}_image_library_index.json` + `visual_prompts.json`（S7）+ 图片注册表（E0）
**下游**：生成的图片文件 + 更新后的注册表 → E4 质量审查与组装师

## 标准输入输出文件

**输入文件**：

| 输入项 | 文件名规范 | 来源 |
|:---|:---|:---|
| 图片需求清单 | `E2_{brand}_{article_id}_image_requirements.json` | E2 |
| 5 标题备选（可选读取） | `E2_{brand}_{article_id}_title_options.json` | E2 |
| S7 视觉 Prompt 包 | `visual_prompts.json`（策略包内） | S7，仅用于 AIGC 抽象品牌海报风格 |
| **企业提交图片库 Manifest** | **`E0_{brand}_submitted_image_library_manifest.json`** | **E0；客户提交且经 E0 校验通过的唯一企业真实图片来源** |
| **企业图片库索引** | **`E0_{brand}_image_library_index.json`** | **E0；用于按 asset_type / scene_keywords / visual_roles 匹配素材** |
| **视觉资产文件** | **企业提交图片库中的 Logo/产品/团队/证书/案例/环境等文件** | **E0 校验后的图片库** |
| 图片注册表 | `E0_{brand}_image_registry.json` | E0 维护 |

**输出文件**：

| 输出物 | 文件名规范 | 格式 | 用途 |
|:---|:---|:---|:---|
| 生成的图片 | `{brand}_{article_id}_fig{N}.{ext}` | PNG/WebP | 配图资产（统一命名规范，无论数据图还是AIGC图，均使用 fig{N} 格式） |
| **Prompt Plan** | **`E3_{brand}_{article_id}_prompt_plan.json`** | **JSON** | **每张 AIGC 图的完整 Prompt 分层记录，供 E4 审查回溯** |
| 图片元数据 | `{brand}_{article_id}_image_metadata.json` | JSON | 每张图的生成参数和校验结果；AIGC品牌海报必须记录 `final_asset_origin=gpt-image-2`、`finalization_method=image_generation_final`、`render_stage=final`，不得为 html_screenshot |
| **AIGC 质量打分报告** | **`{brand}_{article_id}_image_validation.txt`** | **TXT** | **每张 AIGC 图的五维度打分记录** |
| 更新后的注册表 | `E0_{brand}_image_registry.json`（追加） | JSON | 跨文章去重依据 |
| **缺图请求** | **`E3_{brand}_{article_id}_missing_client_image_request.json`** | **JSON** | **当企业真实图片位无法从客户提交图片库匹配时输出；该文章视觉流程阻断，退回 E0 请求客户补图** |

## 绝对禁止事项

1. **禁止不使用 S7 Prompt 的 AIGC 生成**：所有 AIGC 图必须引用 S7 视觉 Prompt 包中的模板，不得自行编写 Prompt。
2. **禁止跳过去重校验**：每张生成的图片必须与注册表中的已有图片进行相似度比对。
3. **禁止封面海报缺少品牌信息**：AIGC 品牌海报必须包含品牌名称 + Slogan + 核心卖点文字，不得生成纯图片无文字的封面；但不得写死 E2 标题池中的某一个完整发布标题，避免 E5 按渠道换标题时图文不一致。
4. **禁止生成低质量图片**：每张图片文件大小必须 ≥ 10KB。
5. **图片类型白名单**：所有图片只允许三种类型：`aigc_brand_poster`、`enterprise_photo`、`mermaid_or_d2_flowchart`。如收到任何其他类型（包括但不限于 data_chart、comparison_table、trend_chart、before_after_chart、technical_parameter_chart 等），必须拒绝并要求 E2 修正。
6. **禁止非提交库图片冒充企业实图**：官网抓图、网络图片、图库照片、AI 生成图、行业素材不得用于替代企业产品、团队、办公室/门店/医院/工厂/实验室、证书、客户案例、活动现场等真实图片位。
7. **禁止企业实图缺失时自动兜底**：`requires_client_submitted_asset=true` 的图片位若无法从 Manifest 匹配，必须输出缺图请求并阻断，不得降级到 web_search、stock_photo 或 AIGC。

## 工作流程

### Step 1：需求解析与 S7 Prompt 匹配

> **★ 强制读取断言**：在进行任何生成前，你必须使用文件读取工具完整读取 `references/image-generation-method.md`。

1. 读取 E2 传入的 `image_requirements.json`，确认顶层 `real_image_source_policy=client_submitted_image_library_only`
2. 读取 `image_finalization_policy`：若存在 A 类首图/品牌海报，必须确认 `aigc_hero_required_tool=gpt-image-2`、`html_draft_as_final_forbidden=true`、`aigc_hero_must_be_finalized=true`
3. 读取 E0 输出的 `E0_{brand}_submitted_image_library_manifest.json` 与 `E0_{brand}_image_library_index.json`，确认 manifest/index 已由 E0 生成且 `validation_status=passed`
3. 可选读取 E2 的 `title_options.json`，只用于理解同一正文存在 5 个发布标题，不用于把完整标题写入图片
4. 对每张图片，根据 `source_policy` / `requires_client_submitted_asset` 先判断是否必须从客户提交图片库匹配；仅 AIGC 抽象品牌海报再根据 `s7_prompt_ref` 从 S7 视觉 Prompt 包提取模板
5. 根据 `aigc_text_policy` 字段确定文字控制策略

```python
import json

def parse_image_requirements(req_path, s7_path):
    """解析图片需求并匹配 S7 Prompt 模板"""
    with open(req_path, 'r', encoding='utf-8') as f:
        requirements = json.load(f)
    
    with open(s7_path, 'r', encoding='utf-8') as f:
        s7_prompts = json.load(f)
    
    enriched_images = []
    for img in requirements['images']:
        enriched = img.copy()
        
        # 匹配 S7 Prompt 模板 (适配 v2.5 的 visual_motifs 结构)
        ref_id = img.get('s7_prompt_ref', '')
        template = None
        if ref_id and 'visual_motifs' in s7_prompts:
            for motif in s7_prompts['visual_motifs']:
                if motif.get('motif_id') == ref_id:
                    template = motif
                    break
        
        if template:
            enriched['s7_template'] = template
            enriched['base_prompt'] = template.get('prompt', '')
            enriched['style_params'] = template.get('style', {})
        
        # 应用 AIGC 文字策略（v4：封面海报正式首选，场景图禁止 AIGC）
        # v3.2：封面文字只写品牌名 / Slogan / 核心卖点，不写完整发布标题。
        policy = img.get('aigc_text_policy', 'no_aigc')
        if policy == 'brand_poster_full_text':
            brand_name = requirements.get('brand', '')
            slogan = requirements.get('slogan', '')
            selling_points = requirements.get('selling_points', '')
            enriched['prompt_suffix'] = (
                f', include brand name "{brand_name}", slogan "{slogan}", '
                f'and key selling points "{selling_points}" as text overlay '
                'with professional typography, visually stunning design; '
                'do not render the full article title as overlay text'
            )
            enriched['title_bound'] = False
        elif policy == 'no_aigc':
            enriched['prompt_suffix'] = None  # 不使用 AIGC（场景图默认值）
        
        enriched_images.append(enriched)
    
    return enriched_images
```


### Step 1.2：企业提交图片库匹配与阻断（★ v5 新增）

> **核心原则**：企业真实图片只来自客户提交图片库。S1/S7/官网/网络/图库/AIGC 只能提供风格参考或抽象视觉，不得替代企业实图。

```python
from pathlib import Path
import json, shutil

def select_client_submitted_asset(img_spec, manifest, output_path):
    """从企业提交图片库中选择与 image_requirements 匹配的素材。"""
    if img_spec.get('requires_client_submitted_asset') is not True:
        return None

    if img_spec.get('source_policy') != 'client_submitted_image_library_only':
        raise ValueError(f"{img_spec['fig_id']} requires client image but source_policy is invalid")

    allowed_ids = set(img_spec.get('allowed_asset_ids') or [])
    query = img_spec.get('approved_asset_query') or {}
    query_types = set(query.get('asset_types') or [])
    query_keywords = set(query.get('scene_keywords') or [])
    quality_requirement = query.get('quality_requirement', 'usable_ok')

    candidates = []
    for asset in manifest.get('assets', []):
        if asset.get('client_approved') is False:
            continue
        if asset.get('rights_status') in ('restricted', 'restricted_not_allowed', 'no_permission', 'copyright_blocked'):
            continue
        if allowed_ids and asset.get('asset_id') not in allowed_ids:
            continue
        if query_types and asset.get('asset_type') not in query_types:
            continue
        if quality_requirement == 'high_only' and asset.get('quality_grade') != 'high':
            continue
        if query_keywords:
            asset_words = set(asset.get('scene_keywords') or []) | set(asset.get('visual_roles') or [])
            if not (asset_words & query_keywords):
                continue
        candidates.append(asset)

    if not candidates:
        return {
            'blocked': True,
            'fig_id': img_spec['fig_id'],
            'reason': 'no_matching_client_submitted_asset',
            'required_query': query,
            'message': '请客户补充并确认对应企业实图后再继续该篇配图。'
        }

    selected = candidates[0]
    src = Path(manifest.get('library_root', '.')) / selected['file_path']
    shutil.copy2(src, output_path)
    return {
        'blocked': False,
        'fig_id': img_spec['fig_id'],
        'output_path': str(output_path),
        'generation_method': 'client_submitted_image_library',
        'source': 'client_submitted_image_library',
        'source_asset_id': selected['asset_id'],
        'client_submitted': True,
        'rights_status': selected.get('rights_status'),
        'allowed_usage': selected.get('allowed_usage', []),
        'people_release_status': selected.get('people_release_status', 'not_applicable'),
        'library_manifest_sha256': manifest.get('manifest_sha256', ''),
        'source_file_hash': selected.get('sha256', '')
    }
```

若任意图片返回 `blocked=true`，E3 必须输出 `E3_{brand}_{article_id}_missing_client_image_request.json`，并停止该篇进入 E4。该阻断不能由 E3 自行降级绕过。

### Step 1.5：Prompt Plan 构建与输出（v2.7 新增）

> **★ 核心新增**：在实际生成图片之前，先为每张 AIGC 图片构建完整的 Prompt Plan，并输出为独立的可审查工件。此步骤将 E2 的 `prompt_layers` 预规划与 S7 的实际 Prompt 模板合并，产出每张图的最终 Prompt。

```python
import json
from datetime import datetime

def build_prompt_plan(enriched_images, s7_prompts, brand_info):
    """
    为每张 AIGC 图片构建完整的 Prompt Plan。
    
    输出独立的 prompt_plan.json 工件，供 E4 审查和回溯。
    """
    prompt_plan = {
        "brand": brand_info.get('brand_name', ''),
        "article_id": brand_info.get('article_id', ''),
        "generated_at": datetime.now().isoformat(),
        "s7_version": s7_prompts.get('version', ''),
        "prompts": []
    }
    
    for img in enriched_images:
        if img.get('generation_method') != 'ai_generate_brand_poster':
            continue
        
        # 层级 1：S7 基底（从 visual_motifs 中提取）
        s7_base = img.get('base_prompt', '')
        
        # 层级 2：E2 场景描述叠加
        prompt_layers = img.get('prompt_layers', {})
        scene_overlay = prompt_layers.get('scene_overlay', img.get('prompt_guidance', ''))
        
        # 层级 3：文字策略后缀
        text_policy_suffix = img.get('prompt_suffix', '')
        
        # 层级 4：本地化标签
        localization_tags = prompt_layers.get('localization_tags', [])
        localization_str = ', '.join(localization_tags) if localization_tags else ''
        
        # 拼装最终 Prompt
        final_prompt_parts = [s7_base, scene_overlay, localization_str, text_policy_suffix]
        final_prompt = ', '.join([p for p in final_prompt_parts if p.strip()])
        
        # 负面提示词
        negative_prompt = prompt_layers.get('negative_prompt_hint', '')
        if not negative_prompt:
            # 默认负面提示词
            negative_prompt = (
                'blurry, low quality, distorted, deformed, '
                'golden seal, wax seal, medal, Western office, '
                'certificate badge, award trophy'
            )
        
        prompt_entry = {
            "fig_id": img['fig_id'],
            "type": img.get('type', ''),
            "layers": {
                "s7_base": s7_base,
                "scene_overlay": scene_overlay,
                "localization": localization_str,
                "text_policy_suffix": text_policy_suffix,
            },
            "final_positive_prompt": final_prompt,
            "negative_prompt": negative_prompt,
            "generation_strategy": img.get('generation_strategy', 'text2img'),
            "reference_assets": img.get('reference_assets', []),
            "img2img_reference": img.get('img2img_reference', None),
            "tool_params": img.get('tool_params', {}),
            "aigc_text_policy": img.get('aigc_text_policy', 'no_text'),
            "s7_prompt_ref": img.get('s7_prompt_ref', ''),
            "title_bound": img.get('title_bound', False),
            "title_binding_note": "v3.2: visual binds to theme/brand, not a full publish title",
        }
        prompt_plan["prompts"].append(prompt_entry)
    
    return prompt_plan


def save_prompt_plan(prompt_plan, output_path):
    """Prompt Plan 输出为独立 JSON 工件。"""
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(prompt_plan, f, ensure_ascii=False, indent=2)
    print(f"✅ Prompt Plan 已输出: {output_path}")
```

**Prompt Plan 输出文件**：`E3_{brand}_{article_id}_prompt_plan.json`

**标题池兼容校验（v3.2）**：每张 AIGC 品牌海报的 `title_bound` 默认必须为 `false`；除非用户明确要求带标题封面，否则图片不得包含完整文章标题。

**核心价值**：
- 使每张图的完整 Prompt 可审查、可回溯（E4 可在审查时对照 Prompt Plan 检查图片是否符合预期）
- 将 S7 视觉资产 Prompt 与 E2 的场景描述显式结合，而非在运行时隐式拼接
- 为后续迭代提供 Prompt 历史记录（重生成时可对比前后 Prompt 差异）

---

### Step 2：图片分流生产（★ v4 重构）

根据 `generation_method`、`source_policy`、`requires_client_submitted_asset` 和 `source_priority` 字段，将图片分流到三条生产线：

| 生产线 | 适用类型 | 说明 |
|:---|:---|:---|
| 企业提交图片库 | `enterprise_photo` | 客户提交并经 E0 校验的真实图片 |
| AIGC 品牌海报 | `aigc_brand_poster` | GPT-image-2 生成的精美封面海报 |
| Mermaid/D2 流程图 | `mermaid_or_d2_flowchart` | 仅 A4/A6/A11 可用 |

#### 2.0 企业提交图片库获取（`client_submitted_image_library`）—— ★ v5 最高优先级 / 强制来源

适用类型：`enterprise_photo`、`brand_photo`、`product_photo`、`team_photo`、`certificate_photo`、`case_photo`、`service_scene`、`environment_photo`。

当图片位满足任一条件时，E3 必须走本生产线：

- `generation_method = "client_submitted_image_library"`
- `source_policy = "client_submitted_image_library_only"`
- `requires_client_submitted_asset = true`

处理规则：

1. 读取 E0 输出的企业提交图片库 Manifest 和索引。
2. 按 `allowed_asset_ids` 优先精确匹配；没有精确 ID 时按 `approved_asset_query.asset_types`、`scene_keywords`、`quality_requirement` 匹配。
3. 复制原图或按文章尺寸要求裁切导出，不得改变事实性内容，不得生成不存在的产品/人物/证书/环境。
4. 输出 metadata 必须写入：`source_asset_id`、`client_submitted=true`、`rights_status`、`allowed_usage`、`people_release_status`、`library_manifest_sha256`、`source_file_hash`。
5. 若匹配失败，输出缺图请求并阻断：`E3_{brand}_{article_id}_missing_client_image_request.json`。

**禁止降级链路**：企业提交图片库缺图 → **不得** 网络搜索 → **不得** 行业图库 → **不得** AIGC 场景图。唯一允许动作是请求客户补充图片库。

---

#### 2.1 AIGC 品牌海报生产（`ai_generate_brand_poster`）—— ★ v10 GPT-image-2 终稿

> **★ v4 重要变更**：AIGC 产线从 v3 的“封面 + 场景”双功能精简为“封面品牌海报专用”。A 类文章首图统一使用 AIGC 生成精美品牌海报（含品牌名 + Slogan + 核心卖点文字）。AIGC 场景图已被完全取消。

适用类型：`aigc_brand_poster`（A 类首图正式首选）。

**v10 强制要求**：
- 默认工具：`gpt-image-2`；若项目另行指定同级图像生成工具，必须在 metadata 中写明批准原因。
- HTML/CSS/SVG/PPT 只允许作为 `layout_draft`，不能作为最终输出。
- 最终图片 metadata 必须写入：`final_asset_origin="gpt-image-2"`、`finalization_method="image_generation_final"`、`render_stage="final"`、`html_draft_used=false`。
- 若只能生成 HTML 草图，必须输出 `E3_{brand}_{article_id}_visual_finalization_blocker.json` 并停止进入 E4。

```python
def generate_aigc_brand_poster(img_spec, output_path):
    """
    ★ v4：A 类首图统一使用 AIGC 品牌海报（正式首选）。
    
    生成精美品牌海报，包含品牌名 + Slogan + 核心卖点文字。
    必须使用 S7 Prompt 模板作为基础，叠加文字控制策略。
    """
    base_prompt = img_spec.get('base_prompt', '')
    prompt_suffix = img_spec.get('prompt_suffix', '')
    style_params = img_spec.get('style_params', {})
    
    # v2.6: 提取视觉资产约束
    img2img_ref = img_spec.get('img2img_reference')  # Logo/截图文件路径
    reference_assets = img_spec.get('reference_assets', [])  # S1 视觉资产引用
    color_source = img_spec.get('color_source', 'inferred')  # 色彩来源
    recommended_tool = img_spec.get('recommended_tool', '')
    
    # 构建最终 Prompt
    final_prompt = f"{base_prompt}{prompt_suffix}"
    
    # v2.6: 构建生成策略
    generation_strategy = 'text2img'  # 默认纯文本生成
    if img2img_ref and os.path.exists(img2img_ref):
        generation_strategy = 'img2img'  # 有垫图参考，使用图生图
    
    # v2.6: 根据工具选择生成参数
    tool_params = {}
    if generation_strategy == 'img2img':
        if recommended_tool == 'Midjourney':
            tool_params = {
                'cref': img2img_ref,  # --cref 参考
                'cw': 60,  # character weight
            }
        elif recommended_tool in ('Flux.1', 'SDXL'):
            tool_params = {
                'ip_adapter_image': img2img_ref,
                'ip_adapter_weight': 0.4,
            }
    
    # 调用 AI 绘画工具（使用 generate 工具）
    # 实际执行时由 E0 编排师通过 generate 工具调用
    result = {
        'fig_id': img_spec['fig_id'],
        'prompt_used': final_prompt,
        'style_params': style_params,
        'output_path': output_path,
        's7_prompt_ref': img_spec.get('s7_prompt_ref', ''),
        'generation_method': 'ai_generate_brand_poster',
        'required_generation_tool': 'gpt-image-2',
        'final_asset_origin': 'gpt-image-2',
        'finalization_method': 'image_generation_final',
        'render_stage': 'final',
        'html_draft_used': False,
        'generation_strategy': generation_strategy,  # v2.6
        'img2img_reference': img2img_ref,  # v2.6
        'reference_assets': reference_assets,  # v2.6
        'color_source': color_source,  # v2.6
        'tool_params': tool_params,  # v2.6
    }
    
    return result
```

**AIGC 品牌海报质量要求**（★ v4：A 类首图正式首选）：
- 分辨率：≥ 1024×1024（品牌封面海报）
- 品牌名称准确性：`brand_poster_full_text` 策略下，品牌名称 + Slogan + 卖点文字拼写必须正确
- 设计感：专业精美、信息层次清晰、一目了然
- 注意：场景图已完全取消 AIGC，改用企业实拍图/网络图

**★ AIGC 五维度质量打分（逐张执行，v2.7 新增）**：

每张 AIGC 生成的图片，必须按以下 5 个维度进行自评打分（1-5 分），**总分低于 15 分或任一维度低于 3 分的图片必须重新生成**：

| 维度 | 5 分（优秀） | 3 分（及格） | 1 分（不合格） |
|:---|:---|:---|:---|
| **场景真实感** | 看起来像真实照片，光影自然 | 基本像照片，有轻微AI痕迹 | 明显AI生成感，塑料质感、扭曲 |
| **语境匹配度** | 场景元素完全匹配中国企业/行业语境 | 大部分匹配，个别元素不够本地化 | 出现外国面孔、西方建筑、不相关场景 |
| **专业可信度** | 专业人士看到会认为是真实工作场景 | 非专业人士不会质疑 | 一看就是AI生成的装饰图，无专业感 |
| **Caption 一致性** | 图片内容与 Caption 描述完全吻合 | 大致相关，但细节有偏差 | 图片与 Caption 描述的场景明显不符 |
| **品牌形象** | 提升品牌专业形象 | 不损害品牌形象 | 损害品牌形象（低质、不专业、不真实） |

**打分记录格式**（必须在 `{brand}_{article_id}_image_validation.txt` 中记录）：
```
[A1_fig2] AIGC 场景图 | 场景真实感:4 | 语境匹配度:4 | 专业可信度:4 | Caption一致性:5 | 品牌形象:4 | 总分:21 | ✅ PASS
[A1_fig3] AIGC 场景图 | 场景真实感:2 | 语境匹配度:1 | 专业可信度:2 | Caption一致性:3 | 品牌形象:2 | 总分:10 | ❌ FAIL → 重新生成
```

**不合格图片的处理流程**：
```
AIGC 生成 → 五维度打分 → 不通过 → 修改 Prompt 重新生成（最多 3 次）
                              ↓ 3 次仍不合格
                         输出 visual_finalization_blocker
                              ↓
                         退回 E0 请求人工设计/重新生成

注意：A 类品牌海报不得降级为网络搜索图、HTML草图截图或普通Python信息图。
```

**★ A 类首图品牌名称核查（Gate B2）**：

仅当当前图片是 A 类文章的图 1（品牌宣发首图）时执行：

| 检查项 | 通过标准 | 不通过处理 |
|:---|:---|:---|
| 品牌名称存在 | 图片中可见品牌名称 | 重新生成，强化 Prompt 中的文字指令 |
| 品牌名称正确 | 每个字符完全正确，无错字/变形/缺字 | 重新生成，最多重试 3 次 |
| 无多余文字 | 除品牌名称外无其他文字 | 重新生成，简化 Prompt |
| 整体美观 | 海报风格精美、专业，适合作为搜索封面 | 重新生成，调整风格参数 |

> **注意**：如果 3 次重新生成后品牌名称仍然不正确，改用 Python 生成品牌海报（确保文字精确可控）。

#### 2.2 Mermaid/D2 流程图生产（仅 A4/A6/A11 可用）

适用类型：`mermaid_or_d2_flowchart`。仅当文章类型为 A4、A6、A11 且 E2 图片需求清单中指定了此类型时才生产。

处理规则：
1. 读取 E2 提供的流程描述和节点信息。
2. 使用 Mermaid 或 D2 语法编写图表定义文件。
3. 调用 `manus-render-diagram` 渲染为 PNG 图片。
4. 输出 metadata 写入：`generation_method="mermaid_or_d2"`、`diagram_source_file`。

```python
import subprocess

def generate_flowchart(img_spec, output_path):
    """使用 Mermaid/D2 生成流程图（仅 A4/A6/A11 可用）。"""
    diagram_code = img_spec.get('diagram_code', '')
    diagram_format = img_spec.get('diagram_format', 'mermaid')  # mermaid | d2
    
    ext = '.mmd' if diagram_format == 'mermaid' else '.d2'
    src_file = output_path.replace('.png', ext)
    
    with open(src_file, 'w', encoding='utf-8') as f:
        f.write(diagram_code)
    
    subprocess.run(['manus-render-diagram', src_file, output_path], check=True)
    
    return {
        'fig_id': img_spec['fig_id'],
        'output_path': output_path,
        'generation_method': 'mermaid_or_d2',
        'diagram_source_file': src_file,
    }
```

#### 2.3 网络图片抓取（`web_search`）—— 仅限非企业实图参考

适用类型：仅限公共事件图片、非企业主体的环境参考图、行业示意图，且必须满足 `requires_client_submitted_asset=false`、`source_policy` 不是 `client_submitted_image_library_only`。

> **★ v5 重要变更**：网络图片抓取不再是企业实拍图兜底。它不能用于产品、团队、办公/门店/医院/工厂/实验室、证书、客户案例、活动现场等任何需要企业真实图片的位置。

```python
def search_public_reference_image(img_spec, output_path):
    """
    网络图片仅用于公共参考图或行业示意图。
    若图片位要求企业提交素材但素材未在 E0 图片库中登记，必须直接阻断，不能调用本函数。
    """
    if img_spec.get('requires_client_submitted_asset') is True:
        raise ValueError('client submitted image required; web_search is forbidden')
    if img_spec.get('source_policy') == 'client_submitted_image_library_only':
        raise ValueError('client submitted source policy; web_search is forbidden')

    context = img_spec.get('context', '')
    result = {
        'fig_id': img_spec['fig_id'],
        'output_path': output_path,
        'source': 'public_reference_web_search',
        'generation_method': 'web_search',
        'client_submitted': False,
        'usage_note': '公共参考图/行业示意图，不得表述为企业实拍。'
    }
    return result
```

**网络参考图质量要求**：必须标注来源和授权，不得暗示该图片属于客户企业；如用于媒体分发，E4/E5 必须再次检查授权。

### Step 3：跨文章去重校验

每张图片生成后，必须与 E0 维护的图片注册表进行相似度比对。

```python
import hashlib

def compute_image_hash(image_path):
    """计算图片的 SHA256 哈希值。"""
    with open(image_path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()

def check_dedup(image_path, registry_path, threshold=0.85):
    """
    跨文章去重检查。
    
    计算新图片的哈希值，与注册表中已有图片比对。
    相似度 < threshold 则放行。
    """
    new_hash = compute_image_hash(image_path)
    
    if not os.path.exists(registry_path):
        return True, 0.0  # 注册表为空，直接放行
    
    with open(registry_path, 'r', encoding='utf-8') as f:
        registry = json.load(f)
    
    max_similarity = 0.0
    for entry in registry.get('images', []):
        existing_hash = entry.get('sha256', '')
        if existing_hash == new_hash:
            max_similarity = 1.0
            break
        # 简化的相似度计算（实际应使用感知哈希或特征向量）
        common = sum(a == b for a, b in zip(new_hash, existing_hash))
        similarity = common / len(new_hash)
        max_similarity = max(max_similarity, similarity)
    
    passed = max_similarity < threshold
    return passed, max_similarity
```

**去重规则**：
- 完全相同的哈希值：直接拒绝，必须重新生成
- 相似度 ≥ 0.85：拒绝，调整 Prompt 参数后重新生成
- 相似度 < 0.85：放行，注册到注册表

> **★ 强制脚本去重**：你绝对不能自行判断图片相似度，必须强制依赖 `image_dedup_checker.py` 脚本的计算结果。
> **★ Prompt 级防重**：在生成 AIGC 图片前，必须检查注册表中已有的 Prompt，确保本篇使用的 Prompt 在场景、角度、人物构图上与已有图片有显著差异。

### Step 4：注册表更新与元数据输出

所有图片生成并通过去重校验后：

1. 将每张图片的信息追加到图片注册表
2. 输出图片元数据 JSON

```python
def update_registry(registry_path, article_id, image_results):
    """将本篇生成的图片信息追加到注册表。"""
    if os.path.exists(registry_path):
        with open(registry_path, 'r', encoding='utf-8') as f:
            registry = json.load(f)
    else:
        registry = {"images": []}
    
    for result in image_results:
        entry = {
            "article_id": article_id,
            "fig_id": result['fig_id'],
            "sha256": compute_image_hash(result['output_path']),
            "path": result['output_path'],
            "generation_method": result['generation_method'],
            "s7_prompt_ref": result.get('s7_prompt_ref', ''),
            "timestamp": datetime.now().isoformat(),
        }
        registry["images"].append(entry)
    
    with open(registry_path, 'w', encoding='utf-8') as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)
```


---

## 产出交付规则（v2.6.2 新增）

**必须执行**：本节点的所有文件（JSON/MD/PDF等）生成并校验通过后，**必须立即使用 `message` 工具（type="info" 或 type="result"）将产出文件作为附件发送给用户**。
**禁止暂停**：发送产出后，**禁止**等待用户确认（除非遇到硬性错误或到达预设的全局暂停点），必须立即通知 S0 编排师继续执行下一个节点。

## 校验闸门

| 检查项 | 通过标准 | 验证方法 |
|:---|:---|:---|
| 每张图 ≥ 10KB | 文件大小检查 | `os.path.getsize()` |
| 与注册表已用图相似度 < 0.85 | 去重检查 | `image_dedup_checker.py` |
| AIGC 封面兑底图必须有 S7 prompt_id 引用 | 元数据检查 | JSON 字段校验 |
| 图片数量 = image_requirements 中的数量 | 计数检查 | 文件计数 |
| `aigc_text_policy` 执行正确 | Prompt 检查 | 元数据中的 prompt_used 字段 |
| **★ 企业实拍图优先级执行** | **非 AIGC 图占比 ≥ 80%（A 类）/ 100%（B/C/D 类）** | **图片元数据中的 generation_method 统计** |
| **★ 企业实拍图来源可追溯** | **每张企业实拍图必须标注 source_asset_id** | **图片元数据校验** |
| **Prompt Plan 已输出** | **`prompt_plan.json` 存在且非空** | **文件检查** |
| **AIGC 五维度质量打分** | **每张 AIGC 图总分 ≥15，每项 ≥3** | **打分记录文件** |
| **图片类型合规** | **只允许 aigc_brand_poster / enterprise_photo / mermaid_or_d2_flowchart 三种** | **image_requirements.json type 字段校验** |
| **A 类首图品牌名核查** | **品牌名称正确显示、无错字变形** | **目视检查** |

## 子文件引用

- `../shared/enterprise-image-library-policy.md` - 企业提交图片库来源、授权、匹配、缺图阻断与下游视觉使用规范


| 文件路径 | 用途 |
|:---|:---|
| `references/image-generation-method.md` | 图片生成方法论详解 |
| `templates/image_validation_template.txt` | 图片验证报告模板 |
| `templates/prompt_plan_schema.json` | Prompt Plan 输出格式规范 |
| `scripts/image_dedup_checker.py` | 跨文章去重检查器 |
| `scripts/aigc_invoker.py` | AIGC 调用封装器 |
| `scripts/prompt_plan_builder.py` | Prompt Plan 构建器 |

## 双格式输出标准

参见 `shared/output-format-standard.md`。E3 的输出为图片文件（PNG/WebP）和 JSON 元数据，不涉及 MD/PDF 双格式。
