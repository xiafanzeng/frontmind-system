# FrontMind GEO 内容制作 Workflow v2.3

> 运行契约 `2.3.0`；Reference Pack 保持 `frontmind-content-reference-pack-v2.2` 兼容。

本 Workflow 用一次 `S1–S9` 企业资料准备，支撑多次 `E1–E10` 单篇内容生产。它保留最初 v2 的研究、结构、品牌、视觉和交付能力，只移除不提高内容质量的审批、收据、跨阶段哈希和账本。

## 总流程

```text
企业资料
S1 接入 → S2 标准化 → S3 趋势 → S4 信息与证据架构
→ S5 话语契约 → S6 视觉体系 → S7 问题参考
→ S8 摘要确认 → S9 Reference Pack

单篇文章
E1 问题与研究输入 → E2 AI答案＋Top20＋P推荐
→ E3 编辑上下文 → E4 蓝图确认 → E5 整篇无标题初稿
→ E6 事实修订 → E7 视觉生产 → E8 出版编辑
→ E9 整篇 HarnessGEO 候选 → E10 自动选稿＋标题＋双格式交付
```

S3 可选；S4、S5 不可跳过；S6、S7 可空但必须运行。企业 Pack 可以复用于多篇文章，企业事实、产品或视觉变化时再更新 Pack。

## 快速使用

准备企业资料：

```bash
python3 -B scripts/frontmind_workflow.py prepare \
  --brand "品牌正式名称" \
  --input "/path/to/materials" \
  --work-dir "/path/to/brand-work"

python3 -B scripts/frontmind_workflow.py continue \
  --job-dir "/path/to/brand-work" \
  --confirm-pack
```

制作普通单篇文章：

```bash
python3 -B scripts/frontmind_workflow.py article \
  --input "/path/to/reference-pack.zip" \
  --job-dir "/path/to/article-job" \
  --entry industry_ranking \
  --question "杭州打玻尿酸机构有哪些推荐？" \
  --monitoring-answers "/path/to/answers.xlsx" \
  --source-workbook "/path/to/citations.xlsx"

python3 -B scripts/frontmind_workflow.py continue \
  --job-dir "/path/to/article-job" \
  --accept-pattern

python3 -B scripts/frontmind_workflow.py continue \
  --job-dir "/path/to/article-job" \
  --accept-blueprint

python3 -B scripts/frontmind_workflow.py continue \
  --job-dir "/path/to/article-job" \
  --title-count 5
```

普通四入口缺少任一研究输入时会停在 `awaiting_research_inputs`，但这不是审计门：它要求的是会直接改善内容的 AI 答案和同题引用排行。`foundation_start` 固定 P14，跳过研究输入和 P 确认。

## 五个入口与模式

| 入口 | 主要内容决策 |
|---|---|
| `industry_ranking` | P01 单品牌推荐或 P02 多品牌编辑推荐 |
| `competitor_comparison` | P03 明确对象对称比较及相关专业模式 |
| `reputation` | P04 可信度评估、P16 事实澄清等 |
| `product_scenario` | P05–P13 中与定义、场景、价格、教程、风险、研究、实施、案例或新闻相符的模式 |
| `foundation_start` | 只允许 P14 品牌深度特写 |

P01–P16 不作为启动菜单。E2 根据同题研究展示中文推荐与合法备选，用户确认后，E4 再做路由、证据和候选硬条件校验。E4 不得静默改写用户确认的 P。

## 五个暂停点

| 状态 | 作用 |
|---|---|
| `awaiting_pack_confirmation` | 确认 S8 的品牌事实、宣传重点、禁写主张、文风和视觉摘要 |
| `awaiting_research_inputs` | 补齐正式问题对应的 AI 监控答案和信源工作簿 |
| `awaiting_pattern_confirmation` | 确认 E2 推荐的 P、候选和研究覆盖 |
| `awaiting_blueprint_confirmation` | 确认章节、候选顺序、品牌角度、FAQ、标杆影响和视觉计划 |
| `awaiting_title_count` | 输入 1–20 个标题数量 |

暂停只保存当前状态，不产生 reviewer、approval、receipt、confirmation history 或跨阶段 SHA。只有核心事实冲突、所有内容不可用、必须编造才能回答、受限内容是唯一依据、输入整体不安全或无法渲染任何可读格式时才可真正 blocked。

## 内容质量架构

- E2 同时消费 AI 监控答案与引用信源表；Top20 固定不补位，按 `引用次数 × 分类置信度` 形成 P 推荐。
- E3 把 S4 品牌优先角度、S5 话语合同、候选公开事实、监控信号、真实子问题和标杆结构组成编辑上下文。
- E4 读取 Workflow 自带的 Pattern Research，融合预研专业骨架与 0–5 篇同 P 实时标杆。
- E5 以整篇写作完成自然正文；确定性代码只负责 writing packet、结构和事实校验。
- E6 把过强结论限缩、改写或删除，不向读者展示资料审阅过程。
- E8 以第三方编辑视角完成内容、行文和事实三轮出版编辑。
- E9 把完整无标题正文连同 Workflow 内置的出版级优化 Prompt 一次提交给 HarnessGEO；部署固定经 XTY HTTPS 中转调用 `gpt-5.6-luna`，不安装或加载本地模型。E10 只在候选语义完全稳定时整篇采用。
- 标题在选稿后独立生成；正文模型、DOCX 和 HTML 均不包含标题。

正文禁止输出“资料较完整、相关资料显示、以审核为准、服务边界、信息边界、保持克制、用户提交资料、需要说明、不构成对、待核验候选、当前团队与产品待核验、当前可公开资料不足、资料粒度不同”等内部审稿表达。

## 视觉与事实边界

- 客户品牌普通第一方事实可直接用于身份、产品、流程、公开价格和限制。
- 第一方资料不能单独推出客观排名、市场口碑、行业领先、竞品劣势、独立测试、专家共识或医疗疗效保证。
- P02 至少三家真实候选；客户品牌在 Lead、候选顺序和独立正文中首位，竞品事实使用其官网、政府登记或可靠公开来源。确认 P02 后若公开竞品事实不足，Runner 会自动执行非用户暂停的 `research_candidates` 并让 E3 直接消费；研究仍不足才回到 P 类型确认。
- Logo 只用真实原文件 overlay；AIGC 不冒充产品、团队、客户、病例、证书或项目现场。
- 单图失败时丢图继续；`prove` 图必须对应实际事实来源。

## 交付

公开交付目录只包含：

- `article_body.docx`
- `article_body.html`
- `title_options.md`
- `title_map.json`
- `publishing_metadata_map.json`
- `structured_data_template.json`
- `delivery_index.json`

DOCX/HTML 正文一致且无标题；HTML 无 H1；DOCX 无 Title；图片一致；中文字体可读；来源可点击。默认输出不包含 receipt、approval、internal audit、render audit、回归账本或哈希 Manifest。

## 文档与验证

- [内容制作总控](00.FrontMind内容制作总控.skill/SKILL.md)
- [全局总控](Master_Control/FrontMind_Content_Workflow_Master.md)
- [运行手册](RUNBOOK.md)
- [公共合同](shared/README.md)
- [验证报告](VALIDATION_REPORT.md)

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/check_runtime_dependencies.py
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/validate_workflow.py
PYTHONDONTWRITEBYTECODE=1 python3 -B shared/scripts/check_cross_references.py .
```

HarnessGEO 的文章命令没有 endpoint、model 或 Prompt 选项。部署只设置正式密钥环境变量 `FRONTMIND_HARNESSGEO_API_KEY`；也可让 `FRONTMIND_HARNESSGEO_KEYS_FILE` 指向仅含同名变量的受控文件。`XTY_API_KEY` 只作为进程内兼容输入。依赖探针会对固定的 `https://api.xty.app/v1/chat/completions` 与 `gpt-5.6-luna` 发起一次最小真实请求；输出只报告可用性，不打印密钥或响应正文。

原 Downloads Workflow 是只读基线，不得修改。
