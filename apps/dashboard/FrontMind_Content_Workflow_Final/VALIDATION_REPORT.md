# FrontMind GEO 内容制作 Workflow v2.3 验证报告

> 运行合同：`2.3.0`  
> Reference Pack：写出 `frontmind-content-reference-pack-v2.2`，兼容读取 v2.1  
> Workflow 发行状态：`PASS`  
> 匿名 P02 验收任务状态：`AWAITING_TITLE_COUNT`

本文件记录 Workflow 发行验证结果，不是单篇文章的准入凭证，也不进入文章运行链。当前代码、合同、研究资料、真实 XTY 全文调用和匿名验收正文选稿均已收口；HarnessGEO 固定经 XTY HTTPS 中转调用 `gpt-5.6-luna`，不安装、探测或调用本地 AutoGEO 模型。发行包外的匿名验收任务按合同停在 E10 标题数量输入，未完成的标题和文章交付不进入 Workflow 发行包，也不改变运行代码的发布结论。

## 1. 静态与合同验证

2026-08-17 使用工作区绑定 Python、`PYTHONDONTWRITEBYTECODE=1` 与 `-B` 复验：

- Workflow Validator：PASS，497 个文件系统条目、20 个活动 Skill、47 个 JSON、76 个 Python、81 个活动 Markdown、14 个 canonical Schema、18 套聚焦测试；0 error、0 warning。
- Cross-reference：PASS，156 个活动文件，0 issue。
- Pattern Research：PASS，P01–P16 共 16 份 dossier、140 个全局唯一 URL；P01/P02/P14 各 12 篇，其余模式各 8 篇。
- 140/140 个页面观察已逐页语义复审并受 rebuild 保护；结构、子问题、证据位置、优缺点、不可借鉴项和采用理由均为页面特异内容。
- 活动树无 `__pycache__`、`.pytest_cache`、`.pyc` 或符号链接；测试缓存已移至发行树外的可恢复隔离目录。
- 活动流程不存在逐阶段签章或身份账本依赖；历史兼容项只存档，不参与运行。

## 2. 聚焦回归

以下活动回归均已通过：

- 统一 Runner：18/18；覆盖五个质量暂停、内部写作/编辑/视觉 provider 自动续跑、E5–E10 崩溃窗口恢复、P02 自动补充公开研究、旧任务恢复，以及 XTY 密钥进程内映射与旧本地模型变量清除。
- HarnessGEO 部署探针：7/7；固定适配器为 `xty_openai_chat_completions`，固定 POST `https://api.xty.app/v1/chat/completions` 与 `gpt-5.6-luna`，拒绝响应模型静默回退，不读取本地 Python、源码根、模型路径或 provider SDK。
- E1：5/5；E2：13/13；E3：6/6；E4：6/6。
- E5 自然成文与事实修订：4/4；E7 视觉生产：12/12；E9 固定 XTY HTTP 适配器与内置 Prompt：10/10；E10 整篇回退、标题与交付：14/14。
- Strategy S1–S9：6/6；Pattern Research：22/22；共享运行时、路线、来源边界等活动测试全部通过。
- 根 Schema 正反例：11/11；Title Map 覆盖 1、20、去重、P01/P02 排名语义和模式标题公式。

HTTP 合同测试校验了固定 URL、固定 model、system/user 消息、非流式响应、Bearer 认证、chat-completions 响应解析和密钥脱敏；caller 提供的 endpoint/model、本地 Python/root/model 及旧 Google/AutoGEO 变量均不能改变调用。缺凭证或响应为空时失败关闭，且不会生成候选、转用本地模型、执行模拟规则或读取旧兼容工件。

2026-08-17 已使用受控凭证对上述固定 endpoint 与精确 model ID 做过最小真实 chat-completions 连通性验证；该验证不打印密钥或响应正文，也不代替下方匿名全文 E9–E10 验收。

## 3. Reference Pack 与原始能力

- 真实 `frontmind.kb-working-set/schemaVersion=1` 已完成 S1–S9：S1 读取 111 个可用文件；S2 生成 55 个 knowledge、110 个 source、55 个 claim；S4、S5 必跑；S6、S7 产生可空但真实执行的写作资产；S8 只排除局部敏感项，不阻断 Pack。
- 真实轻量 Pack：v2.2 wire、121 个可读文件，`validate_package` 为 0 error、0 warning。
- 匿名最小 Fixture：12 个写作所需文件，v2.2 wire，0 error、0 warning；不包含 approval、receipt、`files[]` 哈希账本或 Pattern Research 副本。
- v2.1 常规与非标准内容布局均由兼容 reader 宽容读取；旧审批、哈希和诊断字段被忽略。
- S4 品牌优先角度、S5 话语合同、S6 视觉资产和 S7 问题资产真实进入 Pack，并经 E3/E4/E5 消费。
- 五入口、P01–P16、`foundation_start ⇔ P14`、P01 单品牌、P02 多品牌、P03 对称比较均有合同和测试。
- 原 Downloads Workflow 仍为 146 个文件、1,951,320 bytes；基线摘要保持 `502af29b1f4417a7bcea42c7874817f2a9b38d539e18f9b046eb3513019709d7`。compatibility 中旧 S1 的 8 个文件与原件逐字节一致。

## 4. 匿名 P02 验收进度

匿名化验收问题：`杭州打玻尿酸机构有哪些推荐？`

已完成至 E10 整篇选稿：

- E2 使用同题监控答案验收 Fixture 与同题引用信源工作簿，重算原始 Top20：12 篇 `classified_article`、4 篇 `unavailable`、3 篇 `non_article`、1 篇 `unsafe_url`，未向第 21 名补位。
- 分类覆盖率 60%；P02 为 7 篇、加权支持 240.56、占比 73.81%；P03 为 5 篇、占比 26.19%；E2 推荐 P02。
- 12/12 篇可分类页面都携带页面级人工复审；E3 保留其结构、真实子问题、证据位置和选择理由；E4 选择 5 篇同 P 标杆并将实际影响写入 Blueprint。
- E3 汇总 100 条 Fact Card、241 个来源、4 个候选画像和 12 个标杆动作；监控提及只作为发现信号，竞品事实必须来自独立公开来源。
- E4 固化 P02、3 个受来源约束的匿名候选、示例客户品牌首位、5 个自然章节和 7 个 FAQ；未静默降级。
- E8 正本 Lead 240 字、5 节、7 个 FAQ、13 个实际使用来源、1 张解释图；示例客户品牌首位且明显详写。
- 计划禁用的报告腔表达为 0；正文未出现“待核验候选”“当前团队与产品待核验”“资料较完整”“以审核为准”“服务边界”“用户提交资料”等内部语言。
- E6 对事实执行 keep/rewrite，而非批量追加免责声明；E8 使用整篇出版编辑，不依赖字符串替换完成内容修订。
- E9 已使用 XTY `gpt-5.6-luna` 对完整无标题匿名验收正文做一次真实远程调用：`status=completed`、`candidate_ready=true`、provider issues=0；响应模型 ID 与固定模型一致。
- E10 保守回归发现候选改动了多处受保护实体/限定表达及三家机构的出现次数，因此按合同整篇选择 E8 安全正本；没有采用任何候选段落，也没有发生段落混拼。
- `job_state.status=awaiting_title_count`；正文选择已经完成，标题尚未生成。

验收输入中的监控答案是明确标注的 synthetic acceptance fixture，不是线上真实监控导出；信源工作簿是同题验收 Fixture。它们可以证明数据流、Top20、P 推荐和标杆融合，但不能被描述为真实市场监控结果。

## 5. HarnessGEO 与交付待项

活动 E9 已统一对外称 HarnessGEO，底层只调用固定的 XTY OpenAI-compatible HTTPS 合同：

```python
POST https://api.xty.app/v1/chat/completions
model = "gpt-5.6-luna"
messages = [HARNESSGEO_SYSTEM_PROMPT, complete_title_free_markdown]
response_format = {"type": "json_object"}
```

出版级 HarnessGEO Prompt 已直接固化在 Workflow；endpoint、model、Prompt、温度、最大输出、重试和 JSON 输出合同都不能由单篇任务覆盖。已删除本地模型路径、专用 Python/root、dataset/engine 选择、模拟规则改写和 `--skip-autogeo`。E9 只生成独立候选；E10 对整篇候选复查实体、候选顺序、数字、日期、价格、来源、限制、适用条件、FAQ、医疗风险、监管法域、语言脚本和高风险动作，任一漂移整篇回 E8，不做段落混拼。

发行包外的匿名验收内容任务仍需完成：

1. 用户输入 1–20 的标题数量；
2. 按最终 E8 正本与 P02 标题公式生成严格等量的标题及 Meta；
3. 生成高保真 DOCX/HTML 最终交付；
4. 完成 DOCX 逐页 PNG/PDF 视觉检查、中文字体、链接、图片和正文等价验收。

部署只需在受控进程中设置：

```bash
export FRONTMIND_HARNESSGEO_API_KEY='...'
# 或：export FRONTMIND_HARNESSGEO_KEYS_FILE=/secure/path/keys.env
```

其中 `keys.env` 只能包含 `FRONTMIND_HARNESSGEO_API_KEY=...`。密钥不得写入 Workflow、Job、候选、日志或发布包。`XTY_API_KEY` 只作为进程内兼容输入并立即映射到正式名称。每个部署环境应先运行 `scripts/check_runtime_dependencies.py` 做一次最小、脱敏的真实连通性检查；单篇任务仍须独立完成其标题、DOCX/HTML 与视觉验收。这些任务级交付状态不改变本报告已经通过的 Workflow 发行结论。

## 6. 发布结论

Workflow v2.3 的活动实现、内容研究、五个质量暂停、P01–P16、S4/S5 数据流、E2 Top20、人工标杆融合、整篇写作/编辑、视觉生产、HarnessGEO API 合同、整篇回退、标题公式和兼容 Pack 均已完成且测试通过。

Workflow v2.3 发行验证为 `PASS`。真实 XTY HarnessGEO 全文调用和 E10 整篇选稿已经完成；匿名验收文章仍停在用户明确保留的标题数量选择，属于发行包外的内容任务状态，不是本地模型回退、身份审计或无用门控。该任务收到标题数量后仍应完成其自身的 DOCX/HTML 逐页验收，但不能把验收文章、密钥或临时验收工件装入 Workflow ZIP。
