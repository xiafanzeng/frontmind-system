# 图片生成方法论

> E3 视觉资产生成师在执行图片生产时必须遵循本方法论。本文档定义了四类图片的生产标准、企业实拍图优先级规范、S7 Prompt 包的使用规范和跨文章去重策略。
>
> **★ v10 核心变化**：封面图保留 AIGC 品牌海报为正式首选，且必须经过 GPT-image-2 或用户明确批准的同级图像生成模型完成最终美化。HTML/CSS/PPT/线框图只允许作为草图，不得截图当最终图片。场景图改为企业提交图片库为唯一真实图片来源，完全取消 AIGC 场景图和网络/图库兜底。

---

## 一、四类图片生产体系（★ v4 重构）

### 1.1 图片分类与生产线

FrontMind 执行层的图片生产分为四条生产线，按优先级从高到低排序：

| 优先级 | 生产线 | 适用类型 | 工具链 | 质量标准 |
|:---:|:---|:---|:---|:---|
| **P1** | ★ AIGC 品牌海报生产线 | `aigc_brand_poster` | **GPT-image-2 / 指定图像生成模型 + S7 Prompt** | 分辨率 ≥ 1024px，A 类首图正式首选；HTML草图不得作为最终图 |
| **P2** | 企业提交图片库生产线 | `enterprise_photo`、`brand_photo`、`team_photo`、`certificate_photo`、`case_photo` | E0 校验通过的客户提交图片库 + asset_id/语义匹配 | 分辨率 ≥ 800px，客户提交，授权可用 |
| **P3** | 公共参考图生产线 | `web_search` | 仅公共事件/行业示意图，不得作为企业实图 | 分辨率 ≥ 800px，授权合规，明确非企业实拍 |
| **P4** | Mermaid/D2 流程图生产线 | `mermaid_or_d2_flowchart`（仅 A4/A6/A11） | Mermaid / D2 渲染 | 清晰可读，中文标注 |

> **★ 重要**：AIGC 场景图已被完全取消。原 `aigc_scene` 类型不再存在，所有企业真实场景图均改用企业提交图片库；网络图片仅可作非企业主体的公共参考。

### 1.2 生产线选择决策树（★ v4 重构）

```
image_requirements.json 中的 generation_method 字段：
  → "ai_generate_brand_poster"     → AIGC 品牌海报生产线（A 类首图正式首选，必须 gpt-image-2/指定图像模型终稿）
  → "client_submitted_image_library" → 企业提交图片库生产线（企业真实图片唯一来源）
  → "web_search"                   → 网络图片抓取生产线
  → "mermaid_d2"                   → Mermaid/D2 流程图生产线（仅 A4/A6/A11）
  → "brand_knowledge_base"          → 企业实拍图生产线（同 P2）

企业真实图缺失处理：
  企业提交图片库匹配失败 → 输出缺图请求并阻断 → 请求客户补图/补授权；不得降级为网络图、图库图或 AIGC
```

---

## 二、企业提交图片库生产线详解（★ v5 强制）

### 2.0 企业提交图片获取流程

**核心原则**：场景图/氛围图/产品/团队/证书/案例/环境等真实企业图片，只能使用 E0 校验通过、客户提交的图片库素材。真实图片更能建立信任，且具备授权可追溯性。注意：抽象封面海报可使用 AIGC，但不得伪造企业实拍。

**获取优先级**：

| 优先级 | 来源 | 说明 | 质量要求 |
|:---:|:---|:---|:---|
| P1 | 客户提交图片库 asset_id 精确匹配 | E0 Manifest 中未显式禁止的素材 | 分辨率 ≥ 800px，授权覆盖目标用途 |
| P2 | 客户提交图片库语义匹配 | 按 asset_type、scene_keywords、visual_roles 选择 | 分辨率 ≥ 800px，授权覆盖目标用途 |
| 阻断 | 缺图/缺授权 | 输出 missing_client_image_request，退回 E0 请求客户补图或补授权 | 不得兜底网络图/图库图/AIGC |

### 2.0.1 企业提交图片库匹配策略

根据 E2 提供的 `approved_asset_query` / `allowed_asset_ids` 字段进行匹配：

1. **类别匹配**：按 `approved_asset_query.asset_types` 或 `allowed_asset_ids` 筛选（product_photo > team_photo > office_photo > certificate_photo > case_photo > event_photo）
2. **场景匹配**：按 `scene_keywords` 语义匹配图片描述
3. **质量匹配**：按 `quality_requirement` 筛选（首图必须 high_only，其他可 usable_ok）
4. **来源确认**：候选素材不得显式 `client_approved=false`，`rights_status` 不得为 restricted/no_permission，且 `allowed_usage` 覆盖目标用途；无匹配时阻断并请求客户补图/补授权

---

## 三、AIGC 品牌海报生产线详解（★ v4 修订）

> **★ v4 重要变更**：AIGC 产线从 v3 的“封面 + 场景”双功能精简为“封面品牌海报专用”。A 类文章首图统一使用 AIGC 生成精美品牌海报（含品牌名 + Slogan + 核心卖点文字）。AIGC 场景图已被完全取消。

### 3.1 S7 Prompt 包使用规范

**强制要求**：生成 AIGC 品牌海报时，必须以 S7 视觉 Prompt 包中的模板为基础。

S7 Prompt 包的结构：

```json
{
  "S7_brand_hero_01": {
    "prompt": "Professional brand poster for {brand_name}...",
    "style": {
      "aspect_ratio": "16:9",
      "color_palette": ["#hex1", "#hex2"],
      "mood": "professional, trustworthy"
    },
    "category": "brand_poster"
  },
  "S7_scene_01": {
    "prompt": "Realistic industrial scene...",
    "style": {
      "aspect_ratio": "16:9",
      "mood": "authentic, professional"
    },
    "category": "scene"
  }
}
```

**Prompt 构建流程**：

1. 从 S7 包中提取 `base_prompt`
2. 替换模板变量（`{brand_name}`、`{industry}`、`{scene}`）
3. 叠加 `aigc_text_policy` 对应的文字控制后缀
4. 叠加 E2 提供的 `prompt_guidance` 中的场景细节
5. 最终 Prompt = `base_prompt` + 场景细节 + 文字控制后缀

### 3.2 AIGC 品牌海报文字策略执行规范（★ v4 修订）

| 策略值 | Prompt 后缀 | 适用场景 |
|:---|:---|:---|
| `brand_poster_full_text` | `include brand name "{brand_name}", slogan "{slogan}", and key selling points as text overlay with professional typography` | A 类首图品牌海报（正式首选） |
| `no_aigc` | 不使用 AIGC 生成 | 所有场景图/氛围图（默认值） |

> **★ v4 变更**：封面海报允许带品牌名 + Slogan + 核心卖点文字，要求设计感强、一目了然。场景图不再使用 AIGC，因此无需场景图相关策略。

### 3.3 AIGC 品牌海报质量控制

**终稿来源硬规则**：

| 字段 | 合格值 | 不合格值 |
|:---|:---|:---|
| `final_asset_origin` | `gpt-image-2` 或用户批准的 `approved_image_generation_model` | `html_screenshot`、`css_render`、`wireframe`、`draft` |
| `finalization_method` | `image_generation_final` | `html_render_only`、`screenshot_only`、`draft_render` |
| `render_stage` | `final` | `draft`、`layout_draft` |
| `html_draft_used` | `false`；如使用过草图，也必须再经图像模型重绘美化 | `true` 且未重绘 |

如果无法满足上述字段，E3 必须阻断，不得把草图交给 E4。

| 检查项 | 标准 | 处理方式 |
|:---|:---|:---|
| 分辨率 | ≥ 1024×1024 | 不达标则重新生成 |
| 品牌名准确 | 品牌名称拼写完全正确 | 拼写错误则重新生成，最多 3 次 |
| Slogan 准确 | Slogan 文字与 S1 记录一致 | 不一致则重新生成 |
| 设计感 | 专业精美、信息层次清晰、一目了然 | 不达标则调整 Prompt 重新生成 |
| 内容相关 | 图片风格与行业/品牌调性匹配 | 不匹配则调整 Prompt 重新生成 |

---

## 四、数据图表生产线详解

### 3.1 通用样式规范

所有数据图表必须遵循以下样式规范：

| 样式项 | 规范 |
|:---|:---|
| DPI | ≥ 150 |
| 字体 | 中文：SimHei / 英文：DejaVu Sans |
| 背景色 | 白色 (#FFFFFF) |
| 网格线 | 浅灰色 (#E0E0E0)，虚线 |
| 数据源标注 | 图片底部居中，8pt 斜体灰色 |
| 标题 | 图片顶部居中，14pt 加粗 |
| 图例 | 右上角或底部，不遮挡数据 |

### 3.2 对比表格图专用规范

对比表格图是 FrontMind 中使用频率最高的数据图表类型，必须遵循以下规范：

| 规范项 | 要求 |
|:---|:---|
| 表头颜色 | 深色（可根据品牌色自定义） |
| 行背景 | 交替颜色（#F8F9FA / #FFFFFF） |
| 单元格内容 | 必须是文字描述，禁止星级评分/数值打分/等级评定 |
| 列宽 | 根据内容自适应，确保文字不截断 |
| 边框 | 细线边框（#DEE2E6） |

### 3.3 流程图生产规范

使用 Mermaid 或 D2 语法生成流程图：

| 工具 | 适用场景 | 渲染命令 |
|:---|:---|:---|
| Mermaid | 简单流程图、时序图 | `manus-render-diagram input.mmd output.png` |
| D2 | 复杂架构图、系统图 | `manus-render-diagram input.d2 output.png` |

---

## 五、公共参考图生产线详解（`web_search` 限制使用）

### 5.1 使用边界

`web_search` 仅可用于公共事件图、行业示意图、非企业主体的参考素材；不得用于产品、团队、办公室/门店/医院/工厂/实验室、证书、客户案例、服务现场等企业真实图片位。

若 `requires_client_submitted_asset=true` 或 `source_policy=client_submitted_image_library_only`，E3 必须直接阻断，不能调用网络图片抓取。

### 5.2 授权合规要求

| 来源 | 授权类型 | 使用限制 |
|:---|:---|:---|
| 公共参考图 | 需明确授权或可商用许可 | 必须标注来源，不能表述为客户企业实拍 |
| 行业示意图 | 需明确授权或可商用许可 | 仅用于泛场景说明，不得承载企业事实 |

## 六、跨文章去重策略

### 5.1 去重机制

E0 维护一个全局图片注册表（`E0_{brand}_image_registry.json`），记录所有已生成图片的哈希值。E3 每次生成新图片后，必须与注册表比对。

### 5.2 去重阈值

| 相似度 | 处理方式 |
|:---|:---|
| = 1.0（完全相同） | 拒绝，必须重新生成 |
| ≥ 0.85 | 拒绝，调整 Prompt 参数后重新生成 |
| < 0.85 | 放行，注册到注册表 |

### 5.3 去重失败处理

如果连续 3 次生成的图片都未通过去重校验：
1. 调整 Prompt 中的场景描述（增加差异化细节）
2. 更换 S7 Prompt 模板中的 style 参数
3. 如仍无法通过，标记为"去重异常"并报告给 E0

---

## 七、图片文件命名与存储

### 6.1 命名规范

```
{brand}_{article_id}_fig{N}.{ext}
```

示例：`华测环保_A1_fig1.png`、`华测环保_A1_fig2.webp`

### 6.2 格式选择

| 图片类型 | 推荐格式 | 说明 |
|:---|:---|:---|
| 企业实拍图 | PNG/WebP | 保持原始格式，优先 PNG |
| AIGC 封面兑底图 | PNG | 保持最高质量 |
| 数据图表 | PNG | matplotlib 默认输出 |
| 公共参考图 | WebP | 压缩率高，适合网页；不得表述为企业实拍 |
| 最终嵌入 DOCX | WebP | E4 会统一转换为 WebP |
