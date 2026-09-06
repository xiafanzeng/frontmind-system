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
six original login fields and a real provider base URL. Order submission also
requires confirmed encoding and the publication runtime switches. No mock catalog or paid probe is an implicit part
of deployment. Customer prices remain the provider's resource `price`; supplier
and agent costs never enter customer outputs.

The supported KOL origin is `https://api.kol.cn`. Read-only catalog operation
uses `PUBLISHER_PROVIDER_ENABLED=true`, `PUBLISHER_REAL_ENABLED=true`, a valid
access token or the six documented login fields, and
`PUBLISHER_PUBLISH_ENABLED=false`. `PUBLISHER_CREATE_ORDER_ENCODING=unknown`
can remain unchanged while only reading resources. The catalog request is
`GET /api/news_resource_2/data`, with token and page supplied server-side.
An administrator starts it from the media-publishing catalog administration
page (`publisherAdmin.requestCatalogSync`). It follows the provider's final
page, stages every page, and activates the complete result in one transaction.
The previous fixed 1,000-page cap has been removed: existing records show a
93,067-resource response at 50/page (1,862 pages). The existing 100,000-resource
bound still applies and incomplete pagination preserves the active catalog.

Catalog names and `price` do not depend on logo downloads. The worker defaults
`PUBLISHER_CATALOG_LOGOS_ENABLED=false`; optional logo jobs remain unclaimed
and no logo-search configuration is required. Setting it to `true` enables the
existing independent logo processing. Do not use the standalone original
repository's `sync:real` script as a deployment or catalog activation gate.
That historical script also required logo-search completion, which is outside
the current names-and-prices requirement.

The supplied source document is **软文街API接口文档2.0_已整合订单列表.docx**.
It documents authentication, resource pagination, order submission, order
queries, and result callbacks. `is_zimeiti=2` means news and `=1` self media.
Its authentication endpoint is `POST https://api.kol.cn/api/auth/authenticate`.
All six request fields are required: `mobile`, `password`, `identity`,
`captcha_token`, `captcha`, and `api_key`. Only the account and password examples
are explicitly placeholders ("实际登录账号" and "实际登录密码"). The document
supplies `advertiser` for the identity and both captcha examples, and a complete
32-character hexadecimal `api_key` example; do not reproduce that value in
source, logs, or customer output. The document does not establish whether these
examples are universal or account-specific, explain a captcha acquisition
endpoint, or require a separately requested API key. Do not claim that an extra
API-key application is necessary before trying the documented flow with
legitimately supplied KOL account credentials.

The input `api_key` and the returned `data.token` are distinct fields. A
successful authentication returns the token used for resource and order APIs;
those subsequent requests do not require the six login fields again. The
document explicitly says "token 接口只需获取一次，并且全局有效。" and
"调用其他接口时，如返回 status=401，需要重新获取 token。" Thus a token is reused
across subsequent API calls; the same text does not promise permanent validity
or cross-account access. No fixed lifetime is specified. If authentication
sets a `User-Agent`, subsequent calls must use the same value, as the document
also specifies.

The client supports either six-field login with a cached token and one safe GET
refresh on authentication rejection, or a supplied server-only access token.
It respects a token's JWT `exp` when present. A supplied token alone never
silently switches to login. When all six login fields are explicitly configured
alongside a token, the client first reuses that token; an actual safe GET 401
permits one login refresh and one retry of that GET. A 403 or incomplete login
configuration does not trigger that fallback. Reissuing a paid order is
never an automatic authentication retry. Safe GETs recover a temporary network,
HTTP, non-JSON or empty-response failure on the same page, with five attempts
and a one-second exponential-backoff base by default. Missing or empty
`Retry-After` uses that backoff; permanent HTTP, response-size and schema
rejections do not trigger repeated same-page requests. The existing
`PUBLISHER_GET_MAX_ATTEMPTS` and `PUBLISHER_GET_RETRY_BASE_MS` overrides remain
available. This does not retry order POSTs or change the 401/403 rules.

The production monitoring worker now runs commit
`5f1d8a35bfc0076411a3e838f3072f16f8cd5c55`. Its loaded runtime configuration
was verified as `maxGetAttempts=5` and `getRetryBaseMs=1000`; no legacy
environment override replaces these values.

On 2026-09-06 the user supplied the
KOL account credentials explicitly. One authentication from the production
host succeeded with HTTP/status 200, using the document's `api_key` example
and its three `advertiser` values; no separate API-key application was needed.
The issued token and original login inputs are held only in root-readable
server configuration/private files. The first authenticated resource page
returned 50 real name/`price` records and reported 91,832 resources across
1,837 pages. A real page later contained one resource with `name=null`; this previously rejected
the entire page and prevented catalog activation. The provider now preserves
page counts while normalization/staging excludes individual rows with no usable
name or customer price. A fully fetched catalog activates its usable rows and
retains the invalid-row count; missing pages and inconsistent totals still
cannot become an active catalog.

The original catalog job completed successfully at **2026-09-06 13:15:45 UTC**
after fetching all **1,837 pages / 91,832 records**. It activated **91,831 usable
resources: 10,787 news and 81,044 self-media resources**, with one missing-name
record excluded and no duplicate identities. The runtime is `live`, credentials
are healthy and both categories are complete. A non-JSON response failure
caused one full retry before completion; the original failed response body and
HTTP status were not retained, so their exact contents are unknown. The same-page
retry improvement above reduces this disruption without adding a new sync job.
After the worker update, the original job
`a63472f2-0ec4-4f3d-9e1c-d9ecae07f4b3` remained the only catalog-sync job and
was still `succeeded`; its run `b6f11c0b-a5ee-5a6d-ac0b-6cde914f9fd5` remained
`success`, with all active category counts unchanged.

Database verification found no empty names or nonpositive active prices and
matched all 50 original first-page names, categories and customer `price` values.
The existing customer account independently verified both category totals and
the first and final API pages, then rendered both media tables with real names
and market unit prices. No supplier-price or credential fields appeared in those
customer responses. Publication remains disabled; publication batches, order
items and submission attempts were all verified as zero after the worker
update. Logo downloads remain disabled independently of this usable
catalog. A signed-in browser session is not a configured worker API credential.

Customer publication history is part of the publishing workbench at
`/publishing?tab=records`. It retains the original search, media-type/status/date
filters, pagination, batch details, result links, and charges. Old
`/publishing/publications` links redirect with their filters, and existing batch
detail URLs remain valid. The navigation change does not alter stored history.

Online payment configuration retains the existing `FRONTMIND_ZPAY_*` and
`FRONTMIND_BANK_*` names. Monitoring Zpay notify/return URLs are scoped to
`/api/monitoring/payments/zpay/{notify,return}` on the Dashboard origin and share
the ledger's deterministic settlement/idempotency behavior.

Build workspace packages before Dashboard. The worker image recursively builds
its dependencies, preserves each app/package's pnpm symlinks and checks module
resolution before starting any network/provider operation.
