# CN migration verification — 2026-09-06

## Current release, scope and acceptance status

The current Dashboard release is deployed. This report distinguishes completed
deployment and read-only checks from the still-pending Dashboard business
acceptance. Historical sections below preserve the evidence at each earlier
stage; their earlier blockers and runtime identities are not the current state.

| Service | Current source revision | Current image digest |
| --- | --- | --- |
| Dashboard | `c6b8f7465d0a5a09bd5d7bef422afc2bb50ef0b7` | `sha256:8785f7cd904118aa1abf6e8e7516d5aba07d10d2106d523e115711d238cecf87` |
| CN Website | `f1dc5182819574aea32dbc50a2f715c414d50e41` | `sha256:d6b3ed32728970ffee319592a269e9019547d9b03a14635207f36e968612238e` |

| Area | Current acceptance result |
| --- | --- |
| Dashboard deployment | Complete: production `/readyz` returned 200 with the exact SHA, migrations and schema; `degradedBuildCount` and `violationCount` were both zero. Website was unchanged by this release. |
| Login and unified navigation | Complete on `c6b8f74`: system administrator, customer and engineer accounts retained their identities across eight pages and twelve reloads, with no browser HTTP errors or page errors. The earlier real password-change boundary test also passed. |
| Original configuration and Token controls | Effective source environments and 1Panel runtime definitions were reconciled. The deployed UI retains the original Zhipu Token, 21st and Aliyun settings; native Website token counters were visible. |
| General agent | Complete on `c6b8f74`: the original two turns and both JSON downloads were reverified, including the attachment's exact-byte sum and hash. |
| Dashboard knowledge base | Pending: the approved reset and fresh upload/task started at 03:48:18 UTC (11:48:18 UTC+08:00); research remains in progress. No formal snapshot publication is claimed. |
| Dashboard brand universe and response logic | Pending: both require the fresh formal knowledge snapshot before business acceptance. |
| Original Website knowledge base, assessment and forecast | Complete: the original KB ZIP and both perspectives' assessments and forecasts survived reload. Its monitoring runs remain at exactly ten successful answers, with no additional attempts. |
| Website execution-log presentation | Complete: only standalone generic tool messages are hidden; detailed events, errors and absolute timers are preserved. |
| Website and Dashboard HTTPS | Complete: public/authoritative DNS, ACME issuance, dedicated SNI certificates and normal trust-chain/hostname validation passed. See the certificate section below. |
| Website building, template work and preview-dependent social acceptance | Outside scope by user instruction. WeChat/Xiaohongshu acceptance is paused because the original UI requires a website preview snapshot; no SiteOps or social mutation was submitted. |

All active AI execution uses Zhipu. Historical Manus tasks were retired by the
user and are not reconstructed. Original non-AI 21st/Aliyun credentials retain
their meaning even where historical database metadata defaults to Manus.
No further monitoring attempts or KOL orders are part of this acceptance.

## Historical production baseline restoration

Dashboard baseline: original production `74ad2397bb8d701a9cdd58c51b5070359295cf8a`.
Initial fused runtime: `543b0db016398a49f6724003cab9d958ae87463b`.
Initial CN Website runtime: `cb5aad9705dd74eed6ecdac1081bd01c55d2e81b`.

First Dashboard Managed Agents release:
`fcecc4b0c0becf787f24fadfca63dde11032333f`.
Its Dashboard digest was
`sha256:33025b6c53feb650dc2deb2dd0ac042da33c28e9747857eb0dd553813803961c`;
its worker digest was
`sha256:76df0fc6bac5c0aadc43335901eb6e42c156b3f95c5f269a32a1f4295813987e`.
Subsequent compatible fixes retain the same migration. The current identities
are listed at the beginning of this report.

Migration 0058 initially brought the new server's journal to 59 entries.
Migration 0059 subsequently brought it to 60 entries. Migration 0060 now
brings it to 61 entries, as recorded below. Schema verification reported 86 expected/actual Dashboard tables with
no differences; monitoring tables remain present. The first 58 applied SQL
files were not changed. Verified backups preceded both migrations.

Compared effective environments with both original production containers and
read-only 1Panel runtime definitions. No original production business variable
is missing. Intentional differences are CN origins, target database/network,
image identity and monorepo skill/migration paths. Twelve encrypted service
credential versions, one Website quota policy and the canonical administrator's
API credential were imported. Existing target accounts/passwords were retained.

The active original static template catalog was copied from the asset volume:
version `21st-included-recommended-20260828-v2`, 32 entries, 1 executable
admission and 31 previews unavailable for execution, exactly as on the source.
All catalog asset hashes passed verification; new filesystem integrity metadata
was generated by the normal seed command. Dashboard `/readyz` then returned 200.

## Historical baseline live checks

- Website and Dashboard HTTPS roots, `/healthz` and `/readyz`: 200, expected SHAs.
- IP HTTP entrance: 308 to canonical Dashboard HTTPS.
- Saved pre-deployment administrator session: authenticated after deployment.
- Six real pages, reload and second tab: same non-null canonical user ID,
  no repeated login and no unhandled browser JavaScript errors.
- Customer monitoring/publishing and system monitoring administration API reads:
  successful with the unified session.
- Draft creation/save and DOCX upload through HTTP: successful; the actual
  Worker parsed the uploaded DOCX, persisted private assets and returned its
  correct non-empty text. These drafts were not published.
- Molizhishu model/domestic/overseas catalog sync jobs: succeeded. No new paid
  monitoring execution was claimed as part of this read-only provider check.
- At baseline restoration, the original administrator Manus key, Website Manus
  key and 21st.dev credential authenticated from the new server. This historical
  check predates the user's Zhipu-only instruction; Manus is no longer used for
  active execution.
- Website readiness: original five skill hashes loaded; service and monitor
  credentials authenticated; payment, order and persistent stores ready.
- Backup: fixed the missing `--no-tablespaces` option and shell pipeline error
  masking. A new complete dump passed compression validation and was stored
  mode 600; failed dumps can no longer appear as successful published backups.

## Remaining external configuration

Zhipu funding is now usable. The original Website project recovered through
its normal controls and completed both real assessments and forecasts; see
the recharge recovery results below.

KOL formal API credentials and logo-search configuration were absent from the
source runtime. Real publishing is disabled; draft management and private DOCX
processing are available. No mock media or provider orders were created.

Aliyun OAuth application configuration is corrected: the original `.net`
callback remains allowed, the CN callback
`https://dashboard.frontmind.cn/api/site-ops/aliyun/oauth/callback` was added,
and the original code-required `/acs/alidns` permission was granted in the RAM
console. The normal Dashboard credential replacement then passed live upstream
validation and saved version 3. Tenant DNS management still requires that
tenant's own verified OAuth authorization; application readiness does not
substitute for a customer grant.

## Certificate issuance

Public resolvers 1.1.1.1 and 8.8.8.8 and authoritative servers
dns7.hichina.com and dns8.hichina.com resolve `www.frontmind.cn` and
`dashboard.frontmind.cn` to `149.88.85.240`, with no conflicting AAAA or CNAME.
Let’s Encrypt HTTP-01 validated the `/var/www/acme` webroot and issued an
EC-256 certificate whose SAN is `www.frontmind.cn`, valid until
2026-12-04 13:37:45 UTC. Website previously received the Dashboard certificate;
the dedicated SNI virtual host now selects `website.key` and
`website.fullchain.pem` under `/etc/ssl/frontmind/` and proxies to port 8888.
Dashboard uses its own certificate and port 3001. Both public HTTPS services
passed normal trust-chain and hostname validation without a TLS bypass.

ACME webroot routes remain reachable before HTTP redirects. Existing acme.sh
cron checks four times daily, installs renewed certificates to the configured
paths and reloads OpenResty. These services are host-managed rather than
represented by the 1Panel site list. See `deploy/openresty/HTTPS.md`.

## Historical production dependency parity

The monorepo initially resolved semver ranges differently from the actual
Dashboard production lock. This broke the native React build contract and
loaded an incompatible transitive motion runtime. The 70 native contract
dependencies are now pinned to their existing exact versions, the original
patches/overrides live at the workspace root where pnpm applies them, and
130 original Dashboard dependency coordinates and their transitive graph were
restored from production `74ad2397`. Seven integration-specific dependencies
remain. Frozen offline installation and workspace typechecking passed; the
complete frontend suite passed 1,228 tests (7 explicitly skipped).

Original production deployment reference files under `apps/dashboard/` were
also restored to that source SHA. New-server deployment continues to use the
root Compose and workflow. Migration tests retain the original constraints
while checking the consolidated 0058/0059 schema: 132 tests passed. Importing
SQL policy helpers no longer runs the standalone historical CLI audit. That
legacy audit still rejects historical 0055/0057 classifications; no applied
SQL or historical policy was rewritten to hide it. At that release stage, the
actual release CLI validated the applied journal and the one pending additive
migration. Current readiness has no pending migration.

## Historical compatible provider release

After a verified backup at
`/srv/frontmind-system/backups/frontmind_system-before-zhipu-20260905T172422Z.sql.gz`,
migration 0059 completed once. The applied count is 60 and its journal hash is
`454ae1b8b76e33d0c46dde291bb91372de68d285e2252bbc7f81b2ca76289d25`.
All 86 Dashboard tables match the new schema exactly; monitoring tables remain.
Both applications returned HTTP 200 from health/readiness endpoints after start.
The running image revisions were independently inspected.

The full node suite passed 4,259 tests (64 skipped); the full client suite
passed 1,228 (7 skipped). The later delivery-wording fix passed its 14 provider
tests and the complete build. The final image itself resolved all 70 native
dependencies correctly and matched the wouter patch byte for byte.
The temporary registry relay, tunnel, loopback CA and TLS private key were removed.

The saved administrator session passed all six pages, reload and a second tab
with the same user ID and no uncaught JavaScript errors. Three rounds of
concurrent monitoring/publishing administrator and balance reads passed. A
pre-existing mojibake `displayName` on administrator ID 1 was corrected from
the same row's already-correct `name`; the conditional transaction changed
exactly one row and browser verification passed.

## Historical Zhipu original-workflow validation

The five original skill ZIPs and their manifests matched their original hashes
in the real Zhipu environment. Real adapter executions passed the original
classification, knowledge-base archive/finalizer, question selection, overseas
translation, assessment and forecast contracts. The knowledge archive had 18
leaf files and a non-empty image asset. Recommendation initially used the
original partial-result path: 15 valid selectable questions from 20 outputs.

Assessment's first result failed the original cross-field validation. The
adapter's transport-schema wording was clarified to preserve the original
skill's stricter constraints. Original prompt, schema and ZIP bytes were not
changed. The original allowed second attempt passed all 13 metrics, authority
checks and deterministic scoring. Forecast passed its original six-action,
four-week scenario checks and deterministic calculations. These assessment
and forecast prechecks used explicitly synthetic monitor inputs; they are not
claimed as production monitoring executions.

The original administrator settings API activated Zhipu credential version 9.
All eight previous Manus versions were retained, including the retired former
active version. A real public-information Website project was admitted through
the original invitation/business-owner flow. Its knowledge-base operation uses
Zhipu and frozen high effort. Actual execution text appears beneath the timer;
refresh/reopen retained the same operation, task and provider session. The real
knowledge-base ZIP downloaded through Website and passed its original parser
(52,083 bytes; SHA-256
`07b3b30b8e558ec04f86de9a6272f0d90201ee23fb8aa5f25e6e040af73805d6`).
The UI showed 7 branches, 40 documents and 16 sources. The actual recommendation
completed with 20 accepted/selectable questions and no dropped items.

The original two-question confirmation submitted exactly once: two DeepSeek
runs with five repetitions each, 10 authoritative upstream subtasks. Refresh
and reopen retained the same runs and upstream tasks. All 10 real monitoring
answers succeeded with no failures.

The two original automatically-created Zhipu assessment sessions initially failed
before assessment tools ran. The authoritative provider event was
`session.error`, `unknown_error`, exhausted retry status, with the message
“余额不足或无可用资源包,请充值。”. The existing project, successful monitoring
results and failed assessment records are retained. No new identities or
additional monitoring attempts were submitted in response. At that stage,
production assessment and forecast were blocked by the provider account's
balance/resource package; the earlier synthetic-input checks did not replace
production validation. That blocker was subsequently resolved, as recorded in
“Website funding recovery completed” below.

Recovery used the original project's 现状评估 and 重新评估 controls after
funding became usable. Each new assessment retained its failed predecessor
and reused the completed knowledge base and real monitoring results, without
submitting another monitor run. Project access remains in the original
browser's IndexedDB; no project-access token is included in this report.
Both actual assessments and their automatic forecasts have now succeeded.

## Historical monitoring production activation

The attempt, wallet and provider-state observations in this section describe
that activation check. No additional monitoring attempt is being submitted as
part of the current Dashboard knowledge-base acceptance.

Catalog synchronization discovered 17 models, but all remained unverified and
disabled. The existing capability-probe API was restricted to localhost
development, while production upsert correctly refused fabricated verification
flags. The administrator's monitoring wallet also started at zero. The normal
production administrator verification entry is now deployed with an explicit
server budget, existing ownership/quote/idempotency checks and authoritative
worker results. It preserves the default zero budget, quotes every existing
capability dimension and supports explicit re-verification only from a
confirmed terminal batch. An unresolved submission or page reload retains its
same deterministic intent. Focused checks passed 13 API tests and 6 UI tests;
Dashboard and monitoring API typechecks and the production build passed.

GitHub build `33982081526` published
`187565420be428f2709468dc7f4d4a56b90e0d67`. Its Dashboard image passed all 70
native dependency versions, the original wouter patch bytes and the required
motion-dom version. The source and runtime environment revisions
were verified on all four running application containers. This deployment
required no database mutation: the 60-entry journal and schema remained exact.
Both public health/readiness endpoints returned 200. The saved administrator
session again passed six pages, reload, a second tab and three rounds of
concurrent administration reads. The temporary TLS registry relay, SSH tunnel,
dedicated loopback CA and private TLS files were removed after image transfer.

The administrator used the normal balance adjustment API once to grant
9,900 ten-thousandths (CNY 0.99) in isolated acceptance funds. The new admin UI
submitted exactly one 7-attempt, CNY 0.90 capability batch with its frozen quote
and deterministic key. Six dimensions passed with authoritative non-empty
answers: default search, reasoning search, mention screenshots, all
screenshots, default region and domestic region 310000. Real screenshot assets
were archived. DeepSeek was enabled through the normal administrator API only
after those results; the frozen plan fingerprint remained unchanged. The other
16 models remain unverified and disabled.

Overseas region 224 remains in provider processing on its original attempt
`8a815c5f-7198-4e5a-b1a2-548866928aaf`, run
`62b80e60-1022-4836-98cb-3d98de9e2008`, provider task
`a6aa870aaa7f49dd8d80c6aeba356b12` and subtask `21836217`. It survived the
worker deployment with the same identity. It has not been marked successful,
failed or unsupported, cancelled or resubmitted; its CNY 0.09 reservation
remains active while the worker polls the authoritative provider result.

Together with the successful ordinary run below, this acceptance created
exactly 8 attempts with 8 distinct consumer IDs. Seven non-empty successes
each have exactly one matching consume entry, totaling 9,000 ten-thousandths
(CNY 0.90). The wallet has balance 900, reserved 900 and available 0. Only the
overseas CNY 0.09 remains reserved; there is no available unused grant to
reverse. All attempts bind immutable configuration, brand and price snapshots
before dispatch. No media order or further acceptance attempt was created.

## Historical normal monitor form correction

Actual production use exposed a repeated-quote loop: a parent mutation render
recreated equal model objects, which recreated the quote input and retriggered
the quote effect. The button remained disabled while pricing repeatedly
returned CNY 0.09. No ordinary monitoring attempt was submitted during this
failure. Commit `6bb5864407dea59cd0ff02a7dd2722ba1461ad09` binds the request to
the existing semantic quote fingerprint instead of object identity, retaining
stale-response cancellation and live balance validation. Eight focused tests,
Dashboard typechecking, the production build and an independent code review
passed. A local new build using production read-only quotes displayed CNY 0.09
and enabled the normal confirmation button without duplicate quote requests or
paid submissions. GitHub build `33984043395` published that source and
both exact images.
The final image passed the 70 native dependency and patch checks again. The
release preserved the exact 60-entry journal/schema without a database
mutation. All running source/environment revisions and public health/readiness
checks passed. On this final version, the saved administrator session again
passed six pages, reload and a second tab with the same canonical user ID and
zero uncaught JavaScript errors. Three rounds of concurrent administration and
balance reads passed.

The normal customer page then submitted its one authorized
question/platform/repetition run with a CNY 0.09 quote, no automatic schedule
and exactly one create request. Run
`65920952-50c0-470f-9544-a4064dfb4ce9` on monitor
`946705fe-b9b9-414c-8e7d-26d42a63d071` completed with a real 713-character
answer and 9 sources, including the official SiliconFlow website. Its single
attempt `beb25cbf-cfd2-469d-9c45-a95c373dbb57` has exactly one CNY 0.09 consume
entry. The customer result page showed the answer, sources and configuration
V1; refreshing retained the result and authenticated canonical user ID 1 with
zero page errors. This completes the ordinary customer monitoring path.

Authenticated result URL:
`https://dashboard.frontmind.cn/monitoring-system/946705fe-b9b9-414c-8e7d-26d42a63d071/runs/65920952-50c0-470f-9544-a4064dfb4ce9`.

To make room for this release, only two unused owned `2b04867` image caches
were removed after confirming that no container used them. Their exact
repository references and revisions were recorded on the host for re-pull.
The live and compatible rollback images, all containers and data were retained.
The temporary quote-fix relay/tunnel and their scoped TLS certificate, key and
loopback CA were removed after transfer.

## Website log presentation update — 2026-09-06 07:29 UTC+08:00

Website commit `f1dc5182819574aea32dbc50a2f715c414d50e41` hides only the
standalone generic messages 开始调用工具, 工具执行完成, 工具执行失败 and 正在执行
from the customer log. Matching permits surrounding whitespace and a final
period or exclamation mark. Filtering precedes the latest-30 slice and history
count; original events and absolute timers remain unchanged. Specific research
updates, concrete errors and task failure status are retained.

The existing four execution-log browser tests, typecheck and explicit CN
production image build passed. Only the Website service was recreated; the
Dashboard, site-operations worker, monitoring worker, MySQL and backup container
identities/start times were unchanged. Website persistent mounts were identical,
and public HTTPS health/readiness checks returned the new SHA successfully.
No provider execution was submitted for this presentation change.

After reloading the retained production project, the enterprise-analysis log
decreased from 140 to 29 entries: all 111 generic messages were hidden, and
the remaining sequence matched the original events with only those messages
removed. Every detailed research update remained; the timer stayed 00:10:10.
The failed assessment retained its error details, failed status and 00:00:06
timer. This browser verification sent no execution mutations.

## Historical Dashboard Managed Agents release — 2026-09-06

Commit `fcecc4b` routes all active Dashboard agent workflows through the frozen
credential provider: general chat, knowledge base, response logic, brand
questions, site building and social. At that stage, existing Manus credential
versions and tasks remained bound to their original provider; the user's later
Zhipu-only instruction retired Manus task execution and reconstruction.
Website building, template work and preview-dependent social acceptance are
now outside this task's scope. Original Skill packages,
business prompts, parsers, confirmation points and downloads are preserved.
No Dashboard log interface was added.

The stable complete suites passed: 4,312 backend/shared/script tests and 1,238
client tests, with 64 and 7 existing skips respectively. Workspace typechecking,
partition verification, protocol/source governance and production image builds
also passed.

After the recoverable backup
`/srv/frontmind-system/backups/frontmind_system-before-dashboard-managed-20260906T015958Z.sql.gz`,
0060 added only provider/model/effort columns to API credentials. The migrator
reported 61 applied entries, no pending entry, and exact schema for all 86
Dashboard tables. Journal hash:
`79afdf3152b60c1beaef5b8e1a1da94f6ce2005bb34609aa1f87c3014bfb1cba`.
Website remained on `f1dc518`; its image and data mounts were preserved.
Both public health/readiness endpoints returned 200. Six unified pages, reload
and a second tab retained the administrator identity with no browser errors.

Independent test customer and delivery-admin accounts were provisioned through
the original APIs. New Zhipu credentials were saved through API/personnel
management without replacing existing customer credentials. General chat
accepted an exact-byte text attachment, returned the correct sum and SHA-256,
and downloaded its validated JSON through the original private artifact route.
The original Agent UI displayed the conversation and file after reload.
Further Dashboard business workflow acceptance remains in progress.

New-customer acceptance exposed a pre-existing profile setup cycle: profile
import required content assets, which required an existing knowledge snapshot.
The dedicated profile import now permits that missing-snapshot condition only
when the same customer's original knowledge-build entitlement passes. Other
modules, ownership, inactive-account restrictions and full-dashboard editing
retain their original authorization.

The original knowledge-base first turn exposed an adapter defect before any
Agent, Environment, Session or user-message mutation: its generated instructions
use `text/plain; charset=utf-8`, which the inline data-URL parser rejected.
The parser now preserves MIME parameters and exact attachment bytes. Invalid
inline attachments return an explicit local rejection rather than an unknown
provider outcome. A transport regression covers both the original ZIP and
charset-qualified UTF-8 instructions, exact hashes and single-session replay.
The failed acceptance turn is retained and recovery uses the original reset
workflow; this finding does not count as completed KB business acceptance.

Two independent newly created accounts reproduced an immediate-login failure:
their first session's database `createdAt` was one second earlier than
`passwordChangedAt`, although it was issued after password verification. The
application/database clocks agreed. MySQL `TIMESTAMP(0)` rounded explicit Date
values but truncated `DEFAULT NOW()` for session creation. Sessions now write
an explicit creation timestamp from the same clock as their other timestamps.
The strict password-change fence and locked login transaction remain intact;
regressions cover both sides of the half-second boundary.

Both fixes are live in `26cec6d698ac751abdd5162938bf89734142b6b2`, built by
GitHub run `34006859017`. Dashboard digest:
`sha256:cc19973c1cc0a3d4f7cc21cb450a2b09c1e92a2a659f59e6392d74a8e644f01e`;
worker digest:
`sha256:34d69fba403c41233e106cb866272d6fffe1f7108d593ec080d4f03f67420b87`.
No database migration was required. Public readiness returned exact schema;
the Website container and its start time were preserved. The existing two-turn
general-agent results still downloaded and validated after restart.

The original password-change and login APIs then passed a real boundary test:
password change was acknowledged at `02:48:51.793Z`, followed immediately by
one login; first authentication succeeded at `02:48:51.955Z`. Password and
new session timestamps both persisted as `02:48:52.000Z`. Eight browser reloads
retained the user, all old sessions were revoked, and exactly one new session
was created. This used only the independent validation engineer; no provider
call was submitted.

An independent read-only check isolated the inherited conversation-retention
failure to MySQL 8.4 rejecting a prepared `LIMIT ?` bound as mysql2's numeric
DOUBLE type. The same SELECT accepted its validated batch size as a string.
Only that parameter binding was changed; the existing 30-day cutoff,
transaction and deletion rules remain unchanged. Six retention tests passed.
No cleanup was manually invoked for validation.

## Website funding recovery completed — 2026-09-06

Each original perspective used its normal “重新评估” control once. Both
assessments succeeded, then both original automatic forecasts succeeded.
Original assessment parser, sample/source-count and scope checks, deterministic
scoring, forecast parsers and calculators all passed. The two previous balance
failures remain recorded.

The original two monitor runs retain exactly ten successful answers and the
same credential version, request/idempotency/terminal hashes and provider task
IDs. No monitoring attempt was added. After deployment and page reload, all
four outputs remained ready and the original KB download was byte-identical:
52,083 bytes, SHA-256
`07b3b30b8e558ec04f86de9a6272f0d90201ee23fb8aa5f25e6e040af73805d6`.
These are real original-project results, superseding the funding blocker
described in the historical validation section above.

## Zhipu-only execution and healthy long-running KB — 2026-09-06

The user retired historical Manus tasks and superseded the earlier retention
requirement above. Active Dashboard and Website AI execution now uses Zhipu;
unknown task creation does not search or reconstruct old conversations. The
existing approved reset starts a fresh upload and task. Ordinary acknowledged
session continuation and original business parsers remain.

A new knowledge-base task on 26cec6d uploaded the original 25,943-byte Skill
and 2,798-byte UTF-8 instructions with both frozen hashes matching. Dashboard
settled it as unavailable at 03:03:56 UTC, after 15 minutes of running, although
Zhipu was still executing. Zhipu delivered the 232,481-byte ZIP at 03:11:39 and
ended the turn at 03:11:58. The downloaded ZIP passed the existing materialized
knowledge-base validator locally. No failed local conversation was rebuilt.
The running-time reset rule has been removed; actual terminal and interrupted
provider states continue through the existing workflow. The fix is deployed
in `c6b8f74`; fresh formal Dashboard knowledge-base acceptance remains pending.

The adapter no longer performs a second AJV schema check before the existing
business validator. It extracts usable JSON and preserves output attachments,
including when the last public message is only a closing sentence. Old Manus
proxy, signed PUT recovery, title-based task reconstruction and unused live
preview execution paths were removed. Original Skill ZIPs, inputs, user
confirmation, ownership checks and private download boundaries remain.

Code validation covered 4,216 backend/shared/script tests and 1,232 client
checks, with 58 and 7 existing skips. The final full backend run passed 4,215
and exposed one stale expectation that still permitted a Manus model; after
correcting that expectation, the consumer suite passed 4/4. The full client
run passed 1,230 and had two timing-sensitive interaction failures; both
affected suites then passed all 57 checks without application changes. These
targeted rerun counts overlap the full suites and must not be added to them;
neither initial full run is described as an all-green run. TypeScript, test
partition/source checks and frozen-lock validation passed. This is code
validation, not the pending fresh production workflow acceptance.

## Current c6b8f74 deployment and browser verification

Dashboard readiness returned HTTP 200 for
`c6b8f7465d0a5a09bd5d7bef422afc2bb50ef0b7`, digest
`sha256:8785f7cd904118aa1abf6e8e7516d5aba07d10d2106d523e115711d238cecf87`.
It reported production mode, exact migrations/schema, `degradedBuildCount: 0`
and `violationCount: 0`. Website remained on `f1dc518`.

The system administrator opened `/`, `/admin/presales`,
`/admin/monitoring/accounts` and
`/admin/monitoring/media-publishing/integration`; the customer opened `/`,
`/monitoring-system` and `/publishing`; the engineer opened `/`. Each account
passed four reloads, twelve in total. `auth.me` retained the same account
identity, no login form appeared, and all eight pages loaded without browser
HTTP responses at or above 400 or page errors.

Customer navigation retains the original Dashboard and adds 监控与发布 with
问题监控 and 媒体发布. System administrators receive the separate
监控与发布管理 section. Original unified settings display Zhipu Token, 21st
and Aliyun controls. Website native input, output and cache token counters and
task counts were visible; these are running usage values, not fixed totals.
The check made no provider, credential or data mutations. The read-only
browser harness blocked six automatic `conversation.syncSnapshot` POSTs to
keep the fresh KB untouched; those harness blocks were not application errors.

The original two-turn general-agent conversation and both JSON downloads were
reverified on `c6b8f74`. The attachment's byte sum and hash matched, and the
original conversation UI and private download path remained available.

Private evidence filenames: `dashboard-postdeploy-ready.json`,
`dashboard-postdeploy-ui-readonly-report.json` and the eight corresponding
administrator/customer/engineer screenshot/text captures. They are retained
under `/tmp/frontmind-zhipu-validation-private`; authentication material is not
included in this report.

## Pending Dashboard business acceptance

The approved original reset and fresh upload/task began at 03:48:18 UTC
(11:48:18 UTC+08:00), with reset revision 2. The provider is still conducting
normal research. Formal materialized knowledge-base publication has not yet
been verified, and the historical 232,481-byte ZIP's successful local
validation does not establish a published snapshot for this new run.

Brand-universe and response-logic acceptance remain pending until the fresh
formal snapshot exists. The Website's completed KB, assessments and forecasts
are separate business results and must not be used to mark these Dashboard
workflows as passed.

## Explicitly excluded website and social work

The user removed website building and template work from the current task.
No SiteOps project opening, template selection, build, publication or related
DNS mutation is required for the remaining Dashboard acceptance.

The original WeChat/Xiaohongshu UI has no independent entry:
`SiteOpsConversationPanel.tsx` renders its generation buttons only when a
snapshot exists and `interactionState` is `preview_ready`, `approved` or
`live`. Although the social service checks the project's bound KB, invoking
it directly before the original UI admits the operation would bypass that
lifecycle. Dependent social acceptance is therefore paused and outside scope;
no SiteOps or social mutation was submitted, and it does not block completion
of the included KB, brand and response-logic workflows.

The inherited template catalog remains 32 sources/previews with only template
22 admitted for execution. The other 31 retain
`STATIC_TEMPLATE_EXECUTION_ADMISSION_PENDING`. That restriction already
existed in the restored source baseline; this migration does not claim that
all 32 templates are selectable. No further template investigation or build
acceptance is part of this task.

## Customer self-service release preparation — 2026-09-06

The user removed the entire delivery-ticket workflow from scope and authorized
customers to reset and modify their own Dashboard directly. Customer ticket
history, engineer processing and approval, administrator dispatch, ticket
attachments and their active APIs have been removed. Existing schema and
applied migrations remain compatible; account deletion still removes legacy
ticket rows.

Direct actions retain account ownership, current service scope, quota and
revision checks. Dashboard editing preserves hidden source fields and uses the
same public projection for reads, writes and import results. Unreleased report
results cannot be overwritten or disclosed by saving customer-visible content.
Knowledge reset archives snapshots still referenced by historical site or
question records, and the cleanup worker retains files that still have a
durable reference. This avoids a foreign-key failure or deleting shared files.

The SiteOps restart dependency now starts a fresh local generation cycle and
preserves existing live deployment/DNS pointers. It releases reserved generation
quota and waits for an active publication/domain action to finish. These local
regressions do not constitute real website building or publishing acceptance.

Verification for this source change:

- Node suite: 314 files passed, 3 skipped; 3,992 tests passed, 57 skipped. The
  configured external MySQL acceptances are among the existing skipped checks.
- Client suite: 87 files passed; 1,046 tests passed, 7 skipped. A subsequently
  added dialog target-switch regression also passed in its 4-test focused run.
- TypeScript, exact Vitest partitions, source/runtime governance and
  `git diff --check` passed. Advisory legacy module-size notices remain.

The previous fresh KB task on `c6b8f74` produced a 356,747-byte ZIP accepted by
the original parser as 55 leaves and 129 evidence files. SHA-256:
`8fc0a18a7d1c53576a59e58e81525682c2fe251631c19edc3ce3b195e76797a2`.
Its single-node modification failed with native Zhipu `session.error`:
service unavailable, retries exhausted. No modification archive was produced,
and the build was not published. The adapter now retains this error across the
following idle notification instead of presenting an archive-integrity failure.
The old conversation is not repaired or reimported; a new reset/upload/task
will verify the original KB workflow on the self-service release.
