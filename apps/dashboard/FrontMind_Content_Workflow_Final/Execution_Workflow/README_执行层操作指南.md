# FrontMind 内容执行层 v2.3

执行层每次制作一篇文章，以“现有内容能否支撑诚实成稿”为继续条件：

`E1 任务与研究输入 → E2 监控答案、Top20 与 P 推荐 → E3 编辑上下文 → E4 P 模式与结构蓝图 → E5 整篇无标题正文 → E6 事实修订 → E7 视觉选择与生产 → E8 出版编辑 → E9 整篇 HarnessGEO 候选 → E10 整篇选稿、标题数量暂停与交付`

完整运行命令以包根 `RUNBOOK.md` 为准。非 `foundation_start` 文章在 E1 提供同题 AI 监控答案与引用信源工作簿，并在 E2 确认 P 推荐、E4 确认蓝图；E10 再回答 1–20 的标题数量。不需要构建阶段回执、文件指纹、审批表或运行时注册表。

## 输入与自动续跑

- E1 可直接接收 v2.1/v2.2 Reference Pack、旧 Pack 或原始企业资料。它安全解包、识别品牌、正式问题和五入口，范围默认自动推断。
- E2 必须真实消费 AI 监控答案与同题引用信源工作簿，整理 Top20、判断内容形态并生成 P01–P16 建议；页面不可访问或无可分类页面时使用预研模板补足结构，但不得伪造 Top20 支持度。`foundation_start` 固定 P14，可跳过 E2。
- E3 只输出一份 `editorial_context.json`，合并可用企业事实、必要限定、研究摘要和来源名称。它不复制运行时注册表，也不冻结上游文件身份。
- E4 校验用户在 E2 确认的唯一 P，把品牌角度、候选顺序、标杆影响、自然章节、FAQ 和视觉计划写入 `article_blueprint.json`，并在正式成文前让用户确认。确认的 P 无法满足硬条件时返回 E2 模式确认，不静默改选。

## 内容、事实与视觉

- E5 先生成完整 writing packet，再由 E5 Skill 在同一上下文中一次写完整篇作者稿；脚本只做结构、事实分配和正规化，不按字段拼句。Content Model 使用 `lead.text`、自然章节段落、FAQ 和结论段落，不含 Title、H1、标题候选或 Meta Description；References 根据实际使用事实自动生成。
- E6 在本阶段直接对主张执行 `keep | qualify | rewrite | remove`。局部证据不足就限缩或删除，不要求用户补齐证据账本。
- E7 按 P 模式依次执行真实企业资产选择、Prompt Plan、图像生成工具调用、原始 Logo overlay 和安全过滤。无图、单图失败或权利不明时丢弃对应槽位并继续纯文字交付；真实产品、团队、证书、案例和项目现场不得用 AIGC 冒充。
- E8 完成内容编辑、行文编辑和事实回查三轮出版编辑，删除审稿腔、同构句和重复内容，输出完整安全正本与简短 warnings。
- E9 把整篇规范化无标题 Markdown 与 Workflow 内置 Prompt 一次提交给部署环境 HarnessGEO，仅输出独立候选，不覆盖 E8、不处理标题、不模拟成功。底层固定经 XTY HTTPS 调用 `gpt-5.6-luna`；凭证由部署控制器管理，普通用户不填写，且不能覆盖 endpoint、model 或 Prompt。

E5 写作、E7 图像工具和 E8 整篇编辑如需总控接手，Runner 会输出 `frontmind-controller-provider/v1`、`user_pause=false` 的机器动作。总控必须在同一任务回合完成并立即续跑；图像工具无文件时返回 `NO_FILE`，该槽位随后被丢弃且不再循环。部署可用固定 provider callback 自动承接，但普通用户不填写内部 authored model、edited model 或图片路径。

## E10 标题与交付

E10 的顺序固定为：

1. 先比较完整 E8 正本和完整 HarnessGEO 候选；事实或语义任一漂移即整篇沿用 E8，禁止段落混拼；
2. 正文确定后，`job_state.json` 进入 `awaiting_title_count`；
3. 用户输入 1–20 的整数；
4. 系统生成恰好 N 个真正不同的标题和发布元数据，不反向改写正文；
5. 从同一份最终 Content Model 高保真渲染无标题 DOCX 与无 H1 HTML 正文片段；渲染器异常时显式失败，不静默降级。

公开交付目录只包含：

- `article_body.docx`：从首段直接答案开始，无 Title/H1；
- `article_body.html`：无 H1 的可嵌入正文片段；
- `title_options.md`、`title_map.json`、`publishing_metadata_map.json`；
- `structured_data_template.json`；
- 实际采用的视觉文件（如有）；
- `delivery_index.json`：仅列文件名、用途和媒体类型。

默认交付不包含 receipt、审批表、哈希账本、内部审计目录或本机绝对路径。本工作流不做 CMS、发布或效果监测。

## 只允许的停止条件

只有全部输入不可读、品牌/主题无法识别、核心身份事实直接冲突、排除敏感内容后无法诚实回答、整体输入安全问题，或自动重试后仍无任何可读正文格式时，才可标记 `blocked`。五个质量型确认使用各自的 `awaiting_*` 状态，绝不标记为 blocked。某条事实、部分页面、第三方材料、标杆或图片不足，均不能使整篇文章停止。HarnessGEO 调用异常作为部署错误明确报告，不得用模拟结果掩盖。
