# 知识库上传证据生命周期

知识库最终 ZIP 会把客户上传原始字节封存在 Dashboard 本地资产目录。封存只用于校验、发布、下载和历史重放，不改变客户会话固定 30 天的闲置保留期。

## 唯一可递归清理范围

生命周期任务只允许递归删除以下严格目录：

```text
knowledge-builds/<userId>/<build UUID>/generation-<positive integer>/upload-evidence
```

该范围不包含同代次的 `official-logo.bin`、`knowledge-base.zip` 或 `operations/`。普通本地资源仍按单文件删除。路径必须是规范相对路径；绝对路径、反斜杠、`..`、额外后缀和用户不匹配都会失败。清理逐层拒绝祖先符号链接；若目标本身是符号链接，只移除链接，不跟随目标。

## 不变量

- **活跃 build 永不清理。** 每次目录删除都在数据库事务中锁定精确的 `userId + buildId + generation`。只要对应 `knowledge_base_builds` 行存在，无论状态为何，都保留证据目录。
- 缺失目录视为成功的幂等清理；重复 job 或重复扫描不会报错。
- 文件系统失败会保留 `knowledge_base_reset_cleanup_jobs` 并按现有失败次数/冷却策略重试。
- 账号删除后 cleanup job 会随用户外键删除，因此孤儿目录由周期扫描继续重试；扫描失败不会删除或改写数据库中的活跃构建。
- 周期孤儿扫描只删除 `mtime` 已超过 24 小时宽限期的严格目录。新目录记为 `deferredYoung` 并保留，避免“目录刚创建、build 行尚未可见”的极端提交窗口；显式 reset/retention cleanup job 不受该宽限影响。
- 每次孤儿扫描最多处理 50 个严格目录，并用游标跨批推进，避免稳定的活跃目录前缀饿死后续孤儿。

## 三条清理路径

### 1. 客户知识库 reset

批准 reset 的同一数据库事务会把每个 build 代次的 `upload-evidence` scope 写入现有 `knowledge_base_reset_cleanup_jobs`，随后删除 build。15 分钟维护任务处理 `local_asset` job；若 build 仍存在则失败关闭并保留 job，绝不删除目录。

### 2. 固定 30 天 conversation retention

会话超过固定 30 天闲置窗口时，retention 事务先锁定并 tombstone 对应 build，再为 Logo、最终 ZIP 和 `upload-evidence` scope 分别创建 cleanup job，最后删除 build 与会话。文件系统删除发生在事务提交后，失败由同一队列重试。

### 3. 用户永久删除

用户永久删除会通过外键删除 build 和其 cleanup job。每 15 分钟运行的 DB-aware orphan sweeper 只发现结构完全匹配且最后修改已超过 24 小时的 evidence scope，并在精确 build 行缺失的数据库锁内删除。这样无需保留已删除用户的队列外键，同时仍能回收异常退出或历史版本遗留目录。

## 调度与观察

生产运行时启动后立即执行一次 reset job + orphan sweep，之后沿用同一个 15 分钟定时器。扫描有工作或失败时记录 `KnowledgeBaseEvidence orphan_sweep_complete` 结构化计数：`scanned`、`removed`、`missing`、`active`、`deferredYoung`、`failed`、`truncated` 和 `nextCursor`。日志不包含证据正文或上传字节。

遇到持续失败时，应先检查数据库可用性、资产根目录权限和目录中是否存在非预期符号链接；不得手工递归删除整个 `knowledge-builds` 或用户目录。
