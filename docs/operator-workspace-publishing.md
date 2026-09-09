# 媒体发布的企业项目边界

操作员的稿件、DOCX 导入、图片、不可变稿件版本、草稿、预检和发布批次归属当前企业项目。媒体资源目录、Logo 和平台运行配置保持共享；账户余额、充值、支付回执及资金流水归属操作员账户，切换企业项目不会切换钱包。

`0065_publisher_enterprise_projects.sql` 为 12 张内容和任务表增加可空项目列及 11 个查询索引，将既有内容归入账号的默认企业项目，既有异步任务从其导入记录或发布条目回填。迁移保留原唯一索引、外键及全部历史金融数据。

服务器的项目上下文已核验操作员所有权。客户仓储查询在 `ownerId` 之外检查项目，覆盖列表、详情、稿件更新与冻结、草稿引用、图片上传和私有下载、批次及 CSV 导出。冻结、发布和对象租约的幂等键包含项目边界；同账号不同项目重复使用同一个客户端键不会串单，已有原始幂等键仍可在原项目内回放。

图片上传在写对象存储之前检查所属稿件。私有图片读取同时校验资产与稿件的一致归属。供应商读取已冻结图片仍使用不可猜测的能力凭证，不依赖浏览器当前项目；凭证校验还要求资产、冻结版本关联和稿件版本属于同一账户、同一项目和同一稿件。

异步 DOCX 导入读取提交时保存的项目，所有生成稿件、版本、图片及关联均显式沿用该项目，即使执行时存在另一个项目的请求上下文。发布后续轮询、对账任务继承原发布条目；工作线程发送供应商订单之前检查条目、批次和稿件版本的账户与项目一致性。全局资源目录任务显式保留空项目。

## 本地验收

`apps/dashboard/server/publisher-enterprise-mysql.test.ts` 使用已初始化的本地 operator acceptance MySQL 数据库，通过专用环境变量启用，不删除表、不调用供应商、不写真实媒体。首次运行会应用 0065；后续运行插入独立 UUID 的验收项目和数据。

```sh
cd apps/dashboard
FRONTMIND_PUBLISHER_PROJECT_TEST_MYSQL_URL=mysql://root@127.0.0.1:33077/fm_project_acceptance_operator_clean \
  pnpm exec vitest run --config vitest.node.config.ts \
  server/publisher-enterprise-mysql.test.ts server/monitoring-docx-offline.test.ts
```

验收覆盖跨项目读取与写入、版本和草稿引用、私有图片与 CSV 下载、上传前拒绝、同客户端键的项目隔离、切换项目后的后台导入、供应商图片能力凭证、共享钱包，以及异步发布来源不一致时在提交前拒绝。既有无供应商的 DOCX HTTP 上传与转换回归一并通过。

### 对话任务与发布幂等回归

本机已有 `mysqld`（MySQL 8.4）时，可运行以下命令。脚本只创建新的临时数据目录和随机回环端口，使用仓库迁移建立全新 acceptance 数据库，并生成合成账号；结束后关闭实例并删除自己创建的数据目录。它不连接生产数据库，不调用媒体供应商。

```sh
pnpm --filter frontmind-client exec tsx scripts/run-workbench-mysql-acceptance.ts
```

覆盖真实 InnoDB 行锁等待、并发旧版本拒绝、交接事务回滚、重复交接和丢响应重试、旧会话快照保留工作台元数据，以及稿件/投放草稿的版本和项目边界。`FRONTMIND_LOCAL_MYSQLD` 可指定已有的 `mysqld` 可执行文件。
