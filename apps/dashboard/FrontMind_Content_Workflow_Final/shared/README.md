# FrontMind v2.3 公共合同

`shared/` 是 S1–S9 与 E1–E10 的活动单一事实源。运行时消费内容工件，不消费审批、收据、reviewer、跨阶段 SHA、runtime Registry 或 Manifest 哈希。旧审计合同只保存在 `compatibility/audit-v2.1/`。

## 版本边界

- Workflow、runner、Job State 和活动单篇内容合同：`2.3.0`；
- Reference Pack wire profile：继续使用 `frontmind-content-reference-pack-v2.2`；
- v2.1/v2.2 Pack 可直接读取，多余审批和哈希字段在接入时忽略；
- Registries 保持轻量 v2.2 内容索引，使用 `usable / qualified / excluded`。

## 核心合同

- `content_job.schema.json`：正式问题、五入口、研究输入和用户约束；
- `monitoring_context.schema.json`：AI 当前答案、品牌顺序、反复维度、子问题、遗漏和分歧；
- `e2_pattern_analysis.schema.json`：Top20 状态、P01–P16 分类、加权/非加权分布与推荐；
- `working_context.schema.json`：E3 编辑上下文，包含 S4 品牌角度、S5 文风、Fact Cards、候选画像、答案格局、标杆动作、读者问题和安全内容；
- `article_blueprint.schema.json`：E4 固化唯一 P、候选顺序、自然章节、FAQ、标杆影响和视觉计划；
- `content_model.schema.json`：无 Title/H1/Meta 的自然正文模型；
- `job_state.schema.json`：阶段和五个内容确认状态；不保存确认历史或文件身份；
- `title_map.schema.json`：E10 在最终正文确定后生成的 N 个标题、H1 建议和 Meta；
- `delivery_index.schema.json`：文件名与用途，不是哈希清单；
- `information_evidence_architecture.schema.json` 与 `brand_facts.schema.json`：S4 的定位、关键 Proof Bundles 和品牌优先角度；
- `reference_pack.schema.json`：轻量可复用 Pack；
- `registries.schema.json`：knowledge/source/claim/image 内容索引。

`scope_analysis.schema.json` 是稳定的自动范围推断支持合同；地区、受众和时间不要求用户填表。

## 模式和研究

- `content-pattern-registry.json`：五入口、P01–P16、路由、分类信号、结构组件、标题公式和视觉配方；
- `pattern-research/`：16 套预研结构与 140 个公开标杆；
- `content-pattern-guide.md`：人类可读模式说明；
- `writing-policy.md`：第三方客观报道＋企业品牌宣传稿的出版写作政策；
- `html-structured-data-policy.md`：无标题正文、独立标题和可选结构化数据。

E2 先读取 AI 监控答案，再按同题引用信源表固定 Top20。运行时标杆只能调整模板顺序、增加真实子问题、增加判断维度和改善证据位置，不能复制原文、覆盖事实边界或删除必要组件。

## 事实资格

用户提供并要求制作内容的普通第一方企业资料默认可支持本品牌身份、产品、流程、公开价格、政策和限制。明确内部、保密、个人敏感、高风险操作或无权视觉必须排除。第一方资料不能单独推出客观排名、市场口碑、行业领先、竞品劣势、独立测试、专家共识或疗效保证。

竞品事实使用竞品官网、政府登记或可靠公开来源；专业公共事实使用监管、标准、研究机构或权威专业来源。Top20 是结构与候选发现输入，不自动等同竞品事实证据。

## 开发验证边界

Schema、单元测试、全局 validator 和视觉 QA 是开发发布门，不进入每篇文章的确认链。Hash 只可用于缓存、去重和安全读取。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B shared/scripts/test_validate_json_instance.py
PYTHONDONTWRITEBYTECODE=1 python3 -B shared/scripts/test_validate_package.py
PYTHONDONTWRITEBYTECODE=1 python3 -B shared/scripts/test_validate_title_map.py
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/validate_workflow.py
```

机器工件只使用 Pack 根或 job 根内的安全相对路径；禁止绝对路径、反斜杠、符号链接和 `..` 越界。
