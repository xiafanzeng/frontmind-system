# Monitoring inside Dashboard

The Dashboard serves the monitoring tRPC router at `/api/monitoring/trpc`.
Downloads, private media, publisher uploads, public publication capabilities and
payment callbacks live under `/api/monitoring/`. The browser never talks to Moli
or KOL. Monitoring login/logout return 410; password and account administration
remain in the Dashboard. System administrators alone can call monitoring admin
procedures. They can also use their own customer workspace.

The existing unified migration `0056_monitoring_domain` contains the complete
monitoring schema through original migration `0008`. The domain repository uses
`monitoring_users` and `monitoring_sessions`, with Dashboard `users`/`sessions`
remaining authoritative. `monitoring_account_links` preserves any already-linked
UUID. New links use a deterministic UUID and a transaction locking the Dashboard
account; three wallets are created at zero, without grants or balance resets.
Account lists populate links for existing Dashboard users. Worker heartbeat
mirrors disabled/deleted accounts and roles before scheduled maintenance.
Do not run the standalone monitoring development migrator on this database.

The embedded API and worker share `DATABASE_URL`. `MONITORING_PUBLIC_ORIGIN`
should be `https://dashboard.frontmind.cn`; it falls back to the Dashboard public
origin. `MONITORING_SESSION_SECRET` is optional when the Dashboard credential
encryption key is configured: a purpose-specific HMAC derives a stable private
asset/payment capability key. The monitoring module never issues a session cookie.

For this single-host deployment, API and worker can use the same persistent
private data volume:

```
OBJECT_STORE_DRIVER=local
ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION=true
LOCAL_OBJECT_STORE_DIR=/var/lib/frontmind/monitoring-assets
```

The volume must be owned by the application UID 10001. Do not mount it as static
web content. Private monitoring media requires the Dashboard session and owner
check; publication images use a per-asset HMAC capability. The local driver
rejects absolute/traversing keys, creates directories/files with 0700/0600,
and prevents overwriting immutable keys with different content. Production stays
in `NODE_ENV=production`; this option enables neither local diagnostics nor demo
seeding. OSS remains available using the original server-only read/write keys.

Monitoring worker needs `MOLI_API_TOKEN`; its callback is
`https://dashboard.frontmind.cn/api/monitoring/webhooks/molizhishu`. Callbacks
only wake a job: the worker retrieves the authoritative provider result.
A run keeps its immutable configuration, is limited to 500 attempts and charges
only successful non-empty answers.

Without KOL credentials, enable the API media-publishing module and persisted
`publisher_runtime_state.feature_enabled` to permit article editing. Keep the
runtime in `live` mode with `credential_status=unconfigured`, publication disabled,
and configure the worker with `PUBLISHER_FEATURE_ENABLED=true`,
`PUBLISHER_PROVIDER_ENABLED=false`, `PUBLISHER_MODE=live` and the public HTTPS
origin. It then processes only DOCX imports and private asset cleanup; it creates
neither a KOL client nor a mock catalog. Provider jobs remain unclaimed and the
empty/unavailable catalog stays honest. Enabling the provider worker requires `PUBLISHER_KOL_ACCESS_TOKEN` or all
six original login fields, a real provider base URL and encoding, and explicit
publication runtime switches. No mock catalog or paid probe is an implicit part
of deployment. Customer prices remain the provider's resource `price`; supplier
and agent costs never enter customer outputs.

Online payment configuration retains the existing `FRONTMIND_ZPAY_*` and
`FRONTMIND_BANK_*` names. Monitoring Zpay notify/return URLs are scoped to
`/api/monitoring/payments/zpay/{notify,return}` on the Dashboard origin and share
the ledger's deterministic settlement/idempotency behavior.

Build workspace packages before Dashboard. The worker image recursively builds
its dependencies, preserves each app/package's pnpm symlinks and checks module
resolution before starting any network/provider operation.
