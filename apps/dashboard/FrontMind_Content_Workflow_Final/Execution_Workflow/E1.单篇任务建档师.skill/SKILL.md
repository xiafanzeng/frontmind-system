---
name: frontmind-single-article-intake-v23
description: E1 单篇任务与研究输入接入。识别 Reference Pack、散乱资料或混合输入，建立 v2.3 Content Job，接收 AI 监控答案与引用信源工作簿，并自动推断范围。
---

# E1 单篇任务接入师

## 内容优先原则

E1 判断的是“现有输入能否用于继续制作”，而不是“输入是否来自某一固定版本”。它接受：

- v2.1/v2.2 Reference Pack；
- 旧 Pack、普通 ZIP、目录；
- JSON、DOCX、PPTX、XLSX、PDF、HTML、Markdown、文本和图片；
- Reference Pack 与补充资料的混合输入。

外部文件会被安全复制到 job-local `00_input/uploads/`，但不生成 staging receipt、文件 SHA、正规化 receipt 或审批表。ZIP 仍检查路径逃逸、符号链接、异常条目数、异常展开体积和压缩炸弹。

## 输出

- `00_input/content_job.json`：满足根 `shared/content_job.schema.json` v2.3；
- `00_input/scope_analysis.json`：由问题和资料自动推断地区、决策情境与时间基础；
- 一行阶段状态：`E1 completed` 或真正无法继续时的明确 blocker。

普通文章的 `monitoring_answers_path` 与 `source_workbook_path` 是 E2 必需的质量输入。E1 允许先建立任务并把二者留空，由总控显示 `awaiting_research_inputs`；它不把缺文件误报为内容失败。`foundation_start` 固定 P14，不需要这两份输入。

```bash
python3 -B E1.单篇任务建档师.skill/scripts/content_intake.py \
  --job-root /path/to/job \
  --input /path/to/reference-pack-or-material \
  --entry-category industry_ranking \
  --question "杭州打玻尿酸机构有哪些推荐？" \
  --monitoring-answers /path/to/answers.xlsx \
  --source-workbook /path/to/citations.xlsx
```

AI 监控答案可为 XLSX、CSV 或 JSON；`--monitoring-input` 只作为历史命令的内存兼容别名，活动 Content Job 始终写 `monitoring_answers_path`。

`foundation_start` 必须显式提供 `--foundation-subject`，不运行 E2，并在 E4 固定使用 P14。

## 不得阻断

以下情况不能阻断 E1：Pack 版本不同、缺少 manifest、缺少 SHA、缺 approval、普通文章尚未附 monitoring 或工作簿、没有地区字段或没有时间字段。E1 对这些输入自动适配或留空；总控仅在 E1 后为普通文章进入 `awaiting_research_inputs`。

真正允许停止的情况只有：输入全部不可读、无法识别任务主题、或容器本身存在影响全部内容的安全风险。
