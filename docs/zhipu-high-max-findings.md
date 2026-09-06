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
- 新内容制作 ZIP Workflow：尚无本轮 High / Max 对照实测，不能套用品牌全域词库的结论。

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
| Dashboard 内容制作 | 跟随客户 Key；客户 3 当前 Max（v5） | 已纠正为用户指定的 v4.11.0 表达修订版（Runtime 4.11 / Pack 4.1）；活动流程无 HarnessGEO/XTY/E9 密钥依赖。原发行作者使用 High 做过实测，Dashboard 仍遵循账号 High/Max 设置；本次完整产物验收另记 |
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
