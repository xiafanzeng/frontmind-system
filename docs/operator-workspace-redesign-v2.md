# 操作员工作区重设计 v2：实现与验收记录

更新日期：2026-09-07。适用仓库：`frontmind-system`，客户端及服务器位于 `apps/dashboard`。

本文记录已实现的接口、交互边界与本地验证，作为代码审阅、验收及回退交接依据。实现分支为 `codex/operator-redesign-v2`，基线为 `cd7728a263edaddd27ee8f2af58a50a68eabe55c`。本轮交付不包含部署或真实付费模型运行。

## 1. 最终产品范围

操作员围绕企业项目工作。侧栏保留原 FrontMind SVG Logo、“AI智能品牌优化”和“FrontMind通用智能体”；不添加“方案”后缀或 Logo 下的营销说明。新建企业项目继续位于项目管理菜单，主工作区无项目时提供创建引导。项目行各自提供重命名、删除菜单；账号与余额、真实账号身份及折叠按钮位于侧栏底部。

六个固定模块为品牌建设、意图优化、进度监控、内容制作、媒体发布、项目工具。第六项保留内部 ID `extensions`，显示名更新为“项目工具”。模块使用真实链接，无编号、关闭按钮和拖拽重排；品牌建设只保留“智能知识库”和“品牌全域词库”。

知识库统一为左侧任务协作、右侧节点树与所选节点内容。在同一工作页完成预览、直接编辑、AI 修改及图片操作，取消操作员独立“知识库展示”入口。构建、确认、失败、余额或凭据暂停等真实状态仍由业务数据驱动；不新增全局搜索、通知中心或模型选择器。

其他模块保留现有真实业务容器、表格、确认流程、发布接口和账户计费，只接入共同外壳、字体、颜色角色及必要的浮层主题。不改变监控尝试、配额、供应商回调、媒体订单或客户价格口径。

### 布局与主题

- 宽屏侧栏为 280px，可折叠到 72px；1024–1279px 默认使用 72px，通过完整项目抽屉展开；更窄屏幕使用移动项目抽屉。
- 一级导航 16px，项目名 15px，工作区项目标题 24px／32px 行高，六模块标签高 52px。正文基线 16px，密集表格保留 14px。
- 六模块使用圆角、右侧倾斜的浏览器标签背景，未选中项使用各模块的柔和实色，当前项以白色连接下方工作面并显示顶部强调线。斜边来自独立装饰 SVG，链接点击区、文字与图标均不倾斜；宽屏六项等分可用宽度，窄屏保持至少 128px 并在标签栏内横向滚动。直接进入后面的模块或调整窗口大小时，标签栏自动将当前模块移入可视范围，不滚动页面正文。
- 主色 `#4B246B`，悬停 `#3B1C55`，画布 `#F6F7F9`，正文 `#20232B`，次文字 `#5D6573`，结构线 `#E2E5EB`，选中面 `#F2EDF6`。
- 输入框边界 `#8F8997` 对白底的计算对比度为 3.39:1。次文字对画布为 5.48:1，白字对主色为 11.91:1，侧栏次文字对侧栏底色为 10.42:1。
- `OperatorThemeProvider` 将明确的主题类传到 Radix Portal 内容及遮罩；Portal 继续挂在原来的 body 或模块容器。监控已有 `monitoring-module-portals` 不移动。
- 旧 Dashboard 的文字变量与共享控件背景变量都叫 `--muted`；旧样式改为 `--dashboard-muted` 的兼容回退，避免辅助正文误用背景色。其他角色仍使用原回退值。

## 2. 统一知识库的数据与接口

### 单个业务控制器

`EmbeddedKnowledgeBasePanel` 保留原有 `preview`、`previewData`、`page`、`onPageChange`、`mode` 调用兼容。操作员传入 `mode="workspace"`，进入统一工作页；内部不通过重复挂载两个完整知识库业务容器来形成左右分栏。

构建树来自真实进度 DTO。节点正文通过新增的节点内容接口读取，不能把树节点的标题、概述或最后一条聊天消息当作完整正文。所选阅读节点与服务器当前待确认节点是不同概念；阅读选择不自动确认、不启动收费任务。

`KnowledgeNodeWorkspace` 在会话、build、generation、reset revision 边界变化时重新建立本地编辑会话。请求使用现有项目 REST 作用域；项目切换后取消请求，并在响应 JSON 解析后再次确认作用域仍有效。过期响应不得覆盖新项目或新节点。

仅有旧正式快照、没有可继续构建记录时，仍复用 `KnowledgeBaseViewer` 阅读现有资料；编辑入口明确说明需要重置并重新上传。保留 Viewer、快照类型及其他预览调用者，不进行全仓删除。

### 新增接口

公开类型位于 `apps/dashboard/shared/knowledge-node-workspace.ts`。

| 接口 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /api/knowledge-base/node/content` | `conversationId`、`leafId`、`expectedGeneration`、`expectedContentVersion` | `KnowledgeNodeDetailsDto` |
| `POST /api/knowledge-base/node/save` | `KnowledgeNodeSaveInput` | `{ accepted: true, unchanged, observation }` |

两个接口都要求登录及现有知识库能力，响应为 `Cache-Control: private, no-store`。真实 owner 和企业项目由服务器认证／项目作用域确定；客户端传入的会话与节点 ID 不能取代所有权校验。

`KnowledgeNodeDetailsDto` 包含：

- `coordinates`：`buildId`、`conversationId`、`leafId`、`generation`、`revision`、`stateEpoch`、`contentVersion`、`resetRevision`。
- `node`：叶节点 ID、标题、真实状态、`contentMarkdown`。
- `resources`：已批准资源 DTO，通过本产品同源资源地址访问，不暴露对象存储或供应商凭证。
- `capabilities`：`directEdit`、`aiEdit`、`manageImages`，每项均为 `{ allowed, reason }`。UI 依据服务端能力显示操作及不可用原因。

`KnowledgeNodeSaveInput` 包含 `conversationId`、`leafId`、`clientRequestId`、`expectedGeneration`、`expectedRevision`、`expectedStateEpoch`、`expectedContentVersion`、`expectedResetRevision`、`contentMarkdown`。正文不得为空，长度上限 300000 字符；服务端执行既有客户正文规范化与物化包一致性校验。

参数无效返回 400；未登录返回 401；不存在或不属于当前作用域的构建按现有所有权规则拒绝；节点版本、重置版本及幂等冲突返回 409；数据库或无法确认的服务状态返回 503。409 在可以读取时附带权威 `observation`，供前端刷新最新状态。冲突不会静默覆盖用户草稿。

## 3. 保存、确认与正式知识库更新

### 直接编辑

直接编辑使用当前节点正文作为输入基础，标题仍由既有节点结构确定。保存绑定完整坐标与重置版本，服务器在事务中按重置状态、构建、回合的顺序锁定相关对象。选择目标节点与预约保存同事务提交，不依赖浏览器先进行一次可能被其他操作穿插的 select。

同一保存内容和坐标重复尝试复用 `clientRequestId`。服务端核验完整请求哈希；重复成功请求返回既有结果，处理中返回明确状态，同一个请求 ID 换内容返回幂等冲突。

正文没有实际变化时，保存记录为成功且 `unchanged=true`，不重新打开已确认或已发布节点、不制造新内容版本。正文确实改变时，服务端生成确定性的应用侧节点 Patch，复用既有 Working Set 校验与 CAS 激活路径，仅更新目标正文并保留其他节点及图片关联。

成功保存更新当前 Working Set 内容版本，继续遵循节点再次确认流程。用户看到“修改已保存，请确认后更新知识库”；这不代表已替换正式知识快照。提交错误、版本冲突或本地处理失败保留原节点及浏览器草稿，不自动重置、不自动发起另一次模型请求。编辑器提供 Markdown／预览切换，以及二级标题、加粗、列表和链接操作；目录收为面包屑，退出后恢复目录位置。

### AI 修改与图片

AI 修改继续使用既有 `low_v1` 节点修订入口和确认协议。模型、调用预算、恢复与计费由服务器现有流程管理，UI 不新增供应商或模型切换。直接编辑尚未保存或节点修改正在提交时，限制并行任务消息和其他冲突操作。

图片管理沿用既有本地图片选择、上传、替换与解除关联能力。纯图片动作不因界面合并而转为文本模型任务；共享图片解除引用不能删除其他节点依赖的图片。

### 更新正式知识库

“更新知识库”是单独的明确确认操作，仅在服务端允许打包、没有未保存草稿或冲突提交时开放。它将已确认的内容更新为正式版本，供后续任务使用。

确认框冻结打开时的会话。更新请求设有独立的 30 秒等待期限，超时或返回丢失后保留工作稿并显示“重新读取更新结果”。核对权威进度和快照之前，不把核对按钮当成第二次发布请求；读取也有等待期限。成功后留在同一页，归档下载明确属于已更新版本。

**正在执行和历史任务继续使用各自绑定的知识版本。** 本轮不改写内容制作已有 Reference Pack、监控配置版本或历史运行，不重绑定已接受任务，不触发网站发布或媒体投放。完成节点保存、完成确认和完成正式更新是三个不同结果，界面及接口不能混用。

## 4. `manual_v1` 持久化与回退兼容

直接编辑由服务器写入 `recovery.nodeEditMode = "manual_v1"`，复用现有 `conversationTurns` 及应用侧 Patch 元数据。本轮没有新增数据库表、列或迁移文件。

`manual_v1` 的固定边界：

- `apiCredentialId`、上游任务 ID、Patch 的 `providerTaskId` 均为空。
- 不接收本轮供应商附件、不创建模型 Session、不调用模型、不记供应商用量。
- 冻结正文及哈希、基础 Working Set ID、基础内容版本、节点、generation、reset revision 和操作租约。
- 直接派发、后台恢复及恢复失败处理先识别 `manual_v1`，进入同一本地处理器；不得在恢复时落入供应商调用路径。
- Patch 权威校验同时核对模式、包 SHA256、基础 Working Set、基础版本及空供应商身份。失败保留最后一个完整 Working Set。

原 `low_v1` 和已接受的其他旧回合仍走原分支；`manual_v1` 是新增的服务器持久化语义，不能只按“没有数据库迁移”宣称任意旧服务器都可直接回退。

回退要求：优先回退外观而保留 `manual_v1` 的读取、恢复、失败收敛与 Patch 校验兼容代码。若必须回退到不理解该标记的服务器，应先停止接受新的直接保存，并让在途本地保存得到明确收敛，或保留相应兼容处理；不得将遗留本地回合改派供应商、删除回合记录或改写内容版本以强行兼容。该要求是新增持久化协议的兼容边界，不是新增数据库迁移或另建发布控制流程。

## 5. 路由、项目与草稿边界

旧 `/?view=knowledge-display`、`/knowledge-base?view=knowledge-display` 使用 replace 归一化到统一知识库入口。归一化保留 `enterpriseProjectId`、`operatorOwnerId`、其他查询参数及 hash，避免整页刷新或返回键循环；只处理已识别的旧知识库路径。历史 `knowledge-display` 内部调用保留兼容映射，新导航不再生成旧地址。

`WorkspaceQueryProvider` 仍以登录用户、代操作 owner、企业项目建立独立缓存和传输生命周期。同项目切模块保留 QueryClient；切项目停止旧请求、清理旧缓存。监控子项目 `project` 与企业项目 `enterpriseProjectId` 不混用。

`/account` 是账号层，清除企业项目参数并保留必要的管理员代操作 owner；`/agent` 清除项目和代操作参数。账号统一钱包仍跨项目共用，不改计费或额度数据模型。

`WorkspaceNavigationBoundary` 位于 `AppContent` 的基础呈现层，跨项目保持挂载；它不持有业务查询缓存。草稿通过 `useWorkspaceDraftGuard` 注册，覆盖模块链接、项目按钮、程序跳转、浏览器前进／后退及离开页面提醒。

离开时允许继续编辑、放弃并离开；所有未保存项均有保存能力时提供保存后离开。保存期间同步锁定重复提交、Escape、遮罩和关闭；保存失败留在当前页。草稿注销后不调用失效保存函数。History 只增加私有定位信息并保留原 state 数据，卸载时清理本实例监听器及仍由本实例持有的包装函数。

## 6. 重置与全新任务

重置仍是独立危险操作，使用原服务端能力和预期重置版本，展示明确确认；存在未保存或未提交内容时要求先处理，不用视觉改造绕过现有重置范围。

观察到已完成的重置 revision 后，前端清理旧知识库会话、本地同步队列和进度查询别名，移除当前快照投影；以新重置 revision 建立新的构建边界。只允许一个全新知识库会话进入初始化，不把通用智能体会话、旧展示会话或过期响应当成新任务。失败或不兼容的旧构建保留明确说明及重新上传入口，不自动续跑旧工作流。

重置、节点修改和正式知识更新各自使用原来的业务语义。本轮没有扩张重置清理范围，也没有用重置自动重做监控、内容制作或媒体发布任务。

## 7. 内容制作任务与原生 ZIP 流程

内容制作有独立的任务选择器和“新建任务”弹窗。四个起点与现有原生协议对应：建立新的 Reference Pack、刷新市场研究与定位、创建或导入 P0、撰写单问题文章。创建时选择企业资料来源并可附加材料；正式企业知识库提供企业事实，不冒充 Reference Pack。

任务区左侧保留当前任务的协作对话，右侧展示真实阶段、必需确认和成果。任务首次读取完成前显示“正在读取任务阶段”，不根据缺失信息猜测工作流。任务的完成由实际 `jobKind` 与 `workflowStatus` 判断，不以进度数值代替完成事实。

| 原生路径 | 页面与后续行为 |
| --- | --- |
| 新建／刷新 Reference Pack | 企业资料 → 市场研究 → 比较对象确认 → 核心定位确认 → 交付资料包 |
| P0 | 先明确使用已有资料包或创建资料包；使用已有包后进入创建／导入、例文、蓝图、正文编辑和交付 |
| 单问题文章 | 先明确资料包；随后确认正式问题与应答、文章类型、例文、适用的问题定位、蓝图及最终交付 |
| P0／文章中选择“先创建资料包” | 原生 Job 转为资料包任务，在 `positioning_ready` 结束；资料包交付后创建独立的新 P0 或文章任务 |

资料包完成后，操作员明确选择当前任务交付的真实 ZIP，再选择创建 P0 或单问题文章。前端通过带项目作用域的同源成果接口读取该文件，将实际字节作为新任务附件；不把文件名、外部链接或旧任务 ID 当作资料包。新表单保留企业名称，补充材料与带入的 ZIP 同时保留。新任务开始后继续完成原生“使用已有资料包”的明确确认。P0 交付的更新包也可用于后续文章任务。

任务启动使用同步锁。失败保留会话、输入和 File 对象，明确重试沿用原逻辑提交身份。切换任务检查未提交内容；请求作用域及任务身份失效后，旧读取、资料包下载和提交结果不得更新新任务。服务端固定首次接受的原生 `job_id`，拒绝同任务 revision 回退，同时允许同一 Job 的合法类型转换。工作流分发 ZIP 及内部状态文件不进入客户成果列表。

本地运行绑定的包为 `apps/dashboard/FrontMind_Content_Workflow_v4.11.0_Final.zip`，SHA256 为 `fc73c4334d57dc7b4382cc6a0be3d9ffe498aa168273032b9d0d8a7fba462bcb`。附件设计包只有方案和参考图；本轮没有替换运行包、修改 skill hash 或修改原生任务协议。

离线运行直接使用该 ZIP：37 项原生测试通过；在禁用网络的条件下，独立执行 1 个资料包 Job、1 个 P0 Job 和 7 个文章 Job，形成 8 份 Markdown、8 份 HTML、8 份 DOCX、8 份标题映射，共 160 个标题，Reference Pack 版本连续更新至 9。9 个终态 JSON 均由应用的真实状态 reducer 读取。原生校验通过 DOCX 结构及中文字体嵌入；没有将离线固定内容的输出质量等同于真实模型生成质量。

证据文件为外部截图目录中的 `content-workflow-offline-tests.log`、`content-workflow-deliveries.json`。这些是原生工作流的离线执行证据；浏览器交互验收使用实际 React 组件与模拟 API，二者共同覆盖流程衔接，但不声称完成线上模型端到端运行。

## 8. DEV 预览与截图

DEV 专用地址为 `/preview/operator-workspace`，只通过 `import.meta.env.DEV` 限定的开发预览路由导入。预览项目、创建／重命名／删除回调和知识数据来自本地样例；节点编辑为只读设计验收路径。它用于布局、中文排版、菜单和断点检查，**不能证明真实账户授权、服务端保存、计费、任务恢复或其他模块业务已通过端到端验收**。

以下六张视口截图保存在工作区外，未作为媒体提交到仓库：

外部目录：`/Users/fanzengxia/.codex/visualizations/2026/09/07/01a07c27-f6ac-7191-8b85-214b9252237c/operator-redesign`

| 视口文件 | 检查用途 |
| --- | --- |
| `workspace-2048.png` | 宽屏布局与正文空间 |
| `workspace-1440.png` | 常规桌面工作区 |
| `workspace-1280.png` | 展开侧栏边界 |
| `workspace-1024.png` | 72px 紧凑侧栏与工作面 |
| `workspace-768.png` | 平板单工作面 |
| `workspace-390.png` | 窄屏文字与溢出检查 |

标签几何修正后另存 `browser-tabs-{2048,1440,1280,1024,768,390}.png`：2048–1024px 的六项完整填满标签栏；768／390px 只在标签栏内横滚，六种视口均无页面级水平溢出。52px 高度、链接和图标无变形均已用浏览器几何核对。`browser-tabs-keyboard-focus.png` 记录 2px 可见键盘焦点及 Enter 切换；`browser-tabs-drawer-1024.png` 与 `browser-tabs-drawer-390.png` 记录相关项目抽屉。抽屉开启时主区 inert，Escape 关闭后恢复主区并将焦点还给原入口。

最终六张 `workspace-*.png` 已在斜边标签修正后按 2048×1152、1440×960、1280×800、1024×768、768×1024、390×844 重拍。`viewport-checks.json` 记录无页面横向溢出、单个输入实例与 52px 标签高度。`workspace-720.png` 是 720×480 的放大重排等效视口，未将其标为浏览器原生 200% 缩放测试。

`node-direct-editor.png`、`node-save-conflict.png` 使用真实节点组件与模拟接口：预览和打开编辑产生 0 次写请求；提交只发出 1 次保存请求；409 后原草稿保留。

`content-*.png` 记录四种任务创建、资料包路线确认、交付以及带包新建 P0／文章；`content-browser-qa-report.json` 记录 1440／390px 的请求与布局检查。补充 PDF 后原 ZIP 仍在，手机成果区、表单底部与确认动作均可滚动到达，没有 JavaScript 异常或横向溢出。开发模板的 debug-collector 404 不属于业务接口失败。

`details-*.png` 记录应答逻辑、内容分析、部件设置、媒体发布与监控的桌面和手机样式。日期弹层保持原 Portal，双月在手机内部滚动，底部确定按钮可见。各模块继续使用真实组件及本地匿名样例，未发出监控运行或发布请求。

## 9. 已执行验证与交付记录

| 验证范围 | 结果 |
| --- | --- |
| 全部客户端测试 | 114 个文件通过；1256 项通过、7 项既有跳过 |
| 知识库服务端相关测试 | 11 个文件；391 项通过、4 项既有跳过 |
| 内容制作服务端相关测试 | 3 个文件；67 项通过 |
| 原生 v4.11.0 ZIP 测试 | 37 项通过 |
| 原生离线完整交付 | 9 个独立 Job 完成，产物与 Pack 版本见第 7 节 |
| 客户端及工作区类型检查 | `pnpm --filter frontmind-client check` 与 `pnpm typecheck` 通过 |
| 测试分区 | canonical=456，node=342，client=114，精确分区通过 |
| 源码治理与运行包检查 | `pnpm --filter frontmind-client check:governance` 通过 |
| 差异格式检查 | `git diff --check` 通过 |

完整客户端命令：`pnpm --filter frontmind-client test:client`。最终客户端日志、类型检查与治理日志保存在外部交付目录。

知识库服务端使用 `pnpm exec vitest run --config vitest.node.config.ts`，运行以下文件：`knowledge-node-workspace-service.test.ts`、`knowledge-node-workspace-api.test.ts`、`knowledge-node-manual-edit-service.test.ts`、`knowledge-node-edit-service.test.ts`、`knowledge-node-edit-contract.test.ts`、`knowledge-base-api.test.ts`、`knowledge-base-turn-service.test.ts`、`knowledge-base-materialized-contract.test.ts`、`knowledge-base-recovery-worker.test.ts`、`knowledge-base-materialized-assets.test.ts`、`knowledge-base-materialized-publication.test.ts`。涵盖所有权、只读投影、手动保存不调用供应商、无变化、幂等、冲突、Working Set 和恢复分流。

内容服务端用相同 node 配置运行 `content-production-state.test.ts`、`frontmind-v2-chat-router.test.ts`、`general-agent-purpose.test.ts`。这两组后端结果保留在本任务工具记录中，未另存原始日志。没有把其他任务遗留的同名日志作为本轮证据，也未声称运行全量 342 个 node 文件。

最终客户端回归包含：旧入口归一化、跨项目缓存与请求隔离、草稿离开保护、只读节点预览、手动保存失败与冲突、保存后权威正文重读、AI／图片目标冻结、重置旧代际清理、更新结果不确定时只读核实、内容任务重试与 Pack 交接，以及版本检查等待期间切换任务不改投消息。测试过程中存在既有异步 `act(...)` 提醒及故意触发错误分支的日志；最终没有失败断言。

### 标准构建与源码身份

标准构建使用根目录 `pnpm build`：工作区 packages → Dashboard 的既有 `release-channel.mjs build` → monitoring worker。代码按 Conventional Commits 提交，全部改动提交、工作树干净后执行构建。构建保留源码身份、产物密封及生产产物审计，不关闭检查、不修改锁文件或删除测试。

构建完整 SHA、退出状态和检查结果记录在外部交付目录的 `build-result.json` 与 `build.log`。交付目录不写入生产环境，不包含客户数据或供应商凭据；截图与生成媒体未提交到 Git。

| 提交 | 内容 |
| --- | --- |
| `8a536bf` | 只读节点详情、手动保存和 `manual_v1` |
| `f503d8b` | 斜边导航、统一知识库、草稿和项目边界、共用主题 |
| `aadedd1` | 独立内容任务、资料包交接、原生状态及任务提交保护 |
| `d0062d3` | 发布、内容分析与部件的内部控件及浮层适配 |

### 实际验证边界

本轮交付为本地代码和构建产物。客户端使用真实组件配合 jsdom／浏览器模拟接口，服务端相关测试使用现有测试设施，原生工作流离线执行禁用网络。没有运行 MySQL 实库验收，没有用真实客户知识库重放“重置到更新”的线上闭环，也没有实际启动新的付费模型回合、监控尝试、媒体投放或外部发布。

原生 ZIP 已验证独立任务及最终交付能力，浏览器已验证输入、确认、资料包交接和关键页面状态；实际供应商连接、真实费用、耗时和生成质量不在这些离线结果中。未执行部署，也未修改独立的 `frontmind-monitoring-system` 仓库。
