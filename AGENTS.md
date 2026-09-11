# FrontMind System Agent Guide

This file is the repository-level starting point for any coding agent working on
FrontMind System. Read it before changing code.

## Canonical workspace

- Repository: `git@github.com:xiafanzeng/frontmind-system.git`
- Canonical local checkout: `/Users/fanzengxia/Documents/GitHub/frontmind-system`
- Always confirm the active branch and `git status --short --branch` before editing.
- Do not choose a sibling `frontmind-system-*` directory by name. Those are
  separate Git worktrees on feature branches and may represent old snapshots.
- Never copy `.env` files, credentials, private keys, database dumps, media, or
  ignored runtime data into commits or agent prompts.

## Read first

1. `README.md` for the system map and normal development loop.
2. `BASELINE.md` for the source repositories and fusion baseline.
3. `docs/architecture/fusion-boundary.md` for application boundaries.
4. `apps/dashboard/README.md` for the Dashboard/API behavior and local setup.
5. `apps/dashboard/docs/operations/RELEASE.md` and `deploy/README.md` before
   proposing or performing a production release.
6. `docs/operations/RELEASE.md` for the short IPv4 checklist.

When documents disagree, stop and report the discrepancy. In particular, the
deployment documents currently mention both `149.88.85.240` and `149.88.85.148`;
never infer the production host from memory or from a branch name.

## System boundaries

- `apps/dashboard` is the only browser/API host and the only login authority.
- The Website is an independent application and is not a second login system.
- `apps/monitoring-worker` and the monitoring provider packages run server-side.
- Shared contracts, database access, object storage, payment, and publishing
  code live under `packages/`.
- The production stack is defined by `deploy/docker-compose.yml` and includes
  MySQL, Dashboard, siteops-worker, Website, monitoring-worker, migration, and
  backup services.

## Development commands

Use the repository-pinned package manager (`pnpm@10.4.1`):

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Dashboard-only local setup is documented in `apps/dashboard/README.md`. Local
database commands are for development; do not run schema push against a
production database.

## Change and release rules

- Keep a change on an intentional branch and leave the worktree clean before
  release.
- Use versioned migrations only. Never reset production data, replay historical
  migrations, or replace a release migration with `db:push`.
- Production runs immutable OCI image digests and root-owned runtime env files.
  Do not build from a server checkout or commit `dist` as a release artifact.
- Before a migration, take the documented recoverable backup and use the
  release migrator's observed plan values. After startup, check `/healthz`,
  `/readyz`, the exact build SHA, login, and the changed surface.
- Inspect the actual workflow files in `.github/workflows/` and the target
  server controller before claiming that an automated deployment path exists.
  Documentation may describe a newer or different deployment revision.

Agents may implement and test requested changes autonomously. Treat production
deployment, database migration, rollback, branch deletion, worktree removal,
and secret changes as separate operational actions that require the user's
explicit target and timing.
