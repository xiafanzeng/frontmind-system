# 最终手册第三部分实施与验证记录

基线：f31e590；以下是前序专项记录。最新集成结果以 [最终验收记录](kb-upload-reset-final-verification.md) 为准。

## 修改前故障复现

- server/customer-ai-usage.test.ts 新增 4 项回归，在原实现全部失败：generation 混合、后台回包时间覆盖已发布状态、创建未知显示暂无调用、Token 完整但费用待结算显示已同步。
- client/src/lib/business-execution-adapters.test.ts 新增 3 项回归，在原实现全部失败：本地发布批次创建被解释为供应商提交、监控完成虚构整理样本、网站部署完成误作生成预览。
- client/src/lib/final-reply.test.ts 新增 2 项回归，在原实现全部失败：中间知识展示允许复制、服务端最终标识被后续摘要覆盖。
- client/src/dashboard/workflow/Workflow.test.tsx 回归在原实现失败：父组件不能指定 Completed 后 Section 的分隔线归属。

## 实现

- 用量以 buildId + generation 分组；当前代 build 和历史代所属 turn 的业务状态独立于最后活动时间。按既有 ai_cost_events 去重账本累计，展开保留调用/turn 明细；不读取会话累计快照和供应商成本。
- 创建结果未知、当前轮未知但此前已有费用、Token/费用未齐全保持同步中；未发送请求的失败/停止显示准确文案；当前轮未调用和历史轮费用分开说明。
- 企业项目优先手动选择、当前项目、授权列表中最近记住项目，失效选择不越权。
- 官网恢复真实 deploy 记录；修订和部署使用不同公开阶段；线上验证只读取持久化 verification.public.verifiedAt，不用完成时间虚构验证。
- 监控使用真实采集尝试提交/终止/结果时间，失败无样本不再用 terminalAt 伪装样本；完成阶段为采集结果。
- 媒体发布只把 createdAt 解释为本地批次创建；客户 DTO 暴露既有逐媒体提交尝试的 ID、顺序、开始/结束、固定结果状态。供应商受理仅由 submittedAt 证明；原始请求、响应、凭据不进入 DTO。
- 企业问答/内容在本轮真实预约、已读取知识快照处写最小业务事件，沿用 agent_events 和 turn。应答逻辑通过既有状态请求返回原生工具/活动记录，不增加模型轮询。问题保存/用户确认明确为业务活动。
- 通用任务最终复制标识由服务端所属 turn 的公开结束状态判定；缺少历史生命周期时保留兼容规则。知识节点的全文、代码与右键复制共用 finalReplyIds，只有完成标识或已验证的服务器展示回执允许复制。
- WorkflowSection 增加 divider 选项，知识资料/词库/问题父组件关闭重复顶部线。发布白底在 App 外壳加载，因此包含认证、模块加载、错误重试和刷新。

## 已运行检查

- 160 项相关服务端测试通过（customer-ai-usage、frontmind-general-execution、frontmind-v2-chat-router、response-logic-api、siteops/service）。之后新增用量和应答逻辑测试，相关 36 项通过。
- 58 项相关客户端测试通过（ResponseLogicWorkspace、ProductionPublishingEntry、App）。保留原有 React act 提示，未导致失败。
- 最近一轮 27 项复制/节点真实组件渲染、项目偏好、逐媒体过程、共享分隔线客户端测试通过。
- 节点组件真实 Markdown 渲染断言：中间内容无任何复制按钮，已验证最终正文同时有全文和代码复制。
- knowledge-base-production-e2e 内存执行器补齐既有 SQL 关联能力；6 通过、7 原有条件跳过。该组是受控回归，不能替代 required MySQL 验收。

## 尚需集成验收

- MySQL required 模式正在按当前 CN 供应商及完整工作稿契约修复旧测试夹具。
- 多视口真实业务页面截图、十次浮窗收展的 1px 锚点检查、真实登录切页/异常联动及真实模型生成未在本记录中声称通过；由总任务最终验收报告单独记录。
