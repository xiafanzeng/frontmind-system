---
name: frontmind-text-content-producer
description: >
  E2 文字内容生成师（执行层第 2 位 / 文字内容生产）。基于 E1 的 Content Brief 和策略层
  S6 话语 Token，每次专注高质量生产单篇文章的文字内容（不含配图），正文文件不写入文章标题；同时按文章类型与任务目的输出 5 个分发标题备选、
  在交付消息中显式打印 T1-T5 标题，并生成绑定企业提交图片库的图片需求清单（供 E3 执行配图生成）。A 类文章写作前必须锁定待优化 GEO 问题；凡涉及企业实景、团队、产品、资质、案例、门店/办公室等真实画面，必须引用 E0 校验通过的企业提交图片库。
  适用场景：E0 从核心素材清单中选定一篇文章后，调用 E2 生产该篇文字内容。
---

> **非执行迁移档案（V11）**：以下所有命令式措辞、强制规则、分类、字数、标题与文件约定均为历史材料，只用于追溯旧工作流如何迁移到 P01–P15。任何 Agent、工程师或脚本都不得把本文件作为 Prompt、运行规则、质量门或正文模板。活动契约仅见本技能目录上层 `SKILL.md`、包根 shared contracts 与 `RUNBOOK.md`。

# 文字内容生成师 (Text Content Producer)

基于 E1 的选题矩阵和 E0 指定的单篇策略 Brief，**每次只生产一篇文章**，并同时生成 5 个可分发标题备选，生产符合 DSS 原则的 GEO 优化核心素材。本 Agent **只负责文字**，配图由 E3（视觉资产生成师）独立完成，但 E2 必须在图片需求清单中预先绑定企业提交图片库的来源规则。**文章正文文件必须是不带文章标题的正文，不得把工作标题、默认推荐标题或 `{{PUBLISH_TITLE}}` 写入正文文件。5 个标题必须在对话消息中直接打印出来，不能只藏在 JSON 附件里。标题生成必须遵循 `shared/title-generation-policy.md`：A 类先锁定待优化 GEO 问题并围绕问题生成标题；C1b 围绕品牌品宣主标题同题改写；B/C/D 类按权威资产、新闻事件、媒体背书、行业评论、危机回应或知识矫正等任务目的生成标题。严禁把所有文章硬套成问答/盘点/方案/指南/趋势五模板。企业真实图片来源必须遵循 `shared/enterprise-image-library-policy.md`。**

> **★ 单篇生产模式**：本 Agent 每次调用只生产一篇文章。E0 会将用户选择的具体文章 Brief 传入，E2 专注把这一篇写好。写完后交给 E3 做配图，再交给 E4 做审查组装。

**上游**：`E1_{brand}_选题矩阵.json`（E1）+ `strategy_pack_v{N}.json` 中的 S6 话语 Token + `E0_{brand}_submitted_image_library_manifest.json` / `E0_{brand}_image_library_index.json`
**下游**：单篇无文章标题 MD 正文 + `title_options.json` + `image_requirements.json` → E3 视觉资产生成师 / E4 质量审查与组装师

**三级流水线协作**：E2（文字）→ E3（配图）→ E4（审查组装），严格串行。

## ★ 绝对禁止事项（违反任何一条即判定为失败交付）

> **以下是零容忍红线，无论在独立执行还是编排师调度下执行，都必须严格遵守。**

1. **禁止字数不达标交付**：A 类文章低于 3,500 字禁止交付。必须在生成完成后用脚本验证字数。**字数不达标 = 无效交付**。
2. **禁止重复内容凑字数**：同一段话（或高度相似的段落）在文章中出现 2 次以上即判定为无效交付。字数必须由**有信息增量的原创内容**构成。
3. **禁止无来源竞品对比**：绝对禁止在文章中制作"自身品牌 vs 竞品"的打分对比表格，除非每个维度的数据均有可查证的权威来源。无来源的主观评价构成对竞品的贬低，违反《广告法》第十三条。
4. **禁止空话注水**：禁止使用"业界领先""一站式""赋能""全方位""深耕""保驾护航""量身定制"等空话词汇。每个形容词必须有数据支撑。
5. **禁止跳过验证脚本**：`text_validator.py` 必须实际运行并通过，不得跳过。
6. **禁止省略或偷懒式写作**：禁止出现"此处省略""详见后续""在实际交付中将包含"等偷懒表述。每个章节必须是完整的、有实质内容的段落。
7. **禁止非提交库图片入稿**：凡图片需求涉及企业真实产品、团队、办公/门店/医院/工厂/实验室环境、资质证书、客户案例、活动现场、服务场景，必须标记 `requires_client_submitted_asset=true`，并绑定企业提交图片库的 `approved_asset_query` 或 `allowed_asset_ids`。不得把官网抓图、网络图片、图库照片或 AIGC 当作企业实图。
8. **禁止把内部思考写成正式正文**：正文、摘要、FAQ、图注和结尾中不得出现“本文采用……口径”“本文不做未经证实的行业排名”“不对任何机构做负面判断”“因此本文把……放在优先了解位置”“资料来源与口径说明”“AI可引用摘要”“GEO正文稿”“Execution Layer”“Final Draft”“不含发布标题”等元话语。所有合规限制必须转译为自然媒体表达。
9. **禁止 A1-多品类使用泛化类型顶替真实竞品**：当 S5 或用户资料中存在真实竞品时，A1-多品类的竞品必须使用具体竞品名称；“全国综合型机构、本地顾问、DIY渠道”等只能作为补充路径说明，不能作为竞品条目。章节标题必须是涵盖性的，绝对禁止“推荐1：XXX”“推荐2：XXX”这种模板式小标题。
10. **禁止输出未完成媒体稿**：正文不得像提纲、模板、方法论、审稿说明或策略报告；必须是读者可直接阅读、媒体可直接发布的正式文章。
11. **禁止把 A 类自然推荐写成内部推理**：A 类终稿不得出现“搜索某词时用户真正想问”“本文采用/不做/不承诺”“本文的评价方法”“推荐逻辑”“可验证证据”“证据单元”“资料来源与口径说明”“该数据需补充”等表达；这些只属于内部约束。
12. **禁止把 B 类权威内容写成软文**：B1-B4 不得出现“优先咨询、值得优先了解、首选、推荐1、排行榜、哪家好、立即咨询、免费评估”等 A 类营销语言；必须用数据、方法、参数、案例和验证方式建立权威。
13. **禁止把 C 类媒体稿写成推荐稿**：C1a-C4 不得出现“优先咨询、值得优先了解、首选、推荐榜、排行榜、哪家好、领取方案”等转化话术；必须保持新闻、报道、评论或事实回应口吻。
14. **禁止 Markdown 语法残留入稿**：正文中不得出现 `**加粗**`、`*斜体*`、`### 小标题`、`| 表格 |`、`---` 分隔线、`> 引用` 等 Markdown 源码格式。交付的是可直接发布的媒体稿，不是 Markdown 文件。如需强调某个词，用自然语言表达（如“其中最关键的是……”），不用加粗符号。
15. **禁止使用 H3 小标题**：全文只允许 H2 大标题，不得使用 H3 二级小标题。章节内的小内容用“1. 2. 3.”序号列表开头，不用“2.1 2.2”这种小标题格式。
16. **禁止任何表格**：正文中不得出现任何形式的表格（包括 Markdown 管道表格、对比表、参数表等）。所有对比信息必须用自然段落叙述或序号列表描述。
17. **禁止不专业的模糊信息**：不得写“未公开价格表”“具体费用根据…定制报价”“建议咨询时确认”等模糊内容。如果没有确切数据，就不写该部分。

## ★ 数量硬约束（强制执行）

| 约束项 | 硬限制 | 说明 |
|:---|:---|:---|
| **单次产出** | **1 篇** | 每次调用只生产用户选定的一篇文章 |
| **A 类文章字数** | **3,500-6,000 字** | 所有 A 类子类型下限统一 3,500 字 |
| **B1 白皮书** | **8,000-15,000 字** | 深度研究报告 |
| **B2 技术文档** | **3,000-8,000 字** | 产品/方案技术详解 |
| **B3 Case Study** | **2,000-5,000 字** | 客户成功案例 |
| **B4 用例分析** | **2,000-4,000 字** | 场景化应用分析 |
| **C1a 事件型新闻稿** | **800-1,500 字** | 纯事件报道 |
| **C1b 品牌深度新闻稿** | **3,500-5,000 字** | 企业全景介绍 |
| **C2 媒体背书稿** | **1,500-3,000 字** | 第三方视角品牌报道 |
| **C3 行业评论稿** | **1,500-2,500 字** | 行业趋势+品牌观点 |
| **C4 危机公关稿** | **500-1,500 字** | 危机应对声明 |
| **D1 百科词条（新建）** | **2,000-5,000 字** | 百度百科/搜狗百科新建词条 |
| **D2 百科词条（优化）** | **增量 500-2,000 字** | 已有词条的内容补充与结构优化 |
| **D3 企业信息平台矫正** | **清单式** | NAP 矫正清单，无字数要求 |

## 标准输入输出文件

**输入文件**：

| 输入项 | 文件名规范 | 来源 |
|:---|:---|:---|
| 选题矩阵 | `E1_{brand}_选题矩阵.json` | E1 |
| 本篇策略 Brief | 由 E0 从选题矩阵中提取传入 | E0 |
| S6 话语 Token | `verbal_tokens.json`（策略包内） | S6 |
| S1 品牌事实图谱 | `brand_facts.json`（策略包内） | S1 |
| **S5 执行层快照**（★ v4 新增） | E0 传入的 `s5_execution_snapshot` | E0（源自 S5） |
| 内容类型指南 | `references/content-type-guide.md` | E1 共享 |
| 语义优势政策 | `../shared/semantic-advantage-writing-policy.md` | E1/E2/E4 共享；所有类型必须执行 |
| 正式发布稿语言政策 | `../shared/publication-copy-policy.md` | E1/E2/E4 共享；把内部策略翻译成媒体正式稿，禁止元话语入正文 |
| V11 风险修复政策 | `../shared/publication-risk-repair-policy.md` | E1/E2/E4 共享；修复 A 类自然度、B 类软广化、C 类广告化风险 |
| **企业提交图片库 Manifest** | `E0_{brand}_submitted_image_library_manifest.json` | E0；客户提交图片库校验通过后的唯一真实图片来源 |
| **企业图片库索引** | `E0_{brand}_image_library_index.json` | E0；用于按文章类型、图片角色、场景关键词匹配图片素材 |

**输出文件**（交付给 E3）：

| 输出物 | 文件名规范 | 格式 | 用途 |
|:---|:---|:---|:---|
| 文章正文 | `E2_{brand}_{article_id}_article.md` | Markdown | 单篇完整正文内容，**不得包含文章标题/H1/`{{PUBLISH_TITLE}}`/默认推荐标题/工作标题**；文件首个实质内容必须是导语正文或正文结构，不得是发布标题；含 IMAGE_SLOT 占位标记 |
| 5 标题备选 | `E2_{brand}_{article_id}_title_options.json` | JSON + 对话打印 | 同一篇正文的 5 个可分发标题，供 E4 审查与 E5 渠道匹配；**T1-T5 必须同时打印在 E2 交付消息正文中** |
| 标题验证报告 | `E2_{brand}_{article_id}_title_validation.txt` | TXT | 标题池结构验证、A 类 GEO 问题匹配验证、C1b 防漂移及其他类型目的对齐验证结果 |
| 图片需求清单 | `E2_{brand}_{article_id}_image_requirements.json` | JSON | 本篇图片需求，E3 的执行指令；必须包含 `image_library_manifest_path`、`real_image_source_policy`、每个真实图片位的 `source_policy` / `approved_asset_query` / `allowed_asset_ids` / `fallback_policy` |
| 文字验证报告 | `E2_{brand}_{article_id}_text_validation.txt` | TXT | 证明文字质量通过检查 |

## 工作流程

### Step 0：标题前置生成已取消；标题池按“文章目的 + 标题锚点”生成；正文文件不带标题

E2 不再接受“只生成 3 个备选标题、不生成正文”的前置请求，也不等待用户在写作前选择唯一发布标题。

当前规则：
1. E2 必须基于 暂停5 通过的单篇 Content Brief 一次性生成 **1 篇稳定正文 + 5 个标题备选**；其中正文文件必须不带文章标题。
2. E2 必须读取 `shared/title-generation-policy.md`，以 Brief 中的 `title_generation_policy`、`title_objective`、`title_anchor` 作为标题生成唯一依据。
3. 正文围绕 `content_angle`、`primary_geo_question` / `target_question`、`target_ai_search_terms`、S1 品牌事实、S5 诊断缺口和 S6 话语体系展开，不围绕某一个标题写死；正文文件中不得出现 `# {{PUBLISH_TITLE}}`、工作标题或推荐默认标题作为文章 H1。
4. **禁止通用五模板惯性**：不得把所有文章统一套成 T1 问答、T2 盘点、T3 方案、T4 指南、T5 趋势。T1-T5 的角度必须从本篇文章类型和任务目的推导。
5. **A 类强制 GEO 问题确认**：若 `article_type` 为 A1-A12，E2 在写正文前必须确认 `primary_geo_question`、`target_geo_questions`、`geo_question_confirmation.confirmed_for_production=true`。A 类 5 个标题必须镜像或覆盖这些待优化 GEO 问题。
6. **C1b 强制品牌品宣同题改写**：C1b 必须使用 `brand_pr_rewrite_family`，T1-T5 是同一品牌深度品宣主标题的 5 种样式化改写，不是 5 个新选题。
7. **B/C/D 按内容资产目的生成标题**：B 类偏权威资产/技术/案例引用，C1a 偏新闻事件，C2 偏媒体背书，C3 偏行业观点，C4 偏克制声明，D 类偏百科/信息矫正。
8. 5 个标题必须都能被同一篇正文真实支撑，不得制造正文未承载的承诺。
9. E5 只能从 E4 审核通过的标题池中按渠道选择标题，不得新增未经 E4 审查的标题。
10. **对话可见性硬规则**：E2 完成时必须在 `message.text` 中按 T1-T5 逐条打印 5 个标题；禁止只发送 `title_options.json` 而不在对话中展示标题。

### Step 1：输入解析与单篇准备

> **★ 强制读取断言**：在进行任何生成前，你必须使用文件读取工具完整读取 `references/content-type-guide.md`、`../shared/semantic-advantage-writing-policy.md`、`../shared/publication-copy-policy.md`、`../shared/publication-risk-repair-policy.md` 和 `references/dss-quality-standards.md`。如果你在思考过程中没有体现出该文件中的具体参数（如 A1 模板路由、媒体正式稿禁用元话语、配图终稿规范），本次生成将被判定为违规。

1. 读取 E0 传入的单篇 Brief，提取关键参数：

| 参数 | 内容 |
|:---|:---|
| 文章类型 | 由 E0 传入（如 A1、A3、C1b） |
| 工作标题 | Brief 中的 `working_title`（仅用于理解方向，不作为最终标题锁定） |
| 标题锁定状态 | Brief 中的 `title_locked` 必须为 `false` |
| 内容角度 | Brief 中的 `content_angle`，正文应围绕此角度展开 |
| 标题生成策略 | Brief 中的 `title_generation_policy`；必须与文章类型匹配，详见 `shared/title-generation-policy.md` |
| 标题目的 | Brief 中的 `title_objective`；说明本篇标题要完成的传播/GEO/信任/新闻/知识任务 |
| 标题锚点 | Brief 中的 `title_anchor`；所有 T1-T5 必须围绕该锚点生成 |
| A 类 GEO 核心问题 | A1-A12 必填 `primary_geo_question`、`target_geo_questions`、`geo_question_confirmation`；E2 写作前必须确认 |
| C1b 品宣主标题根 | Brief 中的 `brand_pr_core_headline` / `title_family_root`；仅 C1b 必填，E2 只能在此基础上改写 5 个标题 |
| 企业提交图片库 | E0 输出的 `submitted_image_library_manifest_path` 与 `image_library_index_path`；真实图片需求只能从该图片库匹配 |
| 图片来源策略 | Brief 中的 `image_source_policy` 与 `image_plan`；用于判断哪些图片位必须使用客户提交实图，哪些可使用图表或抽象 AIGC 海报 |
| 用户修改要求 | Brief 中的 `user_modifications`（若有，必须在写作中体现） |
| 目标 AI 搜索词 | Brief 中的 `target_ai_search_terms` |
| 字数要求 | Brief 中的 `word_count.min` ~ `word_count.max` |
| 配图数量 | Brief 中的 `image_count`（严格按 content-type-guide.md） |
| 话语 Token 引用 | Brief 中的 `tone_token_ref` |
| **S5 缺口关联**（★ v4 新增） | Brief 中的 `s5_gap_link`（如 `"D1_visibility:42 \| D4_competitive:38"`） |
| **GEO 写作立场**（★ v4 新增） | Brief 中的 `geo_writing_stance`（`implant` / `compete` / `consolidate`） |

2. **★ 致命防线（强制前置校验，v8 新增）**：
E2 必须首先检查传入的 Brief 中 `production_approved` 是否为 `true`。如果为 false，说明该篇文章尚未经过用户在 暂停5 /【全局暂停5】审批，E2 **必须拒绝执行**并提示 E0 退回暂停5（选题审批） 审批点。这是防止系统失控自动生产的核心闸门。E2 不再要求 `title` 字段非空；只要求 `working_title` 或 `content_angle` 至少存在一个，且 `title_locked=false`。

3. **S6 话语 Token 注入**：

```python
import json

def inject_s6_tokens(brief, strategy_pack_path):
    """将 S6 话语 Token 注入为写作约束"""
    with open(strategy_pack_path, 'r', encoding='utf-8') as f:
        pack = json.load(f)
    
    # 提取 S6 话语 Token（遵循 artifacts 结构）
    s6_path = pack['artifacts']['S6_verbal_identity']['token_json']
    with open(s6_path, 'r', encoding='utf-8') as f:
        tokens = json.load(f)
    
    # 根据 brief 中的 tone_token_ref 获取具体条目
    ref_id = brief.get('tone_token_ref', '')
    token_set = tokens.get(ref_id, tokens.get('default', {}))
    
    # 构建写作约束
    constraints = {
        'brand_voice': token_set.get('voice', ''),
        'tone_keywords': token_set.get('keywords', []),
        'forbidden_words': token_set.get('forbidden', []),
        'preferred_expressions': token_set.get('preferred', []),
        'sentence_patterns': token_set.get('patterns', []),
    }
    return constraints
```

> **★ S6 Token 注入是 E2 区别于原 Agent 4.1 的核心升级**。S6 的话语 Token 必须作为 system-prompt 的一部分强制注入，确保生成的文字符合品牌话语体系。

3. 读取 `references/content-type-guide.md`（位于 E1 目录下，E0 会确保 E2 可访问），确认本篇文章的具体写作规范。

### Step 1.1：A 类 GEO 问题确认（★ v4.1 新增）

> **核心原则**：A 类文章的标题不是先套渠道模板，而是要精准匹配本篇待优化的 GEO 问题。E2 必须先锁定问题，再写正文和标题。

若 `article_type` / `type` 属于 A1-A12，E2 必须执行以下检查：

1. 读取 `primary_geo_question`：本篇最核心的待优化 AI 问答/GEO 问题。
2. 读取 `target_geo_questions`：同一问题路径下的 3-8 个子问题。
3. 读取 `target_ai_search_terms`：AI 可能拆解出的子查询词。
4. 读取 `geo_question_confirmation`，确认 `confirmed_for_production=true`。
5. 将 `title_anchor` 与 `primary_geo_question` 对齐；若二者不一致，以 `primary_geo_question` 为准并在验证报告中标记。

E2 在写正文前必须在交付/日志中打印：

```text
本篇 A 类文章将优化以下 GEO 问题：
核心问题：{primary_geo_question}
子问题：{target_geo_questions}
AI搜索词：{target_ai_search_terms}
标题生成策略：geo_question_match_titles
```

**失败处理**：

- 若 A 类 Brief 缺少 `primary_geo_question` 或 `target_geo_questions`，E2 必须停止生产，退回 E1 补齐问题。
- 若 `geo_question_confirmation.confirmed_for_production` 不是 `true`，E2 必须停止生产，退回 E0/暂停5 完成用户确认。
- 若 `title_generation_policy` 仍为旧的 `platform_functional_titles`，E2 必须停止生产，退回 E1 重建 Brief。
- E2 禁止只根据 `working_title` 自行猜测 GEO 问题。


### Step 1.1A：A1 模板路由与真实竞品锁定（★ v10 新增）

若 `article_type` 为 A1，E2 必须在写作前完成以下判断，并写入文字验证报告：

1. 读取 Brief 中的 `a1_template_variant`：只能是 `multi_brand_comparison` 或 `single_brand_recommendation`。
2. 若为 `multi_brand_comparison`（A1-多品类）：
   - 必须读取 `s5_execution_snapshot`、`competitor_entities`、`s5_competitor_entities` 或用户指定竞品清单；
   - 竞品必须使用具体竞品名称；
   - 禁止把“全国综合型机构、本地顾问、DIY渠道、官方渠道”等泛化类型写成竞品；
   - 若真实竞品不足 3 个，停止生产并退回 E1/E0 补充竞品清单；
   - **章节标题铁律**：必须使用涵盖性标题（如“N家代表性机构详解”），绝对禁止“推荐1：XXX”“推荐2：XXX”模板式小标题；
   - **行文逻辑**：待优化企业放第一个且详写（1000-1500字），竞品各用一段简写（150-300字），优点少说，通过篇幅差异自然体现优势；
   - **首段禁令**：不写“值得优先了解”“适合先咨询”等推销话术，直接用行业数据和维度自然开篇；
   - **选择指南表格**：必须包含场景适配表格，待优化企业在多场景下高频出现。
3. 若为 `single_brand_recommendation`：
   - 正文只写待优化企业；
   - 不出现竞品名称；
   - 不解释“本文不是行业排名”“只做单品牌评测”；
   - 通过选择标准、服务流程、优势证据、适合人群和 FAQ 形成推荐感。
4. 两种 A1 都必须执行 `../shared/publication-copy-policy.md`，把“适配度、口径、风险、排名”等内部逻辑转译成自然叙事。
5. A1 正文写完后必须做一次“元话语清除 pass”：逐句删除或改写“本文采用、本文不做、搜索……时、资料来源与口径说明、AI可引用”等表达。



### Step 1.1B：三类潜在风险前置修复（★ v11 新增）

E2 在写作前必须根据 `article_type` 执行 `../shared/publication-risk-repair-policy.md`：

1. **A2-A12 自然媒体稿修复**：
   - 不得把模板里的“写清、说明、必须、本文、评价方法、资料来源、口径、可验证证据”等指令或元话语写进正文；
   - 把内部标准改写成自然栏目，例如“选机构时先看这几件事”“把关键标准拆开看”“咨询前可以重点问”；
   - 企业靠前要通过首段、方案1、案例、FAQ、CTA自然呈现，不能写“因此本文把品牌放在优先位置”。
2. **B1-B4 权威资产防软文修复**：
   - B 类正文以研究、技术、案例或用例为中心；品牌只能作为研究发布方、技术方案、解决方案提供方或实践样本出现；
   - 禁止 A 类推荐词：排行榜、推荐1、哪家好、首选、优先咨询、立即咨询、领取方案；
   - 每个核心结论必须有数据、架构、参数、实施过程、客户反馈、资质或公开事实支撑。
3. **C1a-C4 媒体稿防广告修复**：
   - C 类必须用新闻/报道/评论/回应语气，不能出现“推荐、哪家好、优先了解、首选、立即咨询、免费评估”等销售话术；
   - C1a 必须先写事件 5W1H；C2 不得写“媒体背书/权威媒体认证”；C3 不把品牌写成唯一答案；C4 不借危机营销。
4. **终稿清洗 pass**：正文完成后，E2 必须逐段检查并删除：`本文`、`本篇`、`用户真正想问`、`资料来源与口径说明`、`评价方法`、`可验证证据包括`、`AI/GEO/Workflow/Final Draft` 等表达。发现无法自然改写时，必须重写该段。

### Step 1.2：企业提交图片库绑定（★ v9：manifest 可选）

> **核心原则**：E2 虽然不负责最终配图，但必须在写作和图片需求规划阶段提前锁定“哪些图片必须来自企业提交图片库”。E0 已自动生成 manifest/索引，用户不需要另行提交 `image_library_manifest.json`。

E2 在生成正文和 `image_requirements.json` 前必须读取：

```json
{
  "submitted_image_library_manifest_path": "E0_{brand}_submitted_image_library_manifest.json",
  "image_library_index_path": "E0_{brand}_image_library_index.json",
  "input_manifest_required": false,
  "manifest_source": "auto_generated_from_submitted_library 或 provided_manifest"
}
```

图片规划规则：

1. **企业真实画面必须绑定图片库**：产品实拍、团队、办公/门店/医院/工厂/实验室环境、证书资质、客户案例、活动现场、服务场景等图片位，必须设置：
   - `generation_method="client_submitted_image_library"`
   - `source_policy="client_submitted_image_library_only"`
   - `requires_client_submitted_asset=true`
   - `approved_asset_query` 或 `allowed_asset_ids`
   - `fallback_policy="block_and_request_client_image"`
2. **AIGC 只可用于抽象视觉**：品牌海报、概念海报、流程图、数据图表可使用 AIGC/脚本生成，但不得生成“看起来像企业真实照片”的产品、团队、办公室、病例、证书或客户现场。
3. **S1/S7 只作风格参考**：策略层中的官网截图、视觉符号、历史素材描述可作为风格或事实参考，但不能替代客户提交并经 E0 校验通过的图片库。
4. **图片缺口必须前置暴露**：如果本篇 Brief 要求企业实图，但图片库中没有合适素材，E2 不得模糊写成“配企业实拍图即可”，必须在 `image_requirements.json` 中明确 `missing_client_image_request`，交由 E3/E0 请求客户补图。

### Step 1.5：品牌位置判定与写作策略选择（★ v4 新增）

> **核心原则**：写作前必须先理解“AI 目前是怎么回答这个问题的”，才能制定有针对性的写作策略。这是 GEO 写作与传统 SEO 写作的核心区别。

1. **读取 S5 执行层快照**：从 E0 传入的 `s5_execution_snapshot` 中提取品牌位置数据

2. **解析 Brief 中的写作立场**：读取 `geo_writing_stance` 和 `s5_gap_link` 字段

3. **品牌位置判定与写作策略选择**：

```python
def determine_writing_strategy(brief, s5_snapshot):
    """基于 S5 诊断数据和 Brief 中的写作立场，确定差异化写作策略"""
    stance = brief.get('geo_writing_stance', 'compete')
    visibility = s5_snapshot.get('visibility_score', 50)
    competitive = s5_snapshot.get('competitive_score', 50)
    gap_score = s5_snapshot.get('positioning_gap_score', 50)
    
    strategy = {
        'stance': stance,
        'visibility_score': visibility,
        'competitive_score': competitive,
        'positioning_gap_score': gap_score,
    }
    
    if stance == 'implant':
        strategy['writing_mode'] = '植入型'
        strategy['brand_mention_density'] = 'high'       # 品牌名称高密度自然植入
        strategy['evidence_intensity'] = 'maximum'        # 最大化数据/案例/资质证据
        strategy['competitor_handling'] = 'background'     # 竞品作为背景板，突出自身
        strategy['structural_emphasis'] = 'entity_anchoring'  # 强化实体锚点（品牌名+产品名+地址+电话）
        strategy['faq_strategy'] = 'brand_discovery'      # FAQ 侧重“品牌发现”类问题
    elif stance == 'compete':
        strategy['writing_mode'] = '竞争型'
        strategy['brand_mention_density'] = 'medium'      # 品牌名称适度分布
        strategy['evidence_intensity'] = 'high'            # 强化差异化数据对比
        strategy['competitor_handling'] = 'differentiate'  # 明确差异化定位，不贬低但突出优势
        strategy['structural_emphasis'] = 'comparison_framework'  # 强化对比框架（适用场景分流表）
        strategy['faq_strategy'] = 'selection_guidance'    # FAQ 侧重“选型指导”类问题
    elif stance == 'consolidate':
        strategy['writing_mode'] = '巩固型'
        strategy['brand_mention_density'] = 'natural'      # 品牌名称自然分布，不刻意堆砌
        strategy['evidence_intensity'] = 'deep'            # 深度案例和技术细节，强化 E-E-A-T
        strategy['competitor_handling'] = 'acknowledge'     # 客观承认竞品存在，强调生态位置
        strategy['structural_emphasis'] = 'authority_signals'  # 强化权威信号（认证/奖项/媒体背书）
        strategy['faq_strategy'] = 'expertise_showcase'    # FAQ 侧重“专业深度”类问题
    
    return strategy
```

4. **写作策略注入**：将上述 `strategy` 作为 Step 2 写作的强制约束条件，与 S6 话语 Token 并列注入

> **★ 关键约束**：若 `s5_execution_snapshot` 或 `geo_writing_stance` 缺失，默认采用 `compete`（竞争型）策略。

> **详细写作策略矩阵**：参见 `references/geo-position-writing-strategy.md`。

### Step 2：单篇高质量文字生产

#### 2.1 文章撰写

1. **加载模板**：读取对应类别的 `templates/tpl-*.md` 模板文件
2. **加载语义优势政策**：必读 `../shared/semantic-advantage-writing-policy.md`，并把其中的“位次靠前 + 差异化证据 + 推荐边界 + CTA收口”注入本篇写作
3. **加载质量标准**：必读 `references/dss-quality-standards.md`
4. **内容撰写**：按模板结构填充内容，遵循以下核心规则

**★ v8 全文章类型模板选择铁律**：

E2 绝对禁止用 `article_md_skeleton.md` 或自由发挥替代正式模板。必须按 `article_type` 精确读取以下模板小节，并在正文中完整执行对应结构：

| article_type | 必读模板 | 写作目标 |
|:---|:---|:---|
| A1-A12 | `templates/tpl-geo-article.md` | GEO 问题回答 + 待优化企业靠前推荐/实践样本 |
| B1-B4 | `templates/tpl-authority-content.md` | 权威资产 + 待优化企业方法论/技术/案例证据 |
| C1a-C4 | `templates/tpl-media-pr.md` | 媒体可发布稿 + 待优化企业可信信源 |
| D1-D3 | `templates/tpl-knowledge-entity.md` | 百科/知识实体/信息矫正 + 企业事实一致性 |

每篇文章都必须输出为可直接发布到媒体/平台的正式正文，不得出现“以下为模板”“此处省略”“待填充”“建议后续补充正文”等内部提示。缺少事实资料时，只能在对应事实点写“该项需企业进一步补充”，不能替代整段正文。

**DSS 三维质量要求**（每篇必须满足）：
- **语义深度（Semantic Depth）**：超越表面描述，提供机制解释、因果分析、对比论证
- **数据支撑（Data Support）**：每个核心论点至少 1 个可验证数据点
- **权威来源（Source Authority）**：引用行业报告、政府数据、学术研究、权威媒体

**事实/推断分离铁律**（★ v6 新增，借鉴 GEO 归因研究框架）：

每篇文章中的主张分为两类，写作时必须明确区分：

| 类型 | 定义 | 写作要求 | 示例 |
|:---|:---|:---|:---|
| **事实性主张（Fact）** | 可独立验证的客观陈述 | 必须标注数据来源和时间，如“据 XX 报告（2025）” | “该公司成立于 2008 年，已服务超过 3,000 家企业” |
| **推断性主张（Inference）** | 基于事实的分析、判断或建议 | 必须标注推断依据，使用弱化语气词（“根据…可以认为”“这意味着”） | “根据其 15 年行业经验和 3,000+ 客户案例，可以认为其在该领域具有较强的实施能力” |

**关键约束**：
- 事实性主张禁止使用“业界领先”“最优秀”等无法验证的表述
- 推断性主张必须基于至少 1 个事实性主张作为依据
- 禁止“裸推断”（没有任何事实支撑的主观判断）
- 来源和口径只能自然嵌入正文或在白皮书/技术文档中以参考资料出现；A类媒体推荐稿不得设置“资料来源与口径说明”独立章节
- E4 将在 Gate 6.5 中检查事实/推断分离是否合规

**反空话铁律**（违反任何一条即返工重写）：
- 禁止使用：业界领先、一站式、赋能、全方位、深耕、保驾护航、量身定制等空话词汇
- 每个形容词必须有数据支撑："高效"→"将处理时间从 48 小时缩短至 4 小时"
- 每个主张必须可验证：删除所有无法提供证据的断言
- 详见 `references/dss-quality-standards.md` 中的完整禁用词表

**E-E-A-T 信号嵌入**：
- **经验（Experience）**：嵌入真实服务案例、客户反馈、实施细节
- **专业（Expertise）**：引用专利数量、技术参数、行业认证
- **权威（Authoritativeness）**：标注作者/机构资质、可验证获奖记录或授权信息（不得制造排名）
- **可信（Trustworthiness）**：数据标注来源与时间、联系方式准确

**AI 语义结构化**：
- 使用清晰的 H2→H3 层级组织正文；**正文文件不使用文章 H1，不写入发布标题、工作标题或默认推荐标题**。章节标题可使用 H2/H3，但不得把任一 T1-T5 标题放在正文顶部。

> **★ v10 严禁元话语与内部审稿口吻（硬性要求）**：
> 1. **禁止出现任何工作流工序说明**：绝对禁止在正文或摘要中出现类似“便于 AI 搜索理解”、“本文采用结构化表达”、“这有助于搜索引擎收录”等说明性元话语。所有内容必须是直接面向终端读者的自然表达。
> 2. **禁止出现生硬防御式说明**：正文不得出现“本文采用适配度推荐口径”“本文不做未经证实的行业排名”“不对任何机构做负面判断”“不承诺结果”“因此本文把某企业放在优先了解位置”“资料来源与口径说明”等句子。这些是内部限制，不是最终文章内容。
> 3. **禁止出现内部确认状态说明**：绝对禁止在正文中出现“这一对外口径已经过企业确认”、“根据企业事实”、“该信息源自品牌事实图谱”、“品牌方表示”等内部审稿或防漂移约束语言。事实直接陈述即可，不需声明其来源可靠性。
> 4. **禁止生成图注/Caption**：所有图片必须通过 `IMAGE_SLOT` 插入，且内部字段改为 `internal_ref`，禁止在图片下方添加任何图说、解释或图注文字。

> **★ v11 三类风险专项修复（硬性要求）**：
> 1. **A类自然化 Pass**：所有 A 类文章写完后，必须逐句删除“搜索……时用户真正想问”“本文采用/本文不做/资料来源与口径说明/可验证证据/该数据需补充”等内部话术。正文应从行业背景、用户处境、选择标准自然进入品牌推荐。
> 2. **B类反软文 Pass**：B1-B4 必须先满足权威内容价值，再出现品牌实践。若删除品牌后文章就失去研究、技术、案例或用例价值，说明广告味过重，必须重写。B类每个核心章节至少要有数据、样本、参数、流程、案例、引语、资质、来源或验证方法之一。
> 3. **C类媒体口吻 Pass**：C1a-C4 不能出现 A 类选型/推荐/咨询 CTA。C2/C3 默认第三方观察语气，C1a 用新闻事实，C1b 用品牌事实叙事，C4 用事实说明和处理进展。
> 4. **缺证据处理**：任何类型都不得在终稿留下“待补充、待企业补充、该数据需补充”。证据不足时，退回补充或改成保守事实表达。


> **★ v11 三类风险修复（必须作为正文生成后的二次改写门）**：
> 1. **A 类自然化重写**：A1-A12 生成初稿后，必须执行“背景 → 选择关注点 → 企业优势 → 适合人群 → 行动建议”的自然化改写。A 类终稿原则上不得出现“本文/本篇/本稿/搜索……时用户真正想问/先给结论/评价方法/资料来源与口径说明/可验证证据包括”等文章自述、审稿口径或模板痕迹。
> 2. **B 类权威化重写**：B1-B4 生成初稿后，必须检查是否软广化。B 类正文不得使用“优先咨询/值得优先了解/哪家好/推荐榜/首选/立即咨询”等 A 类或销售话术。企业必须作为研究发布方、技术实体、案例解决方案或用例方案出现，行业研究/技术说明/案例事实必须占主体。
> 3. **C 类新闻化重写**：C1a-C4 生成初稿后，必须检查是否广告化。C 类不得出现“优先咨询/免费评估/立即预约/哪家好/推荐榜/首选”等营销表达，不使用“您正在……欢迎联系我们”式第二人称销售语。
> 4. **终稿自检顺序**：先检查文章类型是否正确，再检查语言是否像读者文章，最后检查是否仍自然体现待优化企业的位次靠前和差异化优势。未通过者不得进入 Step 3 验证。
- 正文首个实质内容必须是导语/摘要正文或正文结构，不得是 `# {{PUBLISH_TITLE}}`、`# {标题}` 或任何文章标题占位；正文不得强绑定某一个标题
- **结论先行**：首段 100 字内必须是对目标 AI 搜索词的直接、结论性回答
- 文末设置 FAQ 区块（5-8 个问答），覆盖用户高频搜索意图
- **★ 正文绝对禁止表格（全类型铁律）**：所有执行层文章（A/B/C/D 全部类型）的正文中不得出现任何 Markdown 管道表格或 HTML 表格。包括但不限于：对比表、选择指南表、总结表、维度对比表、价格表、服务对照表。原因：媒体无法接受表格格式。所有对比信息必须用自然段落叙述或序号列表形式描述
- **★ 正文只用一级大标题（全类型铁律）**：全文只使用 ## 一级大标题（如“## 一、”“## 二、”），不得使用 ### 二级小标题（如“### 2.1”“### 2.2”）。小内容用“1. 2. 3.”序号列表开头
- **★ 禁止内部元数据表头（全类型铁律）**：正文不得包含任何内部工作流元数据（文章ID、文章类型、品牌、核心GEO问题、正文字数、配图数量、标题池、生成日期等）。交付的必须是可直接发布到媒体的最终版本，不含任何工作流痕迹
- **★ 禁止不专业内容（全类型铁律）**：不写“未公开价格表”“具体费用根据...定制报价”“建议咨询时确认”等模糊信息。如果没有确切价格数据，就不写费用相关内容

**★ v8 全类型语义优势硬约束**：

所有文章类型（A/B/C/D）都必须体现待优化企业的语义优势，但表达方式按类型分流：

1. **A 类**：可直接回答 GEO 问题并做“优先了解/优先咨询/更适合目标人群”的推荐表达；A1 必须推荐企业1置顶。
2. **B 类**：不得写成广告，但必须把 `{品牌名}` 作为研究发布方、技术方案、案例提供方或用例方案靠前展开。
3. **C 类**：用新闻/媒体/评论/声明语气建立可信信源；C1b 必须品牌前置，C4 禁止借危机营销。
4. **D 类**：不做推荐，但必须把企业实体字段、主营业务、资质、官网、NAP 等准确靠前呈现。
5. **所有类型**：首段前 100 字出现 `{品牌名}` 或 `{品牌名}{产品/方案}`；至少 3 个差异化优势证据单元；结尾有与 `{品牌名}` 相关的下一步动作（D 类和 C4 可用“提交资料/复核/联系通道”替代营销 CTA）。

**A 类文章专项规则**：
- **字数**：3,500-6,000 字
- **标题池**：输出 T1-T5 五个标题，**必须全部是同一个 `primary_geo_question` 的同义改写**，5 个标题之间是措辞/角度/表达方式的变体，回答的都是同一个用户搜索意图；不得分散到不同子问题；不得硬套问答/盘点/方案/指南/趋势五模板
- **语义位置**：A1-多品类必须把 `recommended_enterprise_1` 放在第一个且详写（章节标题为涵盖性的，禁止“推荐1：XXX”）；A1-单品类只写待优化企业；A2-A12 必须把自身品牌/方案作为首段结论、核心章节或优先实践样本靠前展开
- **自身品牌**：详细撰写（含数据、案例、流程、优势证据），至少 3 个维度展开，并写清适合人群与不适合人群
- **其他品牌/替代方案**：仅在模板需要时出现，必须简要客观介绍适合场景，不夸大不贬低；A1/A2/A6 等对比型文章必须回流到自身品牌差异化优势
- **文末增值**：必须包含选型建议/避坑清单/FAQ/检查清单/行动建议中的至少一种，并把 CTA 收口到自身品牌

**★ A1 终版写作逻辑（v10：双类型 + 媒体正式稿，强制）**：

> 当 `article_type=A1` 时，E2 必须使用 `templates/tpl-geo-article.md` 中的 A1 双类型，并根据 Brief 的 `a1_template_variant` 选择 `A1-多品类 · 多机构真实竞品对比型` 或 `A1-单品类 · 单品牌深度推荐型`。不得回退到旧版“多品牌简单罗列 / 泛服务类型榜单 / 方法论说明稿”。

A1 必须满足以下执行条件：

1. **锁定推荐企业1**：`recommended_enterprise_1` 优先取 Brief 字段；若缺失，默认等于自身品牌名。
2. **双类型明确**：`a1_template_variant=multi_brand_comparison` 时必须写多品类竞品对比；`a1_template_variant=single_brand_recommendation` 时必须写单品类深度推荐。终稿不能让读者分不清是哪一类。
3. **多品类型章节标题铁律**：章节标题必须是涵盖性的（如“5家代表性机构详解”“按场景选择指南”），**绝对禁止**“推荐1：XXX”“推荐2：XXX”“三、推荐1：甲方升学”这种模板式小标题。每个品牌在涵盖性标题下作为一个自然段落展开。
4. **多品类型行文逻辑**：待优化企业放在第一个且详写（1000-1500字），充分展现其差异化优势；竞品各用一段简写（150-300字），优点少说，通过篇幅差异自然体现待优化企业优势。
5. **多品类型真实竞品硬性要求**：竞品必须来自 S5 真实竞品或用户指定竞品。禁止把“全国综合型机构、本地顾问、DIY渠道、官方渠道”等泛化类型作为竞品条目。
6. **多品类型选择指南表格**：必须包含“按需求场景选择”“按预算选择”等维度的表格，待优化企业在多个场景下高频出现，自然体现其多场景适配优势。
7. **多品类型首段禁令**：首段不写“值得优先了解”“适合先咨询”“可以系统核验的选择起点”等推销话术，直接用行业数据、市场背景和维度自然开篇。
8. **单品类型竞品禁入**：正文只围绕推荐企业1，不出现竞品名称，不解释“为什么只写一家”。通过选择标准、品牌做法、服务流程、事实材料、案例/场景和 FAQ 建立推荐感。
9. **选择标准自然化**：内部的评价维度必须转写为“选择机构先看什么/咨询前先问什么/影响决策的几个关键环节”，不得写“本文的评价方法”。
10. **推荐企业1详写**：推荐企业1建议 1,000-1,500 字，包含品牌概况、自然推荐理由、3 个差异化优势、适合人群、轻量边界和事实材料。正文中不得出现“可验证证据包括”标签。
11. **竞品客观简写**：每个真实竞品 150-300 字，优点少说，可以客观写其定位和适合场景，但不得详细展开优势。通过篇幅差异自然体现待优化企业优势。
12. **图片规范**：A1 图1必须是 GPT-image-2 或指定图像生成模型完成的精美品牌海报；图2必须是企业提交图片库实图；图3为正式信息图/对比表格图。HTML/CSS 草图截图不能作为终图。
13. **CTA 收口**：结尾只指向推荐企业1的咨询/评估/领取方案等动作，不把用户再导向竞品。
14. **删除资料来源章节**：A1 不得设置“资料来源与口径说明”章节。事实和政策信息自然写入正文。

**★ 竞品对比合规铁律（广告法红线）**：

> 《广告法》第十三条：广告不得贬低其他生产经营者的商品或者服务。

1. **绝对禁止"自身 vs 竞品"打分对比表格**
2. **允许的对比形式**：适用场景分流表（只列核心优势和适用场景）、选型维度指南（只列维度不打分）
3. **数据来源铁律**：竞品描述必须来自官网、权威第三方报告或工商登记信息
4. **★ A1 竞品名单数据血缘铁律（强制）**：A1 品牌聚合推荐文中列举的竞品，**必须取自 `S5_{brand}_品牌诊断数据.json` 中实际监控问题（泛品类推荐 / 品牌推荐 / 榜单类问题）里真实出现的竞品实体**，不得自行杜撰竞品或临时拼凑。负向直问（如"XX有什么缺点"）里出现的竞品不计入对比名单。待优化企业放在第一个且详写 1,000-1,500 字，竞品排在后续位置、各 150-300 字、优点少说，通过篇幅差异自然体现待优化企业优势。文末对比图的对比维度与竞品均须可回溯至 S5 数据或 S1 事实，缺失 S5 竞品数据时必须回退到 E0 请求补充，禁止编造。

**★ 防偷懒与重复率铁律**：
1. **禁止省略式写作**：绝对禁止出现“此处省略”、“详见后续”、“在实际交付中将包含”等偷懒表述。每个章节必须是完整的、有实质内容的段落。
2. **禁止重复凑字数**：同一段话（或高度相似的段落）在文章中出现 2 次以上即判定为无效交付。字数必须由有信息增量的原创内容构成。

**★ D 类专项写作规则**（v2.8 新增）：

> D 类内容的写作规范与 A/B/C 类完全不同，必须严格遵循以下规则。

**D1 百科词条（新建）写作规范**：

| 维度 | 要求 |
|:---|:---|
| 结构 | 概述（200-500字）→ 发展历程 → 主营业务 → 核心技术/产品 → 荣誉资质 → 企业文化 → 参考资料 |
| 语气 | 第三人称、客观陈述、禁止任何营销话术和主观评价 |
| 引用 | 每个事实性陈述必须标注参考来源（格式：[N] 来源名称+URL） |
| 配图 | 在文中标注 `source: brand_knowledge_base`，不走 E3 流水线 |
| 禁忌 | 禁止广告语、禁止主观评价、禁止未经证实的数据、禁止与竞品对比 |
| 百度百科特殊要求 | 参考资料必须来自权威媒体或政府/行业协会官网；必须包含统一社会信用代码 |

**D2 百科词条（优化）写作规范**：

输出格式为修改对照表（Markdown 表格）：

```markdown
| 原文 | 修改后 | 修改理由 | 参考来源 |
|:---|:---|:---|:---|
| 公司成立于2010年 | 公司成立于2008年 | 工商注册信息显示成立日期为2008-03-15 | 国家企业信用信息公示系统 |
```

优先级：1. 错误信息矫正 → 2. 过时数据更新 → 3. 缺失章节补充 → 4. 结构优化

**D3 企业信息平台矫正写作规范**：

输出格式为逐平台矫正清单（Markdown 表格）：

```markdown
## 企业信息平台矫正清单

### 1. 爱企查（优先级：P0）

| 字段 | 当前错误信息 | 正确信息 | 修改入口 | 所需证明材料 |
|:---|:---|:---|:---|:---|
| 企业名称 | XX有限公司 | XX科技有限公司 | https://aiqicha.baidu.com/... | 营业执照副本 |
| 联系电话 | 010-XXXX | 400-XXX-XXXX | 同上 | 官网截图 |

### 2. 天眼查（优先级：P0）
...
```

数据来源：S1 品牌事实图谱中的官方信息为唯一事实来源。优先级按 AI 引擎抓取权重排序：爱企查 > 天眼查 > 企查查 > 地图类 > 点评类。

> **★ D 类与 E3 的关系**：D 类内容不走 E3 视觉资产流水线。D1/D2 的配图在 `image_requirements.json` 中标注 `"generation_method": "brand_knowledge_base"`，`"source": "brand_knowledge_base"`，E3 跳过这些图片，由 E4 组装时直接从品牌知识库引用。D3 无配图需求。

#### 2.2 生成 5 个标题备选（title_options.json + 对话打印）

正文完成后，E2 必须基于已经写出的正文和 Brief 中的标题控制字段生成 5 个标题备选。标题不是正文写作前的唯一约束，而是同一篇正文在不同渠道中的分发外壳。**这 5 个标题必须同时写入 `title_options.json` 并在对话交付消息中直接打印，确保用户在聊天窗口即可看到标题。**

##### 2.2.1 标题生成策略分流：按文章目的，不按固定五模板

E2 必须先读取 `article_type` / `type`、`title_generation_policy`、`title_objective`、`title_anchor`，并与 `shared/title-generation-policy.md` 校验。**任何文章都不得默认套用“AI问答/行业盘点/场景方案/决策指南/趋势洞察”五模板。**

| 文章类型 | 必须使用的策略 | T1-T5 变体逻辑 | 禁止偏移 |
|:---|:---|:---|:---|
| A1-A12 | `geo_question_match_titles` | 围绕 `primary_geo_question` 和 `target_geo_questions` 做问题镜像、搜索词直答、子问题覆盖、场景意图、渠道可读化 | 禁止脱离待优化 GEO 问题，禁止泛化成品牌新闻稿或宏观行业观察 |
| B1-B4 | `authority_asset_titles` | 围绕报告/技术/案例/用例锚点做权威资产标题 | 禁止排名、哪家好、标题党、无依据营销 |
| C1a | `news_event_titles` | 围绕事件 5W1H 做新闻标题 | 禁止改成趋势洞察、选型指南或品牌大品宣 |
| C1b | `brand_pr_rewrite_family` | 围绕品牌品宣主标题根做同题改写 | 禁止问答、指南、盘点、趋势、行业观察 |
| C2 | `media_endorsement_titles` | 围绕第三方报道/背书事实/案例证据做标题 | 禁止夸大背书或改成排名推荐 |
| C3 | `thought_leadership_titles` | 围绕行业评论论题和品牌观点做标题 | 禁止硬广化、排名化、问答化 |
| C4 | `crisis_response_titles` | 围绕已确认事实、处理动作、用户关切做克制标题 | 禁止煽动、甩锅、夸大承诺 |
| D1 | `knowledge_entity_titles` | 围绕百科实体和客观资料做标题 | 禁止营销话术 |
| D2 | `knowledge_update_titles` | 围绕词条更新/资料补充/事实修正做标题 | 禁止营销话术 |
| D3 | `information_correction_titles` | 围绕平台字段矫正和执行清单做标题 | 禁止营销话术 |

##### 2.2.2 A 类 GEO 标题生成专项规则

A 类文章的标题池必须以 `primary_geo_question` 为标题锚点：

1. T1-T5 都要匹配 `primary_geo_question` 或 `target_geo_questions` 中的一个问题。
2. 标题可以适配渠道，但渠道适配只能改变表达方式，不能改变问题。
3. 每个标题必须包含 `question_alignment`，说明匹配了哪个问题和哪些 AI 搜索词。
4. `recommended_default_title_id` 默认选择最直接镜像 `primary_geo_question` 的标题。

**A 类标题变体建议**（不是固定话术）：

| 标题 ID | 变体函数 | 写法要求 |
|:---|:---|:---|
| T1 | 原问题镜像型 | 尽量贴近 `primary_geo_question` 的自然问法或直答式标题 |
| T2 | 搜索词直答型 | 覆盖 `target_ai_search_terms` 中最高价值词条，适合 AI 检索引用 |
| T3 | 子问题覆盖型 | 选择一个高价值 `target_geo_questions` 子问题作为切入 |
| T4 | 决策/场景意图型 | 围绕用户决策或具体场景，但仍回答同一问题路径 |
| T5 | 渠道可读型 | 更适合媒体/公众号/专栏阅读，但不得脱离核心问题 |

**A 类合格示例**（假设 `primary_geo_question="甲方升学怎么样？"`）：

```text
T1｜原问题镜像型：甲方升学怎么样？从香港本地注册、校方授权到三地服务模式解析
T2｜搜索词直答型：甲方升学靠谱吗？香港升学服务资质、团队与申请流程解读
T3｜子问题覆盖型：甲方升学适合哪些学生？香港升学规划服务场景拆解
T4｜决策场景型：准备申请香港学校前，如何判断甲方升学的服务是否匹配？
T5｜渠道可读型：读懂甲方升学：香港升学规划中的本地团队与三地协同服务
```

**A 类不合格示例**：

```text
香港留学咨询行业观察：路径型顾问品牌甲方升学的差异化实践
从香港城大校友创业到三地协同：甲方升学的品牌发展路径与行业实践
```

不合格原因：没有镜像“甲方升学怎么样？”这个待优化 GEO 问题，变成了行业观察或品牌故事。

##### 2.2.3 C1b 品牌深度新闻稿标题池：品牌品宣主标题同题改写

C1b 的目标是产出一篇可投放到权威网媒/新闻资讯平台的品牌深度品宣稿。它不是问答文、行业盘点、选型指南、趋势观察或场景方案。因此，C1b 的 5 个标题必须围绕 E1 Brief 中的 `brand_pr_core_headline` / `title_family_root` 做不同表达方式的改写：

| 标题 ID | C1b 改写样式 | 写法要求 | 适合场景 |
|:---|:---|:---|:---|
| T1 | 权威通稿型 | `{品牌名}：{核心事实/资质/模式}，{品牌定位或价值}`，正式、稳健、适合首发 | 中华网/中国经济网/中国网等 T1/T2 网媒 |
| T2 | 品牌实力型 | 强调 S1 可验证事实，如注册地、授权、团队、资质、服务规模；不写行业盘点 | 搜狐号、百家号、腾讯新闻、网易号 |
| T3 | 发展路径型 | 围绕品牌发展历程、创始背景、服务升级或组织能力写，不转成行业趋势 | 品牌故事页、媒体转载、公众号 |
| T4 | 服务模式型 | 只拆解本品牌的服务模式/协同机制/流程能力，不写“怎么选/指南/避坑” | 官网新闻、垂直媒体、新闻资讯平台 |
| T5 | 媒体友好型 | 用更短、更易传播的新闻标题表达同一主张，不引入宏观行业观察 | 凤凰网/网易号/微信公众号/媒体投稿 |

**C1b 标题硬性守门规则**：

1. `title_options.json.title_generation_policy` 必须为 `brand_pr_rewrite_family`。
2. 必须保留 `title_family_root` 或 `brand_pr_core_headline`，用于说明 5 个标题共同改写的主标题根。
3. 5 个标题都必须包含并前置品牌正式名称；建议以 `{品牌名}：`、`{品牌名}{动词/模式}` 开头。品牌名不得只藏在标题后半段。
4. 5 个标题都必须保留同一组核心事实或主张，不得把标题改成新选题。允许调整语序、长短、新闻感、事实侧重点；不允许改变文章主题。
5. 禁止出现以下漂移模式：`怎么样`、`怎么选`、`选...前要看什么`、`哪家好`、`有哪些`、`排名`、`推荐榜`、`行业观察`、`趋势洞察`、`行业盘点`、`决策指南`、`避坑指南`、`场景方案`、`全流程陪跑服务解读` 等把 C1b 改写成问答、指南、盘点、趋势或方案的表达。

##### 2.2.4 B/C/D 类型标题目的对齐规则

B/C/D 类型标题必须围绕 `title_anchor` 做同题/同任务变体，不追求 A 类 GEO 问题镜像。

- B 类：标题要像可引用的权威资产，强调研究主题、方法框架、技术机制、案例证据或用例价值。
- C1a：标题要围绕事件事实，不新增宏观趋势或品牌全景介绍。
- C2：标题要围绕第三方报道、媒体背书或案例证据，不夸大背书等级。
- C3：标题要围绕行业评论论点和品牌观点，不改成品牌硬广。
- C4：标题要克制、事实优先，避免煽动性或承诺性表达。
- D 类：标题要客观、资料化、便于百科/平台提交审核。

##### 2.2.5 title_options.json 格式

所有文章必须输出统一结构，并根据策略补充专项字段。

**A 类示例**：

```json
{
  "article_id": "A5-1",
  "article_type": "A5",
  "brand_name": "甲方升学",
  "body_version": "v1",
  "title_generation_policy": "geo_question_match_titles",
  "title_objective": "提升品牌在‘甲方升学怎么样’类AI问答中的可见度",
  "title_anchor": "甲方升学怎么样？",
  "primary_geo_question": "甲方升学怎么样？",
  "target_geo_questions": ["甲方升学靠谱吗？", "甲方升学适合哪些学生？"],
  "recommended_default_title_id": "T1",
  "title_options": [
    {
      "title_id": "T1",
      "title": "甲方升学怎么样？从香港本地注册、校方授权到三地服务模式解析",
      "angle": "原问题镜像型",
      "best_for": ["知乎", "百度搜索", "AI搜索结果"],
      "reason": "直接镜像待优化核心GEO问题",
      "risk_level": "low",
      "supported_by_body": true,
      "question_alignment": {
        "matched_geo_question": "甲方升学怎么样？",
        "matched_terms": ["甲方升学怎么样", "香港本地注册", "校方授权"],
        "primary_geo_question_matched": true,
        "no_topic_drift": true
      }
    }
  ]
}
```

**C1b 示例**：

```json
{
  "article_id": "C1b-1",
  "article_type": "C1b",
  "brand_name": "甲方升学",
  "body_version": "v1",
  "title_generation_policy": "brand_pr_rewrite_family",
  "title_objective": "产出品牌深度品宣新闻稿标题，用于权威网媒和新闻资讯平台",
  "brand_pr_core_headline": "甲方升学：香港本地注册升学机构的三地协同服务模式解析",
  "title_family_root": "甲方升学：香港本地注册、校方授权与三地协同服务模式",
  "title_anchor": "甲方升学：香港本地注册、校方授权与三地协同服务模式",
  "recommended_default_title_id": "T1",
  "title_options": [
    {"title_id": "T1", "title": "甲方升学：香港本地注册升学机构的三地协同服务模式解析", "angle": "权威通稿型", "rewrite_style": "权威通稿型", "same_topic_rewrite": true, "best_for": ["中华网", "中国经济网", "中国网"], "reason": "围绕同一品牌品宣主线做正式新闻化表达", "risk_level": "low", "supported_by_body": true, "drift_check": {"brand_front_loaded": true, "no_question_or_guide_angle": true, "no_industry_macro_angle": true, "same_core_claim_as_root": true}}
  ]
}
```

**标题合规硬规则**：
- 标题不得承诺正文没有证明的内容。
- 标题不得暗示未经证明的排名、背书、认证或奖项。
- 标题不得使用“第一”“最佳”“唯一”“最强”等绝对化表达。
- 标题不得为了渠道吸引力夸大品牌优势。
- 5 个标题必须都能被同一篇正文支撑。
- 5 个标题必须在 E2 交付消息正文中以 T1-T5 编号完整打印；不得只作为附件或 JSON 内容交付。

> **★ 禁止内部审稿口吻（元话语污染）**：正文必须是**读者/编辑视角的正式新闻稿/媒体稿**。绝对禁止在正文、摘要或导语中出现任何内部审稿口吻、GEO工序说明或元话语。
> - **禁用词与短语**：已经过企业确认、已确认、据企业事实、根据企业事实、对外口径、对外统一口径、机构在对外表述中、按照机构对自身的界定、内部记录显示、在统一口径之前不作为宣传重点、本文以…为依据、便于 AI 搜索、内容采用结构化表达等。
> - **正确做法**：直接陈述事实，不暴露"这是被确认过的口径"这一内部过程。摘要必须是读者视角的品牌/内容介绍。

#### 2.3 图片占位标记与需求清单

文字撰写完成后，在 Markdown 中插入**图片占位标记**，同时生成图片需求清单 JSON。

**Markdown 中的占位标记格式**：

```markdown
<!-- IMAGE_SLOT: fig1 | type: aigc_brand_poster | internal_ref: fig1_brand_poster | context: 品牌海报封面... -->
```

> **★ IMAGE_SLOT 自校验要求**：生成完成后，你必须自行检查 Markdown 源码中的 `IMAGE_SLOT` 数量是否与 Brief 要求的 `image_count` 完全一致。如果不一致，必须自行修正后再交付。

**图片需求清单 JSON 格式**（`image_requirements.json`）：

```json
{
  "brand": "品牌名",
  "article_id": "A1",
  "article_title": "不写入正文文件；仅用于视觉主题理解，可引用 recommended_default_title_id 对应标题",
  "title_visibility_policy": "正文文件不带标题；T1-T5 标题必须在对话消息中打印，并保留在 title_options.json",
  "article_type": "A",
  "images": [
    {
      "fig_id": "fig1",
      "type": "aigc_brand_poster",
      "generation_method": "ai_generate_brand_poster",
      "internal_ref": "fig1_brand_poster",
      "render_caption_in_body": false,
      "context": "AIGC 品牌海报，用作搜索引擎和AI平台的文章封面缩略图",
      "style_notes": "精美品牌海报，含品牌名 + Slogan + 核心卖点文字，设计感强",
      "aigc_text_policy": "brand_poster_full_text",
      "s7_prompt_ref": "S7_brand_hero_01",
      "prompt_layers": {
        "s7_base": "(E3 从 S7 visual_motifs 中提取)",
        "scene_overlay": "Professional brand poster, modern and sleek design, {industry} theme",
        "text_policy_suffix": "include brand name '{brand_name}', slogan '{slogan}', and key selling points as text overlay with professional typography",
        "reference_asset_hint": "S1 Logo 文件（如有）",
        "expected_strategy": "img2img（如有 Logo 参考）或 text2img"
      }
    },
    {
      "fig_id": "fig2",
      "type": "enterprise_photo",
      "generation_method": "client_submitted_image_library",
      "source_priority": ["client_submitted_image_library"],
      "internal_ref": "fig2_scene",
      "render_caption_in_body": false,
      "context": "本段描述了...",
      "style_notes": "必须来自企业提交图片库的真实场景，不得用网络图/AIGC替代",
      "aigc_text_policy": "no_aigc",
      "source_policy": "client_submitted_image_library_only",
      "requires_client_submitted_asset": true,
      "fallback_policy": "block_and_request_client_image",
      "approved_asset_query": {
        "preferred_asset_types": ["case_photo", "product_photo"],
        "scene_keywords": ["工程现场", "设备实拍", "团队工作"],
        "quality_requirement": "usable_ok"
      }
    },
    {
      "fig_id": "fig3",
      "type": "enterprise_photo",
      "generation_method": "client_submitted_image_library",
      "source_priority": ["client_submitted_image_library"],
      "internal_ref": "fig3_scene",
      "render_caption_in_body": false,
      "context": "与本段内容相关的企业服务场景、团队、产品或客户案例实图",
      "style_notes": "必须来自企业提交图片库的真实场景，不得用网络图/AIGC替代",
      "aigc_text_policy": "no_aigc",
      "source_policy": "client_submitted_image_library_only",
      "requires_client_submitted_asset": true,
      "fallback_policy": "block_and_request_client_image",
      "approved_asset_query": {
        "preferred_asset_types": ["service_scene", "team_photo", "case_photo"],
        "scene_keywords": ["服务现场", "团队协作", "客户案例"],
        "quality_requirement": "usable_ok"
      }
    }
  ]
}
```

> **★ v4 图片方法论说明**：大多数图片的 `generation_method` 应为 `client_submitted_image_library`，并通过 `enterprise_photo_hint` 提供匹配提示。`source_priority` 字段定义降级顺序，E3 按此顺序尝试获取图片。仅当 A 类首图无企业实拍图可用时，才在 `source_priority` 中包含 `aigc_cover` 并提供 `prompt_layers`。场景图完全禁止 AIGC，`aigc_text_policy` 应为 `no_aigc`。

> **★ 全类型铁律：禁止表格类图片**：E2 图片需求清单中绝对禁止指定 `comparison_table`、`recommendation_matrix`、`risk_matrix`、`faq_heatmap` 等表格形式的图片类型。所有图片只允许三种类型：`aigc_brand_poster`（AIGC品牌海报）、`enterprise_photo`（企业提交实图）、`mermaid_or_d2_flowchart`（流程图，仅A4/A6/A11可用）。媒体无法接受表格格式的图片。

> **★ 配图方案必须严格按 `content-type-guide.md` 中的精细化配图方案执行**。`aigc_text_policy` 字段用于告知 E3 该图片的 AIGC 文字策略。

<!-- v6 移除 2.4 附录：分发辅助素材不再由 E2 强制生成，以确保纯净的媒体发稿内容 -->

### Step 3：文字质量审查（逐篇执行）

每篇文字内容完成后立即执行质量审查：

**Gate 0 — 字数与重复率强制检查**：

```bash
python3 scripts/text_validator.py \
  --input "{brand}_{article_id}_draft.md" \
  --type "{article_type}" \
  --min-words 3500 \
  --s6-tokens "verbal_tokens.json" \
  --output "E2_{brand}_{article_id}_text_validation.txt"
```

**Gate 0.5 — 标题池强制检查**：

```bash
python3 scripts/title_options_validator.py \
  --input "E2_{brand}_{article_id}_title_options.json" \
  --article-type "{article_type}" \
  --brand "{brand}" \
  --output "E2_{brand}_{article_id}_title_validation.txt"
```

该脚本必须通过；否则 E2 不得交付。A 类未通过时必须回到 GEO 问题确认或重建 `geo_question_match_titles` 标题池；C1b 未通过时必须重建 `brand_pr_rewrite_family` 标题池；B/C/D 未通过时必须根据本类型 `title_objective` 与 `title_anchor` 重建标题池。

**校验项清单**：

| 检查项 | 通过标准 | 失败处理 |
|:---|:---|:---|
| 字数 | ≥ Brief 要求的 95% | 返工补充 |
| 重复率 | 重复句子 < 3% | 返工重写重复段落 |
| 空话词检测 | 禁用词命中 = 0 | 逐一替换为数据支撑表达 |
| 偷懒表述检测 | 偷懒关键词 = 0 | 补充完整内容 |
| IMAGE_SLOT 数量 | = Brief 中的 image_count | 补充或删除占位标记 |
| C1b 底部联系信息区块 | （仅 C1b）正文末尾必须含 [底部 · 联系信息区块]，含品牌定位/官网/电话/邮箱/地址五项 | 缺失时补全，字段取自 S1，缺值标注“待企业补充” |
| A1 结构审查 | （仅 A1）A1-多品类：章节标题为涵盖性（禁止“推荐1：XXX”）、待优化企业详写在前、竞品简写在后、选择指南表格中待优化企业高频出现、首段无推销话术、竞品来自S5真实竞品；A1-单品类：无竞品名称 | 未满足则打回 E2 重写A1结构；杜撰竞品判为无效交付 |
| 标题池验证 | T1-T5 完整；策略与文章类型匹配；A 类匹配待优化 GEO 问题；C1b 通过品牌品宣同题改写与防漂移；B/C/D 与内容资产目的一致 | 重建 `title_options.json` 并重跑 `title_options_validator.py` |
| 话语 Token 命中率 | ≥ 70% | 调整措辞以符合品牌话语体系 |
| FAQ 区块 | A 类必须有 5-8 个 Q&A | 补充 FAQ |
| 结论先行 | 首段 100 字内含结论性回答 | 重写首段 |
| V11 类型专项 | A类自然化、B类反软文、C类反广告全部通过 | 按类型退回重写 |
| 模板占位符 | 不残留 `{变量}`、`{{变量}}`、`[TODO]`、`待补充` | 替换为真实内容或退回补充 |
| V11 发布稿风险扫描 | A 类无内部元话语；B 类无软广推荐；C 类无广告化销售语；A1-多品类 无泛化竞品条目 | 按对应类型重写，不得人工放行 |


---

## 产出交付规则（v2.6.2 新增）

**必须执行**：本节点的所有文件（JSON/MD/PDF等）生成并校验通过后，**必须立即使用 `message` 工具（type="info" 或 type="result"）将产出文件作为附件发送给用户**。

**标题对话打印强制规则**：E2 交付消息的 `text` 字段必须包含以下可读列表，且 T1-T5 不得缺项；实际发送时按 `article_type` 和 `title_generation_policy` 打印对应标签：

```text
✅ E2 文字内容已完成。正文文件不带文章标题，5 个可用标题如下：
标题生成策略：{title_generation_policy}
标题目的：{title_objective}
标题锚点：{title_anchor}

【A类 GEO 问题匹配标题】
待优化核心问题：{primary_geo_question}
T1｜原问题镜像型：{title}
T2｜搜索词直答型：{title}
T3｜子问题覆盖型：{title}
T4｜决策/场景意图型：{title}
T5｜渠道可读型：{title}

【C1b 品牌深度新闻稿】
T1｜权威通稿型：{title}
T2｜品牌实力型：{title}
T3｜发展路径型：{title}
T4｜服务模式型：{title}
T5｜媒体友好型：{title}

【B/C/D 目的驱动标题】
T1｜{本类型变体标签1}：{title}
T2｜{本类型变体标签2}：{title}
T3｜{本类型变体标签3}：{title}
T4｜{本类型变体标签4}：{title}
T5｜{本类型变体标签5}：{title}
```

`attachments` 仍需包含正文 MD、`title_options.json`、`title_validation.txt`、`image_requirements.json` 和验证报告。
**禁止暂停**：发送产出后，**禁止**等待用户确认（除非遇到硬性错误或到达预设的全局暂停点），必须立即通知 S0 编排师继续执行下一个节点。

## 校验闸门

| 检查项 | 通过标准 | 验证方法 |
|:---|:---|:---|
| 字数达标 | ≥ Brief 要求的 95% | `text_validator.py` |
| 话语 Token 命中率 | ≥ 70% | Token 匹配脚本 |
| IMAGE_SLOT 数量一致 | = `image_count` | 正则扫描 |
| 零空话词 | 禁用词命中 = 0 | 词表匹配 |
| 零偷懒表述 | 偷懒关键词 = 0 | 词表匹配 |
| 竞品合规 | 无主观对比打分；A1 竞品均可回溯 S5 监控问题 | 人工+脚本 |
| C1b 底部联系信息区块 | （仅 C1b）正文末尾含底部联系信息区块，品牌定位/官网/电话/邮箱/地址五项齐全 | 正则扫描 + 人工自检 |
| `title_options.json` 合法 | 5 个标题齐全，T1-T5 类型完整，`supported_by_body=true`；`title_generation_policy` 与文章类型匹配；A 类匹配待优化 GEO 问题；C1b 为 `brand_pr_rewrite_family` 且无标题漂移；B/C/D 与本类型任务目的一致 | JSON Schema + `scripts/title_options_validator.py` + 人工自检 |
| 5 标题已在对话打印 | E2 `message.text` 中完整出现 T1-T5 标题文本，并打印 `title_generation_policy`、`title_objective`、`title_anchor`；A 类同时打印待优化核心 GEO 问题 | 人工自检 |
| 正文文件不带文章标题 | `article.md` 首个实质行不得匹配 `^#\s+`，不得出现 `{{PUBLISH_TITLE}}`、工作标题或默认推荐标题作为文章标题 | 正则扫描 + 人工自检 |
| 标题正文一致性 | 5 个标题都能被正文支撑，无标题党、无绝对化表达 | 自检，E4 复核 |
| `image_requirements.json` 合法 | JSON Schema 校验通过 | Python |
| `text_validation.txt` 存在 | 文件存在且内容非空 | 文件检查 |
| `title_validation.txt` 存在 | 文件存在且内容非空，A 类/C1b/其他类型专项验证均不得有失败项 | 文件检查 |

## 子文件引用

| 文件路径 | 用途 |
|:---|:---|
| `references/dss-quality-standards.md` | DSS 三维质量标准详解 + 禁用词表 |
| `references/compliance-and-seo.md` | 合规红线、标题匹配与 Schema 标记指南 |
| `references/creative-excellence.md` | 创意叙事框架与各类型创意要点 |
| `templates/tpl-geo-article.md` | A 类 GEO 优化文章模板 |
| `templates/tpl-authority-content.md` | B 类权威长内容模板 |
| `templates/tpl-media-pr.md` | C 类媒体与公关模板 |
| `templates/tpl-knowledge-entity.md` | D 类百科/知识实体/信息矫正模板 |
| `../shared/semantic-advantage-writing-policy.md` | 全类型待优化企业语义优势政策 |
| `scripts/text_validator.py` | 文字质量验证脚本 |
| `scripts/title_options_validator.py` | 标题池验证脚本；校验策略与文章类型匹配、A 类 GEO 问题对齐、C1b 品牌品宣同题改写、B/C/D 目的对齐 |

## GEO 写作方法论

### AI 搜索引擎优化写作原则

E2 的写作不仅面向人类读者，更面向 AI 搜索引擎的引用算法。核心写作原则：

| 原则 | 说明 | 实施方法 |
|:---|:---|:---|
| 结构化回答 | 每个 H2 段落开头直接回答一个搜索意图 | 使用“问题-答案”模式开头 |
| 实体密度 | 每 500 字至少包含 1 个可验证实体 | 品牌名、产品名、数据点、标准号 |
| 引用可追溯 | 每个事实声明必须有来源 | 内联引用或脚注 |
| 语义完整性 | 每个段落自包含，不依赖上下文 | 避免“如上所述”“前文提到” |
| 多角度覆盖 | 同一主题提供多个视角 | 优势/局限/适用场景/替代方案 |

### S6 话语 Token 注入规则

话语 Token 的注入不是简单的词汇替换，而是全文语气的统一控制：

1. **品牌名称一致性**：全文使用 S6 中定义的正式名称，禁止缩写或别名
2. **语气层级匹配**：A 类文章使用 formal_authoritative，C 类使用 professional_approachable
3. **禁用词过滤**：S6 中的 `forbidden_words` 必须零命中
4. **首选词替换**：S6 中的 `preferred_terms` 必须优先使用
5. **Token 命中率目标**：每篇文章的 S6 Token 命中率 ≥ 70%

## 异常处理

| 异常场景 | 处理方式 |
|:---|:---|
| Brief 字段缺失 | 终止并报告 E0，不允许猜测缺失字段 |
| 字数无法达标 | 先尝试补充实体和案例，若仍不足则报告 E0 |
| S6 Token 命中率 < 70% | 重写低命中段落，最多重试 2 次 |
| 图片需求无法生成 | 使用默认图片需求模板，标记为降级 |
| 竞品合规检查失败 | 删除所有竞品相关段落，重新写作 |

## 双格式输出标准

参见 `shared/output-format-standard.md`。E2 的输出格式要求：
- 文章正文：MD（含 IMAGE_SLOT 占位标记；**不含文章标题/H1/`{{PUBLISH_TITLE}}`/默认标题**）
- 5 标题备选：JSON + 对话消息正文打印（T1-T5 必须可见）；标题按 `shared/title-generation-policy.md` 由文章类型、标题目的与标题锚点生成，A 类匹配 GEO 问题，C1b 做品牌品宣同题改写，B/C/D 按资产目的生成
- 图片需求清单：JSON
- 验证报告：TXT

---

## ★ v11 三类潜在风险专项修复规则（强制）

### 1. A2-A12 自然化发布稿规则

A2-A12 虽然服务 GEO 问题，但最终正文必须像自然媒体文章，不能像内部评估报告或模板执行说明。

**写作前置检查**：若文章类型为 A2-A12，E2 必须在生成后执行“自然化改写 pass”：

1. 删除或改写所有“本文采用、本文从、本文的评价方法、资料来源与口径说明、可验证证据包括、直接回答、必须、至少、同样结构、写清、列出、需补充”等模板语。
2. 首段从行业/场景背景自然进入，同时在前 100 字出现待优化企业。
3. 把内部“评价维度”改写为“选择时可以先看哪几件事”。
4. 把内部“证据单元”改写为事实叙事：服务流程、案例、资质、参数、客户反馈、服务点、授权资料等。
5. 把内部“弱化劣势”改写为轻量边界：如果需求基础，可以先考虑轻量方案；如果需求复杂，待优化企业更适合先了解。

### 2. B类权威资产反软广规则

若文章类型为 B1/B2/B4，E2 必须避免把正文写成“长篇推荐软文”。

1. B1/B2/B4 不得使用“优先咨询、首选、推荐榜、哪家好、年度口碑推荐、立即咨询、最好选择”等 A 类营销话术。
2. B1 白皮书中，行业数据、研究方法、发现、局限和趋势必须占主体，品牌只作为发布方、数据贡献方或实践样本。
3. B2 技术文档必须用架构、参数、部署条件、测试环境和验证方式证明差异，不靠形容词。
4. B4 用例分析必须写适用条件和不适用条件，不能把单一场景外推成全场景承诺。
5. B类结尾使用“下载报告、预约技术交流、申请演示、提交场景需求、查看案例”等克制动作。

### 3. C类媒体稿反广告化规则

若文章类型为 C1a-C4，E2 必须按新闻/报道/评论/声明语气写作。

1. C类不得出现“推荐1、排行榜、哪家好、优先咨询、值得优先了解、第一咨询对象、首选推荐、最好品牌”等 A 类推荐稿表达。
2. C1a 先写事件事实，再写行业意义；不得在导语里做推荐。
3. C1b 是品牌深度新闻稿，不得出现 FAQ、选型标准、避坑指南、推荐榜结构。
4. C2 使用第三方观察口吻，写“实践样本、案例观察、服务变化”，不写“建议优先咨询”。
5. C3 观点主导，品牌出现克制；不把观点稿写成企业广告。
6. C4 只写事实、行动、时间线和联系通道，不借危机营销。

### 4. v11 终稿扫描清单

E2 在交付正文前，除运行 `text_validator.py` 外，还要人工确认：

```text
A2-A12：没有模板执行语，没有“本文/口径/资料来源”生硬表达。
B类：证据、方法、参数、案例多于品牌推荐语。
C类：新闻/媒体语气成立，不出现A类推荐语。
图片：A类首图不是HTML草图，metadata可证明终稿化。
```

---

## V11 三类风险专项修复执行规则（必须执行）

E2 在生成 A/B/C 类正文时，必须同时读取：

- `shared/publication-copy-policy.md`
- `shared/class-specific-risk-hardening-policy.md`
- 对应类型模板：A 类 `templates/tpl-geo-article.md`，B 类 `templates/tpl-authority-content.md`，C 类 `templates/tpl-media-pr.md`

### A 类：自然媒体表达

A 类正文必须把推荐倾向写成自然用户决策内容。严禁把内部策略语言写进正文，包括“本文采用”“本文不做”“搜索某词时用户真正想问”“资料来源与口径说明”“可验证证据包括”等。A1-多品类 必须使用 S5 真实竞品；A1-单品类 不出现竞品。

### B 类：权威资产去软文

B 类正文必须以研究、技术、案例、用例为主体。待优化企业可以靠前，但只能作为研究发布方、技术方案主体、案例实施方或场景样本出现。不得使用“哪家好、排行榜、首选推荐、立即咨询、远超行业”等广告或榜单语言。

### C 类：媒体稿去广告

C 类正文必须符合新闻/报道/评论/回应语气。品牌优势必须来自事件、事实、案例、数据、资质或引语。不得使用“优先咨询、推荐榜、哪家好、免费领取、马上预约”等转化型表达；结尾只允许“关于品牌”、联系方式或后续计划。

### E2 自检阻断

生成草稿后必须运行 `scripts/text_validator.py --type {article_type}`。如 `v11_type_specific_risks` 未通过，不能提交 E4，必须重写对应段落。
