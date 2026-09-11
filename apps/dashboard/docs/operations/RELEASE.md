# FrontMind Dashboard 发布指引

> 本文件只做指引。本仓的权威发布流程位于仓库根目录：

- [`docs/operations/RELEASE.md`](../../../../docs/operations/RELEASE.md) — IPv4 发布清单与镜像 digest 更新步骤
- [`deploy/README.md`](../../../../deploy/README.md) — 生产 Compose 布局、迁移、备份与回滚

## 生产环境事实

- 生产主机：`149.88.85.240`（SSH 别名 `frontmind-system-qjy`，root 登录）。
- 旧主机 `149.88.85.148` 已退役并排除在本部署之外；任何指向 `.148`、
  `frontmind-deploy` forced-command、`/opt/frontmind-deploy` 或控制器版本
  (`update-release-controllers.sh --apply-version=N`) 的旧文档均属于历史材料，
  不能执行。历史归档见 [`../history/`](../history/)。

## 常规发布

1. 改动走分支，同仓 PR 单次合并进 `main`；根 `.github/workflows/publish-images.yml`
   在 main push 时构建 `frontmind-system-dashboard` 与 `frontmind-system-worker`
   两个镜像（sha tag + latest）。
2. 在服务器上按 sha tag 拉取镜像，解析出不可变 digest，写入
   `/etc/frontmind-system/compose.env`，保留旧 digest 作为回滚点。
3. 有 pending 迁移时先停写、做可验证备份，再用 plan 观测值执行 migration profile；
   无迁移直接 `docker compose up -d --force-recreate` 受影响服务。
4. 验证 `/healthz`、`/readyz`、readyz 中的 build SHA、登录与变更面。

日常可使用本机 Skill `$frontmind-release` 一条指令完成上述流程；
Prompt 示例见根 [`docs/operations/RELEASE.md`](../../../../docs/operations/RELEASE.md)。
