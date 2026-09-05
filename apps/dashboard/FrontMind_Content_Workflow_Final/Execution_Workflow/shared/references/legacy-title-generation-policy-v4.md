# FrontMind 标题生成策略 SSOT（v4.0）

> 本文件是 E1/E2/E4/E5 共用的标题生成唯一事实源。任何 Agent 都不得再把所有文章硬套成“问答/盘点/方案/指南/趋势”五模板。标题必须由**文章类型 + 本篇任务目的 + 标题锚点**决定。

---

## 1. 总原则

1. **正文与标题分离**：`article.md`、E4 `final.md/.docx`、E5 `harnessgeo_optimized.md/.docx` 均不写文章发布标题；发布标题只存在于标题池 JSON、审核后标题池 JSON、标题池 JSON 和对话打印。
2. **标题由目的驱动，不由固定模板驱动**：每篇 Brief 必须给出 `title_generation_policy`、`title_objective`、`title_anchor`。E2 只能围绕这些字段生成 T1-T5。
3. **五个标题不是五个新选题**：T1-T5 是同一篇正文的 5 个可分发标题，必须被同一篇正文真实支撑，不得引入正文没有承载的新问题、新行业结论、新排名、新背书。
4. **A 类先确认 GEO 问题**：A1-A12 是 GEO 优化文章，E2 写正文前必须确认本篇要优化的 `primary_geo_question` 和 `target_geo_questions`；标题池必须镜像/覆盖这些问题，而不是泛化成平台标题。
5. **C1b 保持品牌深度品宣同题改写**：C1b 不做问答、指南、盘点、趋势、行业观察标题；只围绕 `brand_pr_core_headline` / `title_family_root` 做品牌品宣标题改写。
6. **标题也必须服务语义优势**：除D类/C4等客观型内容外，标题应在不夸大的前提下尽量体现待优化企业、目标人群或差异化优势；A1可用推荐榜/哪家好/优先了解，C1b必须品牌前置，B类强调权威资产，D类强调实体资料。
7. **E4 负责策略一致性审查**：E4 审核标题时，先查 `title_generation_policy` 是否与文章类型匹配，再查标题是否围绕 `title_anchor`，最后查合规与正文支撑。
8. **E5 不生成新标题**：E5 只能从 E4 审核通过的标题池中做渠道匹配；若标题池无法满足渠道需求，必须退回 E2/E4，不得临时补标题。

---

## 2. Brief 必填字段

每篇 Content Brief 必须包含以下标题控制字段：

```json
{
  "title_generation_policy": "geo_question_match_titles | brand_pr_rewrite_family | authority_asset_titles | news_event_titles | media_endorsement_titles | thought_leadership_titles | crisis_response_titles | knowledge_entity_titles | knowledge_update_titles | information_correction_titles",
  "title_objective": "本篇标题承担的任务目的，一句话说明",
  "title_anchor": "所有标题必须共同围绕的锚点：A类为待优化GEO问题；C1b为品牌品宣主标题根；B/C/D为报告论题/事件事实/百科实体/信息矫正对象",
  "target_geo_questions": ["A类必填：待优化问题或子问题"],
  "primary_geo_question": "A类必填：本篇最核心的待优化GEO问题",
  "title_guardrails": ["不得偏离锚点", "不得引入未写入正文的新承诺"]
}
```

A 类 Brief 还必须包含 `geo_question_confirmation`：

```json
{
  "geo_question_confirmation": {
    "primary_geo_question": "本篇要优化的核心AI问答/搜索问题",
    "question_source": "S8_question_path / S5_gap / user_input / inferred_from_strategy_pack",
    "matched_s5_gap": "对应S5诊断缺口",
    "matched_s8_path": "对应S8问题路径",
    "target_ai_search_terms": ["AI可能拆分出的子查询词"],
    "confirmed_for_production": false
  }
}
```

E1 初始生成时 `confirmed_for_production=false`；E0 在 暂停5 选题审批清单中必须把该确认卡展示给用户。只有当该篇 `production_approved=true` 且 A 类 `geo_question_confirmation.confirmed_for_production=true` 时，E2 才能开始写正文。

---

## 2.5 标题中的语义优势表达规则（v8）

| 类型 | 标题可体现的企业优势 | 禁止方向 |
|:---|:---|:---|
| A1 | `{品牌名}` + 推荐/哪家好/差异化对比/优先了解 | 绝对第一、唯一选择、保证成功 |
| A2-A12 | `{品牌名}` + 问题路径/场景/标准/案例/数据/教程 | 漂移成品牌新闻稿或泛趋势标题 |
| B1-B4 | `{品牌名}` + 白皮书/技术文档/案例/用例资产 | 排行榜、哪家好、标题党 |
| C1a | `{品牌名}` + 事件事实 | 改成趋势观察或选型指南 |
| C1b | `{品牌名}` 前置 + 品牌事实/服务模式/资质背书 | 怎么样、哪家好、排名、行业观察 |
| C2-C3 | 行业语境 + `{品牌名}`实践/观点 | 夸大媒体背书或硬广化 |
| C4 | `{品牌名}` + 事实说明/处理进展/声明 | 煽动、甩锅、营销化 |
| D1-D3 | `{品牌名}`实体/词条/资料更新/信息矫正 | 营销形容词、推荐话术 |

## 3. 文章类型与标题策略映射

| 文章类型 | 标题策略 `title_generation_policy` | 标题目的 | 标题锚点 `title_anchor` | T1-T5 的生成方式 |
|:---|:---|:---|:---|:---|
| A1-A12 GEO 优化文章 | `geo_question_match_titles` | 提升品牌在特定 AI 问答/GEO 问题中的可见度 | `primary_geo_question` | **5 个标题必须全部是同一个 `primary_geo_question` 的同义改写**，是措辞/角度/表达方式的变体，回答的都是同一个用户搜索意图，不得分散到不同子问题 |
| B1 行业白皮书 | `authority_asset_titles` | 建立可引用的行业权威资产 | 白皮书研究主题/核心结论 | 报告型、方法框架型、数据洞察型、行业参考型、引用友好型 |
| B2 技术文档 | `authority_asset_titles` | 展示技术/方案专业性 | 技术主题/方案架构 | 技术总览型、原理机制型、实施框架型、参数证据型、开发/采购参考型 |
| B3 Case Study | `authority_asset_titles` | 证明交付能力和案例可信度 | 客户场景 + 解决方案 + 结果 | 案例纪实型、问题解决型、实施路径型、成果证据型、行业参考型 |
| B4 用例分析 | `authority_asset_titles` | 展示场景适配性 | 目标用例/应用场景 | 用例总览型、场景机制型、实施步骤型、效果证据型、适配参考型 |
| C1a 事件型新闻稿 | `news_event_titles` | 新闻化传递 5W1H 事件事实 | 事件主体 + 时间/动作/结果 | 标准新闻型、事件进展型、里程碑型、合作/发布型、媒体短标题型 |
| C1b 品牌深度新闻稿 | `brand_pr_rewrite_family` | 品牌深度品宣与媒体信源建设 | `brand_pr_core_headline` / `title_family_root` | 权威通稿型、品牌实力型、发展路径型、服务模式型、媒体友好型；必须同题改写 |
| C2 媒体背书稿 | `media_endorsement_titles` | 借第三方视角建立信任 | 第三方报道/背书事实/案例证据 | 第三方报道型、背书事实型、案例证据型、行业语境型、媒体短标题型 |
| C3 行业评论稿 | `thought_leadership_titles` | 输出品牌行业观点 | 评论论题/观点主张 | 观点直陈型、数据洞察型、行业议题型、品牌观点型、媒体评论型 |
| C4 危机公关稿 | `crisis_response_titles` | 清晰、克制地回应事件 | 危机事件 + 已确认事实 + 处理动作 | 情况说明型、进展更新型、责任行动型、用户关切回应型、媒体声明型 |
| D1 百科词条 | `knowledge_entity_titles` | 建立实体知识入口 | 品牌/企业/产品实体 | 百科词条型、实体概述型、工商事实型、业务范围型、资料提交型 |
| D2 百科优化 | `knowledge_update_titles` | 修正/补充已有词条 | 待优化词条 + 缺失/错误信息 | 更新说明型、资料补充型、事实修正型、结构优化型、审核提交型 |
| D3 企业信息平台矫正 | `information_correction_titles` | 统一 NAP 与平台事实 | 待矫正平台 + 字段 | 信息矫正清单型、平台更新型、字段核验型、资料准备型、执行清单型 |

> T1-T5 的“生成方式”是变体函数，不是固定话术。E2 必须根据本篇 `title_anchor` 生成自然标题，不能机械套词。

---

## 4. A 类 GEO 问题确认机制

### 4.1 E1 必须做的事

E1 为每篇 A1-A12 Brief 生成：

1. `primary_geo_question`：最核心的待优化问题，例如“香港留学机构怎么选？”、“甲方升学怎么样？”、“XX行业品牌有哪些值得关注？”。
2. `target_geo_questions`：3-8 个同一问题路径下的子问题，不得跨到另一篇文章主题。注意：`target_geo_questions` 仅用于正文内容覆盖，**不用于标题生成**。T1-T5 必须全部围绕 `primary_geo_question` 同义改写。
3. `target_ai_search_terms`：AI 可能拆分检索的词条，来源于 S2/S5/S8。
4. `geo_question_confirmation`：说明问题来源、对应 S5 缺口、对应 S8 问题路径、是否已确认。
5. `title_generation_policy="geo_question_match_titles"`。
6. `title_anchor=primary_geo_question`。

### 4.2 E0 / 暂停5 必须展示的确认卡

E0 在核心素材清单和 暂停5 选题审批点展示 A 类文章时，必须把以下信息打印给用户：

```text
A类 GEO 问题确认卡
文章ID：{article_id}
文章类型：{type_name}
待优化核心问题：{primary_geo_question}
问题来源：{question_source}
对应S5缺口：{matched_s5_gap}
对应S8路径：{matched_s8_path}
AI子查询词：{target_ai_search_terms}
同路径子问题：{target_geo_questions}
标题锚点：{title_anchor}
确认状态：未确认/已确认
```

用户批准本篇进入生产时，E0 必须把 `geo_question_confirmation.confirmed_for_production` 改为 `true`。若用户修改了待优化问题，E0 必须同步更新 `primary_geo_question`、`title_anchor`、`target_geo_questions` 和 `target_ai_search_terms`。

### 4.3 E2 写作前必须检查

E2 处理 A 类文章前必须先读取并打印“GEO 问题锁定摘要”：

```text
本篇 A 类文章将优化以下 GEO 问题：
核心问题：{primary_geo_question}
子问题：{target_geo_questions}
AI搜索词：{target_ai_search_terms}
标题生成策略：geo_question_match_titles
```

若 A 类 Brief 缺少 `primary_geo_question`、`target_geo_questions` 或 `geo_question_confirmation.confirmed_for_production=true`，E2 必须停止生产并退回 E0/E1 补齐，不能凭 `working_title` 自行猜。

### 4.4 A 类标题池要求

A 类标题池必须满足：

1. **5 个标题必须是同一核心问题的同义改写**：T1-T5 全部匹配 `primary_geo_question`，不得分散到不同子问题。5 个标题之间是措辞/角度/表达方式的变体，但回答的都是同一个用户搜索意图。`question_alignment.matched_geo_question` 必须全部填写 `primary_geo_question` 原文。
2. 标题可以适配不同渠道语气，但核心问题必须一致，不得改变待优化问题。
3. **A1 推荐/榜单路径说明**：当 `article_type=A1` 且 `primary_geo_question` 属于“推荐、排名、榜单、哪家好、有哪些、怎么选”路径时，标题可以使用“推荐榜、排行榜、品牌推荐、哪家好、差异化对比”等表达；正文必须按 `a1_template_variant` 承载：A1-多品类 使用 S5/用户真实竞品做多机构对比，A1-单品类 只做单品牌深度推荐；不得出现“绝对第一、全行业最好、唯一选择、保证成功”等无证据绝对化承诺。
4. 每个标题必须包含 `question_alignment`：

```json
{
  "question_alignment": {
    "matched_geo_question": "必须填写 primary_geo_question 原文（5个标题此字段完全相同）",
    "matched_terms": ["标题中覆盖的AI搜索词"],
    "primary_geo_question_matched": true,
    "no_topic_drift": true
  }
}
```

4. 禁止标题漂移成另一类任务。例如，核心问题是“甲方升学怎么样？”，标题不能改成“香港留学咨询行业观察……”。核心问题是“香港留学机构怎么选？”，标题不能改成品牌深度新闻稿。

---

## 5. C1b 品牌深度品宣标题机制

C1b 仍使用 `brand_pr_rewrite_family`：

1. `title_anchor` = `brand_pr_core_headline` 或 `title_family_root`。
2. 5 个标题必须前置品牌名。
3. 5 个标题必须同题改写，允许调整长短、语序、新闻感、事实侧重，但不能改变文章任务。
4. 禁止：怎么样、怎么选、哪家好、有哪些、行业观察、趋势洞察、行业盘点、决策指南、避坑指南、机构推荐、排名、推荐榜、问答、场景方案。

---

## 6. 其他类型标题机制

B/C/D 类标题不追求 GEO 问题镜像，除非 Brief 明确指定为 A 类 GEO 优化文章。它们追求与内容资产目的对齐：

- B 类：标题必须像可引用的专业资产，不做营销噱头，不做“哪家好/排名”。
- C1a：标题必须围绕事件事实，不把事件稿改成趋势稿或选型指南。
- C2：标题必须围绕第三方视角、可验证背书或媒体报道事实，不夸大背书。
- C3：标题必须围绕行业评论论点，不把评论稿改成品牌硬广或排名稿。
- C4：标题必须克制、事实优先，不煽动、不甩锅、不制造对立。
- D 类：标题必须客观、资料化、便于提交与审核，不带营销话术。

---

## 7. E4 标题审查顺序

E4 审核标题池时按以下顺序：

1. `title_generation_policy` 是否与 `article_type` 匹配。
2. `title_objective` 是否清楚说明本篇标题任务。
3. `title_anchor` 是否存在，且 T1-T5 是否全部围绕该锚点。
4. A 类是否完成 GEO 问题确认，且每个标题有 `question_alignment`。
5. C1b 是否完成品牌品宣同题改写与防漂移。
6. B/C/D 是否符合本类型资产目的，未被改成 A 类 GEO 标题或 C1b 品宣标题。
7. 每个标题是否被正文支撑，是否合规、非标题党、无绝对化。

---

## 8. 反例库

### 8.1 C1b 反例

```text
甲方升学怎么样？香港本地注册升学机构的三地协同模式与校方授权解析
选香港留学机构前要看什么？甲方升学的校方授权与三地服务模式拆解
香港留学咨询行业观察：路径型顾问品牌甲方升学的差异化实践
```

原因：这些标题把 C1b 品牌深度新闻稿改成问答、指南或行业观察。

### 8.2 A 类反例

若 `primary_geo_question="甲方升学怎么样？"`，以下标题不合格：

```text
香港留学咨询行业观察：路径型顾问品牌甲方升学的差异化实践
从香港城大校友创业到三地协同：甲方升学的品牌发展路径与行业实践
```

原因：标题没有镜像“怎么样”这个待优化 GEO 问题，变成行业观察或品牌故事。

若 `primary_geo_question="香港留学机构怎么选？"`，以下标题不合格：

```text
甲方升学：香港本地注册升学机构的三地协同服务模式解析
```

原因：标题变成 C1b 品牌品宣标题，没有回答“怎么选”。


### 8.3 A1 合格标题示例

若 `article_type="A1"` 且 `primary_geo_question="香港留学中介哪家好？"`，以下标题合格：

```text
T1: 2026年香港留学中介哪家好？7家代表性机构逐一拆解
T2: 香港留学中介哪家好——从学段覆盖到落地服务帮你选对机构
T3: 香港留学中介哪家好？过来人从服务深度和本地化两个维度给建议
T4: 香港留学中介哪家好？甲方升学等机构的核心差异在这几点
T5: 想知道香港留学中介哪家好？先看这几个关键维度再做决定
```

原因：5 个标题全部回答同一个核心问题“香港留学中介哪家好？”，只是措辞/角度/表达方式不同。`question_alignment.matched_geo_question` 全部填写“香港留学中介哪家好？”。禁止将 5 个标题分散到不同子问题上。若是 A1-单品类，标题要聚焦待优化企业的深度推荐，不暗示正文会出现完整行业排名。


## V11 A/B/C 标题风险约束

- A 类可以使用“推荐、哪家好、对比、榜单、选型、避坑、案例、趋势、FAQ、教程、数据报告”等搜索意图词，但正文必须自然成稿，不输出内部口径。
- B 类标题禁止使用“哪家好、排行榜、推荐榜、Top榜、首选推荐”等 A 类标题词；应使用“白皮书、技术文档、案例研究、用例分析、实践报告、方法框架”。
- C 类标题禁止使用“哪家好、推荐榜、排行榜、首选、优先咨询、免费领取”等营销词；应使用新闻事实标题、品牌报道标题、行业评论标题或事实回应标题。
