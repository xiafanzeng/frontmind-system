# FrontMind System

FrontMind System is the fused monorepo for the FrontMind Dashboard/API,
Website integration, and server-side monitoring and publishing workers.

The Dashboard is the single browser/API and authentication boundary. Website is
kept independent. Monitoring providers and workers run on the server and share
typed contracts and persistence packages with the Dashboard.

## Repository map

```text
apps/dashboard/          React + Express + tRPC + Drizzle application
apps/monitoring-worker/  monitoring and publishing worker
packages/                contracts, config, DB, object store, providers, payment, publisher
deploy/                   production Compose, environment examples, backup, OpenResty
docs/architecture/       system boundaries and runtime design
docs/operations/         release checklists
```

`BASELINE.md` records which earlier Dashboard and monitoring repositories were
fused and the source SHAs used as the baseline.

## Start a new agent on this project

Give the agent the absolute checkout path and the exact branch, rather than a
generic `frontmind-system` label:

```text
Work in /Users/fanzengxia/Documents/GitHub/frontmind-system.
First run `git status --short --branch` and `git rev-parse HEAD`.
Read AGENTS.md, BASELINE.md, docs/architecture/fusion-boundary.md,
apps/dashboard/README.md, apps/dashboard/docs/operations/RELEASE.md,
deploy/README.md, and docs/operations/RELEASE.md.
Do not select a sibling frontmind-system-* worktree, copy secrets, or deploy
until the target host and release path are explicitly verified.
Summarize the architecture, affected files, tests, and release impact before
editing. Then implement the requested change and leave a clean, reviewable diff.
```

The canonical checkout works on task branches cut from `main` (for example
`codex/align-production-240`). Confirm the exact branch at handoff time because
another task may intentionally select a different branch or a fresh `main`
worktree.

## Local development

Requirements are Node.js 20+ and the repository-pinned `pnpm@10.4.1`.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Dashboard environment variables and local database setup are documented in
`apps/dashboard/README.md`. Example files under `deploy/env/` and
`deploy/env.example` contain placeholders only; real values belong in
root-owned runtime files and must never be committed.

## Production release

Read `apps/dashboard/docs/operations/RELEASE.md` first; it is the detailed
release contract. `deploy/README.md` describes the Compose layout, persistent
volumes, backup, migration plan, readiness checks, and rollback expectations.

The intended flow is: review and merge one coherent source change, build and
verify immutable images, update the server's digest references, run the
documented migration plan only when needed, start the selected services, and
verify `/healthz`, `/readyz`, the build SHA, login, and the changed routes.
Never use server-side source checkout/builds, production `db:push`, or a reset
of historical migrations.

The production host is `149.88.85.240` (SSH alias `frontmind-system-qjy`). The
old server `149.88.85.148` is retired and deliberately excluded. Releases are
normally driven end-to-end by the local `$frontmind-release` skill; usage
examples are in `docs/operations/RELEASE.md`.

## Workspace hygiene

The Git repository currently has several linked feature worktrees beside this
checkout. They are not additional applications. Keep them until their branches
are explicitly reviewed; do not delete branches or worktrees merely because
their directory names look old. Generated `node_modules`, `dist`, Vite caches,
and pytest caches are ignored local data and are not part of the source handoff.
