---
name: frontmind-geo-content-workflow-v2-3
description: FrontMind GEO 内容制作 Workflow v2.3 唯一入口。以 S1–S9 构建可复用 Reference Pack，以 E1–E10 完成单篇研究、结构、出版级无标题正文、视觉、HarnessGEO 候选和独立标题交付。
---

# FrontMind GEO 内容制作总控 v2.3

开始前完整读取：

- [全局总控](../Master_Control/FrontMind_Content_Workflow_Master.md)
- [可复制运行手册](../RUNBOOK.md)
- [内容模式注册表](../shared/content-pattern-registry.json)
- [写作政策](../shared/writing-policy.md)

## 运行原则

保留最初 v2 的 `S1–S9`、`E1–E10`、五入口、P01–P16、Top20 研究、模板与标杆融合、品牌优先、视觉生产、HarnessGEO 和标题解耦。Reference Pack wire profile 保持 v2.2；运行契约、Job State 和单篇内容工件使用 2.3.0。

流程删除逐阶段收据、审批表、reviewer、跨阶段 SHA、runtime Registry 和 Manifest 哈希账本，但不能删除会实质改变内容质量的研究与确认。

## 企业资料：prepare

```bash
python3 -B ../scripts/frontmind_workflow.py prepare \
  --brand "品牌正式名称" \
  --input "/path/to/materials" \
  --work-dir "/path/to/brand-work"
```

总控执行 S1–S8，并在 `awaiting_pack_confirmation` 展示品牌事实、宣传重点、禁写主张、默认文风和视觉摘要。确认后：

```bash
python3 -B ../scripts/frontmind_workflow.py continue \
  --job-dir "/path/to/brand-work" \
  --confirm-pack
```

S3 可以跳过；S4、S5 必须实际生成；S6、S7 可以为空但必须运行；S9 只在确认后装配轻量 Pack。

## 单篇文章：article

普通四入口必须同时提供同题 AI 监控答案与引用信源工作簿：

```bash
python3 -B ../scripts/frontmind_workflow.py article \
  --input "/path/to/reference-pack.zip" \
  --job-dir "/path/to/article-job" \
  --entry industry_ranking \
  --question "杭州打玻尿酸机构有哪些推荐？" \
  --monitoring-answers "/path/to/answers.xlsx" \
  --source-workbook "/path/to/citations.xlsx"
```

若两份研究输入尚未提供，E1 保持 `awaiting_research_inputs`；补齐后续跑。E2 完成答案格局、Top20、P01–P16 分类与加权推荐后，进入 `awaiting_pattern_confirmation`：

```bash
python3 -B ../scripts/frontmind_workflow.py continue \
  --job-dir "/path/to/article-job" \
  --accept-pattern
```

也可用 `--selected-pattern P02` 接受 E2 显示的合法备选。P 不是启动菜单；用户只在 E2 研究结果中确认推荐或备选，E4 仍负责最终硬条件校验。确认 P02 后，Runner 会先检查 E3 中除客户品牌外是否已有至少两个具备公开来源和事实的真实候选；不足时自动执行内部 `research_candidates`，优先核验监控候选，再参考 Top20 和可靠公开网页补充。该动作不是用户暂停。研究仍不足时才返回同一确认状态，不得静默降为 P01。

E3–E4 形成编辑上下文和文章蓝图后，进入 `awaiting_blueprint_confirmation`。用户确认具体章节、候选顺序、品牌角度、FAQ、标杆影响和视觉计划：

```bash
python3 -B ../scripts/frontmind_workflow.py continue \
  --job-dir "/path/to/article-job" \
  --accept-blueprint
```

E5–E10 随后完成整篇初稿、事实修订、视觉、出版编辑、整篇 HarnessGEO 候选及自动选稿。选稿后只等待标题数量：

```bash
python3 -B ../scripts/frontmind_workflow.py continue \
  --job-dir "/path/to/article-job" \
  --title-count 5
```

## 总控内部动作协议

S1 可选的旧 S1＋Socratic KB Builder 深度补全、P02 竞品公开研究、E5 整篇写作、E7 图像工具调用和 E8 三轮编辑，都是总控在同一任务回合内完成的内部动作，不是新增用户暂停点。`legacy_enrich_materials` 必须实际读取两个 Skill 并返回 S2 可读材料；若固定 provider 不可用而原材料仍可读，S1 只记 warning 并继续原材料。Runner 如输出 `status=controller_handoff`，必须读取同一对象中的 `contract=frontmind-controller-provider/v1`、`user_pause=false` 和 `action`，完成动作后立即按 `resume` 续跑，直到出现五个正式确认状态之一：

- `research_candidates`：读取正式题面、监控候选、Top20 发现信号、客户品牌和共同维度，只以候选官网、政府登记、监管页面或可靠公开来源形成轻量 `sources + facts`；监控提及和 Top20 标题本身不能充当竞品事实；
- `author_article`：完整读取 E5 writing packet、编辑上下文和蓝图，按 E5 Skill 一次写成无标题 Content Model，保存到 action 指定的 expected path；
- `generate_images`：按 E7 Prompt Plan 对每个槽位调用真实图像工具。工具返回文件就交给 E7；工具没有返回文件则把该槽位作为 `NO_FILE` 结果续跑，使 E7 丢弃单图并继续纯文字；
- `edit_article`：完整读取 E8 editing brief，对全文完成内容、行文、事实三轮编辑，保存到 action 指定的 expected path。

不得把内部参数、provider path 或工具失败问题转问用户，不得在 commentary 后停住。若部署设置了固定 `FRONTMIND_CONTROLLER_PROVIDER`，Runner 会自动调用它；该环境值必须是 JSON argv 数组，provider 以 `--request` 和 `--response` 实现同一协议。未配置 provider 时，由本总控直接完成可执行动作；若 P02 公开研究确实无法运行或没有得到足够来源，不能编造，E4 按既有合同返回 P 类型确认。内部动作文件在完成后删除，只服务当前内容生产，不进入公开交付或审计链。

## 五个内容确认状态

- `awaiting_pack_confirmation`：S8 的品牌与文风摘要；
- `awaiting_research_inputs`：E1 的正式问题、AI 监控答案和信源表；
- `awaiting_pattern_confirmation`：E2 的 P 推荐、候选和研究覆盖；
- `awaiting_blueprint_confirmation`：E4 的完整结构与视觉方案；
- `awaiting_title_count`：E10 的 1–20 个标题数量。

这些状态只保存于最小 `job_state.json`，不生成确认回执或审批账本。操作与当前状态不匹配时只提示下一步，不能把任务标成 blocked。

`foundation_start` 固定 P14，跳过研究输入和 P 确认，但保留蓝图确认与标题数量。

## 内容质量边界

- S4 的 `brand_priority_angles` 和 S5 的 `voice_profile` 必须进入 E3、E4、E5；
- E4 必须读取预研 Pattern Research，并只从 Top20 选择同 P 标杆；
- E5 先生成 writing packet；总控必须作为编辑模型在同一上下文中整篇撰写 `authored-model`，再交给正规化脚本。禁止把确定性 fallback 当作发布稿，也禁止逐事实固定句式拼接；
- E6 只做 `keep / qualify / rewrite / remove`，不得向正文批量追加资料状态说明；
- E8 进行内容、行文和事实三轮编辑，正文中的内部审稿语必须为零；
- E7 使用真实资产、视觉配方和安全生成路线；无图时纯文字继续；
- E9 整篇调用 HarnessGEO，只产独立候选；底层固定经 XTY HTTPS 中转使用 `gpt-5.6-luna`，完整优化 Prompt 内置于 Workflow。部署只提供 `FRONTMIND_HARNESSGEO_API_KEY` 或指向同名变量的受控 keys file，不安装、不探测、不回退到本地模型；文章操作者不能改变 endpoint、model 或 Prompt。E10 检出事实或语义漂移时整篇采用 E8，不混拼；
- P01 只有一个焦点品牌；P02 至少三家真实候选、客户首位且重点详写，不使用客观名次；
- 第一方资料可支持本品牌普通事实，但不能单独推出排名、口碑、领先、竞品劣势或疗效保证。

## 交付

公开目录只包含无标题 DOCX/HTML、独立标题集、发布元数据、结构化数据模板和非哈希 `delivery_index.json`。DOCX 必须保留中文字体、图片和可点击来源；不能静默使用会丢失这些能力的低质量 fallback。
