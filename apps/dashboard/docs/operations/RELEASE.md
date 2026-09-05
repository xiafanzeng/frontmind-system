# FrontMind 权威发布手册

> 本文是 Dashboard 与 Website 常规发布的唯一权威入口。旧的“35 个迁移”、
> 源提交 S/产物提交 F、服务器拉源码构建以及手工阶段状态文件流程均已废弃。

## 1. 发布模型

两个应用保持模块化单体和独立镜像，不因普通更新互相重建：

```text
main
  -> 类型/测试/治理门
  -> Dashboard 真实 MySQL 8.4.10 验收
  -> Buildx 构建完整 OCI 镜像
  -> GitHub OIDC + Cosign 签名精确 digest
  -> 固定服务的受限 SSH key
  -> 服务器校验 repo + digest + workflow identity
  -> Dashboard 先执行 release-db plan
  -> 仅重建目标 Compose service
  -> 本机与公网 /readyz 在 120 秒内通过
  -> 原子记录 current/previous；失败恢复 previous
```

- Dashboard：`ghcr.io/xiafanzeng/frontmind-dashboard@sha256:...`
- Website：`ghcr.io/xiafanzeng/frontmind-website@sha256:...`
- PDF base：`ghcr.io/xiafanzeng/frontmind-dashboard-pdf-runtime@sha256:...`
- tag 只用于发现候选，生产 Compose 和状态文件只接受 digest。
- `dist` 是 CI 镜像内产物，不再构成第二个 Git 提交或服务器输入。

### 1.1 工作区清洁门禁

每次发布必须把 Dashboard 与 Website 两个工作区中本次有意完成的修改全部提交到各自发布分支，
通过同仓 PR 后再合并；`main` 上最终的双亲 merge commit 是唯一 source SHA，不能把
“本地已完成但未提交”的文件留到下一次
发布。推送前和发布完成后都执行：

```bash
git -C /path/to/frontmind-dashboard status --porcelain
git -C /path/to/frontmind-website status --porcelain
```

两条命令都必须没有输出，Codex Desktop 中两个项目都应显示 `0 changes`。若仍有输出，
必须先判断它属于“本次应提交”“明确推迟并单独保存”还是“本地生成物”；不得在含义不明时
发布。`dist`、本地密钥、运行状态和临时构建产物必须由 `.gitignore` 排除，不能通过提交
生成物来伪造清洁状态。CI 始终从干净 checkout 构建，因此线上内容只可能来自已提交的
source SHA。

`GET /healthz` 只表示进程存活；`GET /readyz` 才表示可以接收生产流量。
Dashboard readiness 必须包含完整 migration journal，状态只有
`exact | pending | ahead | diverged`；当 ledger 为 `exact` 时还必须逐项核对完整
Schema contract，Schema 状态必须为 `exact`，否则运行服务拒绝就绪。

### 1.2 最快上线与 1Panel 边界

常规发布的操作入口只有“同仓 PR 合并到 `main`”这条路径，不需要登录 1Panel 或 SSH：

```text
Dashboard / Website 工作区 0 changes
-> 分别推送发布分支并完成同仓 PR CI
-> 以 --merge --match-head-commit 合并审阅过的 head
-> main push 的 prebuild gate 复核 PR、tree 与最新精确 run
-> 各自 CI 签名镜像 digest
-> 受限 SSH forced-command 调用固定服务 controller
-> /readyz 同时核对 source SHA 与 image digest
-> 成功原子更新 current / previous，失败自动回滚
```

1Panel 仅用于人工查看容器、日志、资源和反向代理，不是发布控制面。不应在
1Panel 内把 digest 改成可变 tag、手工点击重建、修改生产环境变量或运行 migration。
服务器的唯一发布事实来自 root-owned controller policy、精确 digest 和原子 state。

首次切换、事故核验或 contract 维护窗可由管理员直接 SSH 执行本文的 root
命令；这不代表恢复“服务器 `git pull` + 挂载源码”。SSH 上仍只验签、拉取和运行
CI 已生成的精确镜像；CI 未全绿时禁止绕过流水线从本地或服务器构建代替。

## 2. CI 行为

Dashboard 的 [dashboard-ci.yml](../../.github/workflows/dashboard-ci.yml) 在 PR
和 `main` 都执行类型检查、源码治理、migration append-only、Drizzle、单元测试
和 release-flow 测试。MySQL 8.4.10 matrix 并行验证：

1. 知识库状态机和事务约束；
2. 两套现有知识库生产 API 的真实 MySQL E2E；
3. PR 目标分支 journal 必须是当前 journal 的前缀，并从该前缀升级；若本次没有
   新 migration，则从“当前前一条 migration”升级；
4. 从 0044 历史 fixture 升级到当前完整 journal，并核验 API usage Schema；
5. 临时追加一条 `expand` migration，验证严格前缀、单次迁移、完整 postflight、
   `mysqldump` 校验、临时库恢复以及候选失败后的旧库恢复；
6. 密码、两套 Setup Token 与 Session 在真实 MySQL 上共同提交，并在触发器拒绝
   Session 撤销时全部共同回滚。

两条 migration upgrade Job 在完成迁移后还会把真实 MySQL
`information_schema` 与最新 Drizzle snapshot 生成的稳定 Schema contract 比较；
仅 ledger 数量正确但表结构漂移同样使 CI 失败。

PR 永远不会 push、签名或部署。合并后的 `main` 在任何应用构建、签名、SSH、数据库
controller、deployment marker 或激活步骤之前，必须先通过仓库内的 exact-PR prebuild
gate。gate 重新核对实际 checkout、双亲和完整 tree、同仓 PR、候选 trailers，以及该 PR
在本 workflow 上的精确成功 run 与 attempt 专属 merge-proof artifact。GitHub Actions API 的
`run.head_sha` 是 PR head，不是 test-merge；PR workflow 在全部必要测试成功后，从实际 checkout
写出严格 JSON，绑定 repository、workflow/run/attempt、PR/base/head 和 test-merge SHA/双亲/tree，
再上传为有限保留期的临时 artifact。gate 不依赖 PR 关闭后可能为空的 `run.pull_requests`，而是
下载唯一 artifact，复核 GitHub 元数据、ZIP 长度、SHA-256 digest 和严格内容。对同一 PR head
重复触发 workflow 时，只把 run ID 最新的精确 configured-workflow run 当作权威；旧 run 的
过期或重复 artifact 不再污染新 run。最终竞态检查会重新列举最新精确 run；若期间出现更新 run，
即使旧 run 成功也必须停止。最新 run 自身错误、未完成、失败、artifact 过期/重复/冲突，或
head/base/tree 移动仍失败关闭。

普通生产变更和 Dev 晋级都必须通过同仓 PR；待合并 head 必须已经包含当前 `main`，并统一使用
`gh pr merge --merge --match-head-commit <reviewed-head-sha>`。普通单亲 direct push、squash
或 rebase merge，以及双亲或 tree 与 PR 不匹配的 merge 都无法满足合同。

这套 gate 不依赖 GitHub Branch Protection、Rulesets 或 commit status，适用于当前私有仓
配置；它能阻止误操作和错误晋级，但信任边界仍包含仓库管理员：管理员既可修改
workflow/gate，也可能构造在 GitHub PR 元数据、双亲和完整 tree 上与正常 PR merge 等价的提交。
gate 依据可观察的 Git/GitHub 事实，不能把这样的受信任管理员行为与正常 merge 做密码学区分。
因此晋级前仍必须评审 gate diff，并由本地 exact-PR verifier 在 merge 前再次读取 head、base、
test-merge、workflow run 和 artifact，最终只允许 `--merge --match-head-commit` 合并。artifact
只是单次 run 的临时证明，不进入数据库、不提交 Git，也不构成永久晋级账本。

`push` 永远不能以历史发布结果绕过上述 PR artifact。Dashboard 的 `workflow_dispatch` 与
`repository_dispatch` 可以复用同一个仍为当前 `main` 的已激活 source：gate 在同一 configured
workflow 的 `push / workflow_dispatch / repository_dispatch` run 中选择最新一条真正完成且其
`Build, sign and deploy immutable image` job 成功的记录，并在返回前再次读取 current main、
该 run 与同一 attempt 的 job。pending、failed、cancelled、skipped、缺 job 或身份不符的 run
都不构成“已激活”，但也不会建立失败状态或阻止独立的完整 PR proof；没有合格成功记录时直接
回到最新精确 PR run + artifact 路径。只有成功激活证据可在旧 PR artifact 到期后支持同源恢复；
否则 artifact 缺失或到期仍失败关闭。整个恢复路径不新增数据库、账本或状态桥。

### 2.1 Knowledge Base Manus v2 同 digest 分阶段开关

Knowledge Base v2 writer 与 active legacy migration 是两个独立的生产运行期开关。新产品
镜像首次发布保持 `FRONTMIND_KB_MANUS_V2_WRITER=false`、
`FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION=false`。完成真实隔离 canary 后，才从 Actions
选择 `workflow_dispatch` 并提供当前生产 `/readyz` 所显示的精确 source SHA 与
`sha256:` digest：

- `dual-read`：writer=`false`，active migration=`false`；
- `canary`：writer=`true`，active migration=`false`；
- `migration`：writer=`true`，active migration=`true`；
- `pause`：writer=`true`，active migration=`false`；
- `complete`：writer=`true`，active migration=`false`，只允许从 `migration` 收口。

五个 phase 只调用固定 Dashboard capability。prebuild gate 必须先证明当前生产 source 是已
激活的同一 `main`，CI 随后独立验签 digest 与 OCI revision。服务器 controller 再以原子 state、
实际运行容器、只读 `release-db plan` 的 exact journal/schema，以及 local/public `/readyz`
作为 fence；只更新 root-owned `/etc/frontmind/dashboard.env` 并对同一 digest 执行
`--force-recreate`。成功不改变 state 的 current/previous digest，也不写数据库。

`pause` 是紧急停止新扫描，不是迁移完成证据。`complete` 调用前，workflow 与服务器 controller
分别要求当前 flags 为 true/true，并要求 public 及 local `/readyz` 的
`lastSweepInfrastructureStatus=ok`、`migrationConverged=true`、`activeLegacyTotal=0`、
`inFlightHandoffs=0`；任一字段 null、缺失或非零都拒绝收口。

开关变更前，controller 会持久写入旧 env 与严格绑定 source/digest/journal 的 recovery sentinel。
普通错误、TERM 或 INT 在退出时恢复；SIGKILL 或主机中断由下一次相同 rollout 调用先恢复旧值，
再决定是否执行新 phase。恢复尚未被 local/public readiness 同时证明时失败关闭并保留 sentinel，
不能越过。`pause`/`complete` 都不撤销已绑定 canonical task，但只有 `complete` 能证明迁移已收口。

首次安装 production-owned v7 controller 必须从已提交并通过聚焦 controller 测试的精确生产候选源码执行：

```bash
sudo deploy/production/update-release-controllers.sh --apply-version=7
```

updater 同时持有 Dashboard、Website 发布锁，原子替换 controller 与 forced command，验证版本、
生产路径与 phase allowlist；安装失败会恢复旧文件。它不修改服务 env、state、数据库或容器。
updater 必须直接从这份精确源码 checkout 执行，以便同时校验并安装相邻的两个模板；它不是常驻
发布入口，installer 不会把它复制到 `/usr/local/sbin`。
旧的 root-owned Dashboard service config 可以省略三个非敏感 rollout 路径，controller 会使用固定
生产默认值。首次执行 updater 前必须先把两个 Manus v2 flag 作为一对明确的 false/false 原子写入
root-owned runtime env；缺失、只出现一个、重复或非布尔值一律拒绝，避免半配置状态。

PDF runtime 仅在 `deploy/1panel-node-pdf/**`、其
[workflow](../../.github/workflows/pdf-runtime.yml)、revision gate 或晋级脚本变化
（或手工触发）时重建。它签名后以
repository dispatch 触发应用镜像，使应用始终引用已验签的 PDF 精确 digest；
普通 UI/服务端变更只解析并复用现有 `stable` 对应的已签名 digest。
所有可能移动 `stable` 的 PDF run 共用一个 main 并发通道；晋级和 dispatch 前均会从
GitHub Trees API 读取候选 SHA 与远端 `main` 的完整递归 tree，只规范比较
`deploy/1panel-node-pdf/**`、PDF workflow、revision gate 和晋级脚本的
`path/mode/type/blob SHA`。无关 main
提交不会误伤仍有效的基础镜像；只要 PDF 文件或 workflow 已被后续提交改变，旧 run 就只
保留其不可变构建/签名，不得移动 `stable` 或触发应用发布。Trees API 返回 truncated 时
失败关闭。规范 revision hash 同时写入晋级日志和 application dispatch payload。

Dashboard 不信任 dispatch payload 自报的 revision：先验签 PDF 精确 digest，再从该
digest 的镜像配置读取 `org.opencontainers.image.revision` 源 commit，用同一 Trees API
规则计算该 commit 与当前 `main` 的 PDF revision；只有两者一致、payload 为 64 位 hex
且等于计算值、digest 同时仍由 `released-current` 和 `stable` 指向时才构建应用镜像。
普通非 dispatch 发布解析 `stable` 后也执行“镜像源 commit PDF tree = 当前 main PDF
tree”检查，防止旧的合法签名 digest 被当作当前基础镜像复用。

服务器部署控制器成功返回后，CI 才在精确 digest 上写入一次性
`deployed-v1-<UTC>-run-<id>-attempt-<n>-sha256-<digest>` 标记，并移动
`deployed-current` / `deployed-previous` 两个回滚指针。标记自身携带 digest，若被复制到
另一 manifest，轮转器不会把它识别为成功部署。PDF runtime 在签名成功后采用独立的
`released-v1-*` 标记，并在这之后才移动 `stable`。

GHCR 每周按这些可信标记保留最近 10 个成功部署（PDF 为最近 10 个成功签名并晋级的基础
镜像），而不是按构建数量保留。轮转器额外保护 current/previous 和可识别的
Cosign `.sig`、attestation `.att` / `.sbom` 版本。由于 GitHub Packages API 不能可靠暴露
所有 OCI referrer 关系，也不能区分“构建失败”和“部署成功但写 marker 失败”，未知 tag、
untagged artifact 和未晋级构建均保守保留；物理版本数允许大于 10，但它们永远不会挤掉成功
版本。可信成功历史未达到 10 个前，轮转器失败关闭，不删除旧版本，避免误删启用新流程前的
current/previous。服务器只主动保留 current 与 previous。

## 3. GitHub 配置

两个仓库各只需要一个 Actions Secret：

| 仓库      | Secret                           | 内容                                       |
| --------- | -------------------------------- | ------------------------------------------ |
| Dashboard | `DASHBOARD_DEPLOY_SSH_KEY`       | 只绑定 Dashboard forced-command 的私钥     |
| Website   | `WEBSITE_DEPLOY_SSH_PRIVATE_KEY` | 只绑定 Website forced-command 的另一把私钥 |

生产主机 `149.88.85.148`、端口 `22`、用户 `frontmind-deploy` 和已人工核验的 ED25519
host key 都是公开发布策略，不是秘密；它们分别固定在 workflow 与
`.github/deploy/production_known_hosts` 中并进入代码评审。workflow 禁止运行时
`ssh-keyscan` 或关闭 host-key 校验，也不再依赖容易漂移的 Repository variables。

`GITHUB_TOKEN` 由 Actions 自动提供，用于 GHCR 和 OIDC，不新增长期 GHCR 写入或读取
令牌。自动发布时，workflow 只通过 SSH 标准输入发送两行
`github.actor + GITHUB_TOKEN`；SSH 原始命令仍只能包含
`<image@digest> <source-sha>`。服务器只为本次 `cosign verify + docker pull` 创建
root-only 的 `/run` 临时 Docker 配置，镜像拉取后立即删除，不把令牌写进命令参数、
Compose、容器环境、日志或长期 `/root/.docker/config.json`。Dashboard/Website 私钥必须
独立；服务器 `authorized_keys` 分别把它们固定到对应服务，无法选择或切换服务。

任何通过上述同仓 PR merge 进入 `main` 的提交，在 prebuild gate 与 CI 全绿后自动构建、签名
并发布，不再设置
`*_AUTO_DEPLOY_ENABLED` 开关或增加普通发布人工审批。服务器在 `state.json` 不存在时只开放
一次受限的“首次签名镜像接管”：仍从 stdin 使用本次 job 的
临时 GHCR 凭据，严格验证仓库、digest、Cosign workflow identity 与 OCI revision；随后
独立证明现有运行容器的 source SHA/digest 与本机/公网 readiness 自洽且健康。当前 source SHA
可以不同于签名候选；候选仍必须由 `main` workflow 签名且 OCI revision 等于请求 SHA。
Dashboard 还必须只读得到 `plan=exact` 且 `schema.status=exact`；`pending/ahead/diverged`
全部在备份、migration 或服务重建前阻断。Website 不调用任何数据库命令。

接管前 controller 会捕获现有容器的 image ID、原 image reference 与 readiness digest。
候选未通过 readiness 时，它在同一个总 deadline 内重建原运行镜像并再次核对本机/公网
identity；只有候选成功后才写首份 state，`previousDigest` 留空且结果记为
`initial-signed-takeover`。现有临时镜像不是经 GHCR digest 验签的回滚身份，因此只用于本次
接管失败时原地恢复，不写成长期 `previousDigest`；下一次成功发布会自然产生首个正式 previous。

## 4. 服务器首次安装边界

先安装 Docker Compose v2、Cosign、MySQL 8.4.10 client、`curl`、`flock`、`jq`、
`sudo`，再生成两把独立部署密钥。以仓库检出目录执行：

```bash
sudo deploy/production/install.sh \
  /root/dashboard-deploy.pub \
  /root/website-deploy.pub
```

安装器只执行以下一次性操作：

- 安装两个独立 Compose 到 `/opt/frontmind-deploy/dashboard` 和
  `/opt/frontmind-deploy/website`；
- 安装 root-owned controller、fixed-service forced-command、一次性 bootstrap-state
  和 contract 入口；
- 创建 `frontmind-deploy` 用户、持久目录和共享应用网络；
- 写入配置示例和两条独立 `authorized_keys` capability。

它不会启动应用、导入数据、执行 migration、修改 1Panel/OpenResty 或填入秘密。
`frontmind-deploy` 必须使用 `/bin/bash` 承载 sshd forced-command，但 `restrict`、固定
command、独立 key 和 sudoers 仍使其无法获得交互 Shell。Dashboard 持久目录固定
UID/GID `10001:10001`；Website 固定 `10002:10002`，两者不可混用。

安装器可以安全重跑：`dashboard-compose.env.example` 与
`website-compose.env.example` 会跟随仓库更新；已经存在的无 `.example` 正式文件只会
校正为 `root:root`、`0600`，其内容绝不被示例覆盖。若正式路径是符号链接或非普通文件，
安装器失败关闭，需管理员先调查。

管理员随后完成：

1. 直接编辑安装器首次生成的 `dashboard-compose.env` 与 `website-compose.env`；其余
   `/etc/frontmind-deploy/**/*.example`、`/etc/frontmind/*.example` 仅在正式文件尚不
   存在时复制为无 `.example` 的文件，绝不以新版 example 覆盖既有正式配置；所有正式
   文件保持 owner `root:root`、mode `0600`；
2. 核对 Dashboard 所在 MySQL external network；
3. 为应用、readiness、migrator、backup、restore 建立分离账户：应用只有业务 DML，
   readiness 只读 ledger/information_schema，migrator 只在一次性容器持有目标库
   DDL，backup 只读，restore 可重建目标库；
4. 首选首次切换也由受限 CI 自动接管，不需要 root 登录 GHCR；只有使用下文兼容的
   root-only `frontmind-bootstrap-state` 入口时，才按临时管理员凭据执行
   `docker login ghcr.io`，完成后立即 `docker logout ghcr.io`。所有普通自动发布只使用
   Actions 经 SSH stdin 传入的 job-scoped `GITHUB_TOKEN`，不依赖或回退到 root 长期登录；
5. Compose 由 controller 直接从上述两个服务器路径运行，1Panel 只观察运行结果；
   现有反向代理继续指向 `127.0.0.1:3001` 与 `127.0.0.1:8888`，不要再挂载源码或
   在服务器安装项目依赖；
6. 首次手工触发 PDF runtime workflow；
7. 首次切换前只读核验生产 ledger 是镜像 journal 的严格有序前缀，并导出原
   1Panel 配置；
8. 首选路径是让受限 CI forced-command 直接从当前健康运行态切换到本次签名 digest；
   controller 会自动执行上述双向 identity 核对、验签、exact DB plan、回退捕获和 readiness
   门，并在成功后建立首份 state。若签名 digest 已经由管理员使用新 Compose
   启动，则可在确认本机与公网 `/readyz` 都返回该 source SHA 和精确 image digest 后，
   由 root 使用一次性兼容入口登记：

   ```bash
   sudo /usr/local/sbin/frontmind-bootstrap-state \
     dashboard \
     ghcr.io/xiafanzeng/frontmind-dashboard@sha256:<64hex> \
     <40hex-source-sha>
   ```

   Website 独立执行同一命令并把 service/repository 换为 `website`。root 入口要求 state
   尚不存在，会再次验签、pull、核对 OCI revision label、当前 Compose container 的
   image ID，以及本机/公网 readiness 的 source SHA + digest；它只写 image env 和
   原子 state，不调用 release-db、backup、restore 或 migration，也不会凭空登记一个
   未运行过的 previous；

9. 再合并一个无数据库变更的候选。候选成功后，bootstrap 的基线 current 会自然
   旋转为 previous；立即核对 state 并演练按该 previous digest 回滚。bootstrap 不能
   重跑，已有 state 时必须失败关闭。

生产 controller policy 位于 `/etc/frontmind-deploy/services/*.env`。必须固定精确
GHCR repository、Cosign workflow identity、GitHub OIDC issuer、Compose 目录、
service、readiness URL，以及每服务独立 state/env/flock。readiness 身份必须同时匹配
source SHA 与精确 image digest；只匹配 SHA 不足以证明公网返回的是本次候选。

## 5. 普通更新（journal exact）

开发者只需完成同仓 PR 并按精确 head 合并到 `main`；不要直接推送 `main`。服务器依次完成
验签、pull、镜像 revision label 校验和
只读 `release-db plan --json`。若 ledger 状态为 `exact`，该命令继续只读验证 Schema，
只有 `schema.status=exact` 才允许发布；列、约束或引擎漂移会在重建容器前失败关闭。
`plan` 是事实观察接口，因此 ledger exact 但 Schema diverged 时仍返回完整 JSON 与零退出；
controller 必须显式判断两层状态。`postflight` 与 `migrate` 对同一漂移仍保持非零失败。
验证通过后：

- 不停止 Website；
- 不备份或写数据库；
- 不重建 PDF runtime；
- 只 `compose up -d --no-deps --force-recreate dashboard`；
- 候选最多等待 90 秒；普通发布复用同一个 120 秒总 deadline，在剩余时间内恢复
  previous。迁移发布若数据库恢复本身超过该 deadline 会保持停写并进入事故状态。

Website 流程没有 DB service，永远不会读取、备份或迁移数据库，也不会重建
Dashboard。

由 `frontmind-deploy` forced-command 发起的普通发布必须从 stdin 收到且只收到 GitHub actor
与 job-scoped token 两行；缺失、格式错误、多余输入或未关闭的输入都会在验签和 pull 前
失败。控制器不会读取持久 Docker 登录作为 fallback。root 直接执行的一次性 bootstrap、
contract 维护窗和事故确认仍保持独立的管理员入口，不复用自动发布 capability。

状态只写入 `/var/lib/frontmind-deploy/<service>/state.json`，包含
`currentDigest`、`previousDigest`、`sourceSha`、`journalHash`、`deployedAt` 和
`lastResult`。写入使用同目录临时文件后原子替换。

镜像内 `migration-manifest.json` 同时绑定两类事实：

- 每条 migration 的 `idx/tag/when/sqlSha256/classification` 与整体
  `journalHash`；
- 最新 `meta/NNNN_snapshot.json` 规范化得到的 `schemaContract` 与
  `schemaHash`。contract 覆盖全部应用表、列名/类型/可空/自增、默认值、
  `ON UPDATE`、生成列表达式及存储方式、字符集/排序规则继承关系、主键、声明索引
  （含访问方法）与唯一约束、外键及动作、CHECK 表达式及 enforcement，并要求所有表
  为 InnoDB；
  `__drizzle_migrations` 不作为应用表参与 Schema hash。MySQL 为外键隐式生成，且列序
  完全一致、名称严格等于外键名、首列名或 `首列名_数字` 的 BTREE 非唯一索引才会被
  规范化排除；任意文本前缀或列序不同的隐式索引不会被忽略，任何其他未声明索引仍视为
  漂移。历史显式索引名只在列序、唯一性和访问方法完整且唯一匹配时规范化；重复或
  任何语义差异仍是漂移。外键约束名不影响关系语义；只有在本地列、引用表/列、`ON UPDATE` 和
  `ON DELETE` 全部唯一匹配时，历史短名才规范化为 snapshot 名称；缺失、重复或任何
  语义不同仍视为漂移。字符字段必须继承表默认值、表必须继承数据库默认值；因此合法的 MySQL 数据库
  默认 collation 不会被误报，但单表或单列 charset/collation 漂移会阻断 readiness。

ledger 为 `pending` 时，plan 只判断严格前缀并把 Schema 标为 `not_checked`，因为旧版
Schema 本来就不等于候选终态；迁移完成后的 `postflight` 必须同时达到
`exact-ledger + exact-schema`。

同一 Dashboard 镜像提供稳定的机器接口：

```text
release-db plan --json
release-db migrate --release-id <id> --expected-applied-count <n> --expected-applied-journal-hash <sha256> --json
release-db postflight --json
```

后两个 `expected-applied-*` 参数由 controller 从第一次 plan、已验证备份和第二次 plan 的
同一前缀事实生成，人工日常发布不需要填写。`migrate` 在取得 MySQL advisory lock 后、执行任何
DDL 前再次核对它们；事实已变化时进入事故隔离，禁止拿旧备份覆盖外部变化。contract 维护窗只在
同一命令上额外增加 `--allow-contract`。

## 6. 新增 migration

已发布的 0000–0048 SQL、journal entry 和 snapshot 由
`config/migration-baseline-0048.json` 的规范摘要保护，任何修改、删除或重排都会
使 CI 失败。0049 及以后必须追加，并在 `drizzle/migration-policy.json` 登记：

```json
{
  "schemaVersion": 1,
  "historicalBaselineThrough": "0048_api_usage_coverage_claims",
  "migrations": {
    "0049_example": "expand"
  }
}
```

`expand` 允许新表、nullable 列、普通索引，以及带数字/字符串/boolean 兼容字面量
DEFAULT 的 NOT NULL 新列。DROP/RENAME、数据更新或删除、类型收窄、唯一约束、
现有表 FK、FULLTEXT/SPATIAL 索引、无兼容默认值的 NOT NULL 和表达式默认值均为
`contract`。每个 Drizzle statement breakpoint 只允许一条 SQL；CI 会解析引号与注释，
禁止用分号把第二条 contract 语句藏在允许的 CREATE/ADD 之后。

当 plan 为 `pending` 且全部是 `expand`，controller 才自动：

```text
停止 Dashboard 写入（停止单个 Dashboard 容器；Website 保持在线）
-> mysqldump + SHA-256
-> 临时库完整恢复并比较表数、ledger 数与完整 applied-journal hash
-> 再次只读 plan，要求 pending prefix 与备份前完全一致
-> 原子写入 in_progress releaseId/backupFile/attemptedDigest
-> 同一候选镜像持有 MySQL advisory lock并再次绑定 applied fact，执行一次 migrate
-> postflight exact-ledger + exact-schema
-> 启动候选镜像并等待 readiness
```

迁移命令非零或结果未知时绝不盲目重跑。controller 立即再次只读 plan：只有
`exact` 才继续；任何 `pending/ahead/diverged/unknown` 都从已验证备份恢复并回到
previous。服务器重启看到 `in_progress` 也只允许同一 digest 进入同样的对账流程。

`contract` 在备份或任何生产写入前自动阻断。唯一的内置例外是一次性的
`0065_siteops_alidns_oauth`：controller 必须同时匹配冻结的 journal、0064 applied
journal、0065 SQL、终态 Schema hash、计数、时间戳和唯一 pending 条目，才会按普通发布
停写、创建一次备份，并向同一候选镜像追加 `--allow-contract`。任何额外、缺失、重排或其他
contract 即使传入维护参数也继续拒绝；forced command 不暴露 0065 或 contract 开关。

精确 0065 在迁移前持久化 releaseId、备份与阶段；迁移容器必须匹配候选镜像、entrypoint、
完整参数和 controller labels 才能被终止或删除，同名外部容器会失败关闭。TERM/INT/HUP、
应用 readiness 失败或成功 state 提交失败都会先终止独立进程组，再恢复同一备份与 previous；
主机重启只读对账 exact 后只做 postflight 和 rollout，绝不重跑 migration。

其他 contract 仍必须先设计为 expand → 回填/验证 → contract 的独立后续发布，不属于普通入口：

```bash
sudo /usr/local/sbin/frontmind-contract-maintenance \
  ghcr.io/xiafanzeng/frontmind-dashboard@sha256:<64hex> \
  <40hex-source-sha>
```

该旧维护命令不再赋予 generic contract 权限；当前仅能在上述精确 0065 事实成立时复用同一
验签、停写、backup、状态、postflight、readiness 和回滚门。

## 7. 失败、回滚与事故处理

- 候选容器或公网 readiness 超时：停止候选，恢复 previous digest。
- migration 后候选失败：保持停写，校验备份 SHA，重建目标数据库、恢复备份，
  再恢复 previous 镜像。
- migration 结果未知且已经恢复备份，或备份后/锁内前缀事实被其他执行者改变：状态进入
  `quarantined`，自动 SSH 发布全部拒绝。前者在 previous 已验证就绪后恢复业务写入；后者不覆盖
  外部数据库事实并保持 Dashboard 停止。管理员完成事故核验后，才可由 root 对同一
  digest/source/release 显式执行：

  ```bash
  sudo /usr/local/sbin/frontmind-deploy-controller --acknowledge-incident \
    dashboard ghcr.io/xiafanzeng/frontmind-dashboard@sha256:<64hex> <40hex-source-sha>
  ```

  该命令本身不访问或修改数据库、不启动应用，只授权后续创建一条新的独立 attempt。

- restore 失败：controller 失败关闭且不恢复写入；保留 state、backup 和日志，
  进入人工事故处理，禁止删除 ledger 或重新跑 migration。
- `ahead/diverged`：在重建容器和数据库写入前阻断，先调查生产事实。
- 当前/上一版本以 state 中 digest 为准，不以 tag、Git 工作树或 1Panel UI 文本为准。

候选在 journal 阻断、普通 plan 失败，或候选失败且 previous 已恢复并通过 readiness
后，会从本机删除；正常服务器只保留 current/previous。若 migration 事实未知、数据库
restore 失败或 previous readiness 未恢复，则保留 `in_progress` 的 releaseId、
backupFile、候选镜像与日志作为事故事实。尤其是 `in_progress` 后第一次只读 plan
本身非零时，不得把状态改写成普通 failed；后续同一 digest 仍从只读 plan 对账开始，
`pending` 只会触发已验证备份恢复，绝不会被当成一条新 migration 再跑。
同理，ledger `exact` 但 `schema.status=diverged` 代表终态未被证明，也必须恢复记录中的
备份和 previous；只有 `exact-ledger + exact-schema` 才能继续候选 rollout。

备份只在 migration 前产生，成功后轮转保留最近 3 份；普通更新没有备份。Actions
日志、Cosign transparency record 和服务器 state 是自动审计事实，不再创建手工
`.attempted/.success` 发布档案。

0045 知识库专项只在首次只读 preflight 证明生产仍未完成时使用；完成后只作为
灾难恢复附录，不得回到常规发布主路径。

## 8. 使用 FrontMind Release Skill

Codex 已安装本机 Skill：

```text
/Users/fanzengxia/.codex/skills/frontmind-release
```

在 Dashboard、Website 或它们的父目录完成修改后，直接输入：

```text
使用 $frontmind-release 把当前 FrontMind 修改验证、提交并上线；expand 自动，删表/contract 先让我审核。
```

Skill 会检查两个仓库的实际 diff 和 migration journal，验证发生变化的仓库，推送发布分支、
创建同仓 PR，并用 `--merge --match-head-commit` 合并审阅过的精确 head；随后等待 merge SHA
对应的 prebuild gate、CI、签名镜像和自动部署，再核对本机/公网 readiness、原子
state 与回滚 digest。完成条件不是“已经 commit”，而是两个本地工作区都无 Changes、均与
`origin/main` 同步，且生产运行精确签名 digest。

普通代码/UI 和符合 policy 的 expand migration 不再询问日常审批；出现 DROP/RENAME、删表、
类型或 enum 缩窄、NOT NULL 收紧、数据删除、ahead/diverged、无法安全完成外部认证或其他
contract 风险时，Skill 必须在生产写操作前停下并说明需要的人工决定。1Panel 仅用于查看容器
和日志，不是发布操作入口。
