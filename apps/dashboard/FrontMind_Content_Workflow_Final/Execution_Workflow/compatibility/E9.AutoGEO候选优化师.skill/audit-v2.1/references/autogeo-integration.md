# AutoGEO 安全接入（v2.1 非活动归档）

> 仅供迁移查阅；字段哈希链不属于 v2.2 运行链。

目标 API 为 `autogeo.rewriters.rewrite_document`。环境中的具体函数签名可能随官方包版本变化，因此：

1. 运行时记录 `autogeo` 包版本；
2. 适配层只传官方函数明确支持的参数；
3. 不捕获错误后改用规则重写；
4. 每个文本字段保留输入和输出 hash；
5. 任一字段失败则整篇候选失败，不拼接部分优化结果；
6. 不把 API Key、Prompt 或内部配置写进文章。

默认锁定字段：`schema_version/job_id/revision/entry_category/question_origin/primary_question/pattern_id/candidate_contract/metadata/references/visual_placements/structured_data_types`。
可优化字段：`lead.direct_answer_sentence/lead.micro_answer/sections[].blocks[].text/sections[].subsections[].blocks[].text/faq[].answer/conclusion.summary|fit|next_action`。

FAQ 问题与 H2/H3 默认锁定，避免算法改变问题覆盖。发布标题不在 Content Model 内，由 E10 在批准正文后独立生成。
