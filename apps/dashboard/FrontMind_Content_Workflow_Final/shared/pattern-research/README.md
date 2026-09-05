# 内容模式结构与标杆研究库 v2.3

本目录为 E2 分类和 E4 蓝图提供 **P01–P16** 的开发期研究资产。它不证明客户或竞品事实，也不进入单篇文章的审批、回执或哈希链。

## 两层权威

- `../content-pattern-registry.json` 是运行时模式与路由权威。每个 P 的 `editorial_template` 可被 E4 直接读取。
- `index.json` 是研究索引。每个 `design_contract` 必须与 Registry 的 `editorial_template` 完全一致；`benchmarks` 只提供可借鉴的结构动作。

E4 的消费顺序固定为：

1. 读取 Registry 的固定专业骨架和证据降级规则；
2. 读取 E2 在当前 Top20 中识别出的同 P 标杆；
3. 从标杆吸收章节顺序、真实子问题、判断维度或证据位置；
4. 不得删除固定组件、复制原文、突破事实边界或把研究 URL 当客户事实来源。

## v2.3 模板字段

每个 P 都具有：

- `template_version`；
- `core_question` 与 `trigger_conditions`；
- `fixed_structure`：稳定组件 ID、编辑任务和读者收获；
- `optional_modules`；
- `required_evidence` 与 `evidence_downgrade_rules`；
- `typical_subquestions` 与 `reader_objections`；
- `natural_brand_entry`；
- `title_formulas`；
- `visual_recipe`；
- `failure_example` 与 `forbidden_behaviors`。

`recommended_structure`、`required_subquestions`、`evidence_placement_rules`、`visual_roles`、`faq_topics`、`quality_gates`、`anti_patterns` 是供早期 E4 读取器使用的稳定别名，内容由上述字段生成。

## 标杆覆盖

- P01、P02、P14：各 12 个去重公开标杆。
- P03–P13、P15、P16：各 8 个。
- 合计 140 个 URL、74 个域名；全库 URL 不重复，每个 P 至少三类来源。
- 既有 URL、访问证据与设计合同保持不变；2026-08-17 对 P01–P16 的 140 个页面全部完成逐页语义复审。

每条标杆保存 `semantic_focus`、结构动作、真实子问题、证据位置、视觉角色、优点、局限和不可借鉴元素。十六组模式的每一个观察字段均来自对应页面的实际结构，不使用只替换语义焦点的批量句式；只保存短篇中文归纳，不保存网页正文、长引文、截图或专有评分。

## 文件与开发命令

- `index.json`：机器可读研究索引。
- `P01.md`–`P16.md`：人类可读模式档案。
- `manual_semantic_reviews_v23.py`、`manual_semantic_reviews_p03_p07_v23.py` 与 `manual_semantic_reviews_p08_p12_v23.py`：P01–P16 的受保护人工逐页观察；无网络访问和文件写入副作用。
- `validate_pattern_research.py`：离线合同校验。
- `tests/test_validate_pattern_research.py`：配额、字段、URL、安全、Registry 镜像和语义去模板化测试。
- `rebuild_v23.py`：开发期重建工具；完整重建时不得把十六组模式送入批量观察生成器，人工内容始终由受保护映射恢复。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B shared/pattern-research/validate_pattern_research.py
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest shared/pattern-research/tests/test_validate_pattern_research.py
PYTHONDONTWRITEBYTECODE=1 python3 -B shared/pattern-research/rebuild_v23.py --sync-manual-reviews
```

## 内容与权利边界

- 标杆只回答“怎样组织一篇更专业的文章”。
- 第一方客户事实、竞品事实、公共专业事实仍由 E3/E6 的实际来源支持。
- 研究页中的品牌表达、专有评分、截图、Logo、图表和原句不得复制。
- `rebuild_v23.py` 不访问网络；需要新增标杆时，开发者直接检索官方资料、GitHub、专业媒体和公开网页，不使用 `research-assistant`。
