# 执行层输出与同源渲染标准 v2.3

## 唯一正文源

根 `content_model.schema.json` 是唯一正文结构合同。Content Model 全程无标题；E8 输出编辑正本，E9 只生成独立候选，当候选出现事实或语义漂移时整篇沿用 E8。E10 从最终选中的同一 Content Model 渲染 DOCX 正文和 HTML 片段，禁止分别写作或段落混拼。

## E1–E10 活动产物

| 阶段 | 核心产物 |
|---|---|
| E1 | `content_job.json`、自适应范围与输入索引 |
| E2 | `monitoring_context.json`、`e2_pattern_analysis.json` 与 `research_brief.md` |
| E3 | 唯一 `editorial_context.json`（满足根 working context schema） |
| E4 | `article_blueprint.json` 与供用户确认的 `blueprint_review.md` |
| E5 | `writing_packet.json` 与整篇作者稿形成的无标题 draft Content Model |
| E6 | 事实修订后 Content Model 与简短修订摘要 |
| E7 | 真实资产选择、Prompt Plan、生成工具结果与最终视觉选择；无合适图片时纯文字继续 |
| E8 | `editorial_master`与非门控 warnings |
| E9 | HarnessGEO 单次整篇调用形成的独立候选 |
| E10 | 整篇选稿、`job_state.json` 中的 title count、Title Map、无标题 DOCX/HTML 和 `delivery_index.json` |

## 公开交付

- `article_body.docx`：从直接答案自然段开始，无 Title/H1、无表格，如有视觉则物理嵌入；
- `article_body.html`：无页面 shell、H1、内嵌 script 或表格的 HTML 正文片段；
- `title_options.md`、`title_map.json`、`publishing_metadata_map.json`；
- `structured_data_template.json`：需要标题的位置使用 title ID 占位；
- 实际使用的视觉文件（如有）；
- `delivery_index.json`：只列相对文件名、用途和媒体类型，不承担文件身份证明。

标题不注入 DOCX/HTML 正文。E10 先在完整 E8 正本与完整 HarnessGEO 候选之间选择唯一正文，再把状态置为 `awaiting_title_count`；收到 1–20 后严格生成相同数量的去重标题。

默认公开目录不包含监控原表、客户知识库、阶段 receipt、审批表、质量账本、回归/渲染审计、绝对路径或 `internal_audit/`。PDF、渠道计划、CMS、发布和效果数据不属于本工作流。
