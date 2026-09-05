# Execution shared v2.3

本目录只保留执行层共享的内容质量、风险修订、同源渲染与根契约路径说明。五入口、P01–P16 和跨层 Schema 只从根 [shared](../../shared/README.md) 读取，执行层不复制第二份活动定义。

v2.3 的核心活动产物是：

- 任务与恢复状态：`../../shared/content_job.schema.json`、`../../shared/job_state.schema.json`；
- 单问题研究：`../../shared/monitoring_context.schema.json`、`../../shared/e2_pattern_analysis.schema.json`；
- 单一工作上下文：`../../shared/working_context.schema.json`；
- 结构蓝图：`../../shared/article_blueprint.schema.json`；
- 无标题正文：`../../shared/content_model.schema.json`；
- 标题映射：`../../shared/title_map.schema.json`；
- 轻量交付索引：`../../shared/delivery_index.schema.json`；
- 内容结构：`../../shared/content-pattern-registry.json`。

`compatibility/audit-v2.1/` 与 `references/legacy-*` 只是非活动迁移资料，不得被 runner、Skill、Prompt、Schema 或下游阶段加载。默认运行不生成 Quality Receipt、Delivery Manifest、runtime Registry、阶段文件指纹或内部审计包。

E5–E10 使用自然正文结构：`lead.text`、`sections[].heading/paragraphs[]`、`faq[]`、`conclusion.paragraphs[]`，所有公开段落只绑定 `fact_ids`。E9 把整篇无标题 Markdown 一次提交给 HarnessGEO；E10 完成整篇回归选稿后才询问标题数量。DOCX/HTML 只由 E10 从同一份最终 Content Model 高保真渲染，不允许静默改用丢链接、图片或中文字体的简易 DOCX。
