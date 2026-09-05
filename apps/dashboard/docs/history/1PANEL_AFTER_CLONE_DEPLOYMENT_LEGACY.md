# FrontMind Dashboard + Website：1Panel 首次替换式生产部署（历史归档原文）

> **已废弃：不得用于新的增量发布。** 本文记录旧的首次部署和源码挂载流程，
> 其中“35 个迁移”、服务器安装依赖、源提交 S/产物提交 F 等约束不再是当前发布
> 契约。新的唯一权威入口是
> [`docs/operations/RELEASE.md`](../operations/RELEASE.md)。仅在调查历史主机时
> 参考本文，且不得复制其中命令到当前生产发布。

本文只记录 2026-07-28 已经实际跑通的首次生产部署路径，不保留试错命令、临时绕行方案
或互相竞争的部署方式。固定发布对象为：

| 项目                    | 最终值                                                                          |
| ----------------------- | ------------------------------------------------------------------------------- |
| Dashboard GitHub        | `xiafanzeng/frontmind-dashboard`（Private）                                     |
| Dashboard SHA           | `62810d58b4d892f4302f387849e4ff9e2116f489`                                      |
| Dashboard build version | `dashboard-20260728-r1`                                                         |
| Dashboard PDF image     | `frontmind-dashboard-node:22.22.2-pdf-62810d58b4d892f4302f387849e4ff9e2116f489` |
| Website GitHub          | `xiafanzeng/frontmind-website`                                                  |
| Website SHA             | `eefe6234b23351b066295c0941ca6cff5ce9ea69`                                      |
| 私有 Docker 网络        | `1panel-network`                                                                |

整体替换顺序：

```text
新版代码只进入新的 GitHub Private Repo：frontmind-dashboard
→ 使用全新的 frontmind_dashboard 空数据库和三套全新持久目录
→ 停止旧 Agent，释放并由 Dashboard 接管 3001
→ dashboard.frontmind.net 指向新 Dashboard
→ Website 通过 frontmind-dashboard:3001 调用内部接口
→ Dashboard 与 Website 验收通过
→ 建立同一恢复点备份并完成隔离恢复演练
→ 恢复正式流量并连续观察至少 24 小时
→ 永久删除旧 Agent 运行环境、域名、服务器资产和数据库
```

旧 GitHub `frontmind-agent` 仓库只作为历史仓库保留，不接收本次或后续 Dashboard
提交。旧 Agent 的数据库、用户数据、密钥和持久文件一律不迁移到新 Dashboard。切换时
只停止旧 Agent；新 Dashboard、Website、备份恢复演练和至少 24 小时稳定观察全部通过
后，才按本文精确目标清单永久删除旧生产资产。

本文所有命令默认在服务器私有 SSH 终端执行。每个新的 SSH 会话都必须重新定义该命令块
使用的变量；不得假设断线前的 shell 变量仍然存在。命令只输出固定状态、路径、版本和
非敏感标识，不得输出真实环境变量、API Key、数据库密码或 service token。
标记为 `bash` 的代码块必须在 Bash 中整块执行；如果当前 shell 不是 Bash，先进入
`bash`，不要逐行跨终端复制。

使用规则：

- 新环境首次部署按第 0–24 节顺序执行，上一节固定成功标记未出现时不进入下一节；
- SHA、image tag、build version、测试数量和迁移数量只适用于本文这次固定 release；
- 已上线环境不得重新执行建库、生成密钥、全量迁移或管理员初始化等一次性步骤；
- 以后发布新功能直接按第 23 节先判断变更类型，再只执行对应增量流程。

阶段导航：

| 阶段                 | 章节  | 完成结果                                                        |
| -------------------- | ----- | --------------------------------------------------------------- |
| 固定发布源           | 0–2   | 两个仓库均为已审核固定 SHA，工作树 clean                        |
| 准备新 Dashboard     | 3–9   | 旧资产清单、新库、新目录、运行环境、PDF 镜像和密钥就绪          |
| 验证并启动 Dashboard | 10–16 | check/test/build/audit、35 迁移、管理员、3001、HTTPS 和凭据就绪 |
| 验证并部署 Website   | 17    | Website 固定 release、8888、五个 Skill 和三条内部链路就绪       |
| 业务切换与退役       | 18–22 | canary、备份恢复、24 小时观察、旧 Agent 精确退役和回滚边界      |
| 日后维护             | 23–24 | 增量更新规则与最终完成清单                                      |

## 0. 一次性迁移到新的私有仓库

目标仓库必须是已经确认归属和可见性均正确的 Private 仓库：

```text
https://github.com/xiafanzeng/frontmind-dashboard.git
```

本地代码检查完成并提交后，在 GitHub Desktop 中把目标仓库明确设为
`xiafanzeng/frontmind-dashboard`。首次 push 前必须在界面中逐字核对 Owner、Repository
和 Remote URL；只允许向新仓库 push，禁止向旧 `frontmind-agent` 仓库 push。

确认新仓库已收到精确 release commit 后，关闭使用该目录的终端、GitHub Desktop 和
Codex 窗口，再把本地文件夹从 `frontmind-agent` 精确改名为：

```text
/path/to/frontmind-dashboard
```

在 GitHub Desktop 中重新定位/添加改名后的本地目录，并再次核对其远端仍是
`https://github.com/xiafanzeng/frontmind-dashboard.git`。旧 GitHub 仓库的分支、提交、
远端配置和 Private 属性不做任何修改。

本次操作完成后的固定状态是：

```text
/path/to/frontmind-dashboard
HEAD = 62810d58b4d892f4302f387849e4ff9e2116f489
```

后续阅读本文时不要再次执行本地文件夹改名，也不要重新创建 GitHub 仓库。

## 1. 固定部署参数

| 项目            | 生产值                                |
| --------------- | ------------------------------------- |
| 代码仓库        | `frontmind-dashboard`                 |
| 宿主机仓库目录  | `/frontmind-dashboard`                |
| 容器内工作目录  | `/app`                                |
| 1Panel 运行环境 | `FrontMind-Dashboard`                 |
| Docker 容器     | `frontmind-dashboard`                 |
| 私有容器 DNS    | `frontmind-dashboard`                 |
| 应用端口        | `3001`                                |
| 公开域名        | `https://dashboard.frontmind.net`     |
| Website 域名    | `https://www.frontmind.net`           |
| MySQL 私有 DNS  | `mysql`（本次生产网络已核验）         |
| MySQL 数据库    | `frontmind_dashboard`                 |
| MySQL 用户      | `frontmind_dashboard`                 |
| Node            | `22.22.2`                             |
| pnpm            | 仓库 `packageManager` 声明的 `10.4.1` |

生产环境的敏感配置只写入 1Panel 运行环境变量界面。不要在仓库目录或容器 `/app` 创建
`.env`、`.env.local` 或 `.env.production`，也不要执行 `cp .env.example .env`。

## 2. 发布前必须具备的代码

服务器只部署已经提交、推送并在干净克隆中验证过的精确 SHA。Dashboard 必须确认：

```bash
set -euo pipefail

EXPECTED_DASHBOARD_SHA='62810d58b4d892f4302f387849e4ff9e2116f489'

test "$(git -C /frontmind-dashboard branch --show-current)" = "main"
dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"
git -C /frontmind-dashboard fetch origin --prune
test "$(
  git -C /frontmind-dashboard rev-parse origin/main
)" = "$EXPECTED_DASHBOARD_SHA"
git -C /frontmind-dashboard merge \
  --ff-only \
  "$EXPECTED_DASHBOARD_SHA"
test "$(
  git -C /frontmind-dashboard rev-parse HEAD
)" = "$EXPECTED_DASHBOARD_SHA"
dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"
echo "DASHBOARD_FIXED_RELEASE_READY"
```

Website 必须确认：

```bash
set -euo pipefail

EXPECTED_WEBSITE_SHA='eefe6234b23351b066295c0941ca6cff5ce9ea69'

test "$(git -C /frontmind-website branch --show-current)" = "main"
website_status="$(
  git -C /frontmind-website status --short
)"
test -z "$website_status"
git -C /frontmind-website fetch origin --prune
test "$(
  git -C /frontmind-website rev-parse origin/main
)" = "$EXPECTED_WEBSITE_SHA"
git -C /frontmind-website merge \
  --ff-only \
  "$EXPECTED_WEBSITE_SHA"
test "$(
  git -C /frontmind-website rev-parse HEAD
)" = "$EXPECTED_WEBSITE_SHA"
website_status="$(
  git -C /frontmind-website status --short
)"
test -z "$website_status"
echo "WEBSITE_FIXED_RELEASE_READY"
```

两个仓库的 `git status --short` 都必须为空。发现服务器有未知修改时停止，不执行
`git reset --hard`、`git checkout`、`git clean` 或 `git stash`，也不在服务器修改
remote、commit 或 push。

Dashboard 还要确认现有 `.gitignore` 安全边界没有被删改：

```bash
set -euo pipefail
cd /frontmind-dashboard

test -f .gitignore
grep -Fx '.env' .gitignore >/dev/null
grep -Fx '.env.*' .gitignore >/dev/null
grep -Fx '!.env.example' .gitignore >/dev/null
grep -Fx '/logs/' .gitignore >/dev/null
grep -Fx '/screenshots/' .gitignore >/dev/null
grep -Fx '/api-responses/' .gitignore >/dev/null
grep -Fx '/.secrets/' .gitignore >/dev/null
grep -Fx '*.pem' .gitignore >/dev/null
grep -Fx '*.key' .gitignore >/dev/null

git check-ignore -q --no-index .env
git check-ignore -q --no-index .env.local
git check-ignore -q --no-index .env.production
git check-ignore -q --no-index screenshots/deploy.png
git check-ignore -q --no-index api-responses/probe.json

if git check-ignore -q --no-index .env.example; then
  echo "ENV_EXAMPLE_MUST_REMAIN_ALLOWED"
  exit 1
fi

echo "GITIGNORE_SECURITY_BOUNDARY_OK"
```

当前数据库版本必须包含：

```text
drizzle/0000_*.sql
…
drizzle/0034_known_scarlet_spider.sql
drizzle/meta/_journal.json（35 条记录）
```

当前生产包还必须包含三个运行时 Skill：

```text
private-workflows/socratic-kb-builder.skill
private-workflows/brand-question-portfolio.skill/
private-workflows/response-logic-builder.skill/
```

## 3. 切换前隔离旧 Agent，并登记精确退役目标

切换前旧 Agent 可以继续运行，但只能用于维持旧站点；不得再向其代码仓库、数据库或持久
目录导入 Dashboard 数据。新旧系统必须完全隔离：

1. 不向旧 `frontmind-agent` GitHub 仓库 push 本次新版提交。
2. 不把旧数据库或旧持久目录挂载给新 Dashboard。
3. 不复用旧 Agent 的凭据加密密钥、ICP 密钥、service token 或内部容器 DNS。
4. 不将旧客户数据复制、导入或同步到 `frontmind_dashboard`。
5. 在 Dashboard 启动前停止旧 Agent 并关闭其自动重启，使 `3001` 完全释放。

开始部署前，从 1Panel 和 DNS 控制台只读盘点并记录以下精确值：

| 退役对象            | 必须记录的精确标识                                             |
| ------------------- | -------------------------------------------------------------- |
| 旧运行环境          | 1Panel 运行环境名称、容器名称/ID                               |
| 旧网站              | `agent.frontmind.net` 对应的 1Panel 网站名称和配置目录         |
| 旧 DNS              | `agent.frontmind.net` 的记录类型、主机记录、记录值和记录 ID    |
| 旧服务器代码        | 规范化后的唯一绝对路径                                         |
| 旧数据库            | 数据库实例、精确数据库名                                       |
| 旧数据库用户        | 完整 `username@host` 主体和 `SHOW GRANTS` 结果                 |
| 旧 prepared-files   | 规范化后的唯一绝对路径或卷名                                   |
| 旧 dashboard-assets | 规范化后的唯一绝对路径或卷名                                   |
| 旧 ICP/其他持久数据 | 每一个规范化绝对路径或卷名，逐项记录                           |
| 旧备份/快照/导出    | 1Panel 任务 ID、快照 ID、规范化导出路径、远端对象及 version ID |
| 旧自动任务          | 备份、同步、清理和导出的精确计划任务 ID                        |
| 旧外部凭据          | 只记录提供方、用途和凭据 ID/名称，不记录或回显真实值           |

清单必须由两人复核，且明确排除 `/frontmind-dashboard`、
`/srv/frontmind-dashboard/prepared-files`、
`/srv/frontmind-dashboard/dashboard-assets` 和 `frontmind_dashboard`。任何旧目标不明确时，
停止退役，不猜测、不使用通配符。

## 4. 新建空数据库

在 `1Panel → 数据库 → MySQL` 新建：

```text
数据库：frontmind_dashboard
用户：frontmind_dashboard
字符集：utf8mb4
访问范围：仅本机/私有 Docker 网络
```

密码使用独立强随机值。写入 `DATABASE_URL` 时必须进行 URL 编码；例如密码中的 `@`、
`:`、`/`、`#`、`?`、`%` 不能原样放进 URI。

数据库不映射公网 `3306`。Dashboard 与 MySQL 必须加入同一个私有 Docker 网络。本次已
在生产私有网络核验 MySQL 服务 DNS 名为固定值 `mysql`，不能在 Dashboard 容器中使用
`127.0.0.1`。以后若迁移 MySQL 容器，必须先重新核验并同步修订固定参数和数据库目标门，
不能为通过检查而临时放宽。

## 5. 创建全新持久目录

在宿主机创建两个全新目录，并限制权限：

```bash
set -euo pipefail

install -d -m 700 /srv/frontmind-dashboard/prepared-files
install -d -m 700 /srv/frontmind-dashboard/dashboard-assets
```

在 1Panel 运行环境中挂载：

```text
/srv/frontmind-dashboard/prepared-files
→ /var/lib/frontmind/prepared-files

/srv/frontmind-dashboard/dashboard-assets
→ /var/lib/frontmind/dashboard-assets
```

这里的 `→` 只表示“左侧宿主机目录映射到右侧容器目录”，不是 Shell 命令。请在 1Panel
运行环境的“挂载”页逐行添加这两组映射。

## 6. 创建 FrontMind-Dashboard 运行环境

在 `1Panel → 网站 → 运行环境 → Node.js` 新建：

```text
名称：FrontMind-Dashboard
容器名称：frontmind-dashboard
宿主机代码目录：/frontmind-dashboard
容器内工作目录：/app
Node：22.22.2
端口：3001
初始启动命令：sleep infinity
自动重启：迁移完成前关闭
```

不同 1Panel 版本对“代码目录/运行目录”的字段命名不同：宿主机仓库应挂载到容器
`/app`，后文所有容器命令都以 `/app` 为准。创建后运行
`docker exec frontmind-dashboard sh -lc 'test "$(pwd)" = "/app"; ls -la /app/package.json'`；
若实际挂载点不同，必须先统一运行目录与三个 Skill 绝对路径，不能混用
`/frontmind-dashboard` 和 `/app`。

先用 `sleep infinity` 只为了让容器存在，以便完成依赖、构建、迁移和管理员初始化；
正式启动命令稍后改为 `pnpm start`。

准备阶段不要给新容器发布宿主机 `3001`。如果当前 1Panel 版本创建运行环境时必须立即
绑定宿主机端口，则先执行第 13 节的旧 Agent 停止与端口释放步骤，再创建
`FrontMind-Dashboard`；旧 Agent 与 Dashboard 绝不能同时绑定 `3001`，也不能把 Dashboard
临时改到其他生产端口。

运行环境需要加入：

- MySQL 所在私有网络；
- Website 所在私有网络；
- 私有 DNS alias `frontmind-dashboard`。

不要把 `3001` 直接开放到公网；公开流量只经过 80/443 和 OpenResty。

## 7. 永久安装 PDF 运行依赖

生产检查已确认当前 `1panel/node:22.22.2`（Debian 12）不包含任何所需 PDF 命令。
仓库提供固定派生镜像定义：

```text
deploy/1panel-node-pdf/Dockerfile
```

它固定使用生产服务器实际核验的完整基础镜像 digest，并永久安装：

```text
poppler-utils
ghostscript
```

Docker 构建上下文由同目录 `.dockerignore` 限制为 Dockerfile 本身，不能把代码、环境
文件、Key 或 token 传入镜像构建。Dockerfile 也不得通过 `ARG`、`ENV`、`LABEL` 或
`COPY` 写入任何敏感值。

先确认服务器代码为已审核 release，且基础镜像仍为文档记录的精确对象：

```bash
set -euo pipefail

docker inspect frontmind-dashboard \
  --format 'configured_image={{.Config.Image}} image_id={{.Image}}'

docker image inspect 1panel/node:22.22.2 \
  --format 'user={{json .Config.User}} repo_digests={{json .RepoDigests}}'
```

预期基础镜像为 `1panel/node:22.22.2`，RepoDigest 包含：

```text
1panel/node@sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28
```

`user` 必须是 `""` 或 `"root"`。任一结果不同都先停，不覆盖 Dockerfile 中的 digest。

构建固定派生镜像：

```bash
set -euo pipefail

cd /frontmind-dashboard

DASHBOARD_RELEASE_SHA="$(git -C /frontmind-dashboard rev-parse HEAD)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"
test -n "$DASHBOARD_PDF_IMAGE"
test -f deploy/1panel-node-pdf/Dockerfile
test -f scripts/validate-production-runtime.mjs

docker build \
  --pull=false \
  --build-arg VCS_REF="$DASHBOARD_RELEASE_SHA" \
  --build-arg IMAGE_VERSION='dashboard-20260728-r1-pdf2' \
  --tag "$DASHBOARD_PDF_IMAGE" \
  --file /frontmind-dashboard/deploy/1panel-node-pdf/Dockerfile \
  /frontmind-dashboard/deploy/1panel-node-pdf
```

构建日志最后必须看到五个 `command -v` 均成功。检查镜像审计标签，防止同名旧镜像被
误用：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"

test "$(
  docker image inspect "$DASHBOARD_PDF_IMAGE" \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
)" = "$DASHBOARD_RELEASE_SHA"

test "$(
  docker image inspect "$DASHBOARD_PDF_IMAGE" \
    --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
)" = "dashboard-20260728-r1-pdf2"

docker image inspect "$DASHBOARD_PDF_IMAGE" \
  --format 'image_id={{.Id}}'
```

随后直接从新镜像验证并记录本次实际安装的软件包版本：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"

docker run --rm \
  --network none \
  --entrypoint sh \
  "$DASHBOARD_PDF_IMAGE" \
  -lc '
set -eu
node --version
command -v pnpm
test "$(pnpm --version)" = "10.4.1"
command -v pdfinfo
command -v pdftotext
command -v pdfseparate
command -v pdfunite
command -v gs
dpkg-query -W -f="\${Package}=\${Version}\n" \
  ghostscript poppler-utils
'
```

基础镜像 digest 已固定；Debian 仓库中的安全更新仍可能随时间变化，因此必须把本次构建
的最终 image ID、两项软件包版本、release SHA 和构建时间写入发布记录，并把这个已经
验收的派生镜像纳入新系统镜像备份或受控私有镜像仓库。不能仅假设未来重新运行
`apt-get` 会得到字节级相同的镜像。

本次已经从容器 Compose 标签核验出以下固定运行上下文：

```text
runtime directory：/opt/1panel/runtime/node/FrontMind-Dashboard
project：frontmind-dashboard
compose file：/opt/1panel/runtime/node/FrontMind-Dashboard/docker-compose.yml
service：node
```

每个新 SSH 会话都重新定义并验证这些变量，尤其不能把
`DASHBOARD_COMPOSE_FILE` 写成目录。下面四行是 SSH Shell 变量，只在终端执行，绝不能
粘贴进 `docker-compose.yml`：

```bash
set -euo pipefail

DASHBOARD_RUNTIME_DIR='/opt/1panel/runtime/node/FrontMind-Dashboard'
DASHBOARD_COMPOSE_PROJECT='frontmind-dashboard'
DASHBOARD_COMPOSE_FILE='/opt/1panel/runtime/node/FrontMind-Dashboard/docker-compose.yml'
DASHBOARD_COMPOSE_SERVICE='node'

test -d "$DASHBOARD_RUNTIME_DIR"
test -f "$DASHBOARD_COMPOSE_FILE"
test "$(grep -Ec '^[[:space:]]*image:' "$DASHBOARD_COMPOSE_FILE")" -eq 1

test "$(
  docker inspect frontmind-dashboard \
    --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
)" = "$DASHBOARD_RUNTIME_DIR"
test "$(
  docker inspect frontmind-dashboard \
    --format '{{ index .Config.Labels "com.docker.compose.project" }}'
)" = "$DASHBOARD_COMPOSE_PROJECT"
test "$(
  docker inspect frontmind-dashboard \
    --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'
)" = "$DASHBOARD_COMPOSE_FILE"
test "$(
  docker inspect frontmind-dashboard \
    --format '{{ index .Config.Labels "com.docker.compose.service" }}'
)" = "$DASHBOARD_COMPOSE_SERVICE"

echo "DASHBOARD_COMPOSE_CONTEXT_OK"
```

在 1Panel 停止 `FrontMind-Dashboard`。使用 1Panel 文件管理器打开上面精确定位的
`docker-compose.yml`。1Panel 当前版本通常把基础镜像写成变量模板：

```yaml
image: 1panel/node:${NODE_VERSION}
```

某些版本也可能已经展开为 `image: 1panel/node:22.22.2`。只把实际存在的这一条
`image:` 替换为：

```yaml
image: frontmind-dashboard-node:22.22.2-pdf-62810d58b4d892f4302f387849e4ff9e2116f489
```

不要修改 `NODE_VERSION`、`run.sh`、1Panel 内部 `.env`、`command`、端口、卷、网络或
`createdBy` 标签。这个 1Panel 生成文件可能直接包含生产环境变量和敏感值，禁止复制或
粘贴完整文件到聊天、工单、日志或截图。先只解析 service 和镜像名，禁止运行可能展开
敏感环境变量的裸 `docker compose config`。下面整个命令块必须在同一个 SSH shell 中
执行：

```bash
set -euo pipefail

DASHBOARD_RUNTIME_DIR='/opt/1panel/runtime/node/FrontMind-Dashboard'
DASHBOARD_COMPOSE_PROJECT='frontmind-dashboard'
DASHBOARD_COMPOSE_FILE='/opt/1panel/runtime/node/FrontMind-Dashboard/docker-compose.yml'
DASHBOARD_COMPOSE_SERVICE='node'
DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test -d "$DASHBOARD_RUNTIME_DIR"
test -f "$DASHBOARD_COMPOSE_FILE"
test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"

docker compose \
  --project-name "$DASHBOARD_COMPOSE_PROJECT" \
  --project-directory "$DASHBOARD_RUNTIME_DIR" \
  --file "$DASHBOARD_COMPOSE_FILE" \
  config --services |
  grep -Fx "$DASHBOARD_COMPOSE_SERVICE"

docker compose \
  --project-name "$DASHBOARD_COMPOSE_PROJECT" \
  --project-directory "$DASHBOARD_RUNTIME_DIR" \
  --file "$DASHBOARD_COMPOSE_FILE" \
  config --images |
  grep -Fx "$DASHBOARD_PDF_IMAGE"

docker compose \
  --project-name "$DASHBOARD_COMPOSE_PROJECT" \
  --project-directory "$DASHBOARD_RUNTIME_DIR" \
  --file "$DASHBOARD_COMPOSE_FILE" \
  up -d --force-recreate --pull never \
  "$DASHBOARD_COMPOSE_SERVICE"

echo "DASHBOARD_FIXED_IMAGE_RECREATED"
```

前三条命令都必须成功。随后核对实际镜像 ID、五个命令、工作目录和网络：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"
test "$(
  docker inspect frontmind-dashboard --format '{{.Image}}'
)" = "$(
  docker image inspect "$DASHBOARD_PDF_IMAGE" --format '{{.Id}}'
)"

test "$(
  docker inspect frontmind-dashboard --format '{{.State.Running}}'
)" = "true"
test "$(
  docker inspect frontmind-dashboard --format '{{.State.Restarting}}'
)" = "false"
INITIAL_RESTART_COUNT="$(
  docker inspect frontmind-dashboard --format '{{.RestartCount}}'
)"

docker exec frontmind-dashboard sh -lc '
set -eu
test "$(pwd)" = "/app"
command -v pdfinfo
command -v pdftotext
command -v pdfseparate
command -v pdfunite
command -v gs
'

docker inspect frontmind-dashboard \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

再次执行同一条限定精确 service 的 `up -d --force-recreate --pull never` 并重复验证，
证明依赖不是当前容器 writable layer 中的临时安装。每次通过 1Panel 编辑、升级或重建
运行环境后，都必须重新确认 Compose 的 `image:`、release SHA 标签和容器实际 image ID
仍指向该固定派生镜像；若被 1Panel 恢复成官方镜像，必须重新应用本节的精确镜像配置后
才能启动。

绝对不要在运行容器中临时 `apt install`，不要 `docker commit`，不要把派生镜像反向
标记成 `1panel/node:22.22.2`，也不要执行 `docker compose down -v` 或
`docker system prune`。

## 8. 一次性生成新密钥

因为使用全新数据库和全新目录，本次必须生成全新的密钥，不能复用旧 Agent 值。
只在首次初始化时，在未录屏、未共享且输出不被采集的本地安全终端分别执行一次；不要在
服务器 SSH 或 1Panel Web 终端生成。每次输出只复制到密码管理器和 1Panel：

```bash
set -euo pipefail

openssl rand -base64 32
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 48
```

依次用于：

1. `FRONTMIND_CREDENTIAL_ENCRYPTION_KEY`，值前加 `base64:`；
2. `FRONTMIND_PRESALES_SERVICE_TOKEN`；
3. `FRONTMIND_PROVISIONING_SERVICE_TOKEN`；
4. `FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET`。

四项必须彼此不同。两枚 service token 还要原样配置到 Website；其余两项只属于
Dashboard。

一旦 Dashboard 已保存加密凭据或 Website 已配置 service token，就不能为了重复验证
本文而重新生成这些值。后续轮换必须作为独立维护操作同时更新所有消费者，并先确认加密
数据可继续解密。

售前 API Key 不在这里生成，也不写入任何环境文件或 Website。它只能由系统管理员登录
Dashboard 的售前页面录入，由 Dashboard 使用新的
`FRONTMIND_CREDENTIAL_ENCRYPTION_KEY` 加密后保存到 `frontmind_dashboard`。

不要在聊天、截图、日志或终端共享记录中展示真实值。只有确认密钥进入未授权人员可见的
公开记录或泄露渠道时才执行上游轮换；不得仅为了“重新走一遍手册”而改变已经安全保存且
正在被新系统使用的密钥。任何真实 Key 都不能进入 Git、Website 环境或浏览器 bundle。

## 9. 在 1Panel 配置 Dashboard 环境变量

以下值全部在 `FrontMind-Dashboard → 环境变量` 中添加：

```env
NODE_ENV=production
PORT=3001

DATABASE_URL=mysql://frontmind_dashboard:<URL编码密码>@mysql:3306/frontmind_dashboard

FRONTMIND_CREDENTIAL_ENCRYPTION_KEY=base64:<新32字节base64>
FRONTMIND_PRESALES_SERVICE_TOKEN=<新随机值，至少32字符>
FRONTMIND_PROVISIONING_SERVICE_TOKEN=<另一新随机值，至少32字符>
FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET=<第三个独立随机值>
FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_TTL_SECONDS=300

FRONTMIND_MONITOR_API_KEY=<监控服务专用Key>

FRONTMIND_PUBLIC_URL=https://dashboard.frontmind.net
FRONTMIND_WEBSITE_URL=https://www.frontmind.net

FRONTMIND_PREPARED_FILE_DIR=/var/lib/frontmind/prepared-files
FRONTMIND_PREPARED_FILE_TTL_MS=2592000000
FRONTMIND_DASHBOARD_ASSET_DIR=/var/lib/frontmind/dashboard-assets
FRONTMIND_KB_V4_ROLLOUT_PERCENT=0
FRONTMIND_KB_V4_ALLOW_USER_IDS=<内部验收账号数字ID，多个用英文逗号分隔>
FRONTMIND_PDF_WORKERS=1
FRONTMIND_CONVERSATION_RETENTION_DAYS=30
FRONTMIND_SERVICE_ENTITLEMENT_ENFORCEMENT=auto

FRONTMIND_KB_SKILL_PATH=/app/dist/private-workflows/socratic-kb-builder.skill
FRONTMIND_BRAND_QUESTION_SKILL_PATH=/app/dist/private-workflows/brand-question-portfolio.skill
FRONTMIND_RESPONSE_LOGIC_SKILL_PATH=/app/dist/private-workflows/response-logic-builder.skill
```

这里展示的均为变量名和占位符，不要把真实值粘贴到部署手册、终端共享输出、截图或 Git。
用户和应用不得在 `/frontmind-dashboard` 或容器 `/app` 创建 `.env`、`.env.local` 或
`.env.production`。所有敏感值只通过 1Panel 服务端环境变量界面管理。1Panel 自己可能
在 `/opt/1panel/runtime/...` 维护内部环境文件并挂载到容器 `/.env`；它不能挂到
`/app/.env*`，也不得由用户手工读取、编辑、复制或提交。

`FRONTMIND_MONITOR_API_KEY` 是监控专用 Key，只允许出现在 Dashboard 服务端的 1Panel
环境变量中；它必须是监控服务提供方签发或确认有效的专用凭据，不能用本节的随机字符串
代替。禁止把它写入 Website、前端配置或任何 `VITE_` 变量。两枚 service token 也禁止
使用 `VITE_` 前缀。

通常不需要设置 `FRONTMIND_UPSTREAM_BASE_URL` 和 `FRONTMIND_MONITOR_API_BASE_URL`；
代码内已有安全的正式默认地址。只有实际服务提供方要求更换时才配置，且必须是无账号、
查询参数和 fragment 的 HTTPS URL。

保存并重建后执行无回显运行环境门。它只输出固定成功/错误码，不输出任何环境变量值：

```bash
docker exec frontmind-dashboard \
  node /app/scripts/validate-production-runtime.mjs
```

必须只出现 `RUNTIME_ENV_OK`。任一错误都先修复对应变量名，禁止用 `env`、`printenv`、
`docker inspect .Config.Env` 或完整 Compose 输出排查。

## 10. 安装、检查、测试和构建

先确认应用目录只保留已跟踪的环境变量模板 `/app/.env.example`，不存在任何真实项目
环境文件，并确认 1Panel 的内部 `/.env` 没有被单独挂载到 `/app/.env*`。只检查路径和
挂载目标，不读取文件内容或容器环境：

```bash
set -euo pipefail

docker exec frontmind-dashboard sh -lc '
set -eu

for path in /app/.env*; do
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    continue
  fi

  if [ "$path" = "/app/.env.example" ]; then
    test -f "$path"
    test ! -L "$path"
    continue
  fi

  echo "PROJECT_ENV_FILE_FORBIDDEN"
  exit 1
done

test -f /app/.env.example
test ! -L /app/.env.example
echo "PROJECT_ENV_FILES_OK"
'

dashboard_mount_destinations="$(
  docker inspect frontmind-dashboard \
    --format '{{range .Mounts}}{{println .Destination}}{{end}}'
)"
if printf '%s\n' "$dashboard_mount_destinations" |
  grep -Eq '^/app/\.env'
then
  echo "PROJECT_ENV_MOUNT_FORBIDDEN"
  exit 1
fi

echo "PROJECT_ENV_MOUNTS_OK"
```

1Panel 自己在私有运行目录维护并挂载到 `/.env` 的配置属于面板实现细节，不是项目环境
文件；不要手工读取、修改或删除它。

### 10.1 安装依赖并执行 TypeScript 检查

不要在持有 1Panel 生产环境变量的正式 Dashboard 容器中执行包管理器、检查器、测试器或
构建器。`env -u` 只能移除子进程环境，不能证明依赖代码不会读取 1Panel 的 `/.env` 或
容器主进程环境。使用固定 PDF 镜像启动不带 env-file、不带生产密钥的一次性容器。

先联网安装锁文件指定的全部开发依赖：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"
docker image inspect "$DASHBOARD_PDF_IMAGE" >/dev/null
dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"

docker run --rm \
  --network bridge \
  --env NODE_ENV=development \
  --entrypoint sh \
  --mount type=bind,src=/frontmind-dashboard,dst=/app \
  --workdir /app \
  "$DASHBOARD_PDF_IMAGE" \
  -lc '
    set -eu
    test "$(pnpm --version)" = "10.4.1"
    pnpm install --prod=false --frozen-lockfile
  '

dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"
echo "DASHBOARD_DEPENDENCIES_READY"
```

断网执行 TypeScript 检查：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"
docker image inspect "$DASHBOARD_PDF_IMAGE" >/dev/null

docker run --rm \
  --network none \
  --env NODE_ENV=test \
  --entrypoint sh \
  --mount type=bind,src=/frontmind-dashboard,dst=/app \
  --workdir /app \
  "$DASHBOARD_PDF_IMAGE" \
  -lc '
    set -eu
    test "$NODE_ENV" = "test"
    test "$(pnpm --version)" = "10.4.1"
    pnpm check
  '

echo "DASHBOARD_CHECK_OK"
```

### 10.2 在无网络、无生产密钥的隔离容器中执行完整测试

不要在继承 `NODE_ENV=production` 的正式 Dashboard 容器中直接执行 `pnpm test`。完整
测试必须使用固定 PDF 镜像启动一次性隔离容器，显式设置 `NODE_ENV=test`，断开网络，
且只把 Website 的契约副本只读挂载到测试所要求的 `/frontmind-website`：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"
test -n "$DASHBOARD_PDF_IMAGE"
dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"

test "$(
  git -C /frontmind-website rev-parse HEAD
)" = "eefe6234b23351b066295c0941ca6cff5ce9ea69"
website_status="$(
  git -C /frontmind-website status --short
)"
test -z "$website_status"
test -f \
  /frontmind-website/server/geo/contracts/provisioning-v2.fixture.json
test -f \
  /frontmind-website/server/geo/contracts/payment-receipt-v1.fixture.json

docker run --rm \
  --network none \
  --env NODE_ENV=test \
  --entrypoint sh \
  --mount type=bind,src=/frontmind-dashboard,dst=/app \
  --mount \
    type=bind,src=/frontmind-website,dst=/frontmind-website,readonly \
  --workdir /app \
  "$DASHBOARD_PDF_IMAGE" \
  -lc '
    set -eu
    test "$NODE_ENV" = "test"
    test "$(pnpm --version)" = "10.4.1"
    pnpm test
  '

echo "DASHBOARD_ISOLATED_TEST_OK"
```

本 release 的完整成功基线为：

```text
Test Files  122 passed (122)
Tests       839 passed (839)
```

两个跨仓契约 fixture 必须来自只读挂载的固定 Website SHA；不要删除跨仓测试或复制
临时 fixture 绕过。完整测试只使用本节给出的 `NODE_ENV=test` 隔离容器。

### 10.3 构建、生产审计和产物验证

完整测试通过后，在无网络、无 env-file、无生产密钥的一次性固定镜像中执行生产构建和
审计：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"
docker image inspect "$DASHBOARD_PDF_IMAGE" >/dev/null

docker run --rm \
  --network none \
  --env NODE_ENV=production \
  --entrypoint sh \
  --mount type=bind,src=/frontmind-dashboard,dst=/app \
  --workdir /app \
  "$DASHBOARD_PDF_IMAGE" \
  -lc '
    set -eu
    test "$NODE_ENV" = "production"
    test "$(pnpm --version)" = "10.4.1"
    pnpm build
    pnpm audit:production
  '

echo "DASHBOARD_BUILD_AND_AUDIT_OK"
```

验证产物：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(
  git -C /frontmind-dashboard rev-parse HEAD
)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

docker run --rm \
  --network none \
  --env NODE_ENV=production \
  --entrypoint sh \
  --mount type=bind,src=/frontmind-dashboard,dst=/app,readonly \
  --workdir /app \
  "$DASHBOARD_PDF_IMAGE" \
  -lc '
    set -eu
    test -f dist/index.js
    test -f dist/pdf-prepare-worker.js
    test -f dist/public/index.html
    test -f dist/private-workflows/socratic-kb-builder.skill
    test -f dist/private-workflows/brand-question-portfolio.skill/SKILL.md
    test -f dist/private-workflows/response-logic-builder.skill/SKILL.md
    node --check dist/index.js
    node --check dist/pdf-prepare-worker.js
    cmp -s \
      private-workflows/socratic-kb-builder.skill \
      dist/private-workflows/socratic-kb-builder.skill
    cmp -s \
      private-workflows/brand-question-portfolio.skill/SKILL.md \
      dist/private-workflows/brand-question-portfolio.skill/SKILL.md
    cmp -s \
      private-workflows/response-logic-builder.skill/SKILL.md \
      dist/private-workflows/response-logic-builder.skill/SKILL.md
    echo "DASHBOARD_ARTIFACTS_OK"
  '

docker run --rm \
  --network none \
  --entrypoint node \
  --mount type=bind,src=/frontmind-dashboard,dst=/app,readonly \
  --workdir /app \
  "$DASHBOARD_PDF_IMAGE" \
  -e '
const value = require(
  "/app/dist/public/__frontmind__/version.json"
);
if (value.version !== "dashboard-20260728-r1") process.exit(1);
console.log("BUILD_VERSION_OK dashboard-20260728-r1");
'

dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"
git -C /frontmind-dashboard diff --check
```

最后执行发布扫描。任何扫描器自身错误都必须失败关闭；异常时只输出文件名或固定错误码，
不输出疑似 Key、私钥正文或任何生产环境变量值：

```bash
set -euo pipefail
cd /frontmind-dashboard
export LC_ALL=C

LEGACY_PORT_PATTERN='30''04'
KEY_PATTERN='(^|[^[:alnum:]_])sk-[A-Za-z0-9_-]{24,}'
PRIVATE_KEY_PATTERN='BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY'

set +e
legacy_port_files="$(
  grep -R -l -F "$LEGACY_PORT_PATTERN" \
    .env.example README.md server client shared scripts \
    private-workflows 1PANEL_AFTER_CLONE_DEPLOYMENT.md dist
)"
legacy_port_status=$?
set -e
case "$legacy_port_status" in
  0)
    printf '%s\n' "$legacy_port_files"
    echo "LEGACY_PORT_FOUND"
    exit 1
    ;;
  1) ;;
  *)
    echo "LEGACY_PORT_SCAN_FAILED"
    exit 1
    ;;
esac

set +e
legacy_domain_files="$(
  grep -R -l -F "agent.frontmind.net" dist
)"
legacy_domain_status=$?
set -e
case "$legacy_domain_status" in
  0)
    printf '%s\n' "$legacy_domain_files"
    echo "LEGACY_AGENT_DOMAIN_FOUND_IN_DIST"
    exit 1
    ;;
  1) ;;
  *)
    echo "LEGACY_AGENT_DOMAIN_SCAN_FAILED"
    exit 1
    ;;
esac

set +e
source_key_matches="$(
  git -c color.grep=false grep \
    -n -E "$KEY_PATTERN" -- . ':!dist'
)"
source_key_status=$?
set -e
if [ "$source_key_status" -ne 0 ]; then
  echo "SOURCE_API_KEY_PATTERN_SCAN_FAILED"
  exit 1
fi
test "$(
  printf '%s\n' "$source_key_matches" |
    wc -l |
    tr -d ' '
)" = "3"
test "$(
  printf '%s\n' "$source_key_matches" |
    sha256sum |
    awk '{print $1}'
)" = "2d718bebab19092311119de95ac0b7c9963d855ccfb0be9f28147102fa6137cd"

set +e
dist_key_files="$(
  grep -R -l -E "$KEY_PATTERN" dist
)"
dist_key_status=$?
set -e
case "$dist_key_status" in
  0)
    printf '%s\n' "$dist_key_files"
    echo "API_KEY_PATTERN_FOUND_IN_DIST"
    exit 1
    ;;
  1) ;;
  *)
    echo "DIST_API_KEY_PATTERN_SCAN_FAILED"
    exit 1
    ;;
esac

set +e
source_private_key_files="$(
  git -c color.grep=false grep \
    -l -E "$PRIVATE_KEY_PATTERN" -- . ':!dist'
)"
source_private_key_status=$?
set -e
case "$source_private_key_status" in
  0)
    printf '%s\n' "$source_private_key_files"
    echo "PRIVATE_KEY_FOUND_IN_SOURCE"
    exit 1
    ;;
  1) ;;
  *)
    echo "SOURCE_PRIVATE_KEY_SCAN_FAILED"
    exit 1
    ;;
esac

set +e
dist_private_key_files="$(
  grep -R -l -E "$PRIVATE_KEY_PATTERN" dist
)"
dist_private_key_status=$?
set -e
case "$dist_private_key_status" in
  0)
    printf '%s\n' "$dist_private_key_files"
    echo "PRIVATE_KEY_FOUND_IN_DIST"
    exit 1
    ;;
  1) ;;
  *)
    echo "DIST_PRIVATE_KEY_SCAN_FAILED"
    exit 1
    ;;
esac

dashboard_status="$(git status --short)"
test -z "$dashboard_status"
git diff --check
echo "DASHBOARD_RELEASE_SCAN_OK"
```

当前固定 SHA 的三个源码命中都是专门验证脱敏逻辑的合成测试值，精确匹配数量和整行
SHA-256 已锁定，且不会进入 `dist`；任何内容、行号或数量变化都会失败，必须人工审计并
随新 release 明确更新预期哈希，不能直接放宽模式。

如果 1Panel 实际挂载目录不是 `/app`，必须先修正运行环境使其统一为 `/app`，不能在同一
部署中混用两个工作目录。任何命令失败都不能继续迁移。

## 11. 在空库执行 0000–0034 共 35 个迁移

数据库必须是刚创建且不含旧 Agent 数据的 `frontmind_dashboard`。唯一允许的 schema
变更命令是 `pnpm db:migrate`。

迁移前先核对仓库迁移源：

```bash
set -euo pipefail

docker exec frontmind-dashboard sh -lc '
set -eu
cd /app
test "$(find drizzle -maxdepth 1 -type f -name "*.sql" | wc -l)" -eq 35
test -f drizzle/0034_known_scarlet_spider.sql
grep -F \
  "\`createdAt\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)" \
  drizzle/0031_payment_receipt_ledger.sql >/dev/null
grep -F \
  "\`updatedAt\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)" \
  drizzle/0032_project_order_registry.sql >/dev/null
'

docker exec frontmind-dashboard node -e '
const journal = require("/app/drizzle/meta/_journal.json");
if (journal.entries.length !== 35) process.exit(1);
if (journal.entries.at(-1)?.tag !== "0034_known_scarlet_spider") process.exit(1);
console.log("MIGRATION_SOURCE_OK count=35 latest=0034_known_scarlet_spider");
'
```

首次部署只允许从真正零表的 `frontmind_dashboard` 开始。只要数据库已有任意表或迁移
账本记录，就立即停止，不把部分迁移状态继续当作正式库。确认尚无任何新业务数据后，只
能在 1Panel 中针对精确目标 `frontmind_dashboard` 及其专用用户重建，再从零表状态一次
执行全部 35 个迁移；不得影响任何其他数据库或用户。

然后通过 Dashboard 容器实际持有的 `DATABASE_URL` 连接数据库，但不打印 URL 或密码。
必须同时确认数据库名、新用户主体、MySQL 版本、二进制日志策略和零表：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
import mysql from "mysql2/promise";
let connection;
try {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error();
  const target = new URL(raw);
  if (
    target.protocol !== "mysql:" ||
    target.hostname !== "mysql" ||
    (target.port && target.port !== "3306") ||
    decodeURIComponent(target.username) !== "frontmind_dashboard" ||
    target.pathname !== "/frontmind_dashboard" ||
    target.search ||
    target.hash ||
    !target.password
  ) {
    throw new Error();
  }
  connection = await mysql.createConnection(raw);
  const [[identity]] = await connection.query(
    `SELECT
       DATABASE() AS db,
       CURRENT_USER() AS principal,
       VERSION() AS engine_version,
       @@version_comment AS version_comment,
       @@GLOBAL.log_bin AS log_bin,
       @@GLOBAL.log_bin_trust_function_creators AS trigger_trust`,
  );
  const [[tables]] = await connection.query(
    "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE()",
  );
  if (identity.db !== "frontmind_dashboard") {
    throw new Error();
  }
  if (!String(identity.principal).startsWith("frontmind_dashboard@")) {
    throw new Error();
  }
  const version = String(identity.engine_version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (
    !version ||
    Number(version[1]) !== 8 ||
    Number(version[2]) < 4 ||
    !String(identity.version_comment).includes("MySQL")
  ) {
    throw new Error();
  }
  if (Number(tables.table_count) !== 0) {
    throw new Error();
  }
  console.log(JSON.stringify({
    status: "EMPTY_DATABASE_TARGET_OK",
    db: identity.db,
    principal: identity.principal,
    engine_version: identity.engine_version,
    log_bin: Number(identity.log_bin),
    trigger_trust: Number(identity.trigger_trust),
    table_count: Number(tables.table_count),
  }, null, 2));
} catch {
  console.error("EMPTY_DATABASE_CHECK_FAILED");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => {});
}
'
```

迁移 `0031_payment_receipt_ledger` 会创建两个不可变账本触发器。先在 1Panel 的 MySQL
管理终端以数据库管理员身份读取并在发布记录中写下原值（它不是敏感值）：

```sql
SELECT
  @@GLOBAL.log_bin_trust_function_creators
    AS original_trigger_trust;
```

`original_trigger_trust` 只能是 `0` 或 `1`。后文统一把它称为
`ORIGINAL_TRIGGER_TRUST`，不得凭记忆假设其原值为 `0`。

如果空库检查同时显示 `log_bin: 1` 且记录的原值为 `0`，Dashboard 专用数据库用户不应
被授予 `SUPER` 或 `SYSTEM_VARIABLES_ADMIN`。只在这个条件下临时执行：

```sql
SET GLOBAL log_bin_trust_function_creators = 1;
SELECT @@GLOBAL.log_bin_trust_function_creators AS trigger_trust;
```

必须看到 `trigger_trust = 1`。原值本来就是 `1` 或 `log_bin = 0` 时不要修改。这里只
允许 `SET GLOBAL`，禁止 `SET PERSIST`；此窗口只覆盖这一次空库迁移。只有出现
`MIGRATION_SOURCE_OK`、`EMPTY_DATABASE_TARGET_OK`，并且触发器策略满足
`log_bin = 0` 或 `trigger_trust = 1` 后，才执行唯一一次：

如果临时把 `0` 改成 `1`，必须保持 MySQL 管理终端打开，并在发布记录显著标记
`TEMP_TRIGGER_TRUST_OVERRIDE_ACTIVE`。SSH、浏览器或迁移进程中断时，不得先重连重跑
迁移；第一步必须查询并恢复下面记录的原值，清除该标记后再审计迁移状态。

```bash
docker exec frontmind-dashboard sh -lc '
set -eu
cd /app
pnpm db:migrate
'
```

任何环境都绝对不要执行 `pnpm db:push` 或 `pnpm db:generate`。它们只作为禁止项记录，
不是本手册中的可执行步骤。

无论迁移成功还是失败，命令返回后第一件事都是回到 1Panel 的 MySQL 管理终端，把全局值
恢复为发布前记录的原值。记录为 `0` 时执行：

```sql
SET GLOBAL log_bin_trust_function_creators = 0;
SELECT @@GLOBAL.log_bin_trust_function_creators AS trigger_trust;
```

记录为 `1` 时执行：

```sql
SET GLOBAL log_bin_trust_function_creators = 1;
SELECT @@GLOBAL.log_bin_trust_function_creators AS trigger_trust;
```

查询结果必须与记录的 `ORIGINAL_TRIGGER_TRUST` 完全一致，然后才能继续审计或启动服务。
不得无条件恢复为 `0`，因为 MySQL 可能与其他应用共享。如果迁移命令非零退出，立即
停止，不要直接重跑。MySQL DDL 可能已经部分提交；在仍无新业务写入时，只能先审计新库
状态，必要时精确重建 Dashboard 自己的新空库后从 `0000` 重新执行，绝不能使用
`db:push` 或 `db:generate` 修补。

迁移成功后，将数据库账本的 35 行按 `created_at` 与 journal 时间戳、SQL SHA-256
逐项核对，并确认毫秒精度、自动更新时间和触发器策略都符合最终定义：

```bash
set -euo pipefail

ORIGINAL_TRIGGER_TRUST='<填入迁移前记录的0或1>'
case "$ORIGINAL_TRIGGER_TRUST" in
  0|1) ;;
  *) exit 1 ;;
esac

docker exec \
  --env "FRONTMIND_EXPECTED_TRIGGER_TRUST=$ORIGINAL_TRIGGER_TRUST" \
  frontmind-dashboard \
  node --input-type=module -e '
import mysql from "mysql2/promise";
import { readMigrationFiles } from "drizzle-orm/migrator";
let connection;
try {
  const expectedTriggerTrust =
    Number(process.env.FRONTMIND_EXPECTED_TRIGGER_TRUST);
  if (![0, 1].includes(expectedTriggerTrust)) {
    throw new Error();
  }
  const expected = readMigrationFiles({ migrationsFolder: "/app/drizzle" });
  connection = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await connection.query(
    "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC",
  );
  if (expected.length !== 35 || rows.length !== 35) {
    throw new Error();
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      String(rows[index].hash) !== expected[index].hash ||
      String(rows[index].created_at) !== String(expected[index].folderMillis)
    ) {
      throw new Error();
    }
  }
  const [[runtime]] = await connection.query(`
    SELECT
      @@GLOBAL.log_bin_trust_function_creators AS trigger_trust,
      (
        SELECT COUNT(*)
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
      ) AS table_count,
      (
        SELECT COUNT(*)
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE()
          AND TRIGGER_NAME IN (
            "website_payment_receipts_no_update",
            "website_payment_receipts_no_delete"
          )
      ) AS trigger_count,
      (
        SELECT COUNT(*)
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = "website_project_orders"
          AND COLUMN_NAME IN ("createdAt", "updatedAt")
          AND DATETIME_PRECISION = 3
          AND COLUMN_DEFAULT = "current_timestamp(3)"
      ) AS fractional_default_count,
      (
        SELECT EXTRA
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = "website_project_orders"
          AND COLUMN_NAME = "updatedAt"
      ) AS updated_at_extra
  `);
  if (
    Number(runtime.trigger_trust) !== expectedTriggerTrust ||
    Number(runtime.table_count) !== 48 ||
    Number(runtime.trigger_count) !== 2 ||
    Number(runtime.fractional_default_count) !== 2 ||
    !String(runtime.updated_at_extra)
      .toLowerCase()
      .includes("on update current_timestamp(3)")
  ) {
    throw new Error();
  }
  console.log(
    "MIGRATIONS_VERIFIED count=35 latest=0034_known_scarlet_spider",
  );
} catch {
  console.error("MIGRATION_LEDGER_CHECK_FAILED");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => {});
}
'
```

只有出现 `MIGRATIONS_VERIFIED count=35 latest=0034_known_scarlet_spider` 才算完成。
此时新库已包含新 Dashboard schema，不应再称为“空库”，但不得含任何旧 Agent 客户
数据。

## 12. 初始化唯一系统管理员

先确认新库还没有任何用户，防止重复执行初始化：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
import mysql from "mysql2/promise";
let connection;
try {
  connection = await mysql.createConnection(process.env.DATABASE_URL);
  const [[row]] = await connection.query("SELECT COUNT(*) AS count FROM users");
  if (Number(row.count) !== 0) throw new Error();
  console.log("ADMIN_INIT_PRECHECK_OK users=0");
} catch {
  console.error("ADMIN_INIT_PRECHECK_FAILED");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => {});
}
'
```

在 TTY 中执行，密码不会进入命令历史：

```bash
docker exec -it frontmind-dashboard sh -lc '
cd /app
pnpm admin:init -- --username admin --display-name "FrontMind Admin"
'
```

然后用不返回密码字段的查询断言只有这一名系统管理员。这个检查只统计
`system_admin`，因此即使验收期间已经创建普通用户，也不会产生误报：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
import mysql from "mysql2/promise";
let connection;
try {
  connection = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await connection.query(
    `SELECT username, role, adminAccessLevel, isActive
     FROM users
     WHERE adminAccessLevel = ?
     ORDER BY id`,
    ["system_admin"],
  );
  if (rows.length !== 1) throw new Error();
  const [admin] = rows;
  if (
    admin.username !== "admin" ||
    admin.role !== "admin" ||
    admin.adminAccessLevel !== "system_admin" ||
    Number(admin.isActive) !== 1
  ) {
    throw new Error();
  }
  console.log("ADMIN_VERIFIED count=1 role=admin access=system_admin active=1");
} catch {
  console.error("ADMIN_VERIFICATION_FAILED");
  process.exitCode = 1;
} finally {
  if (connection) await connection.end().catch(() => {});
}
'
```

## 13. 停止旧 Agent，并让 Dashboard 接管 3001

进入维护窗口后先冻结 Website 的支付、开户和所有会写入旧 Agent 的入口。根据第 3 节
记录的精确运行环境名称，在 1Panel 中停止旧 Agent 并关闭其自动重启；此时只停止，不删除
任何旧资产。同时停止仍处于 `sleep infinity` 的 `FrontMind-Dashboard`，然后以失败关闭
方式确认宿主机 `3001` 已释放：

```bash
set -euo pipefail

command -v ss >/dev/null
port_3001_listeners="$(
  ss -H -lnt 'sport = :3001'
)"
if [ -n "$port_3001_listeners" ]; then
  echo "PORT_3001_STILL_IN_USE"
  exit 1
fi
echo "PORT_3001_RELEASED"
```

必须出现 `PORT_3001_RELEASED`。若仍被占用，只根据 1Panel 中核实过的精确容器名称/ID
查明来源；不要用
模糊进程匹配或批量停止命令。

在 1Panel 一次性完成最后的运行参数：

- 启动命令从 `sleep infinity` 改为 `pnpm start`；
- 宿主机只绑定 `127.0.0.1:3001` 到容器 `3001`，禁止 `0.0.0.0:3001`；
- 三个 Skill 绝对路径仍指向 `/app/dist/private-workflows/...`；
- 首次启动不要设置无限自动重启；保留关闭状态或最多使用已有的有界
  `on-failure:5`，先观察第一次非零退出。

1Panel 保存环境变量、端口或启动命令时可能重新生成 Compose，并把派生镜像恢复成
`1panel/node:${NODE_VERSION}`。所以保存后先不要直接启动：重新读取实际 Compose
标签和文件，按第 7 节再次把唯一 `image:` 改回本次 release SHA 的派生镜像，重新执行
`config --services`、`config --images`，再只对精确 `node` service 执行
`up -d --force-recreate --pull never`。不要另外手工启动第二个 `pnpm start`。

检查：

```bash
set -euo pipefail

DASHBOARD_RELEASE_SHA="$(git -C /frontmind-dashboard rev-parse HEAD)"
DASHBOARD_PDF_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_RELEASE_SHA"

test "$DASHBOARD_RELEASE_SHA" = \
  "62810d58b4d892f4302f387849e4ff9e2116f489"
test "$(
  docker inspect frontmind-dashboard --format '{{.Image}}'
)" = "$(
  docker image inspect "$DASHBOARD_PDF_IMAGE" --format '{{.Id}}'
)"

docker exec frontmind-dashboard sh -lc '
set -eu
test "$(pnpm --version)" = "10.4.1"
test -d /app/node_modules
test -f /app/dist/index.js
test -f /app/dist/pdf-prepare-worker.js
command -v pdfinfo
command -v pdftotext
command -v pdfseparate
command -v pdfunite
command -v gs
'

docker exec frontmind-dashboard \
  node /app/scripts/validate-production-runtime.mjs

docker inspect frontmind-dashboard --format '{{json .Mounts}}' |
  docker exec -i frontmind-dashboard node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const mounts = JSON.parse(input);
  const expected = new Map([
    ["/var/lib/frontmind/prepared-files", "/srv/frontmind-dashboard/prepared-files"],
    ["/var/lib/frontmind/dashboard-assets", "/srv/frontmind-dashboard/dashboard-assets"],
  ]);
  for (const [destination, source] of expected) {
    const mount = mounts.find(item => item.Destination === destination);
    if (!mount || mount.Source !== source || mount.RW !== true) process.exit(1);
  }
  console.log("PERSISTENT_MOUNTS_OK");
});
'

docker exec frontmind-dashboard sh -lc '
set -eu
for directory in \
  /var/lib/frontmind/prepared-files \
  /var/lib/frontmind/dashboard-assets
do
  test -d "$directory"
  test -w "$directory"
  probe="$(mktemp "$directory/.frontmind-write-test.XXXXXX")"
  rm -f -- "$probe"
done
echo "PERSISTENT_MOUNTS_WRITABLE"
'

docker inspect frontmind-dashboard \
  --format '{{json .NetworkSettings.Networks}}' |
  docker exec -i frontmind-dashboard node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const networks = JSON.parse(input);
  const network = networks["1panel-network"];
  if (!network || !network.Aliases?.includes("frontmind-dashboard")) {
    process.exit(1);
  }
  console.log("PRIVATE_NETWORK_ALIAS_OK");
});
'

docker exec frontmind-dashboard getent hosts mysql >/dev/null
docker exec frontmind-dashboard getent hosts frontmind-dashboard >/dev/null

test "$(
  docker port frontmind-dashboard 3001/tcp
)" = "127.0.0.1:3001"

docker inspect frontmind-dashboard \
  --format 'status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} restarts={{.RestartCount}}'

INITIAL_RESTART_COUNT="$(
  docker inspect frontmind-dashboard --format '{{.RestartCount}}'
)"

READY=false
for attempt in $(seq 1 60); do
  if test "$(
    docker inspect frontmind-dashboard --format '{{.State.Running}}'
  )" != "true"; then
    break
  fi
  if docker exec frontmind-dashboard node --input-type=module -e '
const response = await fetch(
  "http://127.0.0.1:3001/healthz",
  { signal: AbortSignal.timeout(5_000) },
);
const payload = await response.json();
if (!response.ok || payload?.status !== "ok") process.exit(1);
' >/dev/null 2>&1
  then
    READY=true
    break
  fi
  sleep 1
done
test "$READY" = "true"
test "$(
  docker inspect frontmind-dashboard --format '{{.RestartCount}}'
)" = "$INITIAL_RESTART_COUNT"
echo "LOCAL_DASHBOARD_READY"
```

启动日志不得包含数据库密码、API Key 或 service token。
`pnpm start` 如果初始化失败必须以非零状态退出；1Panel 必须显示启动失败/不健康，禁止用
`|| true`、守护循环或其他包装吞掉退出码。

如果状态不是持续 `running` 或健康检查失败，只在服务器私有控制台本地检查
`docker logs --tail 200 frontmind-dashboard`，不要复制原始日志到聊天、工单或截图。健康
稳定后才能启用最终自动重启策略；该 UI 保存若再次重建 Compose，仍须重复派生镜像、
pnpm、产物、PDF、端口和健康检查。

## 14. 配置 dashboard.frontmind.net

在 1Panel 新建反向代理网站：

```text
域名：dashboard.frontmind.net
上游：http://127.0.0.1:3001
HTTPS：开启
HTTP → HTTPS：开启
```

根路径整体代理，不能部署在 `/dashboard/` 子路径。开启证书后，在 1Panel 的
`dashboard.frontmind.net → 配置 → 配置文件` 使用下面的完整 `server` 配置；证书和日志
路径与本次 1Panel 网站目录一致。internal 的大小写不敏感正则 `location` 必须与
`location /` 同级：

```nginx
server {
    listen 80;
    listen 443 ssl;
    http2 on;

    server_name dashboard.frontmind.net;
    index index.html;

    access_log /www/sites/dashboard.frontmind.net/log/access.log main;
    error_log /www/sites/dashboard.frontmind.net/log/error.log;

    ssl_certificate /www/sites/dashboard.frontmind.net/ssl/fullchain.pem;
    ssl_certificate_key /www/sites/dashboard.frontmind.net/ssl/privkey.pem;
    ssl_protocols TLSv1.3 TLSv1.2;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    add_header Strict-Transport-Security "max-age=31536000" always;
    error_page 497 https://$host$request_uri;

    if ($scheme = http) {
        return 301 https://$host$request_uri;
    }

    location ~* ^/api/internal(?:/|$) {
        return 404;
    }

    location ^~ /.well-known/acme-challenge {
        allow all;
        root /usr/share/nginx/html;
    }

    location ~ ^/(\.user.ini|\.htaccess|\.git|\.env|\.svn|\.project|LICENSE|README\.md) {
        return 404;
    }

    location / {
        client_max_body_size 300m;

        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $server_name;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

`client_max_body_size 300m` 为应用 250 MB 知识库 ZIP 上限保留协议开销，同时保持有限
请求体边界；禁止改成无限制的 `0`。若以后调整应用上传上限，必须同步评审并更新这里。

保存前使用 1Panel 的配置检查，保存后 reload OpenResty。不要把 internal 404 规则写进
`location /`，否则前缀匹配不会形成独立的公网安全边界。

验证：

```bash
set -euo pipefail

curl -fsS \
  --connect-timeout 5 \
  --max-time 20 \
  https://dashboard.frontmind.net/healthz \
  >/dev/null

for path in \
  /api/internal \
  /api/internal/presales/status \
  /api/internal/provisioning/payment-receipts/ready \
  /api/internal/provisioning/project-orders/ready \
  /api/internal/not-public \
  /API/INTERNAL/presales/status \
  /Api/Internal/not-public
do
  code="$(
    curl -sS \
      --connect-timeout 5 \
      --max-time 20 \
      -o /dev/null \
      -w '%{http_code}' \
      "https://dashboard.frontmind.net$path"
  )"
  test "$code" = "404"
  echo "PUBLIC_INTERNAL_404_OK $path"
done

headers="$(mktemp)"
trap 'rm -f -- "$headers"' EXIT
http_code="$(
  curl -sS \
    --connect-timeout 5 \
    --max-time 20 \
    -D "$headers" \
    -o /dev/null \
    -w '%{http_code}' \
    http://dashboard.frontmind.net/api/internal/presales/status
)"
case "$http_code" in
  301|308) ;;
  *) exit 1 ;;
esac
grep -qiE \
  '^location: https://dashboard\.frontmind\.net/api/internal/presales/status\r?$' \
  "$headers"
rm -f -- "$headers"
trap - EXIT
echo "HTTP_TO_HTTPS_REDIRECT_OK"
```

七条 HTTPS 探针（包括大写和混合大小写变体）都必须为 `404`，不能是由应用返回的
`401`、`403` 或上游正文。HTTP 入口必须先独立证明只重定向到同路径 HTTPS，不能用
`curl -L` 把重定向和最终 `404` 混成一个结果。

## 15. Dashboard 健康门

```bash
set -euo pipefail

curl -fsS \
  --connect-timeout 5 \
  --max-time 20 \
  https://dashboard.frontmind.net/healthz |
jq -e '
  .status == "ok" and
  .configuration.monitorCredentialConfigured == true and
  .configuration.monitorApiBaseUrlConfigured == true and
  .configuration.publicUrlConfigured == true and
  .configuration.upstreamBaseUrlConfigured == true and
  .preparedFiles.status == "ok" and
  .internalLedgers.paymentReceipts.ready == true and
  .internalLedgers.projectOrders.ready == true and
  ([.skills[].name] | sort) ==
    ([
      "brand-question-portfolio",
      "response-logic-builder",
      "socratic-kb-builder"
    ] | sort)
'
```

`/healthz` 不检查管理员录入的售前 API Key。管理员完成第 16 节的“验证并启用”后，
还必须在 Dashboard 容器内部验证三条受保护接口。以下检查直接由 Node 进程从环境读取
token，不把真实值放进宿主机命令历史或 `curl` 子进程参数，只输出就绪标记：

```bash
docker exec frontmind-dashboard node --input-type=module -e '
const checks = [
  {
    name: "PRESALES",
    url: "http://127.0.0.1:3001/api/internal/presales/status",
    header: "x-frontmind-service-token",
    token: process.env.FRONTMIND_PRESALES_SERVICE_TOKEN,
    valid: p =>
      p?.ok === true &&
      p?.credentialConfigured === true &&
      p?.monitorCredentialConfigured === true &&
      p?.publicUrlConfigured === true,
  },
  {
    name: "PAYMENT_LEDGER",
    url: "http://127.0.0.1:3001/api/internal/provisioning/payment-receipts/ready",
    header: "x-frontmind-provisioning-token",
    token: process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN,
    valid: p => p?.schemaVersion === 1 && p?.ready === true,
  },
  {
    name: "PROJECT_LEDGER",
    url: "http://127.0.0.1:3001/api/internal/provisioning/project-orders/ready",
    header: "x-frontmind-provisioning-token",
    token: process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN,
    valid: p => p?.schemaVersion === 1 && p?.ready === true,
  },
];
for (const c of checks) {
  if (!c.token) throw new Error(`${c.name}_TOKEN_MISSING`);
  const response = await fetch(c.url, {
    headers: { [c.header]: c.token },
    signal: AbortSignal.timeout(15_000),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok || !c.valid(payload)) {
    throw new Error(`${c.name}_NOT_READY_HTTP_${response.status}`);
  }
  console.log(`${c.name}_READY`);
}
'
```

## 16. 配置并真实验证上游凭据

1. 打开 `https://dashboard.frontmind.net/login`。
2. 使用系统管理员登录。
3. 进入 `侧栏 → 售前页面`。
4. 输入售前 API Key，点击“测试连接”。
5. 测试通过后点击“验证并启用”。
6. 刷新页面，确认 Key 已由 Dashboard 加密保存到新数据库，界面只显示脱敏状态且不回显
   完整 Key。
7. 执行第 15 节的三条内部就绪检查，确认 `PRESALES_READY`、两个账本就绪标记全部出现。
8. 继续部署并重新构建 Website；真实 Base 和监控 canary 从 Website 执行，放在恢复正式
   流量之前。

只完成“连接测试”不代表 API 链路已验收；最终仍必须至少完成一次真实任务和一次真实
监控，但 Dashboard 售前页面本身不负责创建 Base。

## 17. 验证并部署固定 Website release

Dashboard 的公网健康、内部接口和售前凭据全部就绪后，才能部署 Website。Website 的
固定对象是：

| 项目            | 固定值                                     |
| --------------- | ------------------------------------------ |
| release SHA     | `eefe6234b23351b066295c0941ca6cff5ce9ea69` |
| 服务器代码目录  | `/frontmind-website`                       |
| 1Panel 运行环境 | `FrontMind-Website`                        |
| 容器            | `FrontMind-Website`                        |
| 工作目录        | `/app`                                     |
| 应用端口        | `8888`                                     |
| 宿主机映射      | `127.0.0.1:8888:8888`                      |
| 公网域名        | `https://www.frontmind.net`                |

### 17.1 固定 Website 源码

继续使用服务器 `/frontmind-website` 已经能够鉴权的现有 Git remote，不重新 clone，也
不修改 remote。先让 OpenResty 返回维护页并冻结支付、开户和所有写操作；维护规则必须
为验收源 IP 提供受控旁路，并允许该来源访问新 Website 的 `/healthz` 和 canary 路径，
其他访客仍只看到维护页。

然后在 1Panel 停止精确运行环境 `FrontMind-Website` 并关闭自动重启。维护页由
OpenResty 直接提供，不依赖已经停止的 Node 容器。确认没有旧 Website Node 进程继续
读取正在更新的代码、`dist` 或 `node_modules`，再执行：

```bash
set -euo pipefail

cd /frontmind-website

EXPECTED_WEBSITE_SHA='eefe6234b23351b066295c0941ca6cff5ce9ea69'

if docker inspect FrontMind-Website >/dev/null 2>&1; then
  test "$(
    docker inspect FrontMind-Website --format '{{.State.Running}}'
  )" = "false"
fi

test "$(git branch --show-current)" = "main"
website_status="$(git status --short)"
test -z "$website_status"

for path in /frontmind-website/.env*; do
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    continue
  fi
  if [ "$path" = "/frontmind-website/.env.example" ]; then
    test -f "$path"
    test ! -L "$path"
    continue
  fi
  echo "WEBSITE_PROJECT_ENV_FILE_FORBIDDEN"
  exit 1
done

if docker inspect FrontMind-Website >/dev/null 2>&1; then
  website_mount_destinations="$(
    docker inspect FrontMind-Website \
      --format '{{range .Mounts}}{{println .Destination}}{{end}}'
  )"
  if printf '%s\n' "$website_mount_destinations" |
    grep -Eq '^/app/\.env'
  then
    echo "WEBSITE_PROJECT_ENV_MOUNT_FORBIDDEN"
    exit 1
  fi
fi

git fetch origin --prune
test "$(
  git rev-parse origin/main
)" = "$EXPECTED_WEBSITE_SHA"
git merge --ff-only "$EXPECTED_WEBSITE_SHA"
test "$(git rev-parse HEAD)" = "$EXPECTED_WEBSITE_SHA"
website_status="$(git status --short)"
test -z "$website_status"

test -f server/geo/contracts/provisioning-v2.fixture.json
test -f server/geo/contracts/payment-receipt-v1.fixture.json

test "$(
  git -C /frontmind-dashboard rev-parse HEAD
)" = "62810d58b4d892f4302f387849e4ff9e2116f489"
dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"

echo "WEBSITE_RELEASE_SOURCE_OK"
```

未知修改、未跟踪目录或 SHA 不匹配时立即停止。不得用 `reset`、`checkout`、`clean` 或
`stash` 抹掉现场，也不要为了绕过 Git 鉴权创建第二个不受控 clone。

### 17.2 在仓库外执行 Website Linux 隔离验证

Website 的 `dist` 是 release 中已提交并审计的部署产物。为证明该 SHA 可在 Linux
重建，同时避免重建过程修改正式工作树，先用 `git archive` 在仓库外创建只属于本次
release 的验证快照。下面使用已经固定且自带 pnpm `10.4.1` 的 Dashboard PDF 镜像，
不依赖 Website 基础镜像中的 Corepack：

```bash
(
  set -euo pipefail

  WEBSITE_SHA='eefe6234b23351b066295c0941ca6cff5ce9ea69'
  DASHBOARD_SHA='62810d58b4d892f4302f387849e4ff9e2116f489'
  VALIDATION_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_SHA"
  VALIDATION_CONTAINER='frontmind-website-release-validation-20260728'
  ARTIFACT_PARENT='/srv/frontmind-website-build-artifacts'
  ARTIFACT_ROOT="$ARTIFACT_PARENT/20260728-$WEBSITE_SHA"
  SOURCE_DIR="$ARTIFACT_ROOT/source"
  SOURCE_TAR="$ARTIFACT_ROOT/source.tar"
  DASHBOARD_SOURCE_DIR="$ARTIFACT_ROOT/dashboard-contract-source"
  DASHBOARD_SOURCE_TAR="$ARTIFACT_ROOT/dashboard-contract-source.tar"
  PNPM_STORE_DIR="$ARTIFACT_ROOT/pnpm-store"
  PNPM_STORE_TAR="$ARTIFACT_ROOT/pnpm-store.tar.gz"
  CREATED_VALIDATION_CONTAINER_ID=''

  cleanup_validation_container() {
    if [ -z "${CREATED_VALIDATION_CONTAINER_ID:-}" ]; then
      return
    fi
    current_id="$(
      docker inspect "$VALIDATION_CONTAINER" \
        --format '{{.Id}}' 2>/dev/null ||
        true
    )"
    if [ "$current_id" = "$CREATED_VALIDATION_CONTAINER_ID" ]; then
      docker rm -f "$CREATED_VALIDATION_CONTAINER_ID" \
        >/dev/null 2>&1 ||
        true
    fi
  }

  if docker inspect "$VALIDATION_CONTAINER" >/dev/null 2>&1; then
    echo "VALIDATION_CONTAINER_ALREADY_EXISTS"
    exit 1
  fi

  install -d -m 700 "$ARTIFACT_PARENT"
  if ! mkdir -m 700 -- "$ARTIFACT_ROOT"; then
    echo "WEBSITE_ARTIFACT_ROOT_CREATE_FAILED"
    exit 1
  fi
  install -d -m 700 "$SOURCE_DIR"
  install -d -m 700 "$DASHBOARD_SOURCE_DIR"
  install -d -m 700 "$PNPM_STORE_DIR"
  trap cleanup_validation_container EXIT INT TERM

  test "$(
    git -C /frontmind-website rev-parse HEAD
  )" = "$WEBSITE_SHA"
  website_status="$(
    git -C /frontmind-website status --short
  )"
  test -z "$website_status"
  test "$(
    git -C /frontmind-dashboard rev-parse HEAD
  )" = "$DASHBOARD_SHA"
  dashboard_status="$(
    git -C /frontmind-dashboard status --short
  )"
  test -z "$dashboard_status"
  docker image inspect "$VALIDATION_IMAGE" >/dev/null

  git -C /frontmind-website archive \
    --format=tar \
    --output="$SOURCE_TAR" \
    "$WEBSITE_SHA"
  tar -xf "$SOURCE_TAR" -C "$SOURCE_DIR"

  git -C /frontmind-dashboard archive \
    --format=tar \
    --output="$DASHBOARD_SOURCE_TAR" \
    "$DASHBOARD_SHA" \
    shared/contracts
  tar -xf "$DASHBOARD_SOURCE_TAR" \
    -C "$DASHBOARD_SOURCE_DIR"

  test -f "$SOURCE_DIR/package.json"
  test -f \
    "$SOURCE_DIR/server/geo/contracts/provisioning-v2.fixture.json"
  test -f \
    "$SOURCE_DIR/server/geo/contracts/payment-receipt-v1.fixture.json"
  test -f \
    "$DASHBOARD_SOURCE_DIR/shared/contracts/provisioning-v2.fixture.json"
  test -f \
    "$DASHBOARD_SOURCE_DIR/shared/contracts/payment-receipt-v1.fixture.json"

  CREATED_VALIDATION_CONTAINER_ID="$(
    docker run \
    --detach \
    --name "$VALIDATION_CONTAINER" \
    --network bridge \
    --env NODE_ENV=test \
    --entrypoint sh \
    --mount "type=bind,src=$SOURCE_DIR,dst=/app" \
    --mount "type=bind,src=$PNPM_STORE_DIR,dst=/pnpm-store" \
    --mount \
      "type=bind,src=$DASHBOARD_SOURCE_DIR,dst=/frontmind-dashboard,readonly" \
    --workdir /app \
    "$VALIDATION_IMAGE" \
      -lc 'exec sleep infinity'
  )"
  test -n "$CREATED_VALIDATION_CONTAINER_ID"

  docker exec "$CREATED_VALIDATION_CONTAINER_ID" sh -lc '
    set -eu
    test "$(pnpm --version)" = "10.4.1"
    pnpm install \
      --prod=false \
      --frozen-lockfile \
      --store-dir /pnpm-store
    echo "WEBSITE_DEPENDENCIES_READY"
  '

  docker network disconnect bridge "$CREATED_VALIDATION_CONTAINER_ID"
  test "$(
    docker inspect "$CREATED_VALIDATION_CONTAINER_ID" \
      --format '{{len .NetworkSettings.Networks}}'
  )" = "0"
  echo "WEBSITE_VALIDATION_NETWORK_DISABLED"

  docker exec "$CREATED_VALIDATION_CONTAINER_ID" sh -lc '
    set -eu
    cd /app
    test "$NODE_ENV" = "test"

    node node_modules/tsx/dist/cli.mjs \
      scripts/generate-geo-community-summary.ts --check
    node node_modules/typescript/bin/tsc --noEmit

    echo "RUNNING_SERVER_TESTS"
    node node_modules/vitest/vitest.mjs run \
      --config vitest.server.config.ts

    echo "RUNNING_CLIENT_TESTS"
    node node_modules/vitest/vitest.mjs run \
      --config vitest.client.config.ts

    echo "RUNNING_EQUIVALENT_PRODUCTION_BUILD"
    export NODE_ENV=production
    export VITE_CLIENT_PORTAL_URL=https://dashboard.frontmind.net/login
    export VITE_SITE_URL=https://www.frontmind.net
    export SITE_URL=https://www.frontmind.net
    export BUILD_DATE=2026-07-28

    node node_modules/tsx/dist/cli.mjs \
      scripts/generate-geo-community-summary.ts --check
    node node_modules/vite/bin/vite.js build
    node node_modules/tsx/dist/cli.mjs \
      scripts/generate-seo-assets.ts
    node node_modules/esbuild/bin/esbuild \
      server/index.ts \
      --platform=node \
      --packages=external \
      --bundle \
      --format=esm \
      --outdir=dist
    node scripts/copy-server-skills.mjs
    node scripts/audit-production-bundle.mjs

    test -f dist/index.js
    test -f dist/public/index.html
    node --check dist/index.js
    test "$(
      find dist/skills -type f | wc -l | tr -d " "
    )" = "22"
    diff -qr server/skills dist/skills >/dev/null
    grep -R -F \
      "https://dashboard.frontmind.net/login" \
      dist/public >/dev/null

    echo "WEBSITE_OFFLINE_EQUIVALENT_VALIDATION_OK"
  '

  tar -C "$SOURCE_DIR" \
    -czf "$ARTIFACT_ROOT/linux-built-dist.tar.gz" \
    dist
  tar -C "$ARTIFACT_ROOT" \
    -czf "$PNPM_STORE_TAR" \
    pnpm-store
  (
    cd "$ARTIFACT_ROOT"
    sha256sum \
      source.tar \
      dashboard-contract-source.tar \
      pnpm-store.tar.gz \
      linux-built-dist.tar.gz \
      >SHA256SUMS
  )

  cleanup_validation_container
  if docker inspect \
    "$CREATED_VALIDATION_CONTAINER_ID" \
    >/dev/null 2>&1
  then
    echo "VALIDATION_CONTAINER_CLEANUP_FAILED"
    exit 1
  fi
  CREATED_VALIDATION_CONTAINER_ID=''
  trap - EXIT INT TERM

  echo "WEBSITE_LINUX_BUILD_EVIDENCE_READY"
  echo "artifact_root=$ARTIFACT_ROOT"
)
```

本 release 的固定成功基线：

```text
Website server：20 files / 290 tests passed
Website client：15 files / 168 tests passed
Production build：passed
Production bundle audit：passed
dist/skills：22 files，与 server/skills 一致
```

网络只在验证快照第一次 `pnpm install` 阶段开启；该步骤把锁文件所需包保存在仓库外的
固定 pnpm store。断网后直接调用已经安装并锁定的本地 `tsx`、`tsc`、`vitest`、`vite`
和 `esbuild`。验证快照、pnpm store 归档及 Linux 构建证据都保存在仓库外，不能加入
Git。

### 17.3 安装正式依赖并验证 committed dist

正式 `/frontmind-website` 不在服务器重新构建，也不从验证快照复制产物；它使用固定
commit 内已经审计的 committed `dist`。先使用第 17.2 节保存的固定 pnpm store，在
无网络、无生产密钥的一次性容器中离线安装运行时依赖：

```bash
set -euo pipefail

DASHBOARD_SHA='62810d58b4d892f4302f387849e4ff9e2116f489'
WEBSITE_SHA='eefe6234b23351b066295c0941ca6cff5ce9ea69'
VALIDATION_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_SHA"
ARTIFACT_ROOT="/srv/frontmind-website-build-artifacts/20260728-$WEBSITE_SHA"
PNPM_STORE_TAR="$ARTIFACT_ROOT/pnpm-store.tar.gz"

test "$(
  git -C /frontmind-website rev-parse HEAD
)" = "$WEBSITE_SHA"
test -f "$PNPM_STORE_TAR"
(
  cd "$ARTIFACT_ROOT"
  sha256sum -c SHA256SUMS
)
website_status="$(
  git -C /frontmind-website status --short
)"
test -z "$website_status"

docker run --rm \
  --network none \
  --env NODE_ENV=production \
  --entrypoint sh \
  --mount type=bind,src=/frontmind-website,dst=/app \
  --mount \
    "type=bind,src=$ARTIFACT_ROOT,dst=/validation-artifacts,readonly" \
  --workdir /app \
  "$VALIDATION_IMAGE" \
  -lc '
    set -eu
    test "$(pnpm --version)" = "10.4.1"
    install -d -m 700 /tmp/frontmind-pnpm-store-root
    tar -xzf \
      /validation-artifacts/pnpm-store.tar.gz \
      -C /tmp/frontmind-pnpm-store-root
    test -d /tmp/frontmind-pnpm-store-root/pnpm-store
    pnpm install \
      --prod \
      --offline \
      --frozen-lockfile \
      --package-import-method copy \
      --store-dir /tmp/frontmind-pnpm-store-root/pnpm-store
  '

website_status="$(
  git -C /frontmind-website status --short
)"
test -z "$website_status"
echo "WEBSITE_PRODUCTION_DEPENDENCIES_READY"
```

再在无网络、只读挂载中验证正式 committed `dist`：

```bash
set -euo pipefail

WEBSITE_SHA='eefe6234b23351b066295c0941ca6cff5ce9ea69'
DASHBOARD_SHA='62810d58b4d892f4302f387849e4ff9e2116f489'
VALIDATION_IMAGE="frontmind-dashboard-node:22.22.2-pdf-$DASHBOARD_SHA"

test "$(
  git -C /frontmind-website rev-parse HEAD
)" = "$WEBSITE_SHA"
test "$(
  git -C /frontmind-website ls-tree -r --name-only \
    "$WEBSITE_SHA" -- dist | wc -l | tr -d " "
)" = "463"

docker run --rm \
  --network none \
  --env NODE_ENV=production \
  --entrypoint sh \
  --mount type=bind,src=/frontmind-website,dst=/app,readonly \
  --workdir /app \
  "$VALIDATION_IMAGE" \
  -lc '
    set -eu
    test -f dist/index.js
    test -f dist/public/index.html
    node --check dist/index.js
    node scripts/audit-production-bundle.mjs
    test "$(find dist/skills -type f | wc -l | tr -d " ")" = "22"
    diff -qr server/skills dist/skills >/dev/null
    grep -R -F \
      "https://dashboard.frontmind.net/login" \
      dist/public >/dev/null
    echo "WEBSITE_COMMITTED_DIST_OFFLINE_OK"
  '

website_status="$(
  git -C /frontmind-website status --short
)"
test -z "$website_status"
git -C /frontmind-website diff --check
echo "WEBSITE_FINAL_WORKTREE_OK"
```

正式工作树此时必须仍然 clean。不要把 Linux 重建产生的 hashed asset 差异留在服务器
仓库，也不要用 `git checkout` 或 `reset` 恢复；仓库外快照从设计上避免了这个问题。

### 17.4 配置 Website 运行环境

新建 Website 访问统计持久目录：

```bash
install -d -m 700 /srv/frontmind-website
```

Website 的 session secret 必须是独立随机值，不能使用邀请码、ZPAY Key、Dashboard
service token 或其他现有密码代替。首次初始化时在安全终端执行一次
`openssl rand -base64 48`；该终端必须未录屏、未共享且不采集输出，不能使用服务器 SSH
或 1Panel Web 终端。只把结果保存到密码管理器和下面对应的 1Panel 服务端变量；不要
写入本手册或 Git。生产邀请码使用已经确定并受控保存的值，不由随机命令覆盖。

在 `FrontMind-Website → 环境变量` 配置或保留：

```env
NODE_ENV=production
PORT=8888

FRONTMIND_GEO_INVITE_CODE=<已经确定并受控保存的邀请码>
FRONTMIND_GEO_SESSION_SECRET=<独立随机值，至少32字符>

FRONTMIND_ZPAY_PID=<现有商户PID>
FRONTMIND_ZPAY_KEY=<现有商户密钥>

FRONTMIND_PRESALES_AGENT_URL=http://frontmind-dashboard:3001/api/internal/presales
FRONTMIND_PRESALES_SERVICE_TOKEN=<与Dashboard完全一致>
FRONTMIND_AGENT_PROVISIONING_URL=http://frontmind-dashboard:3001/api/internal/provisioning
FRONTMIND_PROVISIONING_SERVICE_TOKEN=<与Dashboard完全一致>
FRONTMIND_AGENT_INTERNAL_HTTP_HOSTS=frontmind-dashboard

FRONTMIND_PUBLIC_BASE_URL=https://www.frontmind.net
FRONTMIND_TRUST_PROXY=<按实际OpenResty/CDN拓扑确认的CIDR、名称或hop count>
FRONTMIND_GEO_SKILLS_DIR=/app/dist/skills
FRONTMIND_VISITOR_STATS_FILE=/var/lib/frontmind-website/visitor-stats.json
```

两枚 service token 用途不同，必须与 Dashboard 对应值逐项一致。`ZPAY` 值沿用已经核验
的生产商户配置，不因本次 Dashboard 替换而重新生成。邀请码和 session secret 只存在
Website 服务端；session secret 用于签名邀请会话 Cookie，不是用户密码。

`FRONTMIND_TRUST_PROXY` 不能机械照抄默认值。必须根据实际链路
`客户端/CDN → OpenResty → 127.0.0.1:8888 → Docker 容器` 核对代理跳数或可信网段，
并通过 canary 确认 Express 看到的是预期客户端地址而不是所有用户共用的 Docker 网关
地址。

下面四个值只在生成 committed `dist` 时生效，已经由第 17.2 节固定并由产物扫描验证；
修改 1Panel 运行时变量不会改变已构建浏览器文件：

```env
VITE_CLIENT_PORTAL_URL=https://dashboard.frontmind.net/login
VITE_SITE_URL=https://www.frontmind.net
SITE_URL=https://www.frontmind.net
BUILD_DATE=2026-07-28
```

Website 绝不能配置或读取以下 Dashboard 专属值：

```text
FRONTMIND_CREDENTIAL_ENCRYPTION_KEY
FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET
FRONTMIND_MONITOR_API_KEY
售前 API Key
```

除公开 URL 外，任何 Key、secret、password、service token 都不能使用 `VITE_` 前缀。
生产不在 `/frontmind-website` 或容器 `/app` 创建 `.env`、`.env.local`、
`.env.production`。1Panel 自己管理的内部 `/.env` 不得挂载到 `/app/.env*`。

1Panel 最终运行参数：

```text
项目目录：/frontmind-website
容器工作目录：/app
启动命令：pnpm start
容器名称：FrontMind-Website
宿主机映射：127.0.0.1:8888 → 8888
网络：1panel-network
挂载：/srv/frontmind-website → /var/lib/frontmind-website
反向代理：www.frontmind.net → http://127.0.0.1:8888
```

保存前先从已停止的现有容器标签锁定真实 Compose 对象，避免猜项目名后启动第二套
Website：

```bash
set -euo pipefail

WEBSITE_RUNTIME_DIR="$(
  docker inspect FrontMind-Website \
    --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
)"
WEBSITE_COMPOSE_PROJECT="$(
  docker inspect FrontMind-Website \
    --format '{{ index .Config.Labels "com.docker.compose.project" }}'
)"
WEBSITE_COMPOSE_FILE="$(
  docker inspect FrontMind-Website \
    --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'
)"
WEBSITE_COMPOSE_SERVICE="$(
  docker inspect FrontMind-Website \
    --format '{{ index .Config.Labels "com.docker.compose.service" }}'
)"
WEBSITE_CONFIGURED_IMAGE="$(
  docker inspect FrontMind-Website --format '{{.Config.Image}}'
)"

test "$WEBSITE_RUNTIME_DIR" = \
  "/opt/1panel/runtime/node/FrontMind-Website"
test -n "$WEBSITE_COMPOSE_PROJECT"
test -n "$WEBSITE_COMPOSE_SERVICE"
test -n "$WEBSITE_CONFIGURED_IMAGE"
case "$WEBSITE_COMPOSE_FILE" in
  /*) ;;
  *)
    echo "WEBSITE_COMPOSE_FILE_INVALID"
    exit 1
    ;;
esac
case "$WEBSITE_COMPOSE_FILE" in
  *,*)
    echo "WEBSITE_MULTIPLE_COMPOSE_FILES_REVIEW_REQUIRED"
    exit 1
    ;;
esac
test -d "$WEBSITE_RUNTIME_DIR"
test -f "$WEBSITE_COMPOSE_FILE"

docker compose \
  --project-name "$WEBSITE_COMPOSE_PROJECT" \
  --project-directory "$WEBSITE_RUNTIME_DIR" \
  --file "$WEBSITE_COMPOSE_FILE" \
  config --services |
  grep -Fx "$WEBSITE_COMPOSE_SERVICE"

docker compose \
  --project-name "$WEBSITE_COMPOSE_PROJECT" \
  --project-directory "$WEBSITE_RUNTIME_DIR" \
  --file "$WEBSITE_COMPOSE_FILE" \
  config --images |
  grep -Fx "$WEBSITE_CONFIGURED_IMAGE"

echo "WEBSITE_COMPOSE_CONTEXT_OK"
```

禁止运行会展开敏感环境变量的裸 `docker compose config`。通过 1Panel 只保存并重建这
一个现有运行环境，不创建第二个 Compose project，也不执行 `down -v`。首次启动保留
关闭自动重启或最多使用有界 `on-failure:5`，全部健康后才恢复正式策略。

保存并重建后，执行无回显配置门：

```bash
set -euo pipefail

docker exec FrontMind-Website node --input-type=module -e '
const env = process.env;

const exact = {
  NODE_ENV: "production",
  PORT: "8888",
  FRONTMIND_PRESALES_AGENT_URL:
    "http://frontmind-dashboard:3001/api/internal/presales",
  FRONTMIND_AGENT_PROVISIONING_URL:
    "http://frontmind-dashboard:3001/api/internal/provisioning",
  FRONTMIND_AGENT_INTERNAL_HTTP_HOSTS: "frontmind-dashboard",
  FRONTMIND_PUBLIC_BASE_URL: "https://www.frontmind.net",
  FRONTMIND_GEO_SKILLS_DIR: "/app/dist/skills",
  FRONTMIND_VISITOR_STATS_FILE:
    "/var/lib/frontmind-website/visitor-stats.json",
};
for (const [name, value] of Object.entries(exact)) {
  if (env[name] !== value) process.exit(1);
}

const value = name => env[name]?.trim() ?? "";
const unsafePrefix = input =>
  /^(?:replace[-_ ]?with|change[-_ ]?me|example|placeholder|your[-_ ])/i
    .test(input);
const unresolved = input =>
  !input ||
  /[<>\r\n]/.test(input) ||
  unsafePrefix(input);
const publicTokenMarkers = [
  "replace-with",
  "replace_with",
  "change-me",
  "change_me",
  "placeholder",
  "example",
  "your-token",
  "your_token",
];

const invite = value("FRONTMIND_GEO_INVITE_CODE");
const session = value("FRONTMIND_GEO_SESSION_SECRET");
const presalesToken = value("FRONTMIND_PRESALES_SERVICE_TOKEN");
const provisioningToken =
  value("FRONTMIND_PROVISIONING_SERVICE_TOKEN");
const zpayPid = value("FRONTMIND_ZPAY_PID");
const zpayKey = value("FRONTMIND_ZPAY_KEY");
const zpayCid = value("FRONTMIND_ZPAY_CID");
const trustProxy = value("FRONTMIND_TRUST_PROXY");

if (
  !/^[A-Za-z0-9._-]{16,128}$/.test(invite) ||
  invite === "frontmind666"
) process.exit(1);
if (
  session.length < 32 ||
  /\s/.test(session) ||
  unresolved(session)
) process.exit(1);
if (
  presalesToken.length < 32 ||
  /\s/.test(presalesToken) ||
  unresolved(presalesToken)
) {
  process.exit(1);
}
if (
  provisioningToken.length < 32 ||
  /\s/.test(provisioningToken) ||
  unresolved(provisioningToken) ||
  publicTokenMarkers.some(
    marker => provisioningToken.toLowerCase().includes(marker),
  )
) process.exit(1);
if (presalesToken === provisioningToken) process.exit(1);

if (!/^[A-Za-z0-9]{2,64}$/.test(zpayPid)) process.exit(1);
if (
  zpayKey.length < 8 ||
  /\s/.test(zpayKey) ||
  unresolved(zpayKey)
) process.exit(1);
if (zpayCid && !/^\d+(?:,\d+)*$/.test(zpayCid)) process.exit(1);
if (unresolved(trustProxy)) process.exit(1);

const dashboardOnly = [
  "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY",
  "FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET",
  "FRONTMIND_MONITOR_API_KEY",
];
if (dashboardOnly.some(name => env[name])) process.exit(1);
if (
  Object.keys(env).some(
    name =>
      name.startsWith("VITE_") &&
      /(KEY|TOKEN|SECRET|PASSWORD)/.test(name),
  )
) process.exit(1);

console.log("WEBSITE_RUNTIME_ENV_OK");
'

docker exec FrontMind-Website sh -lc '
set -eu
for path in /app/.env*; do
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    continue
  fi
  if [ "$path" = "/app/.env.example" ]; then
    test -f "$path"
    test ! -L "$path"
    continue
  fi
  echo "WEBSITE_PROJECT_ENV_FILE_FORBIDDEN"
  exit 1
done
echo "WEBSITE_PROJECT_ENV_FILES_OK"
'

website_mount_destinations="$(
  docker inspect FrontMind-Website \
    --format '{{range .Mounts}}{{println .Destination}}{{end}}'
)"
if printf '%s\n' "$website_mount_destinations" |
  grep -Eq '^/app/\.env'
then
  echo "WEBSITE_PROJECT_ENV_MOUNT_FORBIDDEN"
  exit 1
fi

echo "WEBSITE_PROJECT_ENV_MOUNTS_OK"
```

### 17.5 Website 启动、私有接口和公网健康门

先验证容器、端口、挂载和私有 DNS：

```bash
set -euo pipefail

test "$(
  git -C /frontmind-website rev-parse HEAD
)" = "eefe6234b23351b066295c0941ca6cff5ce9ea69"
website_status="$(
  git -C /frontmind-website status --short
)"
test -z "$website_status"

test "$(
  docker inspect FrontMind-Website --format '{{.State.Running}}'
)" = "true"
test "$(
  docker inspect FrontMind-Website --format '{{.State.Restarting}}'
)" = "false"
test "$(
  docker port FrontMind-Website 8888/tcp
)" = "127.0.0.1:8888"
test "$(
  docker inspect FrontMind-Website --format '{{.Config.WorkingDir}}'
)" = "/app"

docker exec FrontMind-Website getent hosts frontmind-dashboard >/dev/null

docker inspect FrontMind-Website \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' |
  grep -Fx '1panel-network'

docker inspect FrontMind-Website \
  --format '{{json .Mounts}}' |
  docker exec -i FrontMind-Website node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const mounts = JSON.parse(input);
  const expected = new Map([
    ["/app", "/frontmind-website"],
    ["/var/lib/frontmind-website", "/srv/frontmind-website"],
  ]);
  for (const [destination, source] of expected) {
    const mount = mounts.find(
      item => item.Destination === destination,
    );
    if (!mount || mount.Source !== source || mount.RW !== true) {
      process.exit(1);
    }
  }
  console.log("WEBSITE_CODE_AND_PERSISTENT_MOUNTS_OK");
});
'

docker exec FrontMind-Website sh -lc '
set -eu
test "$(pwd)" = "/app"
test "$(pnpm --version)" = "10.4.1"
test -f /app/dist/index.js
test -f /app/dist/public/index.html

probe="$(
  mktemp \
    /var/lib/frontmind-website/.frontmind-write-test.XXXXXX
)"
renamed="$probe.renamed"
printf "ok\n" >"$probe"
mv -- "$probe" "$renamed"
test -s "$renamed"
rm -f -- "$renamed"

node -e "
const fs = require(\"node:fs\");
const ready = fs.readdirSync(\"/proc\")
  .filter(name => /^[0-9]+$/.test(name))
  .some(name => {
    try {
      const command = fs
        .readFileSync(\"/proc/\" + name + \"/cmdline\", \"utf8\")
        .replace(/\\0/g, \" \");
      return /node(?:\\s+|.*\\/)dist\\/index\\.js/.test(command);
    } catch {
      return false;
    }
  });
if (!ready) process.exit(1);
"

echo "WEBSITE_RUNTIME_PROCESS_AND_WRITE_OK"
'

docker inspect FrontMind-Website \
  --format 'configured_image={{.Config.Image}} image_id={{.Image}}'
```

验证 Website 到 Dashboard 的三条真实私有链路：

```bash
docker exec FrontMind-Website node --input-type=module -e '
const checks = [
  {
    name: "PRESALES",
    url: "http://frontmind-dashboard:3001/api/internal/presales/status",
    header: "x-frontmind-service-token",
    token: process.env.FRONTMIND_PRESALES_SERVICE_TOKEN,
    valid: p =>
      p?.ok === true &&
      p?.credentialConfigured === true &&
      p?.monitorCredentialConfigured === true &&
      p?.publicUrlConfigured === true,
  },
  {
    name: "PAYMENT_LEDGER",
    url: "http://frontmind-dashboard:3001/api/internal/provisioning/payment-receipts/ready",
    header: "x-frontmind-provisioning-token",
    token: process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN,
    valid: p => p?.schemaVersion === 1 && p?.ready === true,
  },
  {
    name: "PROJECT_LEDGER",
    url: "http://frontmind-dashboard:3001/api/internal/provisioning/project-orders/ready",
    header: "x-frontmind-provisioning-token",
    token: process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN,
    valid: p => p?.schemaVersion === 1 && p?.ready === true,
  },
];
for (const check of checks) {
  if (!check.token) throw new Error(`${check.name}_TOKEN_MISSING`);
  const response = await fetch(check.url, {
    headers: { [check.header]: check.token },
    signal: AbortSignal.timeout(15_000),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok || !check.valid(payload)) {
    throw new Error(`${check.name}_NOT_READY_HTTP_${response.status}`);
  }
  console.log(`${check.name}_READY`);
}
'
```

这里必须使用 `frontmind-dashboard:3001`，不能使用 Website 容器自己的
`127.0.0.1`。然后从维护规则已放行的验收源 IP 验证本机和公网 Website 健康；普通访客
此时仍然只看到维护页：

```bash
set -euo pipefail

WEBSITE_INITIAL_RESTART_COUNT="$(
  docker inspect FrontMind-Website --format '{{.RestartCount}}'
)"

curl -fsS \
  --connect-timeout 5 \
  --max-time 20 \
  http://127.0.0.1:8888/healthz |
jq -e '
  .status == "ok" and
  .dependencies.status == "ok" and
  .dependencies.agent.credentialConfigured == true and
  .dependencies.agent.monitorCredentialConfigured == true and
  .dependencies.agent.publicUrlConfigured == true and
  .dependencies.projectOrderRegistry.ready == true and
  .dependencies.paymentReceiptLedger.ready == true and
  ([.skills[] | select(.status == "ok")] | length) == 5 and
  ([.skills[].name] | sort) ==
    ([
      "website-one-shot-kb-builder",
      "geo-question-recommender",
      "geo-knowledge-answer-verifier",
      "geo-current-state-evaluator",
      "geo-optimization-outcome-forecaster"
    ] | sort)
'

curl -fsS \
  --connect-timeout 5 \
  --max-time 20 \
  https://www.frontmind.net/healthz |
jq -e '
  .status == "ok" and
  .dependencies.status == "ok" and
  .dependencies.agent.credentialConfigured == true and
  .dependencies.agent.monitorCredentialConfigured == true and
  .dependencies.agent.publicUrlConfigured == true and
  .dependencies.projectOrderRegistry.ready == true and
  .dependencies.paymentReceiptLedger.ready == true and
  ([.skills[] | select(.status == "ok")] | length) == 5 and
  ([.skills[].name] | sort) ==
    ([
      "website-one-shot-kb-builder",
      "geo-question-recommender",
      "geo-knowledge-answer-verifier",
      "geo-current-state-evaluator",
      "geo-optimization-outcome-forecaster"
    ] | sort)
'

test "$(
  docker inspect FrontMind-Website --format '{{.RestartCount}}'
)" = "$WEBSITE_INITIAL_RESTART_COUNT"

echo "WEBSITE_LOCAL_AND_PUBLIC_HEALTH_OK"
```

最后确认没有邀请码 Cookie 时，本机和公网接口都以 JSON `401` 失败关闭：

```bash
set -euo pipefail

for origin in \
  http://127.0.0.1:8888 \
  https://www.frontmind.net
do
  body="$(mktemp)"
  headers="$(mktemp)"
  trap 'rm -f -- "$body" "$headers"' EXIT
  code="$(
    curl -sS \
      --connect-timeout 5 \
      --max-time 20 \
      -D "$headers" \
      -o "$body" \
      -w '%{http_code}' \
      "$origin/api/geo/session"
  )"
  test "$code" = "401"
  grep -qi '^content-type: application/json' "$headers"
  jq -e \
    '.ok == false and .error.code == "INVITE_REQUIRED"' \
    "$body" >/dev/null
  rm -f -- "$body" "$headers"
  trap - EXIT
done

grep -R -F \
  "https://dashboard.frontmind.net/login" \
  /frontmind-website/dist/public >/dev/null

echo "WEBSITE_UNAUTHENTICATED_BOUNDARY_OK"
```

## 18. 端到端业务 canary 验收

保持 Website 维护页和写入冻结，只使用专门创建的非客户、非敏感 canary 数据。按下列
顺序逐项记录操作时间、操作者、项目 ID/订单 ID 的非敏感标识和结果：

1. 用系统管理员登录 Dashboard，确认管理员工作区、售前控制面、用户管理、交付控制和
   问题监控正常。
2. 创建一个普通 canary 用户并登录，确认普通用户看不到 API Key、Key 脱敏片段、上游
   积分、管理员身份、权限字段或内部账本详情。
3. 从 Website 输入生产邀请码，确认 session Cookie 可用、退出后失效，并确认未登录
   `/api/geo/session` 仍返回 JSON `401/INVITE_REQUIRED`。
4. 在 Website 完成一次 Base 创建，下载并检查 Base ZIP；确认 Website 的
   `website-one-shot-kb-builder` 正常运行，只有可信 assistant 输出被接受。
5. 在 Website 生成并确认 20 个品牌问题；确认 Website 的
   `geo-question-recommender` 产出的题目、分类以及传给 Dashboard 的契约正确。
6. 在 Dashboard 分别用非敏感 canary 输入运行
   `socratic-kb-builder`、`brand-question-portfolio` 和
   `response-logic-builder`，确认三个 Dashboard 运行时 Skill 都能加载、生成可信
   assistant 输出，并把结果正确写入对应工作区。
7. 选一个平台完成固定 5 次真实监控，验证监控专用 Key 生效、答案/引用/来源正确渲染，
   日志和错误响应不包含原始上游敏感内容。
8. 完成现状评估和四周优化预测，验证 Website 的五个运行时 Skill 全部参与预期流程。
9. 完成一次测试支付或支付沙箱回调，核对支付回执账本只产生一条有效记录；重复回调
   不得重复入账。
10. 完成项目订单创建、签约确认、开户和知识导入，核对项目订单账本的幂等键和最终状态；
    重试不得重复开户、重复扣费或重复提交。
11. 在普通用户 Dashboard 检查 Base、20 题、监控、引用、评估和预测结果；桌面端及
    390px 宽度下的简略看板都必须可用。
12. 从 Website 的导航和购买后流程进入
    `https://dashboard.frontmind.net/login`，不得跳到旧 Agent 域名。
13. 查看 Dashboard/Website 服务端日志、浏览器控制台、Network 响应和 Axios 错误，
    确认不含 API Key、service token、数据库 URI、私钥或上游原始敏感响应。
14. 按业务保留策略清理 canary 数据，再次核对两个账本没有因清理发生 update/delete
    破坏。

最后重新执行：

```text
Dashboard 本机与公网 health
Website 本机与公网 health
Dashboard 公网 /api/internal/* = 404
Website → Dashboard 三条 READY
Dashboard 三条 READY
3001 与 8888 的唯一 loopback 监听
两个容器 restart count 不增长
```

任一 canary 或安全门失败都保持维护状态，不恢复正式流量，也不删除旧 Agent。

## 19. 首份备份与隔离恢复演练

canary 通过后仍保持 Website 写入冻结。以同一恢复点建立首份新系统备份，备份范围必须
同时包含：

1. 新数据库 `frontmind_dashboard`，包括 48 张表、Drizzle 迁移账本和两个不可变账本
   trigger；
2. `/srv/frontmind-dashboard/prepared-files`；
3. `/srv/frontmind-dashboard/dashboard-assets`；
4. `/srv/frontmind-website/visitor-stats.json`（文件尚未产生时记录“零文件”）；
5. 固定 Dashboard PDF image、image ID、基础镜像 digest 和包版本；
6. `/srv/frontmind-website-build-artifacts/20260728-<Website SHA>`；
7. Dashboard/Website 两个 SHA、build version、1Panel 运行参数和 Nginx 配置；
8. 密码管理器中本次新系统的密钥条目 ID、恢复权限和保管责任人。发布记录只写条目 ID，
   不写真实值。

使用 1Panel 备份功能或已批准的备份系统建立同一恢复点。每一个对象都记录：

```text
备份任务 ID
开始/完成时间
源对象的精确名称
目标对象或远端 version ID
文件/数据库大小
校验和
保留策略
执行人和复核人
```

备份完成不等于可恢复。必须执行一次隔离恢复演练：

1. 新建与在线库不同的隔离数据库，例如
   `frontmind_dashboard_restore_drill_20260728`，并使用独立临时数据库用户；
2. 把数据库备份恢复到隔离库，绝不能把恢复目标设为在线
   `frontmind_dashboard`；
3. 把三个 Dashboard 目录恢复到
   `/srv/frontmind-dashboard-restore-drill/20260728/` 下三个精确子目录，把 Website
   访问统计恢复到同一隔离根目录；绝不能覆盖在线目录；
4. 使用不连接公网、不接收正式流量的一次性容器挂载恢复对象；
5. 验证恢复库的 Drizzle 账本恰好 35 条、最新为
   `0034_known_scarlet_spider`、表数为 48、trigger 数为 2，并与冻结时关键业务表
   行数核对；
6. 比较每个持久目录的文件数、总字节数、相对路径、权限和校验和；
7. 从密码管理器受控取用凭据加密密钥和 ICP 密钥，只做“可成功解密”的应用级断言，
   不输出解密内容或密钥；
8. 启动隔离 Dashboard 做本机 `/healthz`、管理员登录和只读业务抽查，不连接正式
   Website；
9. 记录恢复开始/结束时间、所有检查结果和演练负责人。

只有数据库、三个 Dashboard 目录、Website 访问统计和两类加密数据全部可恢复，才能
出现固定签字结论：

```text
NEW_SYSTEM_BACKUP_COMPLETE
ISOLATED_RESTORE_DRILL_PASSED
```

演练完成后，只根据演练记录中的精确数据库名、用户主体和规范化目录在 1Panel 中清理
临时对象。不得使用模糊路径、通配符、宽泛 `rm -rf`，也不得误删在线备份。

## 20. 恢复正式流量并观察至少 24 小时

第 18 节 canary、第 19 节备份和隔离恢复全部签字通过后：

1. 解除 Website 维护页；
2. 恢复支付、开户、邀请会话和正式写入；
3. 记录恢复流量时间、两个 release SHA、Dashboard image ID、build version、备份任务
   ID 和当班人员；
4. 旧 Agent 继续保持停止和禁止自动重启，仍不删除。

至少在以下时间点执行并保存一份不含敏感值的健康记录：

| 时间点         | 必查内容                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| 恢复流量后立即 | 两个公网 health、三条私有 READY、公网 internal 404、端口与 restart count |
| 15 分钟        | 5xx、容器状态、数据库连接、支付/订单队列、磁盘和持久目录                 |
| 1 小时         | 登录、普通用户简略看板、Website 邀请会话、账本幂等状态                   |
| 4 小时         | 上游任务、监控、引用、prepared-files 清理和日志脱敏                      |
| 12 小时        | 两个容器 restart count、备份任务、磁盘增长、异常告警                     |
| 24 小时        | 重跑全部技术健康门，并完成至少一次真实业务抽查                           |

观察期间若发生非预期重启、5xx 持续增长、账本不一致、敏感日志、内部接口公网暴露或
数据无法解密，立即重新冻结写入并进入第 22 节的新系统回滚/前向修复流程。不能启动旧
Agent 接管流量。

只有连续至少 24 小时稳定、覆盖一次真实业务检查且再次完成书面签字，才允许永久退役
旧 Agent。

## 21. 永久退役旧 Agent

只有第 18–20 节已签字验收、新 Dashboard 连续稳定至少 24 小时且新系统备份已通过
隔离恢复后，才能永久删除旧生产资产。旧 GitHub `frontmind-agent` 仓库始终
保留为历史仓库，不删除、不归档本地改动到该仓库，也不接收 Dashboard push。

严格按以下顺序执行，每一步只处理第 3 节清单中已经双人复核的一个精确目标：

1. 再次确认旧 Agent 已停止且自动重启关闭，并确认 `3001` 的唯一监听者是
   `FrontMind-Dashboard`。
2. 在 1Panel 中删除清单所列的旧 Agent 运行环境；删除前逐字比对运行环境名称和容器
   ID，确认不是 `FrontMind-Dashboard`。删除弹窗不得勾选含义不明确的级联删除数据、
   卷或共享镜像选项。
3. 在 1Panel 中删除 `agent.frontmind.net` 对应的精确网站、反向代理和证书绑定；随后在
   DNS 控制台按清单中的精确记录 ID 删除 `agent.frontmind.net` DNS 记录。不得影响
   `dashboard.frontmind.net` 或 `www.frontmind.net`。
4. 对旧服务器代码目录执行只读核对：显示其规范化绝对路径、挂载来源和一级内容，并确认
   `realpath -e` 结果、`findmnt`、symlink 状态和所有容器 Mount Source；确认路径不等于、
   不包含且不指向 `/frontmind-dashboard`、`/srv/frontmind-dashboard`、三个新目录、
   `/` 或其他父目录，并确认没有新容器引用。只在 1Panel 文件管理器中选中清单记录的
   那个精确旧叶子目录删除。
5. 在 1Panel 数据库界面逐字核对数据库实例、旧数据库名、完整旧 `username@host` 主体
   和 `SHOW GRANTS`；确认该主体未被 Website、新 Dashboard 或其他数据库共享，且
   Dashboard 当前连接的是 `frontmind_dashboard`。先撤销旧库授权并删除该精确旧用户
   主体，再删除旧数据库。发现共享授权立即停止；不得删除 `frontmind_dashboard` 或其
   用户。
6. 分别核对旧 `prepared-files`、旧 `dashboard-assets`、旧 ICP 目录及清单中的其他旧
   持久目录/卷。每个目标都要显示规范化绝对路径或精确卷名，确认不指向三个
   `/srv/frontmind-dashboard/...` 新目录后，在 1Panel 中逐项删除。命名卷还必须先
   `inspect` 并确认没有任何其他容器引用。
7. 先按精确计划任务 ID 停用旧 Agent 的备份、快照、同步、清理和导出任务；再按任务
   ID、快照 ID、规范化导出路径、远端 bucket/object/version ID 逐个永久删除旧副本。
   若远端存储有版本控制或回收站，还要确认永久删除语义。不得删除新 Dashboard 的备份。
8. 在上游提供方按凭据 ID/名称撤销只属于旧 Agent 的外部 Key 和 token，不读取、不
   回显真实值；共享情况不清楚时立即停止。
9. 重新执行 Dashboard、Website 私有接口、公网 `/api/internal/* = 404`、登录和账本
   健康检查，确认退役动作未影响新系统。

禁止使用通配符、变量展开、前缀匹配、批量容器/数据库删除或宽泛 `rm -rf`。本文故意不
提供旧目录删除命令：任何删除都必须在 1Panel/DNS 界面中针对已记录的精确名称、ID 或
规范化绝对路径逐项完成。目标不完全明确或与新资产有交叉时立即停止。

## 22. 回滚边界

旧 Agent、旧数据库和旧持久目录不是回滚目标，即使它们在最终删除前仍暂存于服务器，也
不得重新承接 Dashboard 流量。

- 尚未产生新业务数据时：停止 Dashboard，精确删除并重建它自己的
  `frontmind_dashboard` 空库和三个 `/srv/frontmind-dashboard/...` 新持久目录，重新执行
  `0000`–`0034` 共 35 个迁移，再重新验收。
- 已产生新业务数据时：先冻结 Website 支付、开户和写入，保存故障现场，只允许恢复
  新 Dashboard 自己的已验证数据库与持久目录备份，或进行向前修复。
- 只有 Website 失败时：Website 只能回滚到与当前 Dashboard 内部接口契约兼容的已验证
  产物，内部地址仍为 `frontmind-dashboard:3001`。

永久删除旧数据库后，不存在、也不允许设计“回滚到旧数据库”的路径。无法确认新系统备份
可恢复时保持维护状态，不得用旧 Agent 应急。

## 23. 后续更新

日后更新不能简化成“在服务器 `git pull` 后直接重启”。首次部署中的数据库创建、密钥
生成、管理员初始化、域名创建和旧 Agent 退役不再重复，但每一个 release 仍必须经过
源码门、构建门、迁移判断和健康门。

### 23.1 先在本地形成可发布 release

Dashboard 更新只在本地 `frontmind-dashboard` 开发和验证，完成：

```text
pnpm check
相关测试或完整 pnpm test
pnpm build（未设置可选覆盖变量时自动生成构建标识）
pnpm audit:production
git diff --check
产物、Skill、迁移和敏感扫描
```

然后 commit 并 push 到新的 Private Repo `xiafanzeng/frontmind-dashboard`。旧
`frontmind-agent` 仓库永远不接收更新。Website 更新同样先在本地验证、生成并提交
committed `dist`，再 push 到 `frontmind-website`；服务器不是开发或修复代码的地方。

每次 release 记录新的 Dashboard SHA、Website SHA（若有）、构建自动生成的版本标识、变更类型和
回滚对象。

第 7、10、17 节中的 SHA、image tag、build version、测试数量、扫描哈希和构建证据目录
是首次 release 的不可变记录。后续更新只复用其流程结构；必须先用本次本地验收结果生成
一套新的固定值并逐项替换，不能为了通过检查把旧值临时注释或放宽。

### 23.2 先判断这次更新属于哪一类

| 变更                                    | 必须动作                                                            |
| --------------------------------------- | ------------------------------------------------------------------- |
| 仅 Dashboard 应用代码/UI                | fetch 后合并固定 SHA、隔离测试、build/audit、重启 Dashboard、健康门 |
| `pnpm-lock.yaml` 或依赖变化             | 额外执行 frozen install，并重新完成依赖和 bundle 审计               |
| 新增 Drizzle SQL/journal 条目           | 先备份并冻结写入，只执行 pending migrations，再启动新应用           |
| PDF Dockerfile、基础 digest、系统包变化 | 重新构建和审计固定派生镜像                                          |
| 环境变量契约变化                        | 在 1Panel 协调更新所有消费者，执行无回显环境门后重建容器            |
| Presales/Provisioning/支付/订单契约变化 | Dashboard 与 Website 必须作为同一兼容 release 验证和部署            |
| 仅 Website 内容或前端                   | 运行 Website 隔离验证、审计 committed `dist`，只重建 Website        |
| 密钥轮换                                | 使用独立轮换计划，不和普通代码发布混在一起                          |

### 23.3 Dashboard 服务器更新顺序

进入维护窗口后执行只读源码门：

```bash
set -euo pipefail

EXPECTED_DASHBOARD_SHA='<填入本次已审核的40位Dashboard SHA>'

printf '%s\n' "$EXPECTED_DASHBOARD_SHA" |
  grep -Eq '^[0-9a-f]{40}$'
test "$(git -C /frontmind-dashboard branch --show-current)" = "main"
dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"
git -C /frontmind-dashboard fetch origin --prune
test "$(
  git -C /frontmind-dashboard rev-parse origin/main
)" = "$EXPECTED_DASHBOARD_SHA"
git -C /frontmind-dashboard merge \
  --ff-only \
  "$EXPECTED_DASHBOARD_SHA"
test "$(
  git -C /frontmind-dashboard rev-parse HEAD
)" = "$EXPECTED_DASHBOARD_SHA"
dashboard_status="$(
  git -C /frontmind-dashboard status --short
)"
test -z "$dashboard_status"
echo "DASHBOARD_UPDATE_SOURCE_READY"
```

接着：

1. 用新 SHA 和本次 build version 按第 7 节构建新的固定 PDF 派生镜像。即使 Dockerfile
   没变，也要让 image tag 和 OCI revision 对应本次 SHA；Docker layer 会复用缓存；
2. 按第 10 节执行 frozen install、`pnpm check`、无网络隔离测试、build、production
   audit、Skill/产物/敏感扫描；
3. 比较新 release 的 migration journal 与在线 `__drizzle_migrations`。

数据库规则非常明确：

- 没有新增 SQL/journal 条目：**不需要**重建数据库，也不需要为形式重复迁移；
- 有新增迁移：冻结写入并先备份在线新系统，只审核新增文件，然后在同一个
  `frontmind_dashboard` 上执行一次 `pnpm db:migrate`；
- `pnpm db:migrate` 只应用账本中尚未记录的 pending migrations，不会重新执行已经
  完成的 35 个迁移；
- 绝不运行 `pnpm db:push` 或 `pnpm db:generate`，也不删除/recreate 已有生产库；
- migration 失败时停止，不直接重跑；先做与第 11 节同等级的状态审计。

构建和 pending migrations 全部成功后，按第 7 节只重建精确 Dashboard service，确认
Compose 未恢复基础镜像，再执行第 13–15 节的端口、restart count、PDF、持久挂载、
三条 READY、公网 health 和 internal 404 健康门。不得并行启动第二个 Node 进程。

### 23.4 Website 是否需要更新

如果 Dashboard 的私有接口契约、登录 URL、购买/开户流程或浏览器 bundle 没有变化，
Website 不需要因为普通 Dashboard 修复而重新部署，只需重跑三条跨容器 READY 和公网
健康门。

需要更新 Website 时：

1. 固定新的 Website SHA；
2. 在仓库外按第 17.2 节完成 Linux 隔离 check、290+168 类测试、等价生产 build 和
   bundle audit；
3. 确认新 commit 已包含经过本地发布流程生成的 committed `dist`；
4. 服务器 `/frontmind-website` 先 fetch 并断言远端目标，再
   `merge --ff-only <已审核固定SHA>`，安装依赖并审计 committed `dist`，不在正式
   工作树重建 hashed assets；
5. 只重建 `FrontMind-Website`，再跑第 17.5 节全部健康门和必要 canary。

普通更新不重新生成邀请码、session secret、Dashboard 加密密钥、ICP 密钥或 service
token；也不重新创建数据库、持久目录、管理员、网站和 DNS。只有变更本身明确要求时，
才使用单独方案操作这些资源。

## 24. 完成标准

- [ ] 本次代码只推送到新 Private Repo `xiafanzeng/frontmind-dashboard`，旧
      `frontmind-agent` 仓库未接收 push。
- [ ] 本地文件夹最终命名为 `frontmind-dashboard`；服务器代码目录为
      `/frontmind-dashboard`，容器工作目录为 `/app`。
- [ ] 新 Dashboard 是 `3001` 的唯一监听应用，公开域名为
      `https://dashboard.frontmind.net`。
- [ ] 全新创建且不含旧 Agent 数据的 `frontmind_dashboard` 已通过
      `pnpm db:migrate` 完成 `0000`–`0034` 共 35 个迁移；迁移后为 48 张表、2 个
      trigger，未执行 `db:push` 或 `db:generate`。
- [ ] 三个全新 `/srv/frontmind-dashboard/...` 持久目录正确挂载。
- [ ] 凭据加密密钥、ICP 密钥和 service token 均为全新值且只存放于 1Panel 服务端
      环境变量；仓库目录和容器 `/app` 除已跟踪的 `.env.example` 外不存在任何真实
      `.env*`，1Panel 内部运行配置未被挂入 `/app`。
- [ ] 售前 API Key 已由管理员在 Dashboard 售前页面录入并加密保存；
      `FRONTMIND_MONITOR_API_KEY` 只存在于 Dashboard 服务端环境变量。
- [ ] 五个 PDF 命令均存在，Dashboard `/healthz` 和三个运行时 Skill 全部通过。
- [ ] 支付回执账本、项目订单账本、Presales、Provisioning 和简略看板接口契约全部通过。
- [ ] Website 通过 `frontmind-dashboard:3001` 调用内部接口，任何 service token 都没有
      `VITE_` 前缀。
- [ ] Website 固定 SHA 已通过 290 个服务端测试、168 个客户端测试、Linux 等价构建和
      production bundle audit；正式服务器工作树使用已审计 committed `dist` 且保持 clean。
- [ ] Website 只监听 `127.0.0.1:8888`，五个运行时 Skill、本机/公网 health 和未登录
      JSON `401/INVITE_REQUIRED` 全部通过。
- [ ] 公网 `/api/internal/*` 返回 `404`。
- [ ] 普通用户看不到 Key、积分或管理员信息；API/Axios 错误、日志和构建产物不含敏感值。
- [ ] 新数据库、三个 Dashboard 目录、Website 访问统计、固定镜像和发布产物已在同一
      恢复点备份，并通过隔离恢复演练。
- [ ] 恢复正式流量后已连续稳定至少 24 小时，并覆盖一次真实业务检查。
- [ ] 24 小时观察及再次签字后，旧 Agent 运行环境、`agent.frontmind.net` 网站与 DNS、
      旧服务器代码目录、旧数据库与用户、旧 prepared-files、旧 dashboard-assets、旧
      ICP/其他持久目录均已按精确目标永久删除。
- [ ] 回滚方案只使用新 Dashboard 空库重建或新系统自身备份，永不使用旧 Agent 数据库
      或旧持久目录。
