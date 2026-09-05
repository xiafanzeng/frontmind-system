# Strategy shared

本目录仅保留 `compatibility/legacy-s1/` 所依赖的历史兼容 schema，不属于活动 S1–S9。所有活跃跨层契约、校验器与机器枚举只读取根 [global shared](../../../shared/README.md)。

- 品牌事实：`../../../shared/brand_facts.schema.json`；本目录 `brand_facts_schema.json` 只供原样 legacy S1 使用，活动 S4/Reference Pack 不得读取它。
- Information/Evidence Architecture：`../../../shared/information_evidence_architecture.schema.json`；策略目录不保留活动镜像。
- Reference Pack：`../../../shared/reference_pack.schema.json`。
- knowledge/sources/claims/images：`../../../shared/registries.schema.json`。
- P01-P15：策略层不得复制或提前选择；唯一 registry 为 `../../../shared/content-pattern-registry.json`。

本目录不再提供 PDF 合并、旧 output standard、旧 strategy pack 模板或第二套运行时校验器。
