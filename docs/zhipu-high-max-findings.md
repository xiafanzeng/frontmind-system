# Zhipu High / Max 实测问题记录

记录日期：2026-09-06。用于判断是否需要替换上游方案；不把本地适配错误混算成供应商任务失败。

## 反复出现上游失败的任务

目前明确复现的是：使用原企业知识库和原 Skill，生成 **160 条品牌全域词库**。模型固定 `glm-5.3`，速度固定 `standard`。

| 次数 | 档位 | 操作 ID | 上游状态 | 可用业务结果 |
| --- | --- | --- | --- | --- |
| 1 | Max | `c8cb9498-4a82-44ed-a188-8f90395611bb` | error | 无 |
| 2 | Max | `06f92e33-11ed-42e2-a8f3-72a12fb6e02d` | error | 无 |
| 3 | Max | `5d12dd31-8b91-4e7c-a204-07ef336e5f42` | error | 无 |
| 4 | High | `9fae3969-1351-47d2-a5cf-8badf7b9c993` | error | 无 |
| 5 | Max | `2c53a25c-d0e8-494d-a1a3-578cf522cf7f` | error | 无 |
| 6 | High | `3e5ecca0-ba72-41e7-a406-1717d463a741` | error | 产生完整 JSON，已按原业务解析与发布流程保存 160 条词表 |

共同的原生错误记录为 `unknown_error` / “服务暂时不可用” / `exhausted`，随后是 `idle/retries_exhausted`。六次均没有额外 repair 请求。最后两次严格按用户要求各测一次，之后停止新增研究请求。

- 最后一次 Max 运行 18 分 16.523 秒，最后一个模型请求持续 650.499 秒；没有可下载产物。
- 最后一次 High 运行 15 分 16.383 秒，最后一个模型请求持续 672.655 秒。结束前已生成 30,403 字节 JSON，160 条、5 列、分类 20/20/20/100 全部通过原解析器。
- High 的上游错误仍保留；业务任务因可用产物已发布而完成。这不等于上游会话正常完成，也不能据此声称 High 已稳定。

## 本地发现并修复的独立问题

1. 适配器没有读取失败终态下的 JSON 文件，业务服务也在解析结果前处理错误。现在将同轮消息及文件候选交给原业务解析器；有效内容走原发布流程，无效内容仍报真实失败。
2. 品牌结果使用 UUID 本地文件 ID，但下载器只识别 `asset_` 前缀，并把持久品牌产物套入上传文件的过期规则。已补齐按所有权和服务端存储来源授权的下载实现；普通上传过期和跨账号隔离保持有效。

业务层固定运行时限已经移除。这两次失败有原生供应商错误证据，并非本地到 15 分钟主动终止；官方说明会话可以持续数小时。供应商尚未给出更细的错误原因，不能把所有失败归因于 Max 参数，或直接认定该任务永远无法运行。

## 不能一起归类为“High / Max 都跑不通”的流程

- 企业知识库：原 55 叶节点、修订、确认与最终归档已完成。
- 响应逻辑：原会话内两轮、保存及确认已完成。
- 通用 Agent：原两轮对话和附件下载已完成；本次另外补客户入口和权限。
- Website 企业分析、评估及预测：充值后已有成功验收；余额问题与模型参数失败分开记录。
- 新内容制作 ZIP Workflow：真实 v4.11 P0 和单问题文章均已在 Max 完成原生多轮制作与文件交付，文章还验证了完整当前 Job 的跨轮恢复；这不是 High / Max 对照实测，不能套用品牌全域词库的结论。

## 参数依据

### 当前各模块实际参数

以下为 2026-09-06 17:34（北京时间）的代码和生产只读核对结果。所有表内 Zhipu 模块均使用 `glm-5.3`、`speed=standard`。High/Max 是账号 Key 的推理设置；修改后新任务使用新绑定版本，已有任务继续使用创建时的冻结值。

| 产品 / 模块 | 当前新任务 effort | 已有任务和验证范围 |
| --- | --- | --- |
| Website 企业知识库 / 企业分析 | High | 保留的 2 个任务成功 |
| Website 问题推荐 | High | 保留的 2 个任务成功 |
| Website 自定义问题分类 | High | 已确认创建路径配置，未另加付费验证 |
| Website 现状评估 | High | 保留的 5 个成功、2 个历史失败；失败不能全部归因于推理档位 |
| Website 优化预测 | High | 保留的 4 个任务成功 |
| Website 监控问题翻译 | High | 已确认创建路径配置，未另加付费验证 |
| Dashboard 企业知识库 | 跟随客户 Key；客户 3 当前 Max（v5） | 原知识库生成、修订和发布已验收；历史任务保留冻结设置 |
| Dashboard 品牌全域词库 | 跟随客户 Key；客户 3 当前 Max（v5） | 上表最后一次 High 使用 v4；可用的 160 条结果已发布，账号默认未因此改成 High |
| Dashboard 应答逻辑 | 跟随客户 Key；客户 3 当前 Max（v5） | 原同会话两轮、保存和确认已验收 |
| Dashboard 通用 Agent（客户 / 交付管理员） | 跟随操作者 Key；客户 3 为 Max（v5），交付管理员 4 为 Max（v1） | 之前验收的 High 会话继续 High，新入口不会把旧会话改成 Max |
| Dashboard 企业问答智能体 | 跟随客户 Key；客户 3 当前 Max（v5） | 已用真实客户页面完成一次 Max 短问答；原生会话正常完成，回答的企业名称、注册主体及两处引用与 55 篇已发布知识原文一致 |
| Dashboard 内容制作 | 跟随客户 Key；客户 3 当前 Max（v5） | 已纠正为用户指定的 v4.11.0 表达修订版（Runtime 4.11 / Pack 4.1）；活动流程无 HarnessGEO/XTY/E9 密钥依赖。本次 P0 和单问题文章均以账号 Max 完成真实交付，完整文件快照跨轮还原通过；原发行作者的 High 测试不冒充本次对照结果 |
| Dashboard 官网制作 / 官网修订 | 跟随客户 Key；客户 3 当前 Max（v5） | SiteOps 冻结设置；本次按用户要求不验收建站；生产运行记录为 0 |
| Dashboard 公众号 / 小红书制作 | 跟随客户 Key；客户 3 当前 Max（v5） | SiteOps 后续任务优先继承父任务冻结设置；无本轮实际运行记录 |
| 问题监控、媒体发布、原 Jenova 跟踪、非 AI 管理操作 | 不适用 | 分别沿用 Moli、KOL、Jenova 等原服务，不使用 Zhipu High/Max |

Website 的生产 `WEBSITE_ZHIPU_EFFORT=high` 由 Dashboard 代理在创建时冻结，Website 浏览器不直接指定 effort。管理员页面目前提供 High/Max；底层 API 支持 Low 不代表当前页面有 Low 选项，也不代表有 Low 的实测结果。系统管理员账号 1 仅保留历史 Manus 元数据，不据此认定它有正在执行的 Manus AI 入口。

企业问答补充验收：`f1513870-add6-4506-8f87-b799c48fd448`，`glm-5.3 / max / standard`，一次原 UI 提交、一次上游指令、无重试新建。知识库 v1 的 55 篇资料以冻结附件提供；引用 `0001.md`《企业概况》和 `0002.md`《注册主体与经营资质》与原文一致。此简单问答成功不能替代 160 条研究任务的稳定性结论。

代码依据：Website `server/geo/broker.ts` 的六类任务，Dashboard `presales-v2-store.ts` / `providers/website-agent-provider.ts` 的 Website 冻结参数；`credential-agent-client.ts` 和 `general-agent-runtime.ts` 的账号 Key 及历史 profile；`siteops/service.ts` 的 SiteOps 凭据继承；`providers/dashboard-agent-provider.ts` 的 `speed: standard`。生产只读记录未导出密钥。

[官方 OpenAPI](https://docs.bigmodel.cn/openapi/openapi-managed-agents.json) 定义 `model.effort` 为 `low / high / max`，`model.speed` 为 `standard`。省略 effort 时，`glm-5.3` 默认 Max；它们是推理档位，不是旧 Manus 的 Base/Pro 套餐。

[官方 FAQ](https://docs.bigmodel.cn/cn/managed-agents/faq.md)；[Agent 配置](https://docs.bigmodel.cn/cn/managed-agents/agent-setup.md)。后续若更换上游，应保留原知识库、Skill、业务解析和可用结果接收方式，并以同一任务的实际完整产物比较；不要仅以某一次 API 返回成功判断替换方案可用。

## 内容制作版本纠正

先前接入仓库中 v2.3.0 ZIP 是版本选择错误，把 E9 专用密钥当作最新流程阻塞也不正确。现以用户指定任务的 v4.11.0 表达修订版为准：原 ZIP SHA256 `fc73c4334d57dc7b4382cc6a0be3d9ffe498aa168273032b9d0d8a7fba462bcb`，29,222,014 字节。适配实际 `job_kind`、`stage`、`revision` 和 14 个原生暂停；P0 创建/导入都是 Runner Job，正文按 draft → edit → titles → deliver，固定 20 个标题。已撤掉误加的 Vault 集成。

当前 Dashboard 源码不存在 WeKnora 配置或调用入口。企业问答、通用 Agent、内容制作与知识库均使用账号统一 Key；管理员“官网管理”的 Website 专用 Key 仍服务独立官网任务，不是重复企业问答配置。

### v4.11 P0 真实制作结果

客户任务 `a0296584-495a-4b86-9b54-f2c2def74bbf` 使用账号实际冻结的
`glm-5.3 / max / standard`，从页面创建一次，依次通过已有 Reference Pack、
新建 P0 和蓝图确认。原生会话正常结束，无 `session.error`；实际 Runner
依次执行 `p0_draft → p0_edit → p0_titles → p0_ready`，没有启用离线 fixture。
最终正文 3,565 字符，20 个唯一标题分为 10 个决策搜索和 10 个媒体公关。
Markdown、HTML、DOCX、标题 JSON 和同 `pack_id` 的 v2 Pack 均通过真实客户
下载；各独立文件与 Pack 内对应文件逐字节相同，原 Pack 验证器通过。

验收采用原发行作者既往真实模型测试用 Reference Pack，不代表正式业务
材料已获批准，也未对外发文。本次未实际联网，例文发现走原 Runner 允许的
零例文分支，不能据此声称联网例文发现通过。旧 `/workspace` 曾三次跨轮
丢失，模型从原 Pack 和前轮输出恢复后完成；不能把这次 P0 成功当成持久性
修复已通过。仅换路径的后续失败及最终完整快照恢复验证见下文。

### 文件上传与跨轮目录问题

后续文章任务 `1cdea530-2897-4392-9f8f-5c0b71acf74d` 的原生工具记录确认，
`/mnt/session/work` 同样会在轮次间消失；只更换路径没有解决问题。当前修复
保留完整当前 Job 的原文件快照，通过同会话 outputs 运输，下一轮恢复原目录；
原发行 ZIP、Runner、业务确认步骤和任务输入不修改。内部快照和状态文件不进入
客户附件，真实内部下载 ID 返回 404，普通 review 和客户 Pack 下载保持 200。

新验收的首次提交 `930f6639-5651-4ef5-a87d-91544fda2109` 在上传 29MB
Workflow 时返回结果不确定。上传开始到最后更新约 60 秒，与本地普通请求
超时高度吻合，但没有保留原始 TimeoutError；不能把原因写成已完全证实。
它尚未创建 Agent、Environment、Session 或模型命令，不能计入 Max 执行失败。
全新上传后，任务 `bd6e0751-e48d-426c-b25d-2c35bd1a9ecc` 创建成功。
单独的大文件上传窗口改为默认 600 秒，普通请求仍为 60 秒；不会自动重发
上传 POST，也不会给研究会话增加总运行时限。

### v4.11 单问题文章真实交付结果

任务 `bd6e0751-e48d-426c-b25d-2c35bd1a9ecc` 已用同一
`glm-5.3 / max / standard` Session 正常完成原流程。完整 Job 快照依次包含
4、42、49、55、61、79 个文件，每次真实恢复相同 Job 的字节和权限，再按
原 revision 继续；两份初始答案没有重复索取，原分析结果没有因跨轮丢失重做。
跨 Dashboard 发布后，登录、同任务继续和最终刷新也正常。

原 Runner 完成初稿、全文编辑、标题和交付，终态为 `completed/E10`，
`offline_fixture=false`。Markdown、HTML、DOCX 和 Title Map 的客户下载
均与原生文件及 Job 内原文件逐字节一致。Markdown 共 2,190 字符、6 个 H2；
20 个唯一标题按决策搜索/媒体分为 10/10。Word 三页及 HTML 桌面/手机
可视检查通过，原文件未改动。

原文章终态按 RUNBOOK 交付四份正文文件。另以一次仅导出文件的同会话请求，
补交 E1 已生成的更新 Pack v3，没有重跑 Runner 或重新制作内容。该 Pack
保留原 ID 和五份 P0 原文件，新增本题研究，原验证器通过，客户下载与 Job
内 ZIP 字节一致。12 个真实内部状态/快照下载 ID 均为 404；17 个正常输出
与原客户 Pack 下载均为 200，大小和哈希一致。

本次输入仍是原作者既往 GLM 测试答案与真实 P0 测试包，不是本次从两个
独立平台新采样的回答。实际联网尝试已发生，但最终接受的外部完整例文为 0，
按原 Workflow 允许的零例文分支完成；不能把它表述为外部例文发现成功。
测试产物未对外发布。该结果说明此内容流程能以 Max 完成，不能推导所有
Max 任务稳定，也不改变 160 条词库研究停止新增付费测试的决定。
