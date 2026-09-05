---
name: frontmind-single-question-pattern-research-v23
description: E2 单问题研究。真实消费 AI 监控答案与引用信源工作簿，完成答案格局、Top20、P01–P16 分类、加权推荐和人类可读研究简报。
---

# E2 单问题监控与标杆拆解师

## 执行顺序

```text
当前正式问题
→ 解析 XLSX/CSV/JSON AI 监控答案
→ 对 Dashboard 工作簿做精确问题筛选
→ 修复排行、字段别名与引用占比
→ 安全访问原始 Top20
→ 文章形态判断与 P01–P16 分类
→ 引用次数 × 分类置信度推荐
→ 输出 P 推荐与同类型标杆结构
```

除 `foundation_start` 外，两份研究输入必须存在并对应同一个正式问题。缺任何一份时由总控保持 `awaiting_research_inputs`，E2 不伪造模板兜底分析。页面不可访问、Top20 全部非文章或分类覆盖不足不会阻断：E2 如实输出 `partial_support`，由预研模板在 E4 承接结构。

AI 监控答案提取当前答案、实体顺序、反复判断维度、子问题、未回答问题、平台分歧和引用链接。监控提及只用于候选发现，不直接证明排名或竞品事实。

## 工作簿宽容导入

- 支持 `内容统计`、`详细表格` 的常见中英文别名；`字段说明`不是必需页；
- 自动识别标题、URL、问题、媒体、引用次数、排行和占比的常见字段别名；
- 混合问题导出只选择与 Content Job 经 Unicode、空格和标点正规化后完全一致的问题；没有精确项时返回 `research_question_mismatch`，禁止用相似度静默换题；
- 详细表可用时按筛选后的行重新统计引用次数；
- 排行重复、断号、顺序错误时按引用次数稳定重排；
- 引用占比缺失或不一致时自动重算；
- 始终只保留修复后的前 20，不因非文章或不可访问而向后补位；
- `内容状态`完全不参与分类、推荐或权重。

## 页面研究边界

页面访问保留公网 HTTP(S)、端口、重定向、MIME、超时和体积安全检查。只在内存读取页面，并仅将章节结构短摘要写入 E2 分析：

- 不落完整 HTML、PDF 或正文；
- 不生成 snapshot/extract receipt；
- 不记录文件 SHA 或 Registry SHA；
- 不要求人工 review receipt；
- 人工纠正通过简单 corrections JSON 直接应用到分类结果。

## 一条命令

有工作簿：

```bash
python3 -B E2.单问题监控与标杆拆解师.skill/scripts/run_e2.py \
  --content-job /path/to/job/00_input/content_job.json \
  --pattern-registry /path/to/workflow/shared/content-pattern-registry.json \
  --pattern-research-index /path/to/workflow/shared/pattern-research/index.json \
  --monitoring-answers /path/to/job/00_input/uploads/answers.xlsx \
  --source-workbook /path/to/job/00_input/uploads/citations.xlsx \
  --work-dir /path/to/job/02_research \
  --research-brief-output /path/to/job/02_research/research_brief.md \
  --output /path/to/job/02_research/e2_pattern_analysis.json
```

`foundation_start` 返回 `skipped_optional`，不伪造监控、Top20 或 P 分布。普通文章不得省略两份研究输入。

最终产物包括 `monitoring_context.json`、`e2_pattern_analysis.json` 与 `research_brief.md`。分析保留原始 Top20 统计、逐页内容形态、分类置信度、结构摘要、加权与不加权分布、支持/冲突排名和推荐，不含跨阶段审计绑定。
