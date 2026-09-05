# HarnessGEO 引擎偏好内容优化指南

## 1. HarnessGEO 简介
HarnessGEO (CMU ICLR 2026) 是一个专门用于"生成式引擎优化"的框架。它通过自动提取各大 AI 平台（如 Gemini, GPT, Claude）的内容偏好规则，并基于这些规则重写网页内容，从而显著提升内容在 AI 生成回答中的可见性（GEO Score）和被引用概率。

作为分发编排师，你的首要任务是在将文章分发出去之前，使用 HarnessGEO 框架或规则模拟 fallback 对其进行“AI 引擎偏好”的二次安全优化。该优化在 E5 中是强制步骤；E4 final.md 只能作为输入源，不能直接作为 E5 发布正本。E5 产出的正本必须是不带文章标题/H1 的正文文件。

## 2. 核心优化逻辑 (HarnessGEOAPI)

我们使用轻量化的 `HarnessGEOAPI` 模式（无需本地部署庞大的强化学习模型，只需调用大模型 API 即可完成基于规则的重写）。

### 2.1 常见引擎偏好规则示例
HarnessGEO 挖掘出的大模型偏好通常包括：
- **数据与事实支撑**：优先使用 S1/E4 已验证的数字、案例和事实；禁止新增未经证明的数据、案例、排名或认证。
- **结构化表达**：偏好清晰的 Markdown 结构（H2/H3 标题、无序/有序列表、表格）。
- **客观中立**：剔除强烈的营销话术、主观形容词和情绪化表达。
- **自包含性**：文章内容需要完整，不依赖外部链接就能讲清一个概念。
- **因果解释**：不仅说明"是什么"，还要解释"为什么"和"怎么做"。

### 2.2 API 调用模拟指南
在实际执行中，你必须先尝试通过 Python 脚本调用 HarnessGEO 库；如果当前环境无法直接运行该库，必须自动降级为 `simulated_rule_based` 规则模拟版，仍然产出不带文章标题/H1 的 E5 HarnessGEO 优化正本、优化报告和运行日志。不得因为库不可用而跳过 Step 1。

**模拟重写（如果你必须手动重写）的 Prompt 逻辑：**
> "You are given a website document as a source. This source will be used by an LLM to generate answers. Your task is to rewrite your document in a way that maximizes its visibility and impact in the LLM's final answer, ensuring your source is more likely to be quoted and cited. Follow these rules: [列出上述偏好规则]"

**安全约束必须同时写入 Prompt**：

1. Do not add new facts, numbers, customer cases, rankings, awards, certificates, or endorsements unless they already exist in S1/E4 verified material.
2. Keep `new_facts_added=false` by default. If a suspected new fact appears, remove it or flag `requires_E4_recheck=true`.
3. Do not create channel-specific full rewrites. Produce exactly one canonical optimized body.
4. Do not generate new titles. Titles must come from E4 `title_options_reviewed.json`. Do not insert any title/H1 into the canonical body; titles stay external and must be shown in the delivery message.

**代码调用示例（供参考）：**
```python
from harnessgeo.rewriters import rewrite_document

# 假设原始文章内容已读取到 original_text 变量中
rewritten_text = rewrite_document(
    document=original_text,
    dataset="E-commerce",   # 商业品牌选 E-commerce，学术/技术品牌选 Researchy-GEO
    engine_llm="gemini"     # 目标引擎：gemini, gpt, 或 claude
)

# 将 rewritten_text 保存为 E5_{brand}_{article_id}_harnessgeo_optimized.md
# 同时生成 E5_{brand}_{article_id}_harnessgeo_report.json，记录 mode / changes / new_facts_added / requires_E4_recheck
```

## 3. HarnessGEO 优化与渠道选择的关系

> **重要说明**：HarnessGEO 负责的是**内容层面的引擎偏好优化**（Step 1），渠道选择是**独立的后续步骤**（Step 2），两者不应混淆。

### 3.1 HarnessGEO 的职责边界

HarnessGEO 只负责以下工作：
- 对核心素材进行引擎偏好规则的二次安全重写
- 增强结构化表达、结论先行、实体清晰度和可引用性
- 去除或弱化营销话术、绝对化表达、未经证明的排序承诺
- 输出 AI 友好度更高的唯一正文正本、优化报告和运行日志；正文正本不得包含文章标题/H1

HarnessGEO **不负责**渠道选择，也不负责新增事实、生成新标题、把标题写进正文或创建多平台全文变体。渠道选择由 SKILL.md 的 Step 2 独立执行；标题只能来自 E4 审核通过的 5 标题池，并必须在交付消息中打印。C1b 标题必须保持品牌深度品宣同题改写，不得由 HarnessGEO 或 E5 改成问答、指南、盘点、趋势或行业观察标题。

### 3.2 渠道选择的正确流程

完成 HarnessGEO 重写后，渠道选择必须严格按照 SKILL.md Step 2 的流程执行：

1. **提取诊断 Top 信源**：从 Agent 2 品牌诊断数据中提取引用频次 Top 10 的域名。
2. **执行 Top 10 评估打分**：按 `media-authority-matrix.md` 中的评估框架，对候选渠道进行 5 维度加权打分。
3. **确定动态目标平台**：按综合分降序选取 Top 5-8 个渠道，每个渠道附带选择理由。

> **★ 关键原则**：渠道选择必须以诊断数据为第一依据，结合评估打分确定。禁止跳过打分直接使用固定渠道组合。
