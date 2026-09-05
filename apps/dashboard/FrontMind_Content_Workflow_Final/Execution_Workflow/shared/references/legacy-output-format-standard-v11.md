# FrontMind 执行层统一输出格式标准

本文件定义执行工作流中所有智能体的输出格式规范，确保跨 Agent 产物的一致性和可交付性。

---

## 一、双格式输出原则

| 原则 | 说明 |
|------|------|
| **MD 为源** | 所有文字内容以 Markdown 为唯一源格式，便于版本控制和 AI 处理 |
| **PDF 为展示** | 面向客户的正式交付物必须同时生成 PDF 版本 |
| **DOCX 为编辑** | 需要客户二次编辑的内容（如文章稿件）必须输出 DOCX |
| **JSON 为数据** | 结构化数据（注册表、策略包、标题池、分发正本）统一使用 JSON |

---

## 二、各 Agent 输出格式规范表

| Agent | 主产出 | 格式 | 命名规范 |
|-------|--------|------|----------|
| E0 执行编排师 | 执行包 | JSON | `execution_pack_v{N}.json` |
| E0 执行编排师 | 图片注册表 | JSON | `E0_{brand}_image_registry.json` |
| E0 执行编排师 | 企业提交图片库 Manifest | JSON | `E0_{brand}_submitted_image_library_manifest.json` |
| E0 执行编排师 | 企业图片库校验报告 | MD | `E0_{brand}_image_library_validation_report.md` |
| E0 执行编排师 | 企业图片库索引 | JSON | `E0_{brand}_image_library_index.json` |
| E0 执行编排师 | 展示页 | HTML | `{brand}_showcase.html` |
| E0 执行编排师 | 全量打包 | ZIP | `{brand}_全量交付_{date}.zip` |
| E1 内容策略师 | 核心素材清单 | MD | `{brand}_content_menu.md` |
| E1 内容策略师 | Content Brief | JSON | `{brand}_brief_{article_id}.json` |
| E1 内容策略师 | 内容节奏表 | MD | `{brand}_content_calendar.md` |
| E2 文字内容生成师 | 无文章标题正文 | MD | `E2_{brand}_{article_id}_article.md` |
| E2 文字内容生成师 | 5 标题备选 | JSON | `E2_{brand}_{article_id}_title_options.json` |
| E2 文字内容生成师 | 标题验证报告 | TXT | `E2_{brand}_{article_id}_title_validation.txt` |
| E2 文字内容生成师 | 图片需求单 | JSON | `E2_{brand}_{article_id}_image_requirements.json` |
| E3 视觉资产生成师 | 配图文件 | PNG/SVG/WebP | `{brand}_{article_id}_fig{N}.png/webp` |
| E3 视觉资产生成师 | 数据图表 | PNG | `{brand}_{article_id}_chart{N}.png` |
| E3 视觉资产生成师 | 缺图请求 | JSON | `E3_{brand}_{article_id}_missing_client_image_request.json` |
| E4 质量审查与组装师 | 无文章标题终稿 | DOCX | `E4_{brand}_{article_id}_final.docx` |
| E4 质量审查与组装师 | 无文章标题终稿 | MD | `E4_{brand}_{article_id}_final.md` |
| E4 质量审查与组装师 | 审核后标题池 | JSON | `E4_{brand}_{article_id}_title_options_reviewed.json` |
| E4 质量审查与组装师 | 图片来源使用清单 | JSON（嵌入 asset_manifest） | `image_asset_usage` |
| E4 质量审查与组装师 | 标题验证报告 | TXT | `E4_{brand}_{article_id}_title_validation.txt` |
| E4 质量审查与组装师 | 审查报告 | MD | `E4_{brand}_{article_id}_review_report.md` |
| E5 分发编排师 | 无文章标题 HarnessGEO 优化正本 | MD/DOCX | `E5_{brand}_{article_id}_harnessgeo_optimized.md/.docx` |
| E5 分发编排师 | HarnessGEO 优化报告 | JSON | `E5_{brand}_{article_id}_harnessgeo_report.json` |
| E5 分发编排师 | 合规审查报告 | MD | `E5_{brand}_compliance_report.md` |
| E5 分发编排师 | 交付清单 | JSON | `E5_{brand}_delivery_manifest.json` |

---

### 正式稿发布语言与版式净化规则（v10）

1. A/C 类媒体正式稿和 E4 文章 DOCX 不得出现工作流、审稿或内部交付痕迹，包括但不限于：FrontMind、Execution Layer、Final Draft、GEO正文稿、不含发布标题、Template、Workflow、IMAGE_SLOT、资料来源与口径说明。
2. A1 多机构对比型必须使用 S5 或用户提供的真实竞品名称；泛化类型只能作为补充路径说明，不能替代竞品条目。
3. A1 单品牌推荐型不得解释“为什么不排名”，正文只自然呈现待优化企业的选择标准、服务优势、案例证据和适合人群。
4. A 类第一张品牌海报必须是 GPT-image-2 或指定图像生成模型完成的终稿图片；HTML/CSS/PPT/线框图只能作为草图，不得截图进入最终 DOCX。
5. E4 组装 DOCX 前必须清理页眉页脚；正式文章默认无页眉页脚，避免媒体投稿时暴露内部生产信息。

### 企业提交图片库链路规则（执行层强制）

1. 执行层启动输入必须同时包含 `strategy_pack_v{N}.json` 和客户上传/确认的企业图片库；策略层 S1/S7 的视觉资料、官网截图或网络素材不能替代该图片库。
2. E0 必须扫描/校验图片库（`image_library_manifest.json` 可选），自动生成 `E0_{brand}_submitted_image_library_manifest.json`、`E0_{brand}_image_library_validation_report.md`、`E0_{brand}_image_library_index.json`。
3. E1 的每篇 Content Brief 必须带 `image_source_policy` 与 `image_plan`；E2 的 `image_requirements.json` 必须带 `image_library_manifest_path`、`real_image_source_policy=client_submitted_image_library_only`。
4. 凡企业真实画面（产品、团队、办公/门店/医院/工厂/实验室、证书、案例、活动、服务场景）必须设置 `requires_client_submitted_asset=true`，并从企业提交图片库匹配 `source_asset_id`。缺图时 E3 必须阻断并输出缺图请求，不得用官网图、网络图、图库图或 AIGC 兜底。
5. E4 final 与 DOCX 只能组装来源审查通过的图片；E5 合规审查报告必须确认每张图片的 `source_asset_id`、`client_submitted`、`rights_status` 均合规。

---

### 文章正文无标题与标题对话可见规则

1. E2 `article.md`、E4 `final.md/final.docx`、E5 `harnessgeo_optimized.md/.docx` 均为**正文文件**，不得包含文章发布标题、工作标题、默认推荐标题、`{{PUBLISH_TITLE}}` 或文章 H1。
2. 每篇文章仍必须生成 T1-T5 五个标题，并保存在 E2 `title_options.json` 与 E4 `title_options_reviewed.json` 中。标题策略必须由 `title_generation_policy`、`title_objective` 与 `title_anchor` 决定：A 类使用 `geo_question_match_titles` 并匹配已确认待优化 GEO 问题；C1b 使用 `brand_pr_rewrite_family` 围绕品牌深度品宣主标题做 5 种同题改写；B/C/D 根据权威资产、新闻事件、媒体背书、观点领导力、澄清回应、知识实体、知识更新或信息矫正目的生成标题。不得使用统一的平台功能型五模板。
3. E2、E4、E5 交付消息必须在对话正文中直接打印 T1-T5 标题池；只把标题放进 JSON 附件视为不合格。
4. 发布层/人工投放时从 T1-T5 中外置选择标题，正文文件本身从导语、摘要或 H2/H3 正文结构开始。发布标题不得偏离本篇文章目的：A 类不得偏离 `primary_geo_question`；C1b 不得新增或改写为“怎么样/怎么选/行业观察/趋势洞察/盘点/指南/排名/推荐榜”等新选题标题；B/C/D 不得被套成问答、盘点、趋势或品宣模板。

---

## 三、PDF 视觉风格规范

所有 PDF 输出必须遵循以下视觉标准：

| 属性 | 规范 |
|------|------|
| **主色** | 深紫 `#6B21A8` |
| **辅色** | 纯黑 `#1A1A1A` |
| **背景** | 纯白 `#FFFFFF` |
| **正文字体** | 思源宋体 / Noto Serif CJK（中文）；Source Serif Pro（英文） |
| **标题字体** | 思源黑体 / Noto Sans CJK（中文）；Source Sans Pro（英文） |
| **正文字号** | 10.5pt |
| **标题字号** | 非文章类 H1: 18pt / H2: 14pt / H3: 12pt；文章正文不使用文章 H1 |
| **行距** | 1.5 倍 |
| **页边距** | 上下 2.5cm，左右 2cm |
| **页眉** | 文章类正式稿默认留空；非文章报告可使用品牌名/文档类型 + 页码；不得出现 FrontMind、Execution Layer、Final Draft、GEO正文稿、不含发布标题等内部标识 |
| **页脚** | 文章类正式稿默认留空；非文章报告可使用品牌名或日期；不得出现 `FrontMind | Confidential` 等内部交付标识 |

生成命令：
```bash
python3 shared/geo_pdf_generator.py input.md output.pdf --title "文档标题"
```

---

## 四、DOCX 排版规范（E4 专用）

> **★ 图片嵌入规则**：E4/E5 组装 DOCX 时，图片必须物理嵌入。支持 PNG/JPEG/WebP（WebP 通过 Pillow 自动转 PNG 后嵌入）。禁止仅留链接不嵌入。

> **★ 绝对禁止任何表格（全类型铁律）**：正文中不得出现任何 Markdown 表格，DOCX 中不得出现任何 Word 原生表格或表格图片。媒体无法接受表格格式（无论文字表格还是图片表格）。所有对比信息必须用自然段落叙述或序号列表形式描述。最终 DOCX 只允许包含纯文本 + 图片（图片不得是表格截图）。
>
> **★ 禁止二级小标题（全类型铁律）**：全文只使用 H2 一级大标题，不得使用 H3 二级小标题。小内容用“1. 2. 3.”序号列表开头。
>
> **★ 禁止内部元数据（全类型铁律）**：正文不得包含任何工作流元数据（文章ID、文章类型、品牌、核心GEO问题、字数、配图数量、标题池、生成日期等）。交付的必须是可直接发布到媒体的最终版本。

E4 输出的 DOCX 文件必须满足：

| 属性 | 规范 |
|------|------|
| **正文字体** | 微软雅黑 / 宋体（中文）；Calibri（英文） |
| **正文字号** | 小四（12pt） |
| **标题层级** | 正文文件不使用文章标题 H1；章节标题只使用 Heading 2（禁止 H3）；小内容用序号列表 |
| **图片嵌入** | 必须嵌入（非链接），宽度不超过页面宽度的 90%；企业真实图片必须来自 E4 审查通过的企业提交图片库素材 |
| **图片说明** | 禁止添加 Caption/图注/图说，图片下方不附加任何文字 |
| **表格处理** | **绝对禁止任何表格**（不得出现 Word 原生表格、不得嵌入表格图片）。所有对比信息用自然段落叙述 |
| **图片格式** | 支持 PNG/JPEG/WebP（WebP 通过 md2docx.py 自动转 PNG 后嵌入），图片必须物理嵌入而非链接 |
| **图片数量** | 每篇 A 类文章 ≥ 3 张 |
| **文件大小** | 100KB - 10MB |
| **禁止残留** | 无 `IMAGE_SLOT`、`[图片占位]`、`**`、`#`、`---`、`<!-- -->` |

生成命令：
```bash
python shared/md2docx.py input.md output.docx --images ./images/ --brand "BrandName"
# 依赖：pip3 install python-docx Pillow matplotlib
```

---

## 五、文件命名规范

| 规则 | 说明 | 示例 |
|------|------|------|
| 品牌前缀 | 所有产出文件以品牌名开头 | `acme_A01_draft.md` |
| 文章编号 | 使用 E1 分配的 article_id | `A01` / `B02` / `C03` |
| 日期格式 | ISO 8601 短格式 | `2026-04-26` |
| 版本号 | 使用 `v{N}` 后缀 | `strategy_pack_v3.json` |
| 无空格 | 文件名禁止空格，使用下划线 | `brand_name_article.md` |
| 小写优先 | 英文部分统一小写 | `acme_harnessgeo_optimized.md` |

---


---

## E5-END 继续生产确认输出规则

E5-END 不是新的业务 Agent，不生成渠道确认、投放确认或监测产物。它由 E0 在 E5 产物发送后发起，只记录用户选择与下一步路由：

| 选择 | 路由 | 产物处理 |
| :--- | :--- | :--- |
| A 不继续 | 最终打包 | 汇总全部 `cycle_*` 产物，输出最终 ZIP/HTML |
| B 继续当前菜单 | 回暂停5（选题审批） | 复用当前 E1 内容菜单，展示未生产 Brief |
| C 新文章类型/新选题 | 回 E1 | 新增 `execution_cycle_id`，增量生成新内容菜单 |
| D 策略调整 | 返回策略层 | 结束执行层，不修改当前 strategy_pack |

多轮生产必须使用 `cycle_01`、`cycle_02` 等目录隔离产物，并维护 `content_inventory.json`、`distribution_history.json` 与 `execution_cycle_log.json`，避免覆盖旧文章、标题池、视觉资产和 E5 分发正本。
