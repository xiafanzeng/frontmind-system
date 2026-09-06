# Dashboard Managed Agents migration

This migration keeps Dashboard's existing workflows and uses Zhipu Managed Agents for the
formerly Manus-backed AI execution paths. Manus execution and task reconstruction are retired. The original Website key settings
remain in Dashboard; Website keeps its existing server boundary.

Jenova brand tracking, Molizhishu question monitoring, KOL publishing, 21st and
Aliyun are independent integrations. This migration does not replace those
providers or reinterpret their credentials as Zhipu credentials.

## Execution boundaries

| Workflow | Existing business entry | Provider integration |
| --- | --- | --- |
| General agent | `frontmind-v2-chat-router.ts` | Existing operation/task, per-turn intent, original user attachment evidence and private artifact store |
| Knowledge base | `knowledge-base-api.ts` | Original materialized v5 turn topology, frozen Skill/input bytes, archive validation and activation |
| Response logic | `response-logic-api.ts` | Original task continuation, Skill/evidence archives, structured schema and business validators |
| Brand questions | `brand-question-portfolio-api.ts`, `brand-question-universe-service.ts` | Original operation token, schemas, repair limits and confirmation flow |
| Existing site building and social implementation (outside current acceptance) | `siteops/manus-provider.ts` | Original persisted operation and stage tokens, input archives, strict JSON/ZIP readers and business quotas; no build, template or preview-dependent social acceptance in this task |
| Browser uploads | `managed-upload-intent.ts` | Original sealed local ingress, ownership, deletion fences and retention; complete-byte multipart upload for Zhipu |

`credential-agent-client.ts` uses the already authorized, frozen Zhipu
credential. It never guesses a provider from key text or replaces the bound
credential while accessing a resource. Credential ownership and
customer account ownership are separate coordinates for managed accounts.

`providers/dashboard-agent-provider.ts` adapts Managed Agents sessions, events,
files and confirmations to the existing business client contract. The existing
`agent_operations` and `agent_tasks.provider_runtime` store provider state in a
`dashboardManaged` namespace. Workflows already using those tables reuse their
original task; other workflows receive transport records tied to their existing
durable intent.

Each mutation is persisted before dispatch. Unknown outcomes do not resend or
search old conversations: use customer self-service reset, new upload and new
task flow. Ordinary continuation keeps the acknowledged session and uses its
own stable turn identity.
Current-turn event boundaries prevent an old idle event or old file from
completing a later turn.

The knowledge-base `manus_v2` protocol marker remains its historical business
ledger contract. Its credential identifies the actual provider. Zhipu's
complete-byte upload has explicit ledger states; it does not manufacture a
presigned PUT URL or pretend that a PUT occurred.

## Inputs, outputs and settings

Original Skill archives, business prompts, generated input archives, schemas,
workflow order and user confirmation points remain unchanged. Transport adds
only runtime path and delivery instructions. The adapter extracts usable
JSON, including ordinary Markdown envelopes, and passes it to the existing
business validator. It adds no duplicate schema rejection. A closing sentence
does not hide an earlier JSON result or output attachment.

Opaque `zhipu-file:` descriptors stay on the server. Downloads verify the
credential, account, session and output file before entering the original
bounded archive or private artifact pipeline. Input files and Skill files are
ineligible as customer output.

The existing key controls save a new Zhipu credential version with frozen
`glm-5.3` model and effort. Administrator account-Key dialogs select High or Max.
Legacy profile identifiers remain only where existing persisted contracts need them. Old AI credentials are not used for execution and can be replaced through the
original settings. Non-AI credentials for 21st and Aliyun keep their original
meaning and are not relabeled.

Existing key and usage controls display Zhipu native tokens. No
token-to-credit or token-to-currency conversion is invented. Existing service,
site and social quotas continue to govern their original business operations;
retaining these controls does not include site building or social generation in
the current acceptance scope.
No new Dashboard execution-log interface is introduced.

A knowledge-base research task remains active while the provider reports it
as running. The old 15-minute reset rule rejected a healthy 23-minute task
before its ZIP existed; it has been removed. The downloaded ZIP from that
incident passed the original materialized validator. Fresh-run acceptance on
the deployed `c6b8f74` release was then attempted; the failed historical
conversation was not rebuilt. That fresh task subsequently produced an original
ZIP accepted as 55 leaves and 129 evidence files. Its node-modification task
then failed with a native Zhipu `session.error` (service unavailable, retries
exhausted), so that build was not published. The adapter now preserves
that terminal error across the following idle event instead of reporting a
successful completion with an invalid archive. A later fresh task on `1c89b0e`
completed the whole original workflow: 55 leaves, one successful node revision,
55 read/confirm actions, final download validation and formal publication.

## Customer self-service

Customer actions no longer create delivery tickets. Customers directly reset
their own knowledge base, modify/delete current questions, reset saved response
logic and edit Dashboard content. Direct question selection includes the chosen
category and becomes selected immediately. Existing ownership, service access,
quota and optimistic revision checks remain. Reset uses the original cleanup
queue and fixed resource credentials, then starts a new upload and task.

Customer ticket history, engineer processing/approval controls, administrator
dispatch and ticket endpoints are removed. Engineers retain assigned projects,
quota controls and original content import. Historical database tables are left
compatible with already applied migrations; account deletion still removes
historical rows.

The existing SiteOps restart action now resets the local generation cycle
directly. It preserves existing live deployment and hostname pointers, releases
reserved generation quota and prevents an active publication/domain operation
from being reset mid-flight. This dependency removal does not expand the task
into building, template, social-generation or publication acceptance.

## Database and release

Migration `0060_dashboard_zhipu_provider` adds only three columns to
`api_credentials`: provider (default Manus), nullable upstream model and
nullable upstream effort. All previous migrations and all pre-existing schema
fields remain unchanged. The adapter
no longer directly depends on AJV. Existing dependency versions are preserved.

The `2ef9e6454d3b4990a684d659e12f9349a8232bf3` Dashboard release is deployed. Dashboard
readiness reports the expected revision and exact migration/schema state, with
no degraded builds or violations. Website remains on
`f1dc5182819574aea32dbc50a2f715c414d50e41`.

## Current acceptance scope and status

Release `1c89b0e` passed read-only browser checks for system administrator,
customer and engineer accounts: nine role paths, nine reloads and 27
page/identity/editor checks retained their authenticated identities without
failed GET requests or uncaught errors. The original Dashboard navigation
and settings remain available, including Zhipu Token, 21st and Aliyun controls.
Customer navigation adds 问题监控 and 媒体发布 under 监控与发布; the system
administrator has a separate 监控与发布管理 section. The original general-agent
two-turn conversation and both JSON downloads were also reverified on that
release. Customer Dashboard editing and exact full-payload restoration also
passed, including stale revision and cross-account rejection. Customer
self-service knowledge reset succeeded and began a fresh task at 05:10:55 UTC
on 2026-09-06 without reusing the old ZIP or provider session.
After KB publication, `ac5ac7c` passed seven further customer checks covering
the dedicated content/website editor entries, actual template downloads and
identity preservation after navigation and reload.
On `70fa85f`, fresh question selection, response-draft save/reset, idempotent
replay, question modification and subsequent deletion passed through the
customer APIs. The UUID correction preserves earlier audit replay keys; an
actual pre-fix successful reset replayed correctly after deployment. Removed
ticket routes returned NOT_FOUND. General-agent downloads were also reverified.

Dashboard's fresh formal knowledge base is published. Its 175,337-byte final
ZIP passed archive and leaf-body verification after a real single-node change;
the other 54 leaves remained unchanged. Response logic completed original
generation, save, same-session continuation, second save and confirmation;
revision 6/version 1 matched independent API and database readback after the
`70fa85f` restart. Brand-universe acceptance has not yet passed after three bounded fresh
tasks received native service-unavailable/retries-exhausted failures. All three
failed sessions had no deliverable or valid result to publish, and independent
checks found no local interruption. Original Skill hashes, the published KB
archive, model and effort remain unchanged; the derived input ZIP contains
each new operation token. Website's completed
knowledge base, assessments and forecasts are separate business results.

The user excluded website building and template work from this task. WeChat
and Xiaohongshu generation have no independent original UI entry: their
buttons require a website snapshot at `preview_ready`, `approved` or `live`.
Their dependent acceptance is paused and outside the current scope. No SiteOps
or social mutation was submitted for that acceptance, and it is not a blocker
to the remaining knowledge-base, brand and response-logic work.

Exact production identities, test outcomes and completed versus pending
business checks are recorded in
[`live-migration-verification.md`](live-migration-verification.md). Passing
transport tests alone is not production business acceptance.

## Long-running tasks and unified workspace update

No nonterminal Managed Agents task is failed solely for elapsed runtime or
waiting time. Website's former 60-minute deadline and KB's remaining unknown,
waiting and transient ZIP-read deadlines are removed. Temporary network reads
continue against the same session; retrying errors stay active, while explicit
terminal errors and cancellations retain their meaning. Original Skill bytes,
model settings and business result validation are unchanged.

The customer monitoring/publishing routes now render inside UserBrandDashboard
with its existing sidebar and expanded subpages. System administrators use the
same PortalShell/getAdminNav navigation across all nine management subpages.
The new 内容分析与 AI 部件 subsection under AI 友好内容资产 adapts the requested
reference UI with explicit sample-data preview labeling; it performs no real
AI, collection, publishing or HelpLook writes.

Administrator Key assignment no longer offers Base/Pro. New credentials use
the existing Zhipu default, while an already verified identical Key remains
unchanged. An invalid/unverified Key is freshly verified and repaired through
a new credential version. Existing task bindings and frozen model settings
are not rewritten. No migration accompanies these changes.

Production acceptance for this update passed ten customer and twelve
administrator browser checks, with unchanged completed KB/response/Website
data. A single controlled glm-5.3/high brand comparison also failed natively
without output; the dedicated account default was restored to max. The three
max failures and this high failure remain honest incomplete business acceptance.

## Historical inspection before explicit effort controls

Read-only production inspection at 07:48–07:52 UTC on 2026-09-06 found the
following effective settings. `standard` is the value of `model.speed`; neither
adapter sends a `service_tier` field. High and max are reasoning-effort values,
while Lite/Base/Pro are FrontMind's existing public profile names.

| Execution entry | Model and effort source | Current effective setting | Speed |
| --- | --- | --- | --- |
| Website original KB, question, assessment and forecast tasks | `presales-v2-store.ts` freezes `glm-5.3` and `WEBSITE_ZHIPU_EFFORT`, defaulting to `high`, when reserving the original task | Environment override absent; Website credential v9 and all eight original acceptance tasks use `glm-5.3/high` | Explicit `standard` when frozen effort is present |
| Customer KB, response logic and brand-question workflows | Exact account credential ID/version, then persisted `dashboardManaged.model/effort` | Customer 3 current credential v3 is `glm-5.3/max`; the first three brand attempts stay on v1/max and the fourth stays on v2/high | Explicit `standard` |
| General Agent for delivery administrators and engineers | New operation freezes the selected public profile; Lite/Base/Pro map to `glm-5.3` with low/high/max, respectively | Default selector remains Pro; the accepted two-turn operation selected Base and remains high, although its credential default is max | Explicit `standard` |
| Existing SiteOps and social implementation, outside real acceptance | Original requested profile, parent-operation profile or customer credential default; operation input freezes credential ID/version, model and effort | Base maps to high and Pro to max; no new build/social task was submitted | Explicit `standard` through the Dashboard adapter |

Website's legacy no-effort compatibility branch sends a model string. New
Website reservations always freeze a validated effort, so that branch is not
used by the current eight original acceptance tasks. General-Agent continuation
omits a new model selection and uses its original operation; changing a Key or
the UI preference does not alter that session. Customer credential assignment
currently has no Base/Pro selector and defaults new credentials to max; an
already verified identical Key retains its previous frozen settings.

The four brand failures do not satisfy the user's condition that high must
pass before a global high switch. No model default or credential was changed
by this inspection. Website's successful high workflows demonstrate those
specific original workflows, not reliable high completion of the brand task.

Account inventory found active Zhipu credentials for customer 3 and delivery
administrator 4. Customer 2 and engineer 5 have no active AI credential and
are not represented as enabled. No customer, delivery administrator or engineer
has an active Manus credential. System administrator 1 retains a historical
Manus row, but the original role has no General Agent entry: the UI requires
`DeliveryAdminOnly`, and an authenticated read returned HTTP 403
`GENERAL_AGENT_ROLE_FORBIDDEN` before the credential check. Unified credential
targets deliberately exclude system administrators; this inspection neither
changes that role boundary nor introduces a shared fallback Key.

There were no active conversation turns or real nonterminal managed-agent or
SiteOps operations. Ten `dashboard.provider.transport` wrapper rows retain
their transport lifecycle status; they are not new active business tasks.
Private, metadata-only evidence is retained as
`zhipu-effective-runtime-readonly.json` and
`zhipu-canonical-admin-readonly.json` under `/tmp/frontmind-reconcile`.


## Administrator High / Max configuration

The administrator's individual and bulk account-Key controls now submit
`upstreamEffort: "high" | "max"`. All account roles in this control share
`glm-5.3` and the adapter's `model.speed: "standard"`. An unchanged verified
Key and identical explicit effort are a no-op; changing effort with the same
Key creates a new credential version. Older tasks retain their original
credential version and frozen model configuration. New unconfigured forms
continue to default to Max. Omitting the new optional API field preserves the
previous same-Key behavior for an already open client.

New General Agent operations take their execution settings from the
administrator's credential. The old client profile remains in existing request
idempotency evidence but cannot override execution. Its composer shows the
configured High/Max instead of the old Lite/Base/Pro picker; an existing task
shows its own frozen setting, including a historical Low when applicable.
The read-only runtime endpoint retains the original role and task ownership
checks and returns no credential secrets.

Website's original task settings remain glm-5.3/high/standard. No account was
mass-updated to High. Site building, templates, preview-dependent social
acceptance and real publishing orders remain outside this request.

The user subsequently authorized one more original brand run with Max and
one with High, with instructions to stop this portion if both fail. Max was
submitted once as operation `2c53a25c-d0e8-494d-a1a3-578cf522cf7f`; this supersedes
the earlier decision not to submit a fifth attempt. These runs reuse the
original Skill bytes and formal knowledge snapshot, not an old provider session.
Their final results and deployment identity are recorded in the live migration
verification document when available.
