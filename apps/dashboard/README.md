# FrontMind Client

FrontMind Client 是一个面向内容生产工作流的现代 Web 应用，用于通过兼容式智能体 API 完成对话、文件上传、文件预览与结果下载。当前交付版本已加入统一品牌替换机制，面向用户展示的对话文本、文件名、文件预览标题、下载文件名以及可处理文件内容会从原始品牌词替换为 **FrontMind**。

## Features

- **Modern Chat Interface**: 玻璃拟态风格界面与平滑动效。
- **File Upload**: 支持图片与文档上传。
- **Markdown Rendering**: 支持 Markdown、代码块与语法高亮。
- **Image Preview**: 支持图片全屏预览、缩放与旋转。
- **File Preview and Download Sanitization**: 文件预览、代理下载、文本类文件、PDF 与 Office Open XML 文件会经过品牌替换处理。
- **Real-time Updates**: 任务状态轮询与重试逻辑。
- **Account Sync**: 内部账号登录、跨设备会话同步与管理员账号管理。
- **Server-side Credentials**: 每个账号的 API Key 经验证后使用 AES-256-GCM 加密保存，浏览器不再长期保存或随请求发送明文 Key。
- **Mobile Responsive**: 支持不同屏幕尺寸。
- **Keyboard Shortcuts**: 支持常用快捷键。

## Brand Replacement Scope

本版本在前端与服务端都增加了品牌替换层。前端会在消息内容、附件名称、文件预览标题、下载名称以及内联图片替代文本中调用统一替换函数；服务端会在 JSON 响应、外部文件代理下载、同源文件下载、响应头文件名以及可处理文件内容中执行替换。

| 位置                                         | 当前处理方式                   | 说明                                                                              |
| -------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| 聊天消息文本                                 | 前端与服务端双层替换           | API 返回中的品牌词会在进入 UI 前替换。                                            |
| 附件和生成文件名称                           | 前端显示名替换，下载响应头替换 | 用户看到的文件名和下载保存名会显示 FrontMind。                                    |
| Markdown、HTML、纯文本、CSV、JSON 等文本文件 | 服务端代理下载时替换正文       | 文件预览与下载不再绕过替换层。                                                    |
| PDF 文件                                     | 服务端尝试文本流替换与覆盖处理 | 对标准文本型 PDF 有效；扫描图像型 PDF 需要 OCR/重制才能完全替换。                 |
| DOCX、PPTX、XLSX 等 Office Open XML 文件     | 服务端替换压缩包内 XML 文本    | 对普通 Office 文档有效。                                                          |
| 底层兼容路径和第三方依赖名                   | 保留必要内部标识               | 例如调试插件、兼容 API 路由、依赖包名可能仍含底层标识，但不作为用户界面内容展示。 |

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Radix UI
- **Backend**: Express, tRPC, Drizzle ORM, MySQL 8
- **Styling**: Custom CSS with oklch colors, Framer Motion animations
- **Build**: Vite 7

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 8+
- MySQL 8+

### Installation

```bash
pnpm install
cp .env.example .env
```

以上复制步骤和本页的数据库命令只用于本地开发。生产环境使用签名 OCI 镜像、
root-only runtime/migrator 配置和受限 digest 部署控制器；不得在服务器检出源码、提交
`dist` 或手工运行常规 migration。唯一发布入口见
[权威发布手册](./docs/operations/RELEASE.md)。

生产 PDF 运行环境从
[`deploy/1panel-node-pdf/Dockerfile`](./deploy/1panel-node-pdf/Dockerfile)
独立构建并按 digest 固定，使 Poppler、Ghostscript 与项目声明的精确 pnpm 在容器重建后
仍然存在；普通 Dashboard 更新不会重建该基础镜像。

本地 `.env` 至少设置 `DATABASE_URL`、`FRONTMIND_CREDENTIAL_ENCRYPTION_KEY`、`FRONTMIND_PRESALES_SERVICE_TOKEN`、`FRONTMIND_PROVISIONING_SERVICE_TOKEN`、`FRONTMIND_MONITOR_API_KEY`、`FRONTMIND_PUBLIC_URL` 和 `FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET`。`FRONTMIND_MONITOR_API_KEY` 必须是监控服务专用凭据，生产环境不会回退使用普通售前 Key；`FRONTMIND_PUBLIC_URL` 必须是可供客户浏览器访问的真实 HTTPS 地址，用于生成开户与工作台链接。凭据密钥、两个服务令牌和预检签名密钥都应使用至少 32 位的独立随机值，并只保存在服务端，且不得互相复用。轮换预检签名密钥会使尚未发布的短时预检凭证失效，但不会影响已发布内容。

Dashboard 正式环境使用 `FRONTMIND_PUBLIC_URL=https://dashboard.frontmind.net`。页面路由、静态资源和 `/api/*` 均按同源相对路径工作，因此 1Panel 应将该域名的根路径整体反向代理到应用端口，不要部署在 `/dashboard/` 等子路径。`FRONTMIND_WEBSITE_URL=https://www.frontmind.net` 仍指向官网。

```bash
pnpm db:migrate
pnpm admin:init
pnpm dev
```

开发服务启动后，请以控制台输出的本地地址为准。默认情况下，服务会由项目内 Express/Vite 集成入口提供。

### Configuration

1. 使用 `pnpm admin:init` 创建首个管理员；密码通过隐藏输入读取，不写入命令行历史。
2. 管理员登录后可在“账号管理”中创建、停用账号或重置密码。
3. 管理员可为一个或多个账号配置同一 API Key。服务端会为各账号分别加密保存凭据并隔离资源权限，后续设备只需登录。
4. 旧版本浏览器中的本地 Key 与会话不会导入账号；登录后只读取该账号的云端数据。
5. 管理员在侧栏“售前页面”中单独配置官网售前 API Key；该 Key 不属于任何个人账号，且不会返回给官网或浏览器。
6. GEO 问题监控使用服务端环境变量 `FRONTMIND_MONITOR_API_KEY`。生产环境缺少或误配专用 Key 时启动失败，且运行时不会静默回退到官网售前 API Key；开发与测试环境仍保留兼容回退。专用 Key 轮换后，旧监控任务不会使用新 Key 继续查询。
7. 普通用户登录后进入企业看板与“知识库智能体”；知识库构建固定使用 Pro，最终 ZIP 会自动形成可检索的文档与图片展示版本。
8. 管理员登录后进入管理工作台。内置 `admin` 账号可把一个用户分配给多个管理员；被分配的管理员可维护该用户的看板、知识库与 API Key，并查看近 30 天积分消耗。
9. 生产环境应把 `FRONTMIND_DASHBOARD_ASSET_DIR` 配置为持久化目录，用于保存知识库 ZIP 中解析出的图片。图片仍需通过登录和用户归属校验后访问。
10. 域名注册与 ICP 备案流程只引导用户前往阿里云操作，Dashboard 仅登记已备案域名、ICP 主体备案号、备案状态及可选备案省份，不接收、上传或存储证件及人脸核验材料。
11. 管理员上传看板模块或官网内容当前模板必须先取得服务端签发的短时预检凭证；凭证绑定管理员、客户、模块、修订号和文件哈希，并通过数据库 nonce 原子消费防止重放。官网内容模板还会逐工单校验修订号、类别和话题快照，任一冲突会整体回滚。生产环境必须配置 `FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET`。

同一个 API Key 可以由多个 FrontMind 账号共同使用。账号之间的会话、任务和文件权限仍按账号隔离；积分总数反映该 Key 池的整体消耗，最近任务明细只展示当前账号创建的任务。共享 Key 下不会透传上游任务或文件目录，未知历史资源需由系统管理员完成迁移。

### Database Commands

```bash
# 根据 schema 生成迁移（开发时）
pnpm db:generate

# 只执行仓库内已有迁移（部署时）
pnpm db:migrate

# 永久清理超过 30 天未更新的会话（供 1Panel 计划任务调用）
pnpm db:cleanup-expired
```

升级到三类工程师版本前必须先冻结写入并运行只读预检。若旧环境曾启用 ICP 材料存储，
还要先对旧私有目录执行清理预演；确认清单无误后才能使用永久删除参数。清理命令只删除
数据库中精确 `storageKey` 对应的文件，拒绝相对路径、越界路径和未登记目录项。

```bash
pnpm db:preflight-three-engineer-roles
pnpm db:purge-icp-materials -- --storage-root=/旧ICP私有目录
pnpm db:purge-icp-materials -- \
  --storage-root=/旧ICP私有目录 \
  --confirm-permanent-delete
pnpm db:migrate
```

永久删除不会为 ICP 文件创建新备份，且不可恢复。生产备份中已有的历史材料仍按原备份
保留周期清除；全新部署没有旧材料目录时无需运行材料清理命令。

不要在发布服务器上用 schema push 替代版本化迁移。数据库备份、1Panel 应用配置、反向代理和正式发布属于部署阶段，需在检查目标面板后单独执行。

用户主动删除会话时，服务端会立即物理删除该会话，并由外键级联删除消息、附件和对话轮次。`db:cleanup-expired` 按会话最后更新时间执行 30 天滚动保留；超过 30 天未更新的会话及其关联记录将无法恢复。

## Keyboard Shortcuts

| Shortcut           | Action                 |
| ------------------ | ---------------------- |
| `Cmd/Ctrl + N`     | New conversation       |
| `Cmd/Ctrl + Enter` | Send message           |
| `Esc`              | Stop current operation |
| `Cmd/Ctrl + ,`     | Open settings          |

## Project Structure

```text
frontmind-client/
├── client/                 # Frontend React application
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── contexts/       # React Context providers
│   │   ├── hooks/          # Custom React hooks
│   │   ├── lib/            # Utilities and API client
│   │   └── pages/          # Page components
├── server/                 # Backend Express server
├── drizzle/                # MySQL schema and versioned migrations
├── scripts/                # Operational CLI (initial administrator)
├── shared/                 # Shared types and constants
└── package.json            # Root package.json
```

## Development

### Local production-mode build

```bash
pnpm build
pnpm db:migrate
pnpm start
```

以上命令只用于本地验证；正式镜像由 CI 构建。生产进程固定监听 `PORT`（默认
`3001`）。`GET /healthz` 是不访问数据库或文件系统的轻量 liveness；`GET /readyz`
检查数据库、完整 migration journal、由最新 Drizzle snapshot 固化的完整 Schema
contract（含默认值、生成列、字符集/排序规则与 CHECK 表达式）、持久卷、Skills、
恢复状态和内部账本，任一失败返回 503。其中 PDF
prepared-files 持久卷会执行唯一临时文件的写入、读回和删除探针，并要求保留
`max(文件系统容量 10%, 5 GiB)` 可用空间。镜像 entrypoint 会在
监听端口前自动执行环境与 `exact-ledger + exact-schema` preflight。官网可通过已鉴权的
`GET /api/internal/presales/status` 读取 `monitorCredentialConfigured` 与
`publicUrlConfigured`，在付费动作发生前阻断不完整配置。

官网服务端通过 `/api/internal/presales` 调用售前代理，并在每次请求中携带 `x-frontmind-service-token`。代理仅开放受约束的文件创建/上传/幂等删除、Base 任务创建/查询/删除及任务输出下载；所有上游任务和文件 ID 都会先写入售前资源账本，不能将该接口用作任意上游代理。`POST /tasks` 可传 `idempotencyKey`：数据库只保存其 SHA-256，并将预留绑定到规范化请求摘要和 API Key 版本；重复请求会复用原任务，冲突或仍在处理的请求不会再次调用上游。输出下载只接受上游结构化文件记录，外部签名 URL 仅保存 SHA-256 授权摘要。更换 Key 后，旧文件仍由其原凭据版本处理；管理员执行撤销时会同时销毁当前与全部历史版本。

问题监控使用同一鉴权边界下的 `POST /api/internal/presales/monitor-runs`、`GET /monitor-runs/:runId`、`GET /monitor-runs/:runId/result` 和 `DELETE /monitor-runs/:runId`。创建请求只接受一个问题、六个平台白名单及幂等键；服务端固定每平台 5 次、`mode=search`、`screenshot=0`。付费 POST 前会先持久化预留，无法确认提交结果时保持 `submission_unknown` 且不自动重发；查询最早在提交 300 秒后触发一次上游轮询，并通过数据库租约合并并发查询。对外结果只包含安全整理后的答案、媒体、引用和检索来源，不返回推理、页面截图或上游任务 ID。删除采用软删除并永久保留幂等键占位，避免同一付费任务被再次提交。

官网服务端在确认订单已支付且合同已签署后，可调用 `POST /api/internal/provisioning/users` 自动创建普通用户。请求必须同时携带独立的 `x-frontmind-provisioning-token` 和稳定的 `Idempotency-Key`，并提交相互匹配的项目、订单、合同证据及客户选择的账号信息。接口使用严格请求结构，不接受 `role`；服务端始终创建 `user` 角色，且不会在响应中回传密码。订单、交易号和合同均有数据库唯一约束，同一幂等键只能对应完全相同的请求。

### Run Tests

```bash
pnpm test
```

### Type Checking

```bash
pnpm check
```

## Notes

如果在源代码扫描、依赖包名、调试插件目录或临时预览域名中仍看到底层标识，这通常属于兼容层、第三方依赖或沙盒预览基础设施，并不是应用返回给最终用户的内容。最终用户可见文本、API JSON 响应以及通过文件代理返回的可处理文件内容已接入 FrontMind 替换机制。

## License

MIT
