# 0045 知识库状态机只读诊断与恢复附录

本文不是常规发布入口。正常更新只使用
[`docs/operations/RELEASE.md`](docs/operations/RELEASE.md)。旧 S/F 双提交、源码容器、
外置 artifact root 和手工执行 SQL 的原文已移至
[`docs/history/KNOWLEDGE_BASE_V2_DEPLOYMENT_LEGACY.md`](docs/history/KNOWLEDGE_BASE_V2_DEPLOYMENT_LEGACY.md)，
只能用于事故取证，不能执行其中命令。

## 只读诊断

1. 对已经验签并按 digest 拉取的候选 Dashboard 镜像执行：

   ```bash
   cd /opt/frontmind-deploy/dashboard
   sudo docker compose --env-file .env --profile release run --rm --no-deps \
     release-db-plan plan --json
   ```

2. `status=exact` 且 `expected.latestTag` 不早于
   `0045_knowledge_base_state_machine`，只表示 SQL ledger 完整；不要重跑 0045。
3. `pending` 必须保持 Dashboard 停写。0045 属于历史 contract migration，只能进入
   root 维护窗；`ahead/diverged` 立即停止并调查，禁止删 ledger。
4. 检查持久卷中的
   `/var/lib/frontmind/dashboard-assets/.frontmind-kb-v2-0045-complete-v3`：必须是
   root-owned、`0600`、非符号链接，并包含 10 行 v3 完成事实。缺失或不合格表示专项
   回填/真实 API/八叶闭环验收事实不完整，不能通过伪造 sentinel 解决。
5. 以 `/readyz` 的知识库检查和完整 migration journal 为最终运行门；`/healthz`
   只证明进程存活。

以上步骤均为只读，不创建备份、不修改 DB、不停止 Website。

## 受控恢复

- 如果只是候选镜像失败，恢复 `state.json` 中的 previous digest；不要碰数据库。
- 若 0045 尚未应用，在批准的停写维护窗使用 root-only contract 入口。它会验签、
  停止 Dashboard、执行完整备份与临时库恢复测试，再调用同镜像 `release-db migrate
--allow-contract`：

  ```bash
  sudo /usr/local/sbin/frontmind-contract-maintenance \
    ghcr.io/xiafanzeng/frontmind-dashboard@sha256:<64hex> \
    <40hex-source-sha>
  ```

- 如果 ledger 已含 0045、但 v3 sentinel 或业务回填事实缺失，不得再次执行 migration。
  这是数据修复事故：保持停写，保留 state/backup/日志，由专项修复版本执行幂等
  backfill、rebind 和验收；完成后才由事故负责人写入 v3 sentinel。
- migration 结果未知时只读重查 plan：`exact` 才能继续；其他状态从 controller 已验证
  的备份恢复，绝不盲目重跑。
- restore 失败时保持 Dashboard 停写并升级事故，Website 继续独立运行。
