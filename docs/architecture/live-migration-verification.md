# CN migration verification — 2026-09-06

## Current deployment and business acceptance status

The table records the deployed runtime after the long-running-task and unified
workspace update. Public `/readyz` reports this build SHA and image digest.
Completed business acceptance below remains separate from brand-universe
acceptance, which is blocked by native provider failures. Historical sections
retain the outcomes and identities of their own stages.

| Service | Runtime source revision | Runtime image digest |
| --- | --- | --- |
| Dashboard | `2609549b3116378814362d8936a9d65f022f6f93` | `sha256:efc0d5bc836938e0db153f97122be940f678c3b03eb05de860e7e3bf62d3c798` |
| Monitoring worker | `ac5ac7c4fac6302a83e5fe760cc76e7b94f62e9f` | `sha256:7134db0d9d3690533f470ce5af5a64e6876914021858368fdb926295187661a3` |
| CN Website | `f1dc5182819574aea32dbc50a2f715c414d50e41` | `sha256:d6b3ed32728970ffee319592a269e9019547d9b03a14635207f36e968612238e` |

| Area | Current acceptance result |
| --- | --- |
| Dashboard deployment | Complete: production `/readyz` returned 200 with the exact SHA, migrations and schema; `degradedBuildCount` and `violationCount` were both zero. Website was unchanged by this release. |
| Login and unified navigation | Three roles passed nine paths, nine reloads and 27 page/identity/editor checks on `1c89b0e`. Seven further customer editor/download/identity checks passed on `ac5ac7c` after KB publication. No failed GET requests or uncaught browser errors; the earlier password-change boundary test also passed. |
| Original configuration and Token controls | Effective source environments and 1Panel runtime definitions were reconciled. The deployed UI retains the original Zhipu Token, 21st and Aliyun settings; native Website token counters were visible. |
| General agent | Complete on `70fa85f`: the original two turns and both JSON downloads were reverified, including the attachment's exact-byte sum and hash. |
| Customer self-service | Complete: own Dashboard editing/restoration and fresh KB reset passed live; on `70fa85f`, fresh direct question selection, draft save, response reset/replay, modification and subsequent deletion all passed. The pre-fix successful reset also replayed correctly. Retired ticket routes returned NOT_FOUND. |
| Dashboard knowledge base | Complete on `1c89b0e`: fresh generation, one real node revision, 55 read/confirm actions, original final ZIP download and formal snapshot publication all passed. |
| Dashboard brand universe | Not passed: three original max tasks and one controlled high comparison all failed with native provider service-unavailable/retries-exhausted events and no deliverable. Original Skill hashes, formal KB and model were unchanged. The account default was restored to max; no fifth task was submitted. |
| Dashboard response logic | Complete: direct question selection, binding, initial generation/save, same-session continuation/save and confirmation passed. Confirmed revision 6/version 1 and all four original fields matched independent API/DB readback after the `70fa85f` restart. |
| Original Website knowledge base, assessment and forecast | Complete: the original KB ZIP and both perspectives' assessments and forecasts survived reload. Its monitoring runs remain at exactly ten successful answers, with no additional attempts. |
| Website execution-log presentation | Complete: only standalone generic tool messages are hidden; detailed events, errors and absolute timers are preserved. |
| Website and Dashboard HTTPS | Complete: public/authoritative DNS, ACME issuance, dedicated SNI certificates and normal trust-chain/hostname validation passed. See the certificate section below. |
| Website building, template work and preview-dependent social acceptance | Outside scope by user instruction. WeChat/Xiaohongshu acceptance is paused because the original UI requires a website preview snapshot; no SiteOps or social mutation was submitted. |

All former Manus AI execution uses Zhipu. The original independent Jenova
Brand Tracker and monitoring/publishing providers retain their integrations.
Historical Manus tasks were retired by the user and are not reconstructed. Original non-AI 21st/Aliyun credentials retain
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

## Historical c6b8f74 deployment and browser verification

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

## Historical Dashboard business acceptance before self-service release

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

## Customer self-service release — 2026-09-06

The user requested removal of the entire delivery-ticket workflow and authorized
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
subsequently verified the original KB workflow on the self-service release,
as recorded in the completed knowledge-base acceptance below.

Release `1c89b0e1077c97a561e91d5e4da4ebb414d45fb8` was pushed and built by
[the successful image workflow](https://github.com/xiafanzeng/frontmind-system/actions/runs/34012525001).
Both deployed images carried that source revision; later runtime identities
are listed at the top of this report. Dashboard readiness returned the exact source revision and exact
migration/schema state. This release required no migration. Website retained
its prior image, container identity and start time.

The dedicated customer edited and then restored its own Dashboard through the
public API. Revisions advanced from 1 to 2 to 3; the full original payload,
including hidden source content, was restored exactly. A stale revision was
rejected, and adding another account's user ID was rejected. No provider task
was started by this editing check. The same customer's direct knowledge reset
then succeeded, cleaned the former build/conversation and started a new
conversation at 05:10:55 UTC using the original company, website and public
notes. It did not reuse an old ZIP or provider session.

Read-only browser acceptance passed nine role paths, nine reloads and 27
page/identity/editor checks. Customer, delivery-member engineer and system
administrator identities matched exactly. There were no failed GET requests
or uncaught errors. The customer's global Dashboard editor opened the original
content and website tabs with their template download controls. Dedicated
content/website editors correctly remain unavailable during KB reconstruction,
matching the server's existing service prerequisite and displayed reason.
The harness blocked 13 automatic conversation snapshot POSTs; it performed no
business mutation. These deliberate blocks were not application errors.

The existing general-agent initial and continuation downloads were reverified
on `1c89b0e`; both `validation-result.json` and `validation-followup.json`
retained their expected values and attachment hash.

## Self-service entry corrections — 2026-09-06

Follow-up source revision `ac5ac7c4fac6302a83e5fe760cc76e7b94f62e9f` fixes two
client entry failures discovered during review. A Basic customer can have more
than one still-active purchase period. The question action dialog now reads
the portal's full purchased-question set, matching the existing server mutation
scope, so earlier active purchases can be modified, deleted or have response
logic reset. Expired or another account's questions are still unavailable.
No server ownership or service rule was widened.

A new customer's unconfigured R0 Dashboard returns a null public payload.
The editor now initializes that explicit R0 state with the existing empty
Dashboard structure, allowing the original profile download/import/confirmation
flow to create the first version. It does not synthesize an empty payload for
an unavailable existing Dashboard. Response confirmation now points to direct
reset instead of the removed request workflow.

The four affected client suites passed 90 tests with seven existing skips.
TypeScript and `git diff --check` passed. Image build and deployment are tracked
separately from these source checks.

The [image build](https://github.com/xiafanzeng/frontmind-system/actions/runs/34013983024)
succeeded, and `ac5ac7c` was deployed with images built from that revision.
Readiness reported exact source, migration and schema state; no migration was
required. Website's container and start time were unchanged. After formal KB
publication the customer passed seven further browser checks: both dedicated
content/website editors opened directly, original current-data templates
downloaded with revision 3, and returning/reloading retained the same customer
identity. No failed GET or uncaught error occurred. The harness blocked one
automatic SiteOps initialization POST, so no site project or build was created.

## Fresh Dashboard knowledge-base acceptance completed — 2026-09-06

The customer self-service reset started a wholly new upload and conversation at
05:10:55 UTC. Initial generation completed after more than 20 minutes, with 55
leaves and 43,827 body characters. The original parser reported complete,
downstream-eligible and publishable output. The former 15-minute cutoff did not
interrupt this healthy task.

One real revision clarified source attribution in leaf 1.1 and removed an
internal workflow tailnote. The original node-revision flow succeeded; exact
comparisons established that the other 54 leaves retained their bodies,
titles and order. All 55 leaves were read and confirmed against the current
presentation hashes. Final build revision was 56 and content version was 2.
Both API and database reported the published state without a notice.

Formal snapshot: `8c8d14ab-1e0b-4688-afeb-1dbf140103f9`.
The original final download contains 175,337 bytes, 119 entries and 115 Markdown
files. SHA-256:
`1beb7c1a79da97b46632d9ae4abdface8f03f7e4b09b433651009aa5695c33b1`.
ZIP CRC, byte count, archive hash and all 55 leaf bodies passed verification.
The run did not import any previous ZIP or reconstruct an old conversation.

## Replacement-question identifier correction

Real customer acceptance on `ac5ac7c` passed direct selection, draft response
save, response reset, idempotent replay and question modification. Deleting the
returned replacement exposed a malformed identifier: the deterministic hash
had not set UUID version/variant bits. Source `70fa85f` corrects only new
replacement IDs to UUID v8. Existing internal audit keys remain unchanged so
previous successful requests retain their replay results; the public UUID
input validation is unchanged.

Twenty focused maintenance/self-service tests and TypeScript passed. A read-only
database check found exactly one affected replacement, belonging solely to the
dedicated validation customer, with no response, monitoring or derived-question
dependencies. That temporary row was conditionally archived by its exact owner,
ID, revision and test text. The formal knowledge snapshot and separate response
question were untouched.

The [image build](https://github.com/xiafanzeng/frontmind-system/actions/runs/34015141629)
succeeded. Dashboard and its same-image SiteOps worker were deployed from
`70fa85fee243240b99ccc29a3b28f00f68de9e84`; readiness returned the exact source
revision, image digest and migration/schema state. No migration was needed.
The independently unchanged monitoring worker remained on `ac5ac7c`, and both
its container/start time and Website's container/start time were preserved.

Fresh customer API acceptance on `70fa85f` passed selection, draft response
save, reset and replay, modification and deletion of the resulting UUID v8
question. The successful reset issued before this correction also returned its
original replay result. Both temporary new questions ended archived; the
separate formal response question and knowledge snapshot were preserved.
Removed customer, engineer and administrator ticket routes returned NOT_FOUND.
No provider execution was initiated by these self-service actions. The existing
general-agent two-turn downloads also passed verification after this restart.

## Dashboard response-logic acceptance completed — 2026-09-06

An independently selected customer question used the published knowledge
snapshot and original `response-logic-builder` Skill. The complete original
workflow passed: bind at revision 1, start at revision 2, initial save at
revision 3, continuation at revision 4, second raw-result save at revision 5
and confirmation at revision 6/version 1. Both provider turns used the same
session. The continuation remained running until its own result arrived;
the first turn's output was not misclassified as a completed second turn.

After the `70fa85f` restart, the acknowledged task and its second result were
still readable. Independent API and database checks at 06:15:17 UTC confirmed
all four final fields exactly matched the second raw result and the reviewed
SHA-256 values. The review checked relevant KB leaves for product, protocol,
model-count, example-price and scale statements. No monitoring batch or sample
was created. Response generation used exactly the original initial and
continuation calls; the existing keyword table payload remained unchanged.

Question: `d935bb97-ae71-41a3-8729-12fcbeb04362`.
Confirmed record: `93cd2eac-372d-49a6-a7fd-d7515447188c`.
The provider improved attribution, dates, price qualification and API migration
boundaries in the second turn. It retained the original Skill's five-step
structure and expanded the conclusion from 336 to 375 characters, so the
internal request to shorten it was not fully followed. No manual rewrite or
third provider call was used to disguise that content limitation.

Seven focused read-only browser checks on `70fa85f` confirmed the four fields
in the formal question workspace and confirmed editor, the correct editable
question/reset targets, disabled confirmation for the confirmed record, and
identity/content persistence after refresh. API state remained revision 6,
version 1, confirmed. No failed reads or uncaught page errors were observed.
All browser mutations were blocked and dialogs were canceled. Consequently,
the conversation pane's automatic save/synchronization was not exercised;
these checks establish field display and controls, not conversation-pane loading.

## Brand-universe native failures and bounded fresh retry

The first operation, `c8cb9498-4a82-44ed-a188-8f90395611bb`, ran for
16 minutes 1.519 seconds before the upstream emitted `session.error` with
`unknown_error`, service unavailable and exhausted retries. Its last model
request lasted 10 minutes 59.253 seconds and ended with `is_error=true`.

The second operation, `06f92e33-11ed-42e2-a8f3-72a12fb6e02d`, ran for
17 minutes 1.628 seconds, from 06:09:22.894 to 06:26:24.522 UTC, and received
the same native error followed by idle with `retries_exhausted`. Its final
model request lasted 11 minutes 54.649 seconds. All 85 tool results had
`is_error=false`; public progress showed successful KB reading and research.
The two tasks stopped at different specific research steps. Both last requests
reported zero usage, but that does not establish the upstream cause or billing.

Independent read-only checks found no local interrupt/delete operation,
native user interruption or cleanup job. The result deadline was null.
Each session contained only the three input archives, zero downloadable
deliverables and zero valid formal JSON candidates. No usable result was
discarded by a validator, and neither task published or entered a repair loop.
The 60-second network timeout applies to individual HTTP requests, not the
session lifetime; the removed 15-minute KB timeout did not affect these tasks.

Both terminal failures were preserved before starting one further bounded,
fresh attempt under the user's retry authorization. The formal KB archive,
original upstream and adapter Skill hashes, `glm-5.3` and `max` effort remain
unchanged. The derived knowledge input ZIP changes because its context contains
the new operation token. No old session is reconstructed or resumed.

## Response-reset wording release

Source `237cd0aa6b815e70d0ac276396c6c3af08a1e88a` replaces the last obsolete
approval wording in the confirmed response editor with the direct reset action:
`如需调整，可点击“重置应答逻辑”后重新生成并确认。` The single-line copy
change passed whitespace/diff checks and the existing image publication build.
Dashboard and its same-image SiteOps worker use digest
`sha256:70b130ff33af01cfa365d6dfe33301ffde45e32fcbc95cb5c48fe7b4260f965b`.
Startup readiness returned the exact source, digest and schema. No database
migration or write was required. The previous `70fa85f` image remains available
for rollback; Website and monitoring-worker container IDs/start times were
unchanged. The acknowledged third brand task retained its original session.

Public `/healthz` and `/readyz` returned 200 with the exact source and digest.
Four focused read-only browser checks confirmed the new footer, absence of
“需求通过后”, stable customer identity after refresh, and unchanged confirmed
revision 6/version 1 with all four fields preserved. No read failure or browser
exception occurred; all four automatic save/snapshot POSTs were blocked.

## Third native brand failure

Operation `5d12dd31-8b91-4e7c-a204-07ef336e5f42` received the same native
service-unavailable/exhausted error at 06:49:39.586 UTC, followed by
idle/retries_exhausted. Its final model request lasted 9 minutes 20.468 seconds
and ended with `is_error=true`. There were three input files, zero downloadable
outputs and zero valid public JSON results. The database deadline remained
null, with no interrupt/delete mutation or cleanup job. The third failure was
preserved; no fourth identical attempt was submitted. See
[`zhipu-managed-failure-handling.md`](zhipu-managed-failure-handling.md) for
official source references, known affected workflows and handling boundaries.

## Long-running-task and unified-workspace update

Website's 60-minute running cutoff, KB's unknown/404 10-minute and waiting/quota
24-hour cutoffs, and the 10-minute transient ZIP download cutoff are removed.
Reads continue against the same acknowledged session. Website recognizes both
retry_status formats, keeps terminal errors across idle notifications, and
projects explicit cancellation; an unknown initial idle does not prove failure.
Transport read failures defer, including interruption while reading an HTTP
200 response body. Permanent malformed responses remain visible errors.

The three failed brand sessions were independently rechecked: all had native
provider error status, null result deadlines, only their initial command, and
no interrupt/delete mutation. Removing local cutoffs does not explain or fix
those upstream model failures. No fourth identical paid task was submitted.

The requested 内容分析与 AI 部件 preview is integrated under AI 友好内容资产.
Customer monitoring/publishing routes keep the original Dashboard sidebar;
system administration directly expands five monitoring and four publishing
subpages in the ordinary sidebar. Key assignment removes Base/Pro choices and
keeps verified identical credentials unchanged, while revalidation repairs an
invalid/unverified credential without changing an existing task binding.

The update requires no migration. Website task execution is hosted by the
Dashboard service, so the Dashboard image contains the Website execution
fixes; its frontend image and the independent monitoring worker need no change.
Focused provider/router/credential/KB and affected client regressions, source
governance, test partitioning and TypeScript checks validate these changes.

The strengthened local browser check found and fixed a pre-existing publishing
admin loading bug: disabled React Query reads remained pending and incorrectly
kept every section loading. Only queries needed by the current section now
participate in loading/error presentation. All nine management subpages were
then checked for actual inner content, alongside both Key dialogs (12 checks,
13 successful API GETs, no writes/errors). Customer checks cover the preview,
local settings, reload and original sidebar through monitoring/publishing.
Focused validation passed 173 KB service tests (four existing skips), 42
Website/Dashboard adapter tests, 103 router/transport tests, credential/Key
regressions and the affected client suites; TypeScript and source checks passed.

## Verified deployment of the long-running-task update

Production runs source `2ef9e6454d3b4990a684d659e12f9349a8232bf3`, Dashboard
and SiteOps digest
`sha256:ed9aa8f7be75e14160ff63a6300c27dd6b16565d899a835cc6150845cab96774`.
[Image publication](https://github.com/xiafanzeng/frontmind-system/actions/runs/34018969271)
passed both jobs. The earlier build correctly rejected a development preview
route in a new production chunk; a DEV-only guard fixed the source and the
unchanged production audit passed. Public health/readiness returned 200 with
the exact SHA/digest and exact migration/schema state. No migration ran; the
Website and independent monitoring-worker container identities/start times
were unchanged. The preceding `237cd0a` image is retained for rollback.

Production browser acceptance passed ten customer and twelve administrator
checks, including all nine admin subpages' actual inner content and both Key
dialogs without Base/Pro. No write request, failed GET or browser exception
occurred. Publishing remains in its pre-existing MOCK state with no provider
credentials; real publishing/orders were not accepted or claimed.

Independent before/after section hashes matched for all 55 formal KB nodes,
the published snapshot and archive, all four response fields at revision
6/version 1, the three prior brand failures, eight Website tasks and two
monitoring runs totaling ten successful answers. The dedicated local preview
server was stopped after acceptance.

## Single high-effort comparison

The dedicated customer 3 used the existing administrator credential API to
start exactly one fresh original brand task with glm-5.3/high (credential
version 2), retaining the original Skill and published KB. Its default was
immediately restored through the same API to verified glm-5.3/max (version 3);
the new task retained its immutable high binding across deployment.

Operation `9fae3969-1351-47d2-a5cf-8badf7b9c993`, session
`sess_01a0759a-738b-7427-b7bd-35754c9ab3a2`, failed natively at
07:40:28.859 UTC with unknown_error/service unavailable/exhausted, followed
by idle/retries_exhausted. The last model request lasted 704.300 seconds and
ended with is_error=true. All 41 model requests and 61 tool calls had end
events; no valid public JSON or downloadable output existed. There was one
initial dispatch, no repair, no publication and no fifth attempt. This result
does not establish a provider root cause and does not support silently changing
all customer defaults to high.


## Administrator High / Max controls and final bounded comparison

Source `2609549b3116378814362d8936a9d65f022f6f93` adds explicit High/Max account-Key
configuration for individual and bulk assignment, with glm-5.3 and standard
speed. Changing only the effort while reusing a verified Key creates a new
credential version; identical settings do not rotate it. Existing tasks keep
original bindings. New General Agent operations use the administrator's
settings even if an old browser sends a different profile. Its UI shows the
actual frozen effort, includes the engineer's original project context and
uses the task response for assistant-message labels.

The same release includes `e018ca0`'s removal of the obsolete pending-reset
approval lock and customer approval wording. Ownership, revision and actual
reset fencing remain. No historical rows are rewritten or reconstructed, and
no migration is required. Focused effort/control regressions passed 382 tests;
the preceding reset correction passed 105 tests. TypeScript, source governance
and exact test partitions passed. Image publication run 34021158864 succeeded.
At 08:25:47 UTC, public health/readiness returned 200 with the exact
source/digest and exact schema. Dashboard and its SiteOps worker use digest
`sha256:efc0d5bc836938e0db153f97122be940f678c3b03eb05de860e7e3bf62d3c798`.
No migration ran. Website and the independent monitoring worker kept their
container identities and start times. The previous `2ef9e64` image remains
available for rollback.

Three live administrator browser checks passed the individual and bulk effort
controls, with no writes, failed reads or browser exceptions. Seven separate
GET-only General Agent checks confirmed current Max, the existing task's High,
and the original customer/system-admin role boundary. No General Agent was
created or continued by these checks.

The user explicitly authorized one further Max task and one further High task,
with instructions to stop this portion if both cannot complete. This updates
the earlier four-attempt acceptance limit.

Max operation `2c53a25c-d0e8-494d-a1a3-578cf522cf7f` used session
`sess_01a075ba-c2b9-7df0-b09e-d04d2dcdc309`, created at 07:59:28.998 UTC.
The native session's own `agent.model` confirmed glm-5.3/max/standard. It failed
at 08:17:45.521 UTC with unknown_error, 服务暂时不可用, exhausted and then
idle/retries_exhausted. Total runtime was 18 minutes 16.523 seconds; the last
model request lasted 650.499 seconds and ended with is_error=true. All 65 model
requests and 108 tools had end events. There were no valid public JSON results
or downloadable outputs, one initial dispatch, no repair and no publication.
The original formal knowledge snapshot and exact Skill hashes were retained.

High operation `3e5ecca0-ba72-41e7-a406-1717d463a741` was accepted once using
session `sess_01a075d3-5a76-741e-aa51-d5854ceaecd9`. The normal administrator API
rotated the same customer Key from version 3/Max to version 4/High, then restored
the account default to version 5/Max after dispatch. The task retained version
4/High. The native session model also directly confirmed glm-5.3/high/standard.
This live change verifies that an effort-only rotation is not discarded as an
identical-Key no-op.

High ran from 08:26:20.732 to 08:41:37.115 UTC (15 minutes 16.383 seconds).
Its native session also ended with unknown_error, 服务暂时不可用, exhausted and
idle/retries_exhausted. The final model request lasted 672.655 seconds; all 35
model requests and 97 tool calls ended. This was a native provider error, with
no local task deadline and no repair dispatch.

Unlike Max, High left a 30,403-byte downloadable
`brand-question-universe-payload.json` at 08:40:43 UTC, scoped to that exact
session. Its SHA-256 is
`0de3a000a8cfd30f426c36f2704546e9057d330401edb3fd1408786d3834b420`.
The unchanged original parser accepted its operation-bound payload. The
original workbook generator and cell-by-cell readback passed: 160 questions,
five columns and category counts 20/20/20/100. The adapter had ignored JSON
files after native failure, and the business service had failed the operation
before checking a usable result. A valid deliverable and an upstream execution
error can coexist; this does not establish that High natively succeeded.

The correction projects same-turn message/file JSON from a finalized native
failure while retaining its error state. The original business parser selects
a valid operation-bound candidate before error handling and uses the existing
workbook, asset and Dashboard version-checked publication path. Normal observe
can read the latest unpublished `PROVIDER_TASK_FAILED` session again; this sends
no initial request or repair and does not permanently exclude late files. There
is no historical conversation scan, reconstruction, direct database edit or
manual import. Cancelled tasks remain cancelled. The three focused suites
passed 39 tests, including prior-round and foreign-session exclusion, invalid
JSON and original 160-row validation. TypeScript, source governance and exact
test partitions passed; no migration is required.

Source `7f1f70f563978fa53b030f8100d6f3070b8d70c6` passed image publication
run 34023034667 and the production bundle audit. Dashboard/SiteOps deployed
digest `sha256:d6ba625cff995d35cf376fc657cce2458909114d69f4ca294b1cacdb1cdd5b1b`.
Public health/readiness at 09:03:37 UTC returned 200 with that exact identity and
exact schema; no migration ran, and Website/monitoring-worker container IDs and
start times were preserved.

The original customer observe then published the existing High result: operation
`succeeded`, publication `published`, provider state still `error`, initial
dispatch count one and repair count zero. At 09:07:07 UTC, all 160 persisted
Dashboard rows matched the original native payload exactly at Dashboard revision
4. Asset download acceptance exposed a separate existing mismatch: the brand
service stores UUID local assets with persistent retention, while the generic
download resolver recognized only `asset_` identifiers and upload expiry. The
owner's JSON download returned `SOURCE_FORBIDDEN` 403; publication was not undone
and no new research was submitted.

The download correction resolves explicit local-asset requests by their existing
owner/scope query without requiring an ID prefix. Null retention is accepted only
for the original server-created brand JSON/XLSX storage key matching that asset
ID; ordinary upload expiry, missing ownership and content-integrity checks remain.
The resolver, retention and affected route suites passed 82 tests, including
UUID result download, ordinary-upload expiry and cross-owner denial. TypeScript,
source governance and exact test partitions passed. No migration or data rewrite
is required.
