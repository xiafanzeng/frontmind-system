# Dashboard Managed Agents migration

This migration keeps Dashboard's existing workflows and uses Zhipu Managed Agents for all active
AI execution. Manus execution and task reconstruction are retired. The original Website key settings
remain in Dashboard; Website keeps its existing server boundary.

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
`glm-5.3` model and effort. Lite/Base/Pro map to low/high/max where those tiers
are available in the original workflow. Old AI credentials are not used for execution and can be replaced through the
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
the deployed `c6b8f74` release remains pending; the failed historical
conversation is not rebuilt. That fresh task subsequently produced an original
ZIP accepted as 55 leaves and 129 evidence files. Its node-modification task
then failed with a native Zhipu `session.error` (service unavailable, retries
exhausted), so formal publication is still pending. The adapter now preserves
that terminal error across the following idle event instead of reporting a
successful completion with an invalid archive.

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

The `c6b8f7465d0a5a09bd5d7bef422afc2bb50ef0b7` release is deployed. Dashboard
readiness reports the expected revision and exact migration/schema state, with
no degraded builds or violations. Website remains on
`f1dc5182819574aea32dbc50a2f715c414d50e41`.

## Current acceptance scope and status

The deployed release passed read-only browser checks for system administrator,
customer and engineer accounts: eight pages and twelve reloads retained their
authenticated identities without page errors. The original Dashboard navigation
and settings remain available, including Zhipu Token, 21st and Aliyun controls.
Customer navigation adds 问题监控 and 媒体发布 under 监控与发布; the system
administrator has a separate 监控与发布管理 section. The original general-agent
two-turn conversation and both JSON downloads were also reverified on this
release.

Dashboard's fresh formal knowledge-base publication is still pending. Brand
universe and response-logic acceptance depend on that snapshot and are also
pending. A historical ZIP passing its local validator is not a published
knowledge snapshot. Website's completed knowledge base, assessments and
forecasts are separate results and do not satisfy Dashboard acceptance.

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
