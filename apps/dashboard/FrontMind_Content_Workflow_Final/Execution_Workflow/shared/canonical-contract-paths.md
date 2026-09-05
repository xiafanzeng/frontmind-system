# 根级唯一活动契约路径 v2.3

执行层不复制以下定义，运行时从工作流程根目录 `shared/` 读取：

- `../../shared/content-pattern-registry.json`
- `../../shared/content-pattern-guide.md`
- `../../shared/reference_pack.schema.json`
- `../../shared/content_job.schema.json`
- `../../shared/job_state.schema.json`
- `../../shared/monitoring_context.schema.json`
- `../../shared/e2_pattern_analysis.schema.json`
- `../../shared/registries.schema.json`
- `../../shared/working_context.schema.json`
- `../../shared/article_blueprint.schema.json`
- `../../shared/content_model.schema.json`
- `../../shared/title_map.schema.json`
- `../../shared/delivery_index.schema.json`

从 Skill 目录解析时为 `../../shared/...`；从 `skill/scripts/` 解析时为 `../../../shared/...`。

旧 Pack 版本或字段差异由 S1/E1 宽容识别和适配，不得仅因版本不同阻断。旧 `quality_report`、`delivery_manifest`、`runtime_evidence_extension`、独立 pattern decision 或各类 receipt Schema 仅存于 `compatibility/audit-v2.1/`，不是活动契约。
