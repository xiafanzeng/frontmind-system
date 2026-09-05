# 执行编排规则详解 (Execution Orchestration Rules)

> **v3.7 企业提交图片库 + 继续生产边界**：执行层单轮主线为 `E0 图片库校验 → E1 → 暂停5 → E2 → E3 → E4 → E5 → 继续生产确认`。E5 是本轮最后生产节点；E5 之后不触发渠道确认、发布或监测回流，但 E0 必须询问是否继续制作其他文章/文章类型。继续当前菜单未生产 Brief 则回暂停5（选题审批）；新增文章类型/新选题则回 E1；选择结束则最终打包。

本文档是 `E0.执行编排师.skill/SKILL.md` 的补充参考，提供执行层 E0-E5 的依赖关系、异常处理、状态管理与结束边界规则。

---

## 一、调度优先级与依赖关系

### 1.1 严格串行依赖链

以下 Agent 之间存在严格的数据依赖，必须按顺序执行，不得并行或跳过：

| 顺序 | Agent | 依赖的上游产出 | 产出物 |
| :--- | :--- | :--- | :--- |
| 0 | E0 执行编排师 | strategy_pack + 企业提交图片库 | 标准化图片库 Manifest + 图片库索引 + 图片库校验报告 + 图片注册表 |
| 1 | E1 内容策略师 | strategy_pack + 企业提交图片库索引 | 选题矩阵 + 核心素材清单 + Content Brief + 逐图客户提交素材计划 |
| 2 | 暂停5 选题审批闸门 | E1 Content Brief | 获批 Brief 列表，`production_approved=true` |
| 3 | E2 文字内容生成师 | 暂停5 通过的单篇 Content Brief + S6 Token + S5 快照 | **无文章标题正文 MD** + 5 标题备选 JSON + 标题验证 TXT + 图片需求 JSON；T1-T5 必须在对话中打印；A 类标题必须匹配已确认 GEO 问题；C1b 标题必须为品牌品宣同题改写；B/C/D 按内容资产目的生成标题 |
| 4 | E3 视觉资产生成师 | E2 图片需求 + S7 Prompt + 企业提交图片库 manifest/index + 图片注册表 | 配图 PNG/WebP + Prompt Plan + 视觉元数据；缺少客户提交实图时输出补图需求并阻断该篇 |
| 5 | E4 质量审查与组装师 | E2 无文章标题正文 + E2 标题池 + E3 图片 + 企业提交图片库 manifest + 图片元数据 | **无文章标题 DOCX + 无文章标题 MD** + 审核后标题池 + 标题验证 TXT + 审查报告；T1-T5 必须在对话中打印 |
| 6 | E5 分发编排师 | 全部 E4 已完成无文章标题正文 + 审核后标题池 + S5/S9 | 无文章标题 HarnessGEO 正本 + 合规审查报告 |

### 1.2 条件触发规则

| 触发条件 | 目标 | 默认行为 |
| :--- | :--- | :--- |
| E1 完成 | 暂停5 | 使用 `message(type="ask")` 展示核心素材清单并等待审批 |
| 图片库校验通过 | E1 | 只要图片库存在、E0 自动生成 manifest/index 且 `validation_status=passed` 即允许进入 E1；不要求用户提交 image_library_manifest.json |
| 暂停5 至少批准 1 篇 Brief | E2/E3/E4 逐篇循环 | 自动逐篇生产，不再要求逐篇选标题；正文文件不带文章标题，T1-T5 标题在交付消息中打印；A 类必须先确认待优化 GEO 问题；C1b 只允许品牌深度品宣主标题同题改写 |
| 所有获批文章完成 E4 | E5 | 自动执行 HarnessGEO 正本优化与分发编排 |
| E5 完成 | 继续生产确认 | E0 询问是否继续制作其他文章/文章类型；A 结束，B 回暂停5（选题审批），C 回 E1，D 结束并返回策略层 |

### 1.3 正文无标题与标题对话可见规则

1. E2/E4/E5 产生的正文类文件（`article.md`、`final.md`、`final.docx`、`harnessgeo_optimized.md/.docx`）均不得包含文章标题、`# {{PUBLISH_TITLE}}`、工作标题或默认推荐标题。
2. T1-T5 标题仍必须生成并进入 `title_options.json` / `title_options_reviewed.json`，用于 E5 渠道匹配；标题策略由 `shared/title-generation-policy.md` 决定：A 类使用 `geo_question_match_titles` 并匹配已确认 GEO 问题，C1b 使用 `brand_pr_rewrite_family` 品牌品宣同题改写，B/C/D 使用对应的目的驱动标题策略。
3. E2、E4、E0 本篇汇总和 E5 分发结果消息必须在 `message.text` 中直接打印 T1-T5 标题；禁止只发送标题 JSON 附件。
4. 发布时由外部发布层在正文外部选择标题，正文文件本身保持无标题正本。A 类发布标题只能从已审核、匹配待优化 GEO 问题的标题中选择；C1b 发布标题只能从 E4 审核通过的权威通稿型/品牌实力型/发展路径型/服务模式型/媒体友好型标题中选择，不得新增问答/指南/盘点/趋势标题；B/C/D 不得临时改成其他文章目的标题。

---


### 1.4 企业提交图片库阻断规则

执行层的企业实图来源只有一个：E0 校验通过的企业提交图片库。

| 场景 | 处理 |
| :--- | :--- |
| 未上传图片库 | 停止启动，要求上传 `Client_Submitted_Image_Library.zip` 或目录 |
| 图片库缺失或无可用图片 | 停止启动，要求客户补充图片库 |
| Brief 标记需要实图但图片库无匹配素材 | E3 输出 `missing_client_image_request.json`，该篇不得进入 E4 |
| E3 使用了非提交库网图/AIGC 冒充企业实拍 | E4 一票否决，打回 E3 |
| E5 正本缺图片物理嵌入 | E5 不合格，补齐图片嵌入 |

S1/S7 视觉资料只可用于风格参考，不能替代企业提交图片库。

## 二、状态管理机制

E0 必须维护以下全局状态变量，贯穿整个执行层生命周期：

```json
{
  "workflow_state": {
    "brand": "{brand}",
    "strategy_pack_version": "v1",
    "current_phase": "content_production",
    "current_article_id": "A1-001",
    "completed_articles": ["A1-001"],
    "pending_articles": ["A2-001"],
    "total_articles": 2,
    "image_registry_path": "E0_{brand}_image_registry.json",
    "submitted_image_library_manifest_path": "E0_{brand}_submitted_image_library_manifest.json",
    "image_library_index_path": "E0_{brand}_image_library_index.json",
    "image_library_sha256": "sha256:...",
    "e5_status": "pending|running|completed",
    "execution_completed_at_e5": false
  }
}
```

---

## 三、人工暂停规则

执行层保留一个内容审批暂停点，并在 E5 后保留一个继续生产确认点：

| 暂停点 | 时机 | 用户动作 | 恢复条件 |
| :--- | :--- | :--- | :--- |
| 暂停5 / 暂停 4 | E1 输出核心素材清单与 Content Brief 后 | 审批哪些 Brief 进入生产；可删改、合并、调整优先级 | 至少 1 篇 Brief 被标记为 `production_approved=true` |
| E5 后继续生产确认 | E5 完成本轮 HarnessGEO 正本与分发编排包后 | 选择是否继续制作其他文章/其他文章类型 | A 结束；B 回暂停5（选题审批）；C 回 E1；D 结束并返回策略层 |

禁止新增以下暂停：

```text
禁止逐篇标题选择暂停（但必须在 E2/E4/E0 交付消息中直接打印 T1-T5 标题）
禁止渠道确认暂停
禁止 E5 后发布/监测暂停
禁止把 E5 后继续生产确认用于确认渠道、预算或投放
```

---

## 四、E5 后继续生产边界

E5 完成后，E0 只能执行两类动作：

1. 询问是否继续制作其他文章或其他文章类型；
2. 用户选择结束后，执行最终打包和展示页生成。

如果用户选择继续当前内容菜单中的未生产 Brief，E0 必须回到 暂停5。

如果用户选择新增文章类型或新选题，E0 必须回到 E1 重新生成增量 Content Brief，并再次进入暂停5。不得绕过 暂停5 直接进入 E2。

E5 必须输出：

```text
E5_{brand}_{article_id}_harnessgeo_optimized.md/.docx（正文正本不带文章标题）
E5_{brand}_{article_id}_harnessgeo_report.json
E5_{brand}_compliance_report.md
E5_{brand}_delivery_manifest.json
```

E5 不负责：

```text
不等待渠道确认
不实际发布
不做预算确认
不做发布后监测
不生成回流文件
```


## 五、多轮生产状态规则

当用户在 E5 后选择继续制作时，E0 必须维护 `execution_cycle_id`，并保留 `completed_article_ids`、`completed_content_types`、上一轮 E5 分发摘要和图片注册表。

- 选择 B 回暂停5（选题审批）：使用当前 E1 内容菜单里的未完成 Brief，不重新生成策略包。
- 选择 C 回 E1：基于同一 `strategy_pack` 增量生成下一轮 Content Brief，E1 必须避免重复已完成选题。
- 每一轮新增或继续的 Brief 都必须重新经过 暂停5 选题审批，才能进入 E2/E3/E4/E5。
