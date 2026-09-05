# FrontMind GEO 内容制作 Workflow v2.3 运行手册

运行契约为 `2.3.0`；Reference Pack 继续使用兼容的 v2.2 wire profile。正式操作者只调用 `scripts/frontmind_workflow.py`，不逐条运行阶段脚本。

## 1. 流程概览

```text
prepare
  S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8
  → awaiting_pack_confirmation

continue --confirm-pack
  S9 → Reference Pack

article
  E1 → E2
  → awaiting_pattern_confirmation

continue --accept-pattern
  E3 → E4
  → awaiting_blueprint_confirmation

continue --accept-blueprint
  E5 → E6 → E7 → E8 → E9 → E10选稿
  → awaiting_title_count

continue --title-count N
  E10标题与双格式交付
```

五个交互点只确认会改变内容结果的事项：Pack 摘要、研究输入、文章类型、文章蓝图和标题数量。`job_state.json` 只保存恢复运行所需的最小状态。

## 2. 准备企业 Reference Pack

输入可为 v2.1/v2.2 Pack、canonical KB、working-set、旧 Pack、普通 ZIP、目录或常用办公文件。多个来源可重复使用 `--input`。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py prepare \
  --brand "示例品牌" \
  --input /path/to/company-materials \
  --work-dir /path/to/brand-work
```

运行结果：

- S1 识别并安全读取资料；已有 KB 直接使用。散乱资料显式选择 `--intake-route legacy_enrichment` 时，Runner 通过固定 controller provider 实际串联字节不变的旧 S1 与 Socratic KB Builder，并把返回的安全材料 ZIP 交给 S2。增强服务失败但原材料仍可读时只记 warning，S2 继续消费原材料。
- S2 一次生成四类轻量 Registry。
- S3 只有无可靠趋势时可以 `skipped_optional`。
- S4 必须生成定位、证据架构和品牌优先角度。
- S5 必须生成“第三方客观报道＋企业品牌宣传稿”话语合同。
- S6 即使无图也会生成视觉规则与可用性结果。
- S7 即使没有历史问题也会生成可空参考库。
- S8 输出 `ReferencePack确认摘要.md` 后进入 `awaiting_pack_confirmation`。

查看摘要并直接修正相应 S4–S7 内容资产后，确认 Pack：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py continue \
  --job-dir /path/to/brand-work \
  --confirm-pack
```

可用 `--output /path/to/pack.zip --version 2` 指定 S9 输出；省略时写入工作目录。S9 Pack 只封装四类 Registry、S3–S7 写作资产和实际材料。

## 3. 启动普通文章

除 `foundation_start` 外，正式文章必须同时提供：

1. 与正式问题对应的 AI 监控答案（XLSX、CSV 或 JSON）；
2. Dashboard 引用信源工作簿。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py article \
  --input /path/to/reference-pack.zip \
  --job-dir /path/to/article-job \
  --entry industry_ranking \
  --question "杭州打玻尿酸机构有哪些推荐？" \
  --monitoring-answers /path/to/answers.xlsx \
  --source-workbook /path/to/citations.xlsx
```

如果启动时缺少任一研究输入，E1 会进入 `awaiting_research_inputs`，而不是继续写一篇没有监控与 Top20 的文章：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py continue \
  --job-dir /path/to/article-job \
  --monitoring-answers /path/to/answers.xlsx \
  --source-workbook /path/to/citations.xlsx
```

混合问题工作簿只自动接受正规化后与正式问题完全一致的记录。没有可靠匹配时仍停留在研究输入状态；不会以低相似阈值静默选错问题，也不会把未分题的“内容统计”当成本题 Top20。

## 4. E2 研究与文章类型确认

E2 会生成：

- `E2/monitoring_context.json`：AI 当前答案、品牌顺序、反复判断维度、子问题、遗漏和分歧；
- `E2/e2_pattern_analysis.json`：Top20 内容形态、逐页 P 分类、加权分布和推荐；
- `E2/research_brief.md`：给操作者阅读的中文研究简报。

页面支持权重为 `引用次数 × 分类置信度`。不可访问页、非文章页和重复别名保留在 Top20 中但不投票，也不从第 21 名补位。

接受 E2 推荐：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py continue \
  --job-dir /path/to/article-job \
  --accept-pattern
```

或从简报列出的合法备选中选择：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py continue \
  --job-dir /path/to/article-job \
  --selected-pattern P02
```

这不是让用户从 P01–P16 盲选菜单。确认 P02 后，Runner 会在 E4 前检查候选证据：客户品牌之外少于两家具有公开来源和具体事实时，自动通过 `frontmind-controller-provider/v1` 执行 `research_candidates`。输入包含正式题面、监控候选与出现顺序、Top20 URL/页面状态、客户品牌、共同比较维度和轻量 `sources + facts` 输出要求；provider 结果直接由 E3 消费。显式提供的 supplemental research 文件优先直接使用，不重复研究。

监控提及、Top20 标题和编辑顺序只用于发现候选，不能充当竞品事实。固定 provider 不可用、研究失败或仍不足两家时，流程不编造、不新增确认点，而由 E4 回到同一个 `awaiting_pattern_confirmation`，要求补充真实候选资料或明确选择合法备选；不会静默降成 P01，也不会用模糊机构补足数量。

## 5. E4 蓝图确认

E3 会把 S4 品牌优先角度、S5 话语合同、监控答案、候选公开事实、Top20 结构、读者问题、安全规则和视觉资产合并为 `E3/editorial_context.json`。Reference Pack 中权利明确且可解码的真图会同时被安全物化到 `00_input/reference_assets/`，上下文只保留相对 job root 的稳定路径，因此 ZIP 临时解包结束后 E7 与 Logo overlay 仍可读取。不安全、缺失、损坏或无权图片被单项跳过，不新增暂停。

E4 读取 P01–P16 预研索引，并按以下顺序选择同 P 的 0–5 篇实时标杆：

```text
classification_confidence → citation_count → raw_rank
```

`E4/blueprint_review.md` 会展示最终 P、候选顺序、品牌重点角度、实时标杆的实际影响、H2/H3、每节读者收获、FAQ、安全内容和视觉方案。

接受蓝图：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py continue \
  --job-dir /path/to/article-job \
  --accept-blueprint
```

也可以提供轻量编辑文件：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py continue \
  --job-dir /path/to/article-job \
  --blueprint-edits /path/to/blueprint-edits.json
```

支持调整同 P 标杆排名、候选顺序、章节顺序/标题、FAQ 和品牌重点角度。修改后 E4 会重新生成蓝图；不会建立审批历史。

## 6. E5–E10 正文生产

蓝图确认后流程自动连续：

- E5 先产生 writing packet，再由 E5 Skill 的编辑模型在同一上下文中整篇写成无标题 `authored-model`；确定性草稿只作开发降级，不得发布；
- E6 对越界事实执行保留、限缩、改写或删除；
- E7 先选择真实资产，再形成品牌视觉、导航图或解释图的安全生产计划；不合规单图被丢弃，正文继续；
- E8 做内容编辑、行文编辑和事实回查，输出安全正本；
- E9 将整篇规范化无标题 Markdown 一次提交给部署环境 HarnessGEO；
- E10 自动比较实体、顺序、数字、日期、价格、来源、限制、适用条件、FAQ 和安全信息。存在漂移时整篇沿用 E8，不做段落混拼。

当 Runner 返回 `contract=frontmind-controller-provider/v1` 且 `user_pause=false`，这是总控内部动作，不是要求操作者再运行一条命令：

- `legacy_enrich_materials` 由固定部署 provider 读取旧 S1、Socratic KB Builder 和原材料，批量形成 S2 可读的 KB/working-set/材料 ZIP；它不增加旧 S1 或 KB Builder 的逐叶确认暂停；
- `research_candidates` 在已确认 P02 且公开竞品证据不足时自动核验监控候选和 Top20 发现线索，返回 E3 可直接消费的公开来源与候选事实；它不把监控答案当事实，也不新增用户暂停；
- `author_article` 由总控读取 writing packet 后整篇生成无标题 Content Model；
- `generate_images` 由总控逐个调用真实图像工具，工具无文件时也把该槽位作为 `NO_FILE` 交回，随后继续纯文字；
- `edit_article` 由总控读取 editing brief 后做完整的内容、行文和事实三轮编辑。

总控必须在同一任务回合自动处理并续跑，直到进入正式用户确认状态。部署若需要用进程回调承接这些动作，可设置 `FRONTMIND_CONTROLLER_PROVIDER` 为 JSON argv 数组；回调接收 `--request PATH --response PATH`，响应同一 contract、action、`completed | no_file | unavailable` 和可选 `output_path`。S1 自动发现同仓库 `private-workflows/socratic-kb-builder`；非标准部署可用 `FRONTMIND_KB_BUILDER_SKILL` 固定它的位置。这些均为部署配置，普通操作者不填写内部模型、Skill 或图片路径。

HarnessGEO 底层固定使用 [XTY 文档所述的 OpenAI-compatible HTTPS 接口](https://doc.xty.app/docs)，不安装 GitHub AutoGEO 包、不运行本地模型，也不需要专用 virtualenv 或源码根。部署只设置：

```text
FRONTMIND_HARNESSGEO_API_KEY=部署密钥
# 或：
FRONTMIND_HARNESSGEO_KEYS_FILE=/deployment/secrets/keys.env
```

`FRONTMIND_HARNESSGEO_KEYS_FILE` 只能包含 `FRONTMIND_HARNESSGEO_API_KEY=...`；`XTY_API_KEY` 仅作为旧部署的进程内兼容输入，不写入 Job。E9 固定 POST `https://api.xty.app/v1/chat/completions`，固定模型 `gpt-5.6-luna`，并把 Workflow 内置的完整 HarnessGEO 系统 Prompt 与整篇无标题正文一起提交。endpoint、model、Prompt、温度、输出合同和重试策略都不是文章级选项，环境变量也不能覆盖。Runner 会主动移除旧 `GOOGLE_API_KEY`、AutoGEO Python/root/model/dataset/engine 和 endpoint/model override。上线前运行 `scripts/check_runtime_dependencies.py`，它会发起一次最小真实 chat-completions 请求并只返回脱敏状态。

E10 选稿后进入 `awaiting_title_count`。输入 1–20：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py continue \
  --job-dir /path/to/article-job \
  --title-count 5
```

标题、H1 建议和 Meta 根据最终正文及该 P 的标题公式独立成稿，不会注入正文。

## 7. 基础启动

`foundation_start` 固定 P14，跳过研究输入与 P 类型确认，但保留蓝图确认和标题数量：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B scripts/frontmind_workflow.py article \
  --input /path/to/reference-pack.zip \
  --job-dir /path/to/foundation-job \
  --entry foundation_start \
  --foundation-subject "示例品牌"
```

## 8. 最终交付

`delivery/` 只包含：

```text
article_body.docx
article_body.html
title_options.md
title_map.json
publishing_metadata_map.json
structured_data_template.json
delivery_index.json
images/                    # 仅在实际采用合规图片时出现
```

正文无 Title/H1/Meta；HTML 是无 H1 的可嵌入片段；DOCX 与 HTML 正文一致，中文字体、可点击来源和实际图片必须正常。高保真 DOCX 渲染不可用时会以 `render_failed` 明确停止，绝不静默输出丢字体、链接或图片的低质量文件。

## 9. 状态不匹配与恢复

`continue` 只接受当前状态对应的操作。传错参数时会原样保留状态，并打印下一条可执行命令，不会把任务标成 blocked。

旧任务按最新内容工件恢复：

- 已有最终正文：进入标题数量；
- 已有 E8 安全正本：从 E9 HarnessGEO 继续；
- 已有 E7 视觉正文：从 E8 继续；
- 已有 E6 事实修订稿：从 E7 继续；
- 已有 E5 Content Model：从 E6 继续；
- 已有 E5 writing packet 或 generated draft：在 E5 内部写作或验证点继续；
- 已有 E7 Prompt Plan：从未完成的视觉槽位继续，已返回 `NO_FILE` 的槽位不再重试；
- 已有 E8 editing brief：从 E8 内部三轮编辑继续；
- 已有 E4 Blueprint：进入蓝图确认；
- 已有 E2 分析：进入 P 类型确认；
- 只有 E1 任务：进入研究输入检查。

真正 blocked 只用于所有内容不可读、品牌/主题无法识别、核心身份事实不可调和、排除受限信息后无法诚实回答、输入整体不安全或高保真正文格式无法生成。

## 10. 安全与边界

- 普通企业资料可直接支持本品牌身份、产品、流程、公开价格和限制。
- 第一方资料不能单独推出客观排名、市场口碑、行业领先、竞品劣势、独立测试或专家共识。
- 明确内部、保密、个人隐私、高风险医疗操作和无权视觉不公开。
- 医疗内容必须保留机构/医师资质、批准产品、面诊、知情同意、严重风险和异常处置边界。
- Logo 只能使用原件 overlay；AIGC 不得冒充真实产品、团队、客户、病例、证书或现场。
- 原 Downloads Workflow 始终只读，不得修改。
