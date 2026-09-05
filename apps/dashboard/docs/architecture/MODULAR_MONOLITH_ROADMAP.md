# 模块化单体治理路线

FrontMind 第一阶段不拆微服务。发布、数据一致性和运行边界稳定之后，按领域逐步缩小巨型模块；
每次抽取都保持同进程、同事务和同一套鉴权，不引入网络调用或分布式一致性。

## 立即生效的护栏

- `pnpm check:governance` 禁止新增生产 `@ts-nocheck`。
- `server/dashboard-api.ts`、`server/knowledge-base-api.ts` 和
  `client/src/dashboard/UserBrandDashboard.tsx` 已冻结当前行数上限；允许缩小，不允许继续增长。
- 新功能必须进入领域模块；旧巨型路由只可删除代码或委托给抽出的模块。
- 每个 legacy fallback 必须登记在 `COMPATIBILITY_REGISTER.md`，新写入不得继续生成旧协议。

## 抽取顺序

1. **Dashboard API**：先按 account、service portal、delivery、monitoring、knowledge-base projection
   抽出 use-case service。路由层只保留鉴权、输入解析、调用和响应映射。
2. **Knowledge Base API**：把 upload/import、state transition、artifact、reset/recovery、read model
   分开；事务边界留在 use-case service，repository 不自行开启事务。
3. **UserBrandDashboard**：先抽 typed data hooks，再拆 table、dialog 和状态面板；页面只组合布局与
   URL 状态。清除最后一个生产 `@ts-nocheck` 后从 allowlist 删除。

每次抽取应满足：对外路由和 JSON contract 不变；权限与租户检查有回归测试；数据库事务覆盖不变；
原文件行数下降；没有新增兼容写入。建议每个 PR 只移动一个 use case，避免把重构与 Schema 变更放在
同一发布中。

## 首次切换后的安全收尾

- 两套账号 Setup 流程当前都会在同一事务消费全部 Setup Token 并撤销 Session；下一步统一为
  user-first 行锁顺序，或只对 MySQL deadlock 做有限次数的整事务重试，消除并发设置/重置密码时的
  偶发安全回滚错误。
- `passwordChangedAt` 防线已经拒绝更早创建的 Session，正常改密路径还会原子撤销全部 Session。
  首次切换稳定后，以独立 `contract` 维护窗把密码版本与 Session 创建时间提升为毫秒或微秒精度，
  不把该列修改混入发布架构切换。
- 真实 MySQL gate 已验证改密、两套 Token 和 Session 在末步失败时整体回滚；继续将 reset、两种
  Setup、deactivate 和 delete mutator 扩成表驱动验收，保持单元事务测试与真实引擎测试两层覆盖。

## 重新评估微服务的条件

只有某领域出现独立扩缩容、必须隔离的故障域、独立合规/数据边界或不同发布节奏，并且模块化单体中
已有稳定接口与观测数据时才评估拆分。代码文件大、团队人数增加或“看起来更现代”都不是拆分依据。
