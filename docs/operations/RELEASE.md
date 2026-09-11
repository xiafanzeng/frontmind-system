# IPv4 release checklist

The repository publishes two immutable GHCR images from `main`:

- `ghcr.io/xiafanzeng/frontmind-system-dashboard`
- `ghcr.io/xiafanzeng/frontmind-system-worker`

After the GitHub Actions run succeeds, copy the image digests into
`/etc/frontmind-system/compose.env`. Keep application secrets in the four
separate root-owned env files; never put them in Compose or GitHub variables.

On the new server, prepare `/srv/frontmind-system` and `/etc/frontmind-system`,
copy `deploy/docker-compose.yml` and `deploy/backup/backup.sh`, then follow the
commands in [`deploy/README.md`](../../deploy/README.md). Run the migration
profile once against the new MySQL volume before starting Dashboard and Worker.

The first acceptance URL is `http://149.88.85.240`. OpenResty proxies only to
`127.0.0.1:3001`; MySQL and Worker have no public ports. The old host
`149.88.85.148` is deliberately excluded.

For the later domain cutover, create `dashboard.frontmind.cn` in 1Panel, proxy
it to port 3001, use 1Panel to request/renew the certificate, then switch the
public origin and secure cookie settings. Website remains at
`www.frontmind.cn`.

## Release Skill

The local skill `$frontmind-release` (installed at
`/Users/fanzengxia/.codex/skills/frontmind-release`) drives the whole flow
above — verify, commit, PR merge, image build wait, digest update on
`149.88.85.240` (SSH alias `frontmind-system-qjy`), migration if pending, and
readiness checks. Companion skill `$frontmind-clean-workspaces` reconciles
local checkouts and linked worktrees. Usage examples:

```text
使用 $frontmind-release 把当前 frontmind-system 修改验证、提交并上线生产（149.88.85.240）；
自动判断服务范围，复用同 SHA 已有发布；含迁移时先备份再执行，全程自主不要问我。

使用 $frontmind-release 查看生产当前版本、/readyz 与最近发布状态。

使用 $frontmind-release 回滚到上一版本；仅回滚应用镜像，不动数据库。

使用 $frontmind-clean-workspaces 盘点 frontmind-system 固定检出与全部 linked worktree：
未上线修改按任务列出，已上线残留与重复快照经我确认后归档到可恢复 stash；
已进 main 未上线的续跑发布；归属不明的只列出不动。
```

Dev 环境尚未建立。将来加入 Dev 后再启用现有的
`$frontmind-promote-dev-to-production` 并为其适配本仓边界；在那之前不要
构造任何 Dev/Prod 耦合流程。
