# 问题监控界面与本地演示验收

独立 `/monitoring` 页面使用 `MonitoringDemo.tsx` 的合成企业、问题、回答与来源；通过 `MonitoringPage serverData={false}` 复用现有表单、费用确认、列表和分析界面。演示组件不持有 API client、不调用 fetch；入口也跳过账号预取、analytics 和生产版本探测。所有演示状态仅存在于当前页面内存，刷新恢复初始数据。

真实企业项目工作区复用同一套桌面工具栏、字体与回答/信源分栏。问题监控仍保持服务端归属校验、计费确认和每次最多 500 attempts。品牌继承企业项目，历史配置继续不可变；没有引入推荐问题、品牌推荐或舆情监控。

## 界面与交互

- 保留已实现的指标看板、问答、指标、趋势、竞品、引用分析、信源分布七个入口，增加商品统计和视频统计，共九个。两类媒体在真实工作区明确暂无可核验数据；演示页展示明确标记的合成条目。
- 工具栏提供现有数据报告、表格浏览、刷新、启停、编辑与执行。回答正文和引用来源各自滚动；桌面弹窗左右分栏、底部操作固定，模型批量工具栏可换行。
- 演示支持保存、编辑、模拟运行、启停、删除恢复、复制回答和链接、全屏、纠正提及位置、引用追踪筛选。纠正不修改原始回答正文。真实页纠正按钮明确标为待开放，引用追踪不会伪装为已接入后端。
- 截图演示是当前合成回答的本地 HTML 快照预览。真实截图仍只能读取已有站内归档媒体。
- 演示表单另有品牌选择/别名的嵌套弹窗，以及核心词添加、删除、启用和暂停。它们明确是当前表单草稿，关闭表单即丢弃，不进入 `MonitorInput`，不改变企业项目归属、问题、执行次数或统计；真实表单保持继承项目品牌。

## 验证命令

```sh
cd apps/dashboard
pnpm exec vitest run --config vitest.client.config.ts \
  client/src/monitoring/MonitoringDemo.test.tsx \
  client/src/monitoring/pages/MonitoringPage.test.tsx \
  client/src/monitoring/components/MonitorForm.test.tsx
pnpm exec tsc --noEmit
node scripts/operator-monitoring-ui-smoke.mjs
```

浏览器脚本创建独立无登录 Chromium 上下文，仅允许 localhost/127.0.0.1。默认连接 `http://127.0.0.1:4173`，截图与 `report.json` 输出到 `/tmp/frontmind-local-ui/monitoring`，可分别通过 `FRONTMIND_MONITORING_UI_ORIGIN`、`FRONTMIND_MONITORING_UI_OUTPUT` 改为其他本地地址和输出目录。所有 API/外部资源请求会被拦截，并作为失败断言。

已在 2048×1100 视口完成当前适配控件的 52 个本地截图状态，覆盖九个页签、本品和全部竞品、全部问题和模型选项、7/30/90 天和自定义日期、计划暂停/恢复、问题/回答切换、引用追踪筛选、全屏及 Escape 焦点返回、复制、本地截图、纠正、双栏表单、品牌弹窗、核心词增删启停、批量模型、深度思考、截图策略、每日/每周、执行时间和取消。API 请求为 0、外部资源请求为 0、浏览器运行异常为 0；相关客户端测试共 8 项通过。

S13 专门验证空名称和缺少问题时保存显示必填错误，且未创建监控；S14 专门验证有效表单完成估价后“保存并立即执行”可用，采用 Playwright trial click 验证可点击而不提交。本地保存成功及模拟执行确认另列为 `Extra-local-save`、`Extra-local-run-confirmation`，不再占用 S13/S14。完整适配范围见[本地状态映射](research/business.molizhishu.com-f1bb7068/business--dashboard-8c4b8bdb/LOCAL_VALIDATION.md)。

## 参考边界

原站提交和品牌创建结果未观察；本地 S13/S14 只证明本地必填校验与启用条件，不能声称与原站提交后状态一致。原生 select、演示表单草稿和九个分析入口是明确适配；未实现原站推荐问题、推荐竞品及 AI 品牌拓展，不做逐控件全部完成或逐像素一致声明。本轮验收桌面布局，移动端沿用现有响应式规则。
