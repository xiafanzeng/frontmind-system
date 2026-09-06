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
| Site building and social | `siteops/manus-provider.ts` | Original persisted operation and stage tokens, input archives, strict JSON/ZIP readers and business quotas |
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
search old conversations: use the existing approved reset, new upload and new
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
site and social quotas continue to govern their original business operations.
No new Dashboard execution-log interface is introduced.

A knowledge-base research task remains active while the provider reports it
as running. The old 15-minute reset rule rejected a healthy 23-minute task
before its ZIP existed; it has been removed. The downloaded ZIP from that
incident passed the original materialized validator. Fresh-run acceptance is
required after deployment; the failed historical conversation is not rebuilt.

## Database and release

Migration `0060_dashboard_zhipu_provider` adds only three columns to
`api_credentials`: provider (default Manus), nullable upstream model and
nullable upstream effort. All previous migrations and all pre-existing schema
fields remain unchanged. The adapter
no longer directly depends on AJV. Existing dependency versions are preserved.

Implementation verification is in progress. Production identities and real
workflow acceptance results are recorded in `live-migration-verification.md`
after deployment; passing mocked transport tests alone is not production
acceptance.
