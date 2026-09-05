# Monitoring module provenance

The following modules were copied into `frontmind-system` from the
`frontmind-monitoring-system` repository at the fusion baseline. They are
namespace-isolated under `@frontmind/monitoring-*` so the Dashboard can adopt
them incrementally without a second login/API host.

| Destination | Source | Purpose |
| --- | --- | --- |
| `packages/monitoring-contracts` | `packages/contracts` | Zod contracts for monitoring, results, billing, admin, publishing |
| `packages/monitoring-db` | `packages/db` | Drizzle schema, repositories, worker adapter, migrations |
| `packages/monitoring-provider-moli` | `packages/provider-moli` | Molizhishu client and result normalization |
| `packages/monitoring-provider-kol` | `packages/provider-kol` | KOL publishing provider client and mocks |
| `packages/monitoring-object-store` | `packages/object-store` | Private/local/OSS object-store implementations |
| `packages/monitoring-publisher` | `packages/publisher` | Media publishing canonicalization and state machine |
| `apps/monitoring-worker` | `apps/worker` | Scheduler, provider submission/polling, result ingestion, publishing jobs |

Tests, `.env` files, deployment credentials, and database dumps were excluded.
Copied source imports were rewritten to the namespace-isolated package names.
The database schema remains a UUID-domain snapshot and requires the unified
Dashboard account-link adapter before production migration; it does not grant
users a second login or session store.
