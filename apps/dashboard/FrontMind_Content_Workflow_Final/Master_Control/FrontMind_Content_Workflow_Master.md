# FrontMind GEO 内容制作 Workflow Master v2.3

> 运行合同 `2.3.0`；Reference Pack wire profile 保持 v2.2；原 Downloads Workflow 只读。

## 1. 架构边界

本系统不重造产品架构。企业 Reference Pack 运行一次并复用，单篇 E 流程每篇运行一次：

```text
企业级：S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 [确认] → S9
单篇级：E1 → E2 [确认P] → E3 → E4 [确认蓝图] → E5 → E6 → E7 → E8 → E9 → E10 [标题数]
```

S3 是唯一可真正跳过的策略研究；S6、S7 可产生空结果但必须执行。`foundation_start` 跳过 E1 的研究输入确认和 E2 P 确认，固定 P14，但保留 E4 蓝图确认与 E10 标题数量。

旧审批、回执、reviewer、pause log、工作簿确认、跨阶段 SHA、runtime Registry、逐文件 Manifest 和 exact-set provenance 不进入活动流程。Hash 只用于缓存、去重与安全读取。

## 2. 企业阶段

### S1 资料接入

直接读取 v2.1/v2.2 Pack、canonical KB、working-set、ZIP、目录和办公文件。已有 canonical KB 直接验证；散乱资料选择 `legacy_enrichment` 时，Runner 通过固定 controller provider 实际读取字节不变的 legacy S1 与 Socratic KB Builder，产出经 S1 安全复检且由 S2 真实消费的增强材料。该增强失败而原材料仍可读时只记录 warning 并继续，不重新引入旧格式门。单文件失败只排除单文件。

### S2 内容标准化

一次生成 knowledge/source/claim/image 四类轻量 Registry。普通企业事实默认 `usable`；需要自然限定的事实为 `qualified`；明确内部、保密、个人敏感、高风险操作或无权视觉为 `excluded`。

### S3–S7 内容资产

- S3：只保留会改变文章论证的政策、标准、技术或市场变化；
- S4：定位、RTB、信息支柱、比较边界、关键 Proof Bundles 与 `brand_priority_angles`；
- S5：`third_party_objective_reporting_plus_brand_promotion` 话语合同；
- S6：Logo、品牌色、真实视觉、权利、四类视觉角色和 P 模式配方；
- S7：真实咨询、监控、销售或搜索问题；不凑数量。

### S8–S9

S8 展示人类可读摘要并进入 `awaiting_pack_confirmation`。用户修正直接修改内容资产，不生成签字或差异账本。确认后 S9 打包四类 Registry 与 S3–S7 写作资产。Pattern Registry 和 Pattern Research 属于 Workflow 自身，不重复写入企业 Pack。

## 3. 单篇阶段

### E1 任务与研究输入

固定一个正式问题、一个五类入口和自动范围。普通入口必须同时具备同题 AI 监控答案与引用信源工作簿；缺少时进入 `awaiting_research_inputs`。这两份文件用于内容研究，不是身份审计。

### E2 单问题研究

AI 答案提取当前答案、品牌提及与顺序、反复维度、子问题、遗漏、分歧和引用链接。信源表按正式问题精确筛选，重算引用次数、排名和占比，固定 Top20；文章/PDF 才参与 P 分类，非文章和访问失败不补位。

页面支持权重为 `citation_count × classification_confidence`。E2 输出加权/非加权分布、支持/反对排名、覆盖率、推荐、合法备选、候选信号和研究简报，并进入 `awaiting_pattern_confirmation`。用户不是从十六模式盲选，而是在研究结果中确认推荐或合法备选。

### E3 编辑上下文

合并 `voice_profile`、`brand_priority_angle`、Fact Cards、候选画像、答案格局、标杆动作、读者问题、公开限制、医疗/法律安全和视觉资产。监控品牌提及只是发现信号；Top20 只是结构与候选发现；客户、竞品和公共专业事实分别使用适当来源。

P02 在 E3 定稿前补充研究到至少三家真实候选。客户品牌之外少于两家具有公开来源和具体事实时，Runner 自动执行非用户暂停的 `research_candidates`，以正式题面、监控候选、Top20 发现信号和共同维度核验公开来源；结果由 E3 直接消费。研究仍不足时返回 E2，让用户补候选或明确选 P01；不得静默降级，也不得用模糊对象凑数。

### E4 文章蓝图

E4 校验用户确认的 P 并读取 Pattern Research。它从 Top20 同 P 项中按 `classification_confidence → citation_count → raw_rank` 选 0–5 篇标杆，把预研必要结构与真实标杆动作融合为自然章节。

每节只向写作层传 `display_heading / editorial_job / reader_takeaway / fact_ids / candidate_ids / benchmark_moves / visual_role`。`editorial_job` 不进入正文。蓝图确认页展示最终 P、候选顺序、品牌重点角度、标杆影响、H2/H3、FAQ、安全内容、视觉计划和禁写主张。

### E5–E8 出版正文

- E5：脚本生成 writing packet，执行 E5 Skill 的编辑模型再在同一上下文中整篇生成无标题 `authored-model`；确定性草稿只用于开发降级和结构诊断，不得作为出版稿；
- E6：对过强或不适用内容执行 `keep / qualify / rewrite / remove`；
- E7：按 P 配方选择真实资产、生成品牌编辑/导航/解释视觉并过滤风险；
- E8：内容编辑、行文编辑、事实回查三轮完成安全正本。

正文只显示事实、判断、品牌价值和行动建议，不显示证据状态、资料缺口或 Workflow 思考。字符串替换仅处理字符清理，不能代替编辑。

P02 自动竞品研究以及 E5、E7、E8 所需的模型或图像工具统一使用 `frontmind-controller-provider/v1` 内部动作。该动作的 `user_pause` 恒为 `false`：总控完成 `research_candidates`、整篇 authored model、逐图文件或 `NO_FILE`、整篇 edited model，并立即续调 Runner。它们不增加 `job_state` 暂停状态，也不向用户索取隐藏路径。固定部署也可用 `FRONTMIND_CONTROLLER_PROVIDER` JSON argv 回调自动完成同一协议。

### E9–E10

E9 将完整无标题正文一次提交给 HarnessGEO，产生独立候选，不决定正本。底层固定经 XTY `https://api.xty.app/v1/chat/completions` 调用 `gpt-5.6-luna`；完整出版优化 Prompt 固化在 Workflow 中，部署只提供 `FRONTMIND_HARNESSGEO_API_KEY`（或指向同名变量的受控 keys file）。不安装或加载本地模型，不接受文章级 endpoint、model 或 Prompt 选择。E10 比较实体、候选顺序、数字、日期、价格、来源、限制、适用条件、FAQ、医疗风险和行动建议；全部稳定才整篇采用候选，任一漂移整篇采用 E8，禁止段落混拼。

选稿后进入 `awaiting_title_count`。收到 1–20 后，根据最终正文和当前 P 的标题公式生成严格等量、角度不同的标题、H1 建议与 Meta，并渲染无标题 DOCX/HTML。

## 4. 五个交互状态

1. `awaiting_pack_confirmation`（S8）；
2. `awaiting_research_inputs`（E1）；
3. `awaiting_pattern_confirmation`（E2）；
4. `awaiting_blueprint_confirmation`（E4）；
5. `awaiting_title_count`（E10）。

`job_state.json` 只保存版本、job、mode、stage、status、selected pattern、title count、warnings、blocker 和更新时间。不保存确认历史、人员、审批时间、回执路径或文件哈希。

## 5. 模式硬边界

- 五入口完整保留；`foundation_start ⇔ P14`；
- P01 单品牌，只允许一个焦点品牌；
- P02 多品牌，至少三家真实候选、客户首位且重点详写、共同最低维度公平；
- P03 是明确对象的对称比较；
- P04–P16 按 Registry 与 Pattern Research 定义；
- 禁止客观第一、最好、最安全、唯一推荐等无依据语义；
- 第一方资料不单独证明排名、市场口碑、领先、竞品劣势或医疗疗效。

## 6. 公开交付

公开目录只含无标题 `article_body.docx`、`article_body.html`、`title_options.md`、`title_map.json`、`publishing_metadata_map.json`、`structured_data_template.json` 和非哈希 `delivery_index.json`。DOCX/HTML 正文和视觉一致，中文可读，来源可点击。

## 7. 真正 blocker

仅限：没有可读安全内容；无法识别品牌或主题；核心身份事实直接冲突；排除受限内容后无法回答；只能靠编造关键事实回答；输入整体受到安全攻击；或自动重试后仍不能输出任何可读格式。确认状态不是 blocked。
