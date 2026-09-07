# 参考界面适配与验收

按用户指定JCodesMore clone-website工作流，复用现有React/TypeScript应用。用户明确要求适配现有工作区，两来源CSS限定组件根，不引入Next.js或替换已有路由。

- 模力指数带view/project/tab的目标 → 企业项目真实问题监控 + `/monitoring`本地演示。
- HelpLook知识库前台及个性化配置 → 扩展应用/AI友好官网下知识库前台；`/knowledge-frontend-demo`合成预览。
- 原站不保存、不创建、不执行、不导出。原截图仅本地保留；研究规格不包含账号隐私。
- 官网本轮只实现配置交互、预览与项目本地草稿。WordPress/阿里云流程待定义；原有官网任务通过独立子入口保留。

## 本地验收

启动前端：`pnpm --dir apps/dashboard exec vite --host 127.0.0.1 --port 4173 --strictPort`。

- 知识库前台：`pnpm --dir apps/dashboard exec node scripts/operator-portal-ui-smoke.mjs`，2048×1200，22份状态截图；另6项组件测试覆盖账号/项目隔离、校验、代码不执行、全部设置Tab、预览及已有工作流入口。与正式工作区18项整合测试共24项通过。
- 两个演示路由跳过登录查询、分析脚本和版本轮询，使用合成数据；真实工作区保持账号与项目验证。
- 原站HTML样式采集受Chrome扩展超时限制，原生截图已覆盖可安全操作状态。原站保存、立即执行、导出和收费操作未执行。像素级同视口对照尚待扩展恢复；详情见各来源STATE_MATRIX。
