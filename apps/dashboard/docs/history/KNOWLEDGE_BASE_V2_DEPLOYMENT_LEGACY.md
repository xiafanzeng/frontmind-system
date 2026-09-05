# 知识库 v2 状态机增量上线与验收手册（历史归档原文）

> **不属于常规发布流程。** 只有只读 preflight 证明生产 0045 知识库状态机、
> inventory 或 v3 completion sentinel 尚未完成，或进行专项灾难恢复时才使用本文。
> 正常代码和新增 migration 发布必须遵循
> [`docs/operations/RELEASE.md`](../operations/RELEASE.md)，不得重新执行本手册的
> 一次性步骤。

版本：2026-08-01

本手册是 `DEPLOY_INCREMENTAL_WITH_DB_MIGRATION.md` 的知识库专项门禁。必须先按
该主手册完成干净发布 worktree、维护页、停写、数据库备份、快进和依赖安装；本次包含
`drizzle/0045_knowledge_base_state_machine.sql`，禁止使用无数据库迁移手册。

任何真实 API Key 都不得出现在 Git、命令历史、日志、截图、fixture、localStorage 或
数据库明文中。此前暴露过的测试 Key 必须在本次验收前吊销；新 Key 只通过 Dashboard
一次性输入或服务端 secret 注入。

## 1. 本地发布硬门

在干净发布 worktree 中执行：

```bash
cd /path/to/frontmind-dashboard

node scripts/package-socratic-kb-skill.mjs
pnpm check
pnpm test
FRONTMIND_RELEASE_STATE_MODEL=1 \
  pnpm vitest run server/knowledge-base-state-model.test.ts
git diff --check
git status --short
```

把上述源代码和测试变更提交为不可变源提交 `S`，确认整个工作区（包括旧 `dist/`）干净
后，再执行正式构建。`pnpm build` 会先验证全工作区干净，安全清空仓库内精确的 `dist/`，
从空目录重建并只生成一次全量产物 manifest：

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
FRONTMIND_BUILD_SHA="$SOURCE_SHA" \
BUILD_SHA="$SOURCE_SHA" \
GITHUB_SHA="$SOURCE_SHA" \
COMMIT_SHA="$SOURCE_SHA" \
pnpm build

ARTIFACT_ROOT="$(
  node -e 'process.stdout.write(require("./dist/artifact-manifest.json").rootSha256)'
)"
git add -A -- dist
git diff --cached --name-only | awk '!/^dist\// { bad=1 } END { exit bad }'
git commit -m 'build: approve Dashboard production artifact'
APPROVAL_SHA="$(git rev-parse HEAD)"

FRONTMIND_BUILD_SHA="$SOURCE_SHA" \
BUILD_SHA="$SOURCE_SHA" \
GITHUB_SHA="$APPROVAL_SHA" \
COMMIT_SHA="$APPROVAL_SHA" \
FRONTMIND_APPROVED_RELEASE_SHA="$APPROVAL_SHA" \
FRONTMIND_EXPECTED_ARTIFACT_ROOT_SHA256="$ARTIFACT_ROOT" \
pnpm audit:production

git diff --check
test -z "$(git status --short)"
```

`F` 必须不同于 `S`、必须是 `S` 的后代，并且 `S..F` 至少有一个且只能有 `dist/`
路径变化。普通 `audit:production` 只读验证，不会重写 manifest 或任何产物。

必须同时确认：

- 10,000 组模型化事件序列零失败。
- migration chain 包含 0045，且列、默认值、唯一索引、租约索引和外键断言通过。
- v4 Skill 的 canonical hash 覆盖 ZIP 内全部文件；历史别名 no-clobber。
- 生产 bundle 含当前 v4、canonical 历史别名和 legacy 兼容归档。
- `.frontmind-dashboard-assets/`、API 响应、Key 和本地验收资料均未进入 Git。
- 附件预约清单包含有序 SHA-256；服务端重新读取已上传对象并核对实际字节后才允许
  stage，不能只凭文件名、大小或修改时间恢复。
- 上游 400/401/403/413/422 和 2xx 缺 taskId 必须一次性收敛为可重试失败；
  408/429/5xx 与网络结果未知才保留原幂等 reservation 继续恢复。
- 客户端声明的 `serverOwned` 不得获得持久化或删除保护；后续轮无 operationId/turnId
  的迟到图片只能 stale/noop。
- 源提交完成后再构建并单独提交 `dist/`，生产服务器不执行构建或测试。

上述任一项失败都停止发布。

## 2. 生产变量与单实例职责

在 1Panel 服务端环境中配置，不把值写入仓库：

```text
FRONTMIND_DASHBOARD_ASSET_DIR=/var/lib/frontmind/dashboard-assets
FRONTMIND_KB_V4_ROLLOUT_PERCENT=0
FRONTMIND_KB_V4_ALLOW_USER_IDS=<内部验收账号数字 ID>
FRONTMIND_APPROVED_RELEASE_SHA=<dist-only 批准提交 F>
FRONTMIND_EXPECTED_ARTIFACT_ROOT_SHA256=<构建输出的 64 位 root SHA-256>
```

生产服务器只消费 `F` 中已提交、已审计的 `dist/`，不得在服务器重新执行构建。容器内
`/app/dist` 应以只读挂载或只读镜像层提供；启动时强制按 manifest 逐字节重算，后续
`/healthz`、`/readyz` 共享 single-flight 完整校验并使用五秒短缓存。TTL 后的首次请求会
重新核验；任何缺失、增加或篡改最迟在该窗口后返回失败，同时避免高频健康检查放大 I/O。

生产未显式配置 rollout 百分比时，新知识库构建默认关闭；已有 build 仍能继续。内部验收
通过后依次设置为 10、50、100。分桶按账号稳定，命中账号的新 build 只使用 v4，不会
创建新的 v3 build。

定时恢复只运行带数据库租约的 turn worker。停服回填脚本中的 legacy 全量读取只执行
一次，不得作为多实例定时任务运行。

主手册识别到精确文件 `drizzle/0045_knowledge_base_state_machine.sql` 后，必须已经把
`KB_V2_REQUIRED=YES` 写入发布状态，并将以下九项初始化为 `NO`。任何键缺失、提前为
`YES` 或被写成 `NOT_REQUIRED` 都必须停止，不得从旧发布状态复制：

```bash
source /root/frontmind-release-current.env
[ "$KB_V2_REQUIRED" = YES ]
for key in KB_ASSET_BACKUP_VERIFIED KB_0045_SCHEMA_VERIFIED \
  KB_MYSQL_ACCEPTANCE_COMPLETED KB_MYSQL_E2E_ACCEPTANCE_COMPLETED \
  KB_V2_BACKFILL_COMPLETED \
  KB_V2_REBIND_FINALIZED \
  KB_REAL_API_ACCEPTED KB_8_LEAF_ACCEPTED \
  KB_ASSET_MOUNT_POSTSTART_VERIFIED; do
  [ "${!key:-}" = NO ]
done
echo 'KB-V2-GATES-INITIALIZED'
```

## 3. 持久卷门与备份

在停写、停服务且数据库备份完成后，确认 Dashboard 的宿主机目录和容器挂载。
`KB_ASSET_EXPECTED_HOST_DIR` 必须是操作员从当前 1Panel bind mount 配置核对过的精确
宿主机绝对路径；`KB_ASSET_CONTAINER_DIR` 必须与容器环境变量完全一致。容器此时已经
停止，**禁止运行 `docker exec` 或 `docker compose exec`**；下面只在宿主机运行
`docker inspect` 和文件工具。

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$SERVICES_STOPPED" = YES ]
[ "$BACKUP_VERIFIED" = YES ]
[ "$KB_ASSET_BACKUP_VERIFIED" = NO ]
[[ "$KB_ASSET_EXPECTED_HOST_DIR" = /* ]]
[[ "$KB_ASSET_CONTAINER_DIR" = /* ]]

CONTAINER_IDS="$(docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" ps -a -q node)"
[ "$(printf '%s\n' "$CONTAINER_IDS" | awk 'NF { n++ } END { print n + 0 }')" -eq 1 ]
DASH_CONTAINER_ID="$(printf '%s\n' "$CONTAINER_IDS" | awk 'NF { print; exit }')"
[ "$(docker inspect --format '{{.State.Running}}' "$DASH_CONTAINER_ID")" = false ]

MOUNT_ROWS="$(docker inspect --format \
  '{{range .Mounts}}{{printf "%s\t%s\t%t\n" .Source .Destination .RW}}{{end}}' \
  "$DASH_CONTAINER_ID")"
MOUNT_RECORD="$(printf '%s\n' "$MOUNT_ROWS" | awk -F '\t' \
  -v destination="$KB_ASSET_CONTAINER_DIR" '$2 == destination')"
[ "$(printf '%s\n' "$MOUNT_RECORD" | awk 'NF { n++ } END { print n + 0 }')" -eq 1 ]
IFS=$'\t' read -r INSPECTED_SOURCE INSPECTED_DESTINATION INSPECTED_RW \
  <<< "$MOUNT_RECORD"
[ "$INSPECTED_SOURCE" = "$KB_ASSET_EXPECTED_HOST_DIR" ]
[ "$INSPECTED_DESTINATION" = "$KB_ASSET_CONTAINER_DIR" ]
[ "$INSPECTED_RW" = true ]

CONFIGURED_ASSET_ROWS="$(docker inspect --format \
  '{{range .Config.Env}}{{println .}}{{end}}' "$DASH_CONTAINER_ID" | \
  sed -n 's/^FRONTMIND_DASHBOARD_ASSET_DIR=//p')"
[ "$(printf '%s\n' "$CONFIGURED_ASSET_ROWS" | awk 'NF { n++ } END { print n + 0 }')" -eq 1 ]
[ "$CONFIGURED_ASSET_ROWS" = "$KB_ASSET_CONTAINER_DIR" ]

ASSET_DIR="$INSPECTED_SOURCE"
ASSET_PARENT="$(dirname -- "$ASSET_DIR")"
ASSET_BASENAME="$(basename -- "$ASSET_DIR")"
ASSET_BACKUP="/root/frontmind-dashboard-assets-${RELEASE_ID}.tar"
ASSET_BACKUP_SHA256="${ASSET_BACKUP}.sha256"

test -d "$ASSET_DIR"
test -w "$ASSET_DIR"
test ! -e "$ASSET_BACKUP"
test ! -e "$ASSET_BACKUP_SHA256"
AVAILABLE_KB="$(df -Pk "$ASSET_DIR" | awk 'NR==2 {print $4}')"
[ "${AVAILABLE_KB:-0}" -ge 1048576 ]

PROBE="$(mktemp "$ASSET_DIR/.frontmind-kb-probe.XXXXXX")"
printf 'frontmind-kb-volume-probe' > "$PROBE"
grep -Fqx 'frontmind-kb-volume-probe' "$PROBE"
rm -f -- "$PROBE"
test ! -e "$PROBE"

tar -cpf "$ASSET_BACKUP" -C "$ASSET_PARENT" "$ASSET_BASENAME"
test -s "$ASSET_BACKUP"
sha256sum "$ASSET_BACKUP" > "$ASSET_BACKUP_SHA256"
sha256sum -c "$ASSET_BACKUP_SHA256"
{
  printf 'KB_ASSET_BACKUP=%q\n' "$ASSET_BACKUP"
  printf 'KB_ASSET_BACKUP_SHA256=%q\n' "$ASSET_BACKUP_SHA256"
  printf 'KB_ASSET_BACKUP_VERIFIED_AT=%q\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'KB_ASSET_BACKUP_VERIFIED=%q\n' YES
} >> "$STATE_FILE"
echo 'KB-ASSET-VOLUME-BACKED-UP'
BASH
```

多实例必须挂载同一个 RW volume。不得使用容器临时层，也不得在未备份 artifact volume
时只备份数据库。

## 4. 0045–0048 migration 前后校验

主手册必须先对批准 journal 与生产 `__drizzle_migrations` 做全量比对：迁移前生产
账本只能是批准 journal 的严格有序前缀，迁移后必须逐项 hash、created_at、顺序和总数
完全一致。不能只检查“最后时间小于 0045”或只按 Git diff 判断待执行 migration。

在执行 migration 前，先用本次批准源中的校验器检查 0046–0048。它会同时验证
全 migration 账本前缀、已应用对象的精确列/默认值/索引/外键，以及未应用 migration
没有留下任何列、表或索引；发现半迁移必须恢复本轮已验证的完整数据库备份：

```bash
source /root/frontmind-release-current.env
[ "$MIGRATION_COMPLETED" = NO ]
[ "$API_USAGE_0046_0048_SCHEMA_VERIFIED" = NO ]
docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  --entrypoint sh node \
  -lc 'cd /app && node scripts/verify-api-usage-migration-schema.mjs pre'
```

`pnpm db:migrate` 成功后、创建 migration success 标记和启动应用前，必须再次运行
postflight。postflight 要求账本与批准 journal 完全一致，并精确验证 0046–0048：

```bash
source /root/frontmind-release-current.env
docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  --entrypoint sh node \
  -lc 'cd /app && node scripts/verify-api-usage-migration-schema.mjs post'
```

必须看到 `API_USAGE_0046_0048_SCHEMA_OK`，并由主手册原子写回
`API_USAGE_0046_0048_SCHEMA_VERIFIED=YES`。该状态不是人工可跳过项。

### 4.0 0045 状态机 schema 校验

执行主手册 migration 之前保存 preflight；该查询只输出计数，不输出客户数据：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$KB_ASSET_BACKUP_VERIFIED" = YES ]
[ "$MIGRATION_COMPLETED" = NO ]
[ "$KB_0045_SCHEMA_VERIFIED" = NO ]

docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  -e KB_0045_DB_STATE="$KB_0045_DB_STATE" \
  --entrypoint sh node -lc 'cd /app && node --input-type=module <<"NODE"
import mysql from "mysql2/promise";
const connection = await mysql.createConnection(process.env.DATABASE_URL);
try {
const expectedColumns = new Map([
  ["conversation_turns", new Set([
    "buildId", "buildGeneration", "operationKey", "operationType",
    "expectedRevision", "expectedLeafId", "requestHash",
    "upstreamIdempotencyKeyHash", "attachmentFileIds", "metadata",
    "leaseExpiresAt"
  ])],
  ["knowledge_base_build_nodes", new Set([
    "sourceTurnId", "presentationKey", "contentSha256"
  ])],
  ["knowledge_base_builds", new Set([
    "generation", "stateEpoch", "activeTurnId", "lastAppliedOperationKey",
    "recoveryLeaseOwnerHash", "recoveryLeaseExpiresAt",
    "currentPresentationKey", "logoStorageKey", "logoSha256", "logoBytes",
    "logoFilename", "logoMimeType", "packageStorageKey",
    "packageArchiveSha256", "packageSizeBytes", "protocolErrorCode"
  ])]
]);
const [columnRows] = await connection.query(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name IN (
    "conversation_turns", "knowledge_base_builds", "knowledge_base_build_nodes"
  )
`);
const presentColumns = columnRows.filter(row =>
  expectedColumns.get(row.table_name)?.has(row.column_name)
).length;
const [indexRows] = await connection.query(`
  SELECT DISTINCT table_name, index_name
  FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND index_name IN (
    "conversation_turns_operation_key_uq",
    "conversation_turns_build_generation_idx",
    "conversation_turns_lease_idx",
    "knowledge_base_build_nodes_source_turn_idx",
    "knowledge_base_builds_active_turn_idx",
    "knowledge_base_builds_recovery_lease_idx"
  )
`);
const [foreignKeyRows] = await connection.query(`
  SELECT constraint_name
  FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = "conversation_turns"
    AND constraint_name =
      "conversation_turns_buildId_knowledge_base_builds_id_fk"
`);
const presentIndexes = indexRows.length;
const presentForeignKeys = foreignKeyRows.length;
console.log(
  `KB_V2_SCHEMA_OBJECTS_BEFORE=columns:${presentColumns},` +
  `indexes:${presentIndexes},foreignKeys:${presentForeignKeys}`
);
if (process.env.KB_0045_DB_STATE === "PENDING" &&
    (presentColumns !== 0 || presentIndexes !== 0 || presentForeignKeys !== 0)) {
  throw new Error("KB_0045_PARTIAL_SCHEMA_RESTORE_REQUIRED");
}
if (process.env.KB_0045_DB_STATE === "APPLIED" &&
    (presentColumns !== 30 || presentIndexes !== 6 || presentForeignKeys !== 1)) {
  throw new Error("KB_0045_APPLIED_SCHEMA_INCOMPLETE");
}
} finally {
  await connection.end();
}
NODE'
BASH
```

然后严格按有迁移主手册执行一次 `pnpm db:migrate`，不得删除 attempt/success 标记后
重跑。MySQL 会逐条隐式提交 0045 的 DDL；任何一条失败都不允许在当前
数据库上续跑，必须完整恢复本轮刚验证的 `DATABASE_BACKUP`、重验账本，
并以新 `RELEASE_ID` 从头发布。成功后执行 postflight：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$KB_ASSET_BACKUP_VERIFIED" = YES ]
[ "$MIGRATION_COMPLETED" = YES ]
[ "$KB_0045_SCHEMA_VERIFIED" = NO ]

docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  -e KB_0045_EXPECTED_HASH="$KB_0045_EXPECTED_HASH" \
  -e KB_0045_EXPECTED_WHEN="$KB_0045_EXPECTED_WHEN" \
  --entrypoint sh node -lc 'cd /app && node --input-type=module <<"NODE"
import mysql from "mysql2/promise";
const connection = await mysql.createConnection(process.env.DATABASE_URL);
try {
  const [migrationRows] = await connection.execute(
    "SELECT hash, created_at AS createdAt FROM __drizzle_migrations WHERE hash = ? AND created_at = ?",
    [process.env.KB_0045_EXPECTED_HASH, Number(process.env.KB_0045_EXPECTED_WHEN)]
  );
  if (migrationRows.length !== 1) {
    throw new Error("KB migration ledger mismatch");
  }
  const [columns] = await connection.query(`
    SELECT table_name, column_name, column_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name IN (
        "conversation_turns",
        "knowledge_base_builds",
        "knowledge_base_build_nodes"
      )
  `);
  const expectedColumns = new Map([
    ["conversation_turns.buildId", ["varchar(36)", "YES", null]],
    ["conversation_turns.buildGeneration", ["int unsigned", "YES", null]],
    ["conversation_turns.operationKey", ["varchar(128)", "YES", null]],
    ["conversation_turns.operationType", ["varchar(32)", "YES", null]],
    ["conversation_turns.expectedRevision", ["int", "YES", null]],
    ["conversation_turns.expectedLeafId", ["varchar(191)", "YES", null]],
    ["conversation_turns.requestHash", ["varchar(64)", "YES", null]],
    ["conversation_turns.upstreamIdempotencyKeyHash", ["varchar(64)", "YES", null]],
    ["conversation_turns.attachmentFileIds", ["json", "NO", "[]"]],
    ["conversation_turns.metadata", ["json", "NO", "{}"]],
    ["conversation_turns.leaseExpiresAt", ["timestamp", "YES", null]],
    ["knowledge_base_build_nodes.sourceTurnId", ["varchar(36)", "YES", null]],
    ["knowledge_base_build_nodes.presentationKey", ["varchar(191)", "YES", null]],
    ["knowledge_base_build_nodes.contentSha256", ["varchar(64)", "YES", null]],
    ["knowledge_base_builds.generation", ["int unsigned", "NO", "1"]],
    ["knowledge_base_builds.stateEpoch", ["int unsigned", "NO", "0"]],
    ["knowledge_base_builds.activeTurnId", ["varchar(36)", "YES", null]],
    ["knowledge_base_builds.recoveryLeaseOwnerHash", ["varchar(64)", "YES", null]],
    ["knowledge_base_builds.recoveryLeaseExpiresAt", ["timestamp", "YES", null]],
    ["knowledge_base_builds.lastAppliedOperationKey", ["varchar(128)", "YES", null]],
    ["knowledge_base_builds.currentPresentationKey", ["varchar(191)", "YES", null]],
    ["knowledge_base_builds.logoStorageKey", ["varchar(1024)", "YES", null]],
    ["knowledge_base_builds.logoSha256", ["varchar(64)", "YES", null]],
    ["knowledge_base_builds.logoBytes", ["int unsigned", "YES", null]],
    ["knowledge_base_builds.logoFilename", ["varchar(512)", "YES", null]],
    ["knowledge_base_builds.logoMimeType", ["varchar(255)", "YES", null]],
    ["knowledge_base_builds.packageStorageKey", ["varchar(1024)", "YES", null]],
    ["knowledge_base_builds.packageArchiveSha256", ["varchar(64)", "YES", null]],
    ["knowledge_base_builds.packageSizeBytes", ["int unsigned", "YES", null]],
    ["knowledge_base_builds.protocolErrorCode", ["varchar(128)", "YES", null]],
  ]);
  const normalizeDefault = value => {
    if (value === null || value === undefined) return null;
    let normalized = String(value).trim();
    while (normalized.startsWith("(") && normalized.endsWith(")")) {
      normalized = normalized.slice(1, -1).trim();
    }
    normalized = normalized.replace(/^_utf8mb4/i, "");
    const singleQuote = String.fromCharCode(39);
    const doubleQuote = String.fromCharCode(34);
    if ((normalized.startsWith(singleQuote) && normalized.endsWith(singleQuote)) ||
        (normalized.startsWith(doubleQuote) && normalized.endsWith(doubleQuote))) {
      normalized = normalized.slice(1, -1);
    }
    return normalized;
  };
  const actualColumns = new Map(
    columns.map(row => [`${row.table_name}.${row.column_name}`, row])
  );
  for (const [key, [type, nullable, defaultValue]] of expectedColumns) {
    const row = actualColumns.get(key);
    if (!row || String(row.column_type).toLowerCase() !== type ||
        String(row.is_nullable).toUpperCase() !== nullable ||
        normalizeDefault(row.column_default) !== defaultValue) {
      throw new Error(`KB column mismatch: ${key}`);
    }
  }

  const [indexes] = await connection.query(`
    SELECT table_name, index_name, column_name, seq_in_index, non_unique
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND index_name IN (
        "conversation_turns_operation_key_uq",
        "conversation_turns_build_generation_idx",
        "conversation_turns_lease_idx",
        "knowledge_base_build_nodes_source_turn_idx",
        "knowledge_base_builds_active_turn_idx",
        "knowledge_base_builds_recovery_lease_idx"
      )
  `);
  const expectedIndexes = new Map([
    ["conversation_turns.conversation_turns_operation_key_uq", [0, "operationKey"]],
    ["conversation_turns.conversation_turns_build_generation_idx", [1, "buildId", "buildGeneration"]],
    ["conversation_turns.conversation_turns_lease_idx", [1, "status", "leaseExpiresAt"]],
    ["knowledge_base_build_nodes.knowledge_base_build_nodes_source_turn_idx", [1, "sourceTurnId"]],
    ["knowledge_base_builds.knowledge_base_builds_active_turn_idx", [1, "activeTurnId"]],
    ["knowledge_base_builds.knowledge_base_builds_recovery_lease_idx", [1, "status", "recoveryLeaseExpiresAt"]],
  ]);
  for (const [key, specification] of expectedIndexes) {
    const [nonUnique, ...names] = specification;
    const actual = indexes
      .filter(row => `${row.table_name}.${row.index_name}` === key)
      .sort((left, right) => Number(left.seq_in_index) - Number(right.seq_in_index));
    if (actual.length !== names.length ||
        actual.some((row, index) => row.column_name !== names[index]) ||
        actual.some(row => Number(row.non_unique) !== nonUnique)) {
      throw new Error(`KB index mismatch: ${key}`);
    }
  }

  const [foreignKeys] = await connection.query(`
    SELECT kcu.table_name, kcu.constraint_name, kcu.column_name,
           kcu.referenced_table_name, kcu.referenced_column_name,
           rc.delete_rule, rc.update_rule
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = kcu.constraint_schema
     AND rc.table_name = kcu.table_name
     AND rc.constraint_name = kcu.constraint_name
    WHERE kcu.constraint_schema = DATABASE()
      AND kcu.table_name = "conversation_turns"
      AND kcu.constraint_name =
        "conversation_turns_buildId_knowledge_base_builds_id_fk"
  `);
  if (foreignKeys.length !== 1 || foreignKeys[0].column_name !== "buildId" ||
      foreignKeys[0].referenced_table_name !== "knowledge_base_builds" ||
      foreignKeys[0].referenced_column_name !== "id" ||
      String(foreignKeys[0].delete_rule).toUpperCase() !== "SET NULL" ||
      String(foreignKeys[0].update_rule).toUpperCase() !== "NO ACTION") {
    throw new Error("KB foreign key mismatch");
  }
  console.log("KB_V2_SCHEMA_OK");
} finally {
  await connection.end();
}
NODE'

printf 'KB_0045_SCHEMA_VERIFIED_AT=%q\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE_FILE"
printf 'KB_0045_SCHEMA_VERIFIED=%q\n' YES >> "$STATE_FILE"
echo 'KB-0045-SCHEMA-VERIFIED-AND-RECORDED'
BASH
```

## 4.1 独立真实 MySQL 状态机验收

内存 executor 测试不能证明 MySQL 的唯一索引、`FOR UPDATE`、事务回滚和并发
租约语义。正式发布必须另外提供一个可丢弃数据库；数据库名称必须包含
`frontmind_kb_acceptance`。harness 不读取默认 `DATABASE_URL`、不创建或删除
数据库，也不执行 `DROP DATABASE`；它只对该专用库应用完整 migrations，写入随机
验收数据，并在结束时删除自己的用户级 fixture。

该验收直接使用生产 `reserveKnowledgeBaseStartBuild`、
`reserveKnowledgeBaseTurn` 和 `claimKnowledgeBaseTurnForRecovery`，覆盖双 start、
双标签 confirm、真实 operationKey unique index、旧 generation/乱序条件提交、并发
租约 claim 和事务原子回滚。先由 DBA 创建空的 disposable DB 和最小权限账号，再执行：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$KB_0045_SCHEMA_VERIFIED" = YES ]
[ "$KB_MYSQL_ACCEPTANCE_COMPLETED" = NO ]

LOG="/root/frontmind-kb-mysql-acceptance-${RELEASE_ID}.log"
ATTEMPT="/root/frontmind-kb-mysql-acceptance-${RELEASE_ID}.attempted"
SUCCESS="/root/frontmind-kb-mysql-acceptance-${RELEASE_ID}.success"
[ ! -e "$LOG" ]
[ ! -e "$ATTEMPT" ]
[ ! -e "$SUCCESS" ]
( set -o noclobber; : > "$ATTEMPT" )
chmod 600 "$ATTEMPT"

read -r -s -p \
  '输入独立 disposable MySQL URL（库名必须含 frontmind_kb_acceptance）: ' \
  FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL </dev/tty
printf '\n'
export FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL
cleanup_acceptance_secret() {
  unset FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL
}
trap cleanup_acceptance_secret EXIT

if ! docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  -e FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL \
  --entrypoint sh node \
  -lc 'unset DATABASE_URL; cd /app && pnpm test:kb:mysql-acceptance' \
  > "$LOG" 2>&1; then
  chmod 600 "$LOG"
  echo 'KB-MYSQL-ACCEPTANCE-FAILED；保持维护页；harness 不主动打印 URL，日志仍按敏感文件处理'
  exit 1
fi
cleanup_acceptance_secret
trap - EXIT

chmod 600 "$LOG"
grep -Fq 'KB_MYSQL_ACCEPTANCE_COMPLETE' "$LOG"
: > "$SUCCESS"
chmod 600 "$SUCCESS"
printf 'KB_MYSQL_ACCEPTANCE_LOG=%q\n' "$LOG" >> "$STATE_FILE"
printf 'KB_MYSQL_ACCEPTANCE_COMPLETED_AT=%q\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE_FILE"
printf 'KB_MYSQL_ACCEPTANCE_COMPLETED=%q\n' YES >> "$STATE_FILE"
echo 'KB-MYSQL-ACCEPTANCE-COMPLETED-AND-RECORDED'
BASH
```

普通 CI 未设置 `FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL` 时仅跳过真实 MySQL
suite；正式门使用 `pnpm test:kb:mysql-acceptance`，会额外设置 required flag，缺少
URL 或库名不符合白名单时必须非零退出。不得把 URL 写入源码、fixture、release env、
命令参数值或持久日志。

## 4.2 独立真实 MySQL 八叶生产闭环验收

基础状态机验收通过后，还必须使用**另一个最初为空**的 disposable 数据库执行完整
生产控制器闭环。不得复用 4.1 已经写入 migration 表和 fixture 的数据库。第二个库名
同样必须包含 `frontmind_kb_acceptance`；harness 会真实执行 start、八个叶子依次确认、
首轮唯一 Logo、后续零图片、最终 ZIP 校验、发布、Viewer 投影、下载 SHA-256 与解压，
并验证累计输出中的旧 ZIP 不会覆盖当前 operation。

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$KB_0045_SCHEMA_VERIFIED" = YES ]
[ "$KB_MYSQL_ACCEPTANCE_COMPLETED" = YES ]
[ "$KB_MYSQL_E2E_ACCEPTANCE_COMPLETED" = NO ]

LOG="/root/frontmind-kb-mysql-e2e-acceptance-${RELEASE_ID}.log"
ATTEMPT="/root/frontmind-kb-mysql-e2e-acceptance-${RELEASE_ID}.attempted"
SUCCESS="/root/frontmind-kb-mysql-e2e-acceptance-${RELEASE_ID}.success"
[ ! -e "$LOG" ]
[ ! -e "$ATTEMPT" ]
[ ! -e "$SUCCESS" ]
( set -o noclobber; : > "$ATTEMPT" )
chmod 600 "$ATTEMPT"

read -r -s -p \
  '输入第二个、最初为空的 disposable MySQL URL（库名必须含 frontmind_kb_acceptance）: ' \
  FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL </dev/tty
printf '\n'
export FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL
cleanup_acceptance_secret() {
  unset FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL
}
trap cleanup_acceptance_secret EXIT

if ! docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  -e FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL \
  --entrypoint sh node \
  -lc 'unset DATABASE_URL; cd /app && pnpm test:kb:mysql-e2e-acceptance' \
  > "$LOG" 2>&1; then
  chmod 600 "$LOG"
  echo 'KB-MYSQL-E2E-ACCEPTANCE-FAILED；保持维护页；日志按敏感文件处理'
  exit 1
fi
cleanup_acceptance_secret
trap - EXIT

chmod 600 "$LOG"
grep -Fq 'KB_MYSQL_E2E_ACCEPTANCE_COMPLETE' "$LOG"
: > "$SUCCESS"
chmod 600 "$SUCCESS"
printf 'KB_MYSQL_E2E_ACCEPTANCE_LOG=%q\n' "$LOG" >> "$STATE_FILE"
printf 'KB_MYSQL_E2E_ACCEPTANCE_COMPLETED_AT=%q\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE_FILE"
printf 'KB_MYSQL_E2E_ACCEPTANCE_COMPLETED=%q\n' YES >> "$STATE_FILE"
echo 'KB-MYSQL-E2E-ACCEPTANCE-COMPLETED-AND-RECORDED'
BASH
```

该门与 4.1 缺一不可：4.1 证明数据库锁、唯一索引和事务语义，4.2 证明生产 API、
状态投影、工件绑定、发布和下载使用的是同一套 MySQL 权威状态。两份成功日志必须分别
归档；任一库非空、URL 缺失、资源哈希不一致或最终标志缺失都停止发布。

## 5. 停服回填

先运行 dry-run，并把完整、无 secret 的 build disposition 保存到只读日志：

```bash
source /root/frontmind-release-current.env
KB_DRY_RUN="/root/frontmind-kb-v2-backfill-dry-${RELEASE_ID}.json"

docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  --entrypoint sh node \
  -lc 'cd /app && pnpm db:backfill-knowledge-base-v2' \
  > "$KB_DRY_RUN" 2>&1

test -s "$KB_DRY_RUN"
grep -Fq '"mode": "dry-run"' "$KB_DRY_RUN"
grep -Fq '知识库状态机回填预检完成' "$KB_DRY_RUN"
chmod 600 "$KB_DRY_RUN"
echo 'KB-BACKFILL-DRY-RUN-SAVED'
```

人工逐项审核：status × skillVersion × Logo × package 分桶、每个 build disposition、缺少
task/credential 的 rebind 数量，以及所有 `ready_to_publish` 缺失 package 的 ID。dry-run
会继续推演“清除可证明的 stale error”之后的动作，因此必须与 apply 预测一致。

`activeTurnNeedsSkill=true` 的 `researching`、`confirming` 或仍需继续请求上游的
`protocol_error` 若显示 `skillPinStatus=missing_hash/unresolvable`，必须停止：只能恢复该
build 绑定的精确历史 Skill 归档，或按维护流程结束旧 generation 后由用户重新启动；禁止
把当前 v4 hash 手工写给旧 build。已有 task 的 legacy reconcile、已冻结完整请求，以及
`PACKAGE_REBIND_REQUIRED`、`LEGACY_TASK_REBIND_REQUIRED`、
`LEGACY_CREDENTIAL_REBIND_REQUIRED` 都不会重新调用 Skill，因此不受此门阻断。

确认数据库和 artifact 备份可恢复后执行一次 apply：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
source /root/frontmind-release-current.env
[ "$KB_V2_REQUIRED" = YES ]
[ "$KB_ASSET_BACKUP_VERIFIED" = YES ]
[ "$KB_0045_SCHEMA_VERIFIED" = YES ]
[ "$KB_MYSQL_ACCEPTANCE_COMPLETED" = YES ]
[ "$KB_MYSQL_E2E_ACCEPTANCE_COMPLETED" = YES ]
[ "$KB_V2_BACKFILL_COMPLETED" = NO ]
LOG="/root/frontmind-kb-v2-backfill-${RELEASE_ID}.log"
ATTEMPT="/root/frontmind-kb-v2-backfill-${RELEASE_ID}.attempted"
SUCCESS="/root/frontmind-kb-v2-backfill-${RELEASE_ID}.success"
[ ! -e "$LOG" ]
[ ! -e "$ATTEMPT" ]
[ ! -e "$SUCCESS" ]
( set -o noclobber; : > "$ATTEMPT" )

if ! docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  --entrypoint sh node \
  -lc 'cd /app && pnpm db:backfill-knowledge-base-v2 -- --apply --inventory-reviewed --prepare-only' \
  > "$LOG" 2>&1; then
  tail -n 80 "$LOG"
  exit 1
fi
grep -Fxq 'KB_V2_BACKFILL_RECOVERY_COMPLETE' "$LOG"
: > "$SUCCESS"
printf 'KB_V2_BACKFILL_LOG=%q\n' "$LOG" >> \
  /root/frontmind-release-current.env
printf 'KB_V2_BACKFILL_COMPLETED=%q\n' YES >> \
  /root/frontmind-release-current.env
echo 'KB-V2-BACKFILL-COMPLETED-AND-RECORDED'
BASH
```

恢复阶段不会降级任何 ready build。`recovery.builds.packageRebindRequired`
专门记录缺凭据、上游不可读、输出无成品或 ZIP 校验失败的
`ready_to_publish` 历史构建；这些项不记入 generic `skipped/failed`，因此不会阻断
显式 rebind 收口。其他 researching/confirming 恢复的任何 `skipped/failed`
仍立即 fail-close。若日志中的 `pendingFinalization.rebindRequired` 大于零，
只能在逐 ID 核验上游 ZIP 确实无法恢复后，单独执行收口阶段：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
source /root/frontmind-release-current.env
[ "$KB_V2_BACKFILL_COMPLETED" = YES ]
[ "$KB_V2_REBIND_FINALIZED" = NO ]
LOG="/root/frontmind-kb-v2-rebind-finalize-${RELEASE_ID}.log"
ATTEMPT="/root/frontmind-kb-v2-rebind-finalize-${RELEASE_ID}.attempted"
SUCCESS="/root/frontmind-kb-v2-rebind-finalize-${RELEASE_ID}.success"
[ ! -e "$LOG" ]
[ ! -e "$ATTEMPT" ]
[ ! -e "$SUCCESS" ]
( set -o noclobber; : > "$ATTEMPT" )

if ! docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" run --rm --no-deps \
  --entrypoint sh node \
  -lc 'cd /app && pnpm db:backfill-knowledge-base-v2 -- --apply --inventory-reviewed --finalize-only --finalize-ready-rebind' \
  > "$LOG" 2>&1; then
  tail -n 80 "$LOG"
  exit 1
fi
grep -Fxq 'KB_V2_REBIND_FINALIZATION_COMPLETE' "$LOG"
: > "$SUCCESS"
printf 'KB_V2_REBIND_FINALIZED=%q\n' YES >> \
  /root/frontmind-release-current.env
echo 'KB-V2-REBIND-FINALIZATION-COMPLETED'
BASH
```

这会保留节点、消息和快照，但把仍无法固化的 build 标为明确的
`PACKAGE_REBIND_REQUIRED`。不得静默发布，也不得删除旧数据。若 pending 数为零，不执行
收口命令，但仍须人工核对 dry-run/apply 日志并执行下面的零项确认；0045 发布中的该门禁
最终必须是 `YES`，不得写 `NOT_REQUIRED`：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$KB_V2_BACKFILL_COMPLETED" = YES ]
[ "$KB_V2_REBIND_FINALIZED" = NO ]
read -r -p \
  '输入 KB-REBIND-ZERO-VERIFIED 确认 pending rebind 为零: ' \
  REBIND_CONFIRMATION </dev/tty
[ "$REBIND_CONFIRMATION" = KB-REBIND-ZERO-VERIFIED ]
printf 'KB_V2_REBIND_FINALIZED_AT=%q\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE_FILE"
printf 'KB_V2_REBIND_FINALIZED=%q\n' YES >> "$STATE_FILE"
echo 'KB-V2-REBIND-ZERO-VERIFIED-AND-RECORDED'
BASH
```

## 6. 启动与内部验收

先保持 `FRONTMIND_KB_V4_ROLLOUT_PERCENT=0`，仅 allowlist 内部账号。启动后 `/healthz`
必须同时确认数据库、0045 schema、artifact volume、Skill、租约恢复和 KB write gate
健康；任一项异常返回 503。

Dashboard 按主手册重建并通过 `/healthz` 后，先执行重建后持久卷门。此时容器必须正在
运行，因此允许 `docker compose exec` 只用于无敏感探针；仍以宿主机
`docker inspect` 的 Source/Destination/RW 为权威，并做双向读写删除：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$DASH_HEALTH_COMPLETED" = YES ]
[ "$KB_ASSET_MOUNT_POSTSTART_VERIFIED" = NO ]

CONTAINER_IDS="$(docker compose -p frontmind-dashboard \
  -f "$DASH_COMPOSE_FILE" ps -q node)"
[ "$(printf '%s\n' "$CONTAINER_IDS" | awk 'NF { n++ } END { print n + 0 }')" -eq 1 ]
DASH_CONTAINER_ID="$(printf '%s\n' "$CONTAINER_IDS" | awk 'NF { print; exit }')"
[ "$(docker inspect --format '{{.State.Running}}' "$DASH_CONTAINER_ID")" = true ]

MOUNT_ROWS="$(docker inspect --format \
  '{{range .Mounts}}{{printf "%s\t%s\t%t\n" .Source .Destination .RW}}{{end}}' \
  "$DASH_CONTAINER_ID")"
MOUNT_RECORD="$(printf '%s\n' "$MOUNT_ROWS" | awk -F '\t' \
  -v destination="$KB_ASSET_CONTAINER_DIR" '$2 == destination')"
[ "$(printf '%s\n' "$MOUNT_RECORD" | awk 'NF { n++ } END { print n + 0 }')" -eq 1 ]
IFS=$'\t' read -r INSPECTED_SOURCE INSPECTED_DESTINATION INSPECTED_RW \
  <<< "$MOUNT_RECORD"
[ "$INSPECTED_SOURCE" = "$KB_ASSET_EXPECTED_HOST_DIR" ]
[ "$INSPECTED_DESTINATION" = "$KB_ASSET_CONTAINER_DIR" ]
[ "$INSPECTED_RW" = true ]

CONFIGURED_ASSET_ROWS="$(docker inspect --format \
  '{{range .Config.Env}}{{println .}}{{end}}' "$DASH_CONTAINER_ID" | \
  sed -n 's/^FRONTMIND_DASHBOARD_ASSET_DIR=//p')"
[ "$(printf '%s\n' "$CONFIGURED_ASSET_ROWS" | awk 'NF { n++ } END { print n + 0 }')" -eq 1 ]
[ "$CONFIGURED_ASSET_ROWS" = "$KB_ASSET_CONTAINER_DIR" ]

HOST_PROBE_NAME=".frontmind-kb-host-${RELEASE_ID}"
CONTAINER_PROBE_NAME=".frontmind-kb-container-${RELEASE_ID}"
HOST_PROBE="$INSPECTED_SOURCE/$HOST_PROBE_NAME"
CONTAINER_PROBE="$INSPECTED_SOURCE/$CONTAINER_PROBE_NAME"
test ! -e "$HOST_PROBE"
test ! -e "$CONTAINER_PROBE"
trap 'rm -f -- "$HOST_PROBE" "$CONTAINER_PROBE"' EXIT
printf 'host-to-container-%s\n' "$RELEASE_ID" > "$HOST_PROBE"

docker compose -p frontmind-dashboard -f "$DASH_COMPOSE_FILE" \
  exec -T \
  -e KB_ASSET_CONTAINER_DIR="$KB_ASSET_CONTAINER_DIR" \
  -e KB_HOST_PROBE_NAME="$HOST_PROBE_NAME" \
  -e KB_CONTAINER_PROBE_NAME="$CONTAINER_PROBE_NAME" \
  -e KB_RELEASE_ID="$RELEASE_ID" node sh -se <<'INNER'
grep -Fqx "host-to-container-${KB_RELEASE_ID}" \
  "${KB_ASSET_CONTAINER_DIR}/${KB_HOST_PROBE_NAME}"
printf 'container-to-host-%s\n' "$KB_RELEASE_ID" > \
  "${KB_ASSET_CONTAINER_DIR}/${KB_CONTAINER_PROBE_NAME}"
INNER

grep -Fqx "container-to-host-${RELEASE_ID}" "$CONTAINER_PROBE"
rm -f -- "$HOST_PROBE" "$CONTAINER_PROBE"
test ! -e "$HOST_PROBE"
test ! -e "$CONTAINER_PROBE"
trap - EXIT
printf 'KB_ASSET_MOUNT_POSTSTART_VERIFIED_AT=%q\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE_FILE"
printf 'KB_ASSET_MOUNT_POSTSTART_VERIFIED=%q\n' YES >> "$STATE_FILE"
echo 'KB-ASSET-MOUNT-POSTSTART-VERIFIED-AND-RECORDED'
BASH
```

本地或内部验收入口：

```text
/preview/knowledge-base-live
```

该入口挂载实际 `ConversationProvider`、聊天区、coordinator、生产 controller、数据库与
同源 artifact API；`/preview/knowledge-base-upstream-probe` 只用于上游诊断，不能计入
上线验收。

使用吊销旧 Key 后的新测试 Key，经一次性输入启动“FrontMind超前智能”，完成：

1. 首轮 1.1 正文和唯一官方主 Logo 同时可见，Logo URL 为 Dashboard 鉴权同源地址。
2. 连续确认三次，严格显示 1.2、1.3、1.4；刷新、焦点切换、断网恢复和双标签同时确认
   不得重复、跳节点、闪回、空正文或产生 notice。
3. 1.2 以后网络面板中图片资源请求数恒为零。
4. 同一 `operationKey` 的上游任务创建数恒为一。
5. full/tail 重放、旧 task、旧 generation 和乱序输出只产生 noop，不产生
   `protocol_error`。
6. 用同一 controller/数据库、仅替换上游 adapter 的 8 叶确定性验收跑到最后一次确认，
   完成 ZIP 绑定、发布、Viewer、鉴权下载、SHA-256 复核和再次解包。
7. 附件断点恢复必须使用同一字节 SHA-256；同名、同大小、同修改时间但字节不同的文件
   必须在创建上游任务前被拒绝。
8. 注入一次确定性上游 422 和一次 `{ task: { status, output } }` 包装响应：前者只能出现
   一条可重试 notice 且不得无限 POST，后者必须正常显示批准正文并收敛状态。

验收记录只能保存 buildId、generation、turnId、taskId、stateEpoch、revision/leaf、结果
码和 artifact hash；禁止保存 API Key、完整正文或附件内容。

真实 API 三次确认通过后，必须由验收人输入精确人工标记；API 探针、自动化测试或
`/healthz` 均不能代替：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$KB_ASSET_MOUNT_POSTSTART_VERIFIED" = YES ]
[ "$KB_REAL_API_ACCEPTED" = NO ]
read -r -p \
  '输入 KB-REAL-API-ACCEPTED 确认真实 API 三次确认验收通过: ' \
  REAL_API_CONFIRMATION </dev/tty
[ "$REAL_API_CONFIRMATION" = KB-REAL-API-ACCEPTED ]
printf 'KB_REAL_API_ACCEPTED_AT=%q\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE_FILE"
printf 'KB_REAL_API_ACCEPTED=%q\n' YES >> "$STATE_FILE"
echo 'KB-REAL-API-ACCEPTANCE-RECORDED'
BASH
```

完整 8 叶、最终 ZIP、发布、Viewer、下载、SHA 和解包全部通过后，再由验收人输入第二个
精确人工标记：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
STATE_FILE='/root/frontmind-release-current.env'
source "$STATE_FILE"
[ "$KB_V2_REQUIRED" = YES ]
[ "$KB_REAL_API_ACCEPTED" = YES ]
[ "$KB_8_LEAF_ACCEPTED" = NO ]
read -r -p \
  '输入 KB-8-LEAF-ACCEPTED 确认完整 8 叶成品验收通过: ' \
  EIGHT_LEAF_CONFIRMATION </dev/tty
[ "$EIGHT_LEAF_CONFIRMATION" = KB-8-LEAF-ACCEPTED ]
printf 'KB_8_LEAF_ACCEPTED_AT=%q\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE_FILE"
printf 'KB_8_LEAF_ACCEPTED=%q\n' YES >> "$STATE_FILE"
echo 'KB-8-LEAF-ACCEPTANCE-RECORDED'
BASH
```

## 7. 灰度

只有内部真实三轮和完整 8 叶闭环都通过后才调整 rollout：

- 内部 allowlist：至少完成一轮真实三确认和一轮完整模拟。
- 10%：保持 24 小时。
- 50%：再保持 24 小时。
- 100%：前两阶段所有 P0 指标为零后执行。

每阶段监控：

- 同 build 多 active turn。
- settled 任务未收敛或 `awaiting_input` 无 approved presentation。
- operationKey 对应多个上游任务。
- stale/duplicate 导致的 protocol error。
- Logo/ZIP/数据库节点哈希不一致。
- 长时间无 presentation、过期租约、ready 持续时间和发布/下载失败。

任何 P0 立即将 `KNOWLEDGE_BASE_WRITES_DISABLED=1` 并重建所有 Dashboard 实例，保留
新 migration 和服务端权威数据。禁止恢复旧客户端 raw-output 投影。修复后先重新完成
内部门禁，再恢复灰度。

## 8. 回滚与归档

- migration 后应用失败：保持维护页。只有证明旧代码兼容 0045 才可短暂回旧代码；否则
  同时恢复数据库备份、artifact volume 备份和旧代码。
- 0045 任意 DDL 失败：保留全部 attempt/log，禁止删标记重跑或在半迁移库
  上续跑。只能完整恢复本轮已验证的 `DATABASE_BACKUP`，校验恢复后列和
  `__drizzle_migrations` 与 preflight 一致，归档失败发布后换新 `RELEASE_ID`。
- 回填 attempt 存在但 success 不存在：不得直接重跑；先检查日志、turn reservation、
  artifact hash 和数据库实际状态。所有回填操作都按 operationKey 幂等恢复。
- ready/published 数据不得由旧轮询改变。已发布快照保持不变。
- 发布成功后归档数据库备份名、artifact backup 与 SHA、migration/backfill
  attempt/success 日志、批准 SHA、灰度配置和验收记录。

写入主手册的业务验收成功之前必须执行最终机械门；任何缺失值、`NO` 或
`NOT_REQUIRED` 都会硬失败：

```bash
bash -se <<'BASH'
set -Eeuo pipefail
source /root/frontmind-release-current.env
[ "$KB_V2_REQUIRED" = YES ]
for key in KB_ASSET_BACKUP_VERIFIED KB_0045_SCHEMA_VERIFIED \
  KB_MYSQL_ACCEPTANCE_COMPLETED KB_MYSQL_E2E_ACCEPTANCE_COMPLETED \
  KB_V2_BACKFILL_COMPLETED \
  KB_V2_REBIND_FINALIZED \
  KB_REAL_API_ACCEPTED KB_8_LEAF_ACCEPTED \
  KB_ASSET_MOUNT_POSTSTART_VERIFIED; do
  [ "${!key:-}" = YES ]
done
[ -s "$KB_ASSET_BACKUP" ]
[ -s "$KB_ASSET_BACKUP_SHA256" ]
sha256sum -c "$KB_ASSET_BACKUP_SHA256"
[[ "$KB_ASSET_EXPECTED_HOST_DIR" = /* ]]
[[ "$KB_0045_EXPECTED_HASH" =~ ^[a-f0-9]{64}$ ]]
[[ "$KB_0045_EXPECTED_WHEN" =~ ^[0-9]+$ ]]

# 这个 v3 sentinel 位于 Dashboard 已验证的持久卷，是跨 RELEASE_ID
# 的完成事实。旧 v1/v2 文件不证明完整 MySQL 八叶闭环，保留但忽略；
# 新发布不得只因 ledger 已 APPLIED 就跳过回填/验收。
KB_V2_SENTINEL="$KB_ASSET_EXPECTED_HOST_DIR/.frontmind-kb-v2-0045-complete-v3"
verify_kb_v2_sentinel() {
  [ -f "$KB_V2_SENTINEL" ]
  [ ! -L "$KB_V2_SENTINEL" ]
  [ "$(stat -c '%u' "$KB_V2_SENTINEL")" = 0 ]
  [ "$(stat -c '%a' "$KB_V2_SENTINEL")" = 600 ]
  [ "$(wc -l < "$KB_V2_SENTINEL" | tr -d '[:space:]')" = 10 ]
  grep -Fxq 'FRONTMIND_KB_V2_COMPLETION_V3' "$KB_V2_SENTINEL"
  grep -Fxq "migrationHash=$KB_0045_EXPECTED_HASH" "$KB_V2_SENTINEL"
  grep -Fxq "migrationWhen=$KB_0045_EXPECTED_WHEN" "$KB_V2_SENTINEL"
  grep -Fxq 'schemaVerified=YES' "$KB_V2_SENTINEL"
  grep -Fxq 'mysqlStateMachineAccepted=YES' "$KB_V2_SENTINEL"
  grep -Fxq 'mysqlEightLeafE2eAccepted=YES' "$KB_V2_SENTINEL"
  grep -Fxq 'backfillCompleted=YES' "$KB_V2_SENTINEL"
  grep -Fxq 'rebindFinalized=YES' "$KB_V2_SENTINEL"
  grep -Fxq 'realApiAccepted=YES' "$KB_V2_SENTINEL"
  grep -Fxq 'eightLeafAndAssetMountAccepted=YES' "$KB_V2_SENTINEL"
}

if [ -e "$KB_V2_SENTINEL" ] || [ -L "$KB_V2_SENTINEL" ]; then
  verify_kb_v2_sentinel
else
  SENTINEL_TMP="$(mktemp \
    "$KB_ASSET_EXPECTED_HOST_DIR/.frontmind-kb-v2-complete.tmp.XXXXXX")"
  trap 'rm -f -- "$SENTINEL_TMP"' EXIT
  {
    printf 'FRONTMIND_KB_V2_COMPLETION_V3\n'
    printf 'migrationHash=%s\n' "$KB_0045_EXPECTED_HASH"
    printf 'migrationWhen=%s\n' "$KB_0045_EXPECTED_WHEN"
    printf 'schemaVerified=YES\n'
    printf 'mysqlStateMachineAccepted=YES\n'
    printf 'mysqlEightLeafE2eAccepted=YES\n'
    printf 'backfillCompleted=YES\n'
    printf 'rebindFinalized=YES\n'
    printf 'realApiAccepted=YES\n'
    printf 'eightLeafAndAssetMountAccepted=YES\n'
  } > "$SENTINEL_TMP"
  chmod 600 "$SENTINEL_TMP"
  chown 0:0 "$SENTINEL_TMP"
  ln "$SENTINEL_TMP" "$KB_V2_SENTINEL"
  rm -f -- "$SENTINEL_TMP"
  trap - EXIT
  verify_kb_v2_sentinel
fi
printf 'KB_V2_PERSISTED_COMPLETION=%q\n' YES >> \
  /root/frontmind-release-current.env
echo 'KB-V2-FINAL-GATE-PASSED'
BASH
```

只有以上门禁全部通过，才能在主发布状态中写入业务验收成功、归档成功并关闭维护流程。
