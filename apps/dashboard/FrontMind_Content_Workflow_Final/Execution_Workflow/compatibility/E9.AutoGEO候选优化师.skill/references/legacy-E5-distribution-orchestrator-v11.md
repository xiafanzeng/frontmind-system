---
name: frontmind-distribution-orchestrator
description: >
  GEO 分发编排师（E5 / 本轮分发编排节点）。读取 E4 审查通过的核心素材、5 标题池和资产清单，
  对每篇 E4 final.md 执行 HarnessGEO 算法或规则模拟优化，生成唯一 AI 引擎偏好、不带文章标题的正文正本，
  并完成分发前合规审查。渠道选择、标题映射、平台适配等分发决策由外部渠道经理后续自行完成，E5 不做渠道分析。
  E5 完成后不等待渠道确认、不实际发布、不进入发布/监测/建站节点；必须通知 E0 进入 E5-END 继续生产确认。
  适用场景：当内容生产流水线(E2/E3/E4)已完成一批用户批准的核心素材生产，需要生成可交给外部渠道团队执行的优化正本时触发。
---

# 分发编排师 (GEO Distribution Orchestrator)

分发编排师的职责精简为两件事：**1. 强制执行 HarnessGEO 正本优化，产出唯一不带文章标题的正文正本**；**2. 分发前合规审查**。渠道选择、标题映射、平台适配卡、信源建设清单等分发决策由外部渠道经理自行完成，E5 不再输出。

> **★★★ 核心铁律 — 禁止多平台全文重写**：E5 **绝对禁止**对核心素材进行多平台全文改写。每篇核心素材只保留 **1 个 HarnessGEO 优化后的不带文章标题正文正本**。各平台投放时使用同一正文正本，仅从 E4 审核通过的 5 个标题中选择渠道标题。理由：多平台全文改写会导致 Context 爆炸、质量稀释，且被 AI 引擎识别为低质量重复内容。

> **核心概念**：内容生产流水线(E2/E3/E4)生产的是"核心素材"。E4 输出：**DOCX（主格式，图片物理嵌入，简洁排版，供媒体投稿）**、**MD（供本 Agent 读取优化）**。分发编排师读取 E4 的 **Markdown 版本**进行 HarnessGEO 优化，产出唯一的不带文章标题优化正本。

> **★ 单轮终点边界**：E5 是单轮内容生产的最后业务节点。E5 只输出优化正本和合规审查结果，不输出渠道推荐、分发矩阵、适配卡、信源建设清单等；E5 结束后必须交由 E0 发起 E5-END 继续生产确认，决定结束、回暂停5（选题审批）、回 E1 或返回策略层。

**上游**：所有 E4 审查通过的 final.md / final.docx + `title_options_reviewed.json` + `asset_manifest.json`（含 `image_asset_usage`）+ 配图
**下游**：HarnessGEO 优化正本与合规审查报告 → E0 发起 E5-END 继续生产确认 → 结束打包 / 回暂停5（选题审批） / 回 E1 / 返回策略层

## 标准输入输出文件

**输入文件**：

| 输入项 | 文件名规范 | 来源 | 用途 | 必要性 |
| :--- | :--- | :--- | :--- | :--- |
| E4 最终正文 | `E4_{brand}_{article_id}_final.md` | E4（质量审查与组装师） | HarnessGEO 优化输入源 | **必须** |
| E4 最终 DOCX | `E4_{brand}_{article_id}_final.docx` | E4 | 外部投稿/交付时使用 | **必须** |
| 审核后标题池 | `E4_{brand}_{article_id}_title_options_reviewed.json` | E4 | 随正本一起交付给渠道经理 | **必须** |
| 资产清单 | `E4_{brand}_{article_id}_asset_manifest.json` | E4 | 正文、图片、DOCX、标题池路径索引 | **必须** |
| 配图文件 | `images/{article_id}_fig*.png/webp` | E3/E4 | 随正本一起交付 | **必须** |

**输出文件**：

| 输出物 | 文件名规范 | 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| HarnessGEO 优化正本 | `E5_{brand}_{article_id}_harnessgeo_optimized.md` + `.docx` | MD + DOCX | 各渠道发布使用的唯一正文正本；**文件不带文章标题** |
| HarnessGEO 优化报告 | `E5_{brand}_{article_id}_harnessgeo_report.json` | JSON | 记录优化模式、规则、改动摘要、风险控制 |
| 合规审查报告 | `E5_{brand}_compliance_report.md` | Markdown | HarnessGEO 优化引入的合规风险扫描结果 |
| 交付清单 | `E5_{brand}_delivery_manifest.json` | JSON | E0 最终打包交付 |

## 工作流

### Step 1 — HarnessGEO 引擎偏好内容优化（强制核心）

内容生产流水线(E2/E3/E4)写出的文章虽然符合品牌策略，但可能不完全符合底层生成式引擎（如大模型）的"胃口"。
你需要利用 **HarnessGEO 框架**（CMU ICLR 2026 论文项目）对文章进行二次重写优化。HarnessGEO 能够自动理解生成引擎（如 Gemini, GPT）的偏好规则，并重写文档以最大化其在 AI 回答中的可见性和引用率。

> 读取 `references/harnessgeo-integration.md` 获取 HarnessGEO 的具体使用方法和引擎偏好规则。

**操作指南**：
1. 读取 E4 产出的核心文章 Markdown 文本（按本轮批准清单，优先从 `asset_manifest.json` 中定位 `E4_{brand}_{article_id}_final.md`）。
2. 明确目标：使用 HarnessGEO 框架或规则模拟引擎进行安全重写，生成 AI 引擎偏好更强的唯一正文正本；该正本文件不得包含文章标题/H1/`{{PUBLISH_TITLE}}`。
3. 调用 `scripts/harnessgeo_optimizer.py`。脚本应优先尝试 `harnessgeo.rewriters.rewrite_document`；如果真实库、API Key 或运行环境不可用，必须自动降级为 `simulated_rule_based`，不得跳过优化。
   - `dataset` 参数：根据品牌类型选择 `E-commerce`（商业/电商）或 `Researchy-GEO`（学术/研究）。
   - `engine_llm` 参数：选择目标引擎（如 `gemini`、`gpt` 或 `claude`）。
4. **强制输出 MD 正本**：每篇核心素材必须保存为 `E5_{brand}_{article_id}_harnessgeo_optimized.md`。该文件是后续所有渠道使用的唯一正文正本，且必须不带文章标题。
5. **强制输出优化报告**：每篇核心素材必须保存 `E5_{brand}_{article_id}_harnessgeo_report.json`，记录优化模式、规则、改动摘要、是否新增事实、合规风险和是否需要回到 E4 复核。
6. **强制组装 DOCX 正本**：对每篇优化后的无文章标题 MD 正本调用 `shared/md2docx.py` 生成带图片物理嵌入的无文章标题 DOCX 文件；图片必须来自 E4 asset_manifest 中通过审查的文件映射。
   ```bash
   python3 shared/md2docx.py E5_{brand}_{article_id}_harnessgeo_optimized.md --images-dir E3_视觉资产/ --output E5_{brand}_{article_id}_harnessgeo_optimized.docx
   ```
7. **强制输出运行日志**：生成 `E5_{brand}_harnessgeo_run_log.json`，记录每篇文章的输入文件、输出文件、优化模式、状态和失败/降级原因。

> **★ 重要约束**：HarnessGEO 优化后的版本即为该篇文章的**唯一正文正本**，且正本文件不带文章标题；后续所有平台投放均使用此版本，不再产生多个改写变体。

**HarnessGEO 安全优化边界**：

| 允许优化 | 禁止优化 |
| :--- | :--- |
| 增加摘要、适用人群、H2 层级、序号列表和 FAQ 式结构（禁止 H3 小标题、禁止任何表格） | 新增未经 S1/E4 支撑的数据、案例、排名、客户名、认证或背书 |
| 将营销化表达改成客观、可引用的品牌实体描述 | 编造事实、夸大能力、暗示"第一/唯一/最佳/首选"等无法证明结论 |
| 拆分长段落、前置结论、补强"品牌-品类-场景-用户问题"关系 | 为不同渠道生成多篇全文变体 |
| 标记证据缺口和待人工复核点；保持正文文件无标题 | 绕过 E4 审查标题池自行新增标题，或把任一标题写入正文正本 |

优化报告中的 `new_facts_added` 默认必须为 `false`。如果真实 HarnessGEO API 生成了疑似新事实，必须在 `requires_E4_recheck=true` 中标记，并不得将该事实写入最终可分发正本。

### Step 2 — 分发前合规审查（强制节点）

> **与 E4.3 的分工**：E4 已完成核心素材的全量合规审查。本步聚焦于 **HarnessGEO 优化过程中新引入的合规风险** 和 **正文格式最终检查**。

**操作指南**：

**2.1 HarnessGEO 优化引入的合规风险扫描**：

扫描 HarnessGEO 优化后的正本，检查优化过程是否新引入了广告法绝对化用语、竞品贬低性词汇、无来源数据等违规内容。

1. 广告法绝对化用语：无"最"、"第一"、"唯一"等绝对化表述 → 修改为相对表述
2. 竞品贬低：无直接或暗示性贬低竞品的表述 → 删除或改为中性对比
3. 数据来源：所有数据点有明确来源标注 → 补充来源或删除
4. 品牌核心数据一致性：与 S1 品牌事实图谱完全一致 → 以 S1 为准修正

**2.2 正文格式最终检查**：

1. 正文不含任何 Markdown 表格（管道表格 `|...|...|`）
2. 正文不含 H3 小标题（`### `）
3. 正文不含 Markdown 加粗语法残留（`**文字**`）在 DOCX 中应已转为 Word 加粗格式
4. 正文不含内部元数据表头（文章ID、文章类型、品牌、核心GEO问题等）
5. 正文不含"本文采用、资料来源与口径说明、Execution Layer"等内部痕迹
6. 正文不含"未公开价格表""具体费用根据...定制报价"等模糊不专业内容
7. DOCX 中图片已物理嵌入（非外部链接引用）
8. 序号列表格式统一为"1. 2. 3."，不使用"1.1 2.1"等多级编号

**2.3 输出合规审查报告**：

生成 `E5_{brand}_compliance_report.md`，列出排查出的风险点及修改措施。

## 打包交付

```
{brand}_GEO_distribution_delivery/
├── 01_harnessgeo_optimized_articles/
│   ├── E5_{brand}_{article_id}_harnessgeo_optimized.md
│   ├── E5_{brand}_{article_id}_harnessgeo_optimized.docx
│   ├── E5_{brand}_{article_id}_harnessgeo_report.json
│   └── images/
│       └── {article_id}_fig*.png
├── 02_title_pool/
│   └── E4_{brand}_{article_id}_title_options_reviewed.json
├── 03_compliance/
│   └── E5_{brand}_compliance_report.md
└── E5_{brand}_delivery_manifest.json
```

## 交付消息规则

**必须执行**：本节点的所有文件生成并校验通过后，**必须立即使用 `message` 工具将产出文件作为附件发送给用户**。

**标题对话可见强制规则**：E5 交付消息的 `text` 字段必须按文章列出审核通过的 T1-T5 标题池（供渠道经理选择），并明确 `harnessgeo_optimized.md/.docx` 是不带文章标题的正文正本。

**禁止渠道暂停**：发送产出后，**禁止**等待用户确认渠道，不得自动进入任何发布、投放、预算、建站或监测节点。必须立即通知 E0 进入 E5-END 继续生产确认；用户选择 A 时最终打包，选择 B 时回到暂停5，选择 C 时回到 E1，选择 D 时返回策略层重新确认。

**渠道决策边界声明**：E5 不输出渠道推荐、分发矩阵、标题映射、平台适配卡、信源建设清单。这些分发决策由外部渠道经理根据标题池和正本自行完成。

## 参考文档导航

| 参考文档 | 何时读取 | 内容概要 |
| :--- | :--- | :--- |
| `references/harnessgeo-integration.md` | Step 1 执行 HarnessGEO 优化时 | HarnessGEO API 使用方法和引擎偏好规则 |

## 质量检查清单

- [ ] 是否已对每篇 E4 核心素材（Markdown 格式）强制生成 HarnessGEO 优化正本？
- [ ] 每篇核心素材是否只产出了 **1 个不带文章标题的** HarnessGEO 优化正本（而非多个平台改写版本）？
- [ ] **★★★ 是否严格遵守了"禁止多平台全文重写"的原则？**
- [ ] HarnessGEO 优化后的正本中品牌核心数据是否与 S1 品牌事实图谱完全一致？
- [ ] 优化报告是否明确 `new_facts_added=false` 或列出待复核事实？
- [ ] 正文是否不含任何表格、H3 小标题、Markdown 语法残留、内部元数据？
- [ ] DOCX 正本中图片是否已物理嵌入？
- [ ] 合规审查是否已完成并输出报告？
- [ ] 交付消息中是否已打印 T1-T5 标题池？

---

## 子文件引用

- `../shared/enterprise-image-library-policy.md` - 企业提交图片库、授权范围与缺图/补授权规则。
