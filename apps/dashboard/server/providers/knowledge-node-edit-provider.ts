import {
  KNOWLEDGE_NODE_EDIT_MODEL,
  KNOWLEDGE_NODE_EDIT_SYSTEM,
  nodeEditSha256,
  parseKnowledgeNodeEditOutput,
} from "../knowledge-node-edit-contract";
import {
  authorizeManagedAiCommand,
  observeManagedAiUsage,
  rejectManagedAiCommand,
} from "../ai-billing-service";
import {
  dashboardAgentRuntimeStore,
  type DashboardAgentRuntimeStore,
  type DashboardManagedRuntime,
  type DashboardProviderIdentity,
  type DashboardRuntimeRecord,
} from "./dashboard-agent-runtime-store";
import {
  ZhipuManagedClient,
  ZhipuManagedError,
  zhipuResourceId,
  type ZhipuRecord,
} from "./zhipu-managed-client";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { agentOperations, agentTasks } from "../../drizzle/schema";
import { getDb } from "../db";

/** Reuse only the empty editor resources from this credential version and
 * enterprise project. Sessions and commands themselves are always fresh. */
export async function findKnowledgeNodeEditorResources(
  identity: DashboardProviderIdentity,
) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const project = identity.enterpriseProjectId
    ? identity.enterpriseProjectLegacyDefault
      ? or(
          eq(agentOperations.enterpriseProjectId, identity.enterpriseProjectId),
          isNull(agentOperations.enterpriseProjectId),
        )!
      : eq(agentOperations.enterpriseProjectId, identity.enterpriseProjectId)
    : isNull(agentOperations.enterpriseProjectId);
  const rows = await db
    .select({ runtime: agentTasks.providerRuntime })
    .from(agentTasks)
    .innerJoin(agentOperations, eq(agentOperations.id, agentTasks.operationId))
    .where(
      and(
        eq(agentOperations.scope, "managed_user"),
        eq(agentOperations.provider, "zhipu"),
        eq(agentOperations.accountUserId, identity.accountUserId),
        eq(agentOperations.apiCredentialId, identity.credentialId),
        eq(agentOperations.credentialVersion, identity.credentialVersion),
        project,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${agentTasks.providerRuntime}, '$.dashboardManaged.intentId')) LIKE 'knowledge-node-edit:%'`,
      ),
    )
    .orderBy(desc(agentTasks.createdAt))
    .limit(20);
  for (const row of rows) {
    const runtime = row.runtime?.dashboardManaged as
      | DashboardManagedRuntime
      | undefined;
    if (
      runtime?.revision === 1 &&
      runtime.model === "glm-5.3" &&
      runtime.effort === "low" &&
      runtime.agentId &&
      runtime.environmentId &&
      !runtime.deleted
    )
      return { agentId: runtime.agentId, environmentId: runtime.environmentId };
  }
  return null;
}

function eventText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter(
          (item) => item?.type === "text" && typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("")
    : "";
}

/** A fresh, text-only Low session. Every POST is journalled before send, and
 * uncertain mutations are never replayed or upgraded to another model. */
export class KnowledgeNodeEditProvider {
  private readonly api: ZhipuManagedClient;
  private readonly store: DashboardAgentRuntimeStore;
  constructor(
    private readonly options: {
      apiKey: string;
      identity: DashboardProviderIdentity;
      store?: DashboardAgentRuntimeStore;
      api?: ZhipuManagedClient;
      authorize?: typeof authorizeManagedAiCommand;
      observe?: typeof observeManagedAiUsage;
      reject?: typeof rejectManagedAiCommand;
      pollMs?: number;
      deadlineMs?: number;
      reusableResources?: { agentId: string; environmentId: string } | null;
    },
  ) {
    this.api =
      options.api ?? new ZhipuManagedClient({ apiKey: options.apiKey });
    this.store = options.store ?? dashboardAgentRuntimeStore;
  }
  private async once(
    record: DashboardRuntimeRecord,
    key: string,
    body: unknown,
    action: () => Promise<string>,
    bind?: (
      runtime: DashboardManagedRuntime,
      id: string,
    ) => DashboardManagedRuntime,
  ) {
    const requestHash = nodeEditSha256(JSON.stringify(body));
    let permission = false;
    record = await this.store.mutate(
      this.options.identity,
      record.localTaskId,
      (runtime) => {
        const old = runtime.mutations[key];
        if (old) {
          if (old.requestHash !== requestHash)
            throw new Error("KNOWLEDGE_NODE_EDIT_REQUEST_CONFLICT");
          return runtime;
        }
        permission = true;
        return {
          ...runtime,
          mutations: {
            ...runtime.mutations,
            [key]: {
              requestHash,
              state: "sending",
              startedAt: new Date().toISOString(),
            },
          },
        };
      },
    );
    const old = record.runtime.mutations[key]!;
    if (old.state === "acknowledged" && old.resourceId) return old.resourceId;
    if (!permission) throw new Error("KNOWLEDGE_NODE_EDIT_SEND_UNCERTAIN");
    try {
      const resourceId = await action();
      await this.store.mutate(
        this.options.identity,
        record.localTaskId,
        (runtime) => {
          const next = {
            ...runtime,
            mutations: {
              ...runtime.mutations,
              [key]: {
                ...runtime.mutations[key]!,
                state: "acknowledged" as const,
                resourceId,
              },
            },
          };
          return bind ? bind(next, resourceId) : next;
        },
      );
      return resourceId;
    } catch (error) {
      const rejected =
        error instanceof ZhipuManagedError && !error.outcomeUnknown;
      await this.store.mutate(
        this.options.identity,
        record.localTaskId,
        (runtime) => ({
          ...runtime,
          mutations: {
            ...runtime.mutations,
            [key]: {
              ...runtime.mutations[key]!,
              state: rejected ? "rejected" : "outcome_unknown",
            },
          },
        }),
      );
      throw error;
    }
  }
  async edit(input: {
    intentId: string;
    prompt: string;
    onSession: (sessionId: string) => Promise<void>;
  }) {
    const record = await this.store.reserve({
      identity: this.options.identity,
      intentId: input.intentId,
      model: KNOWLEDGE_NODE_EDIT_MODEL.id,
      effort: "low",
    });
    const agentBody = {
      name: `FrontMind node editor ${record.operationId}`,
      model: KNOWLEDGE_NODE_EDIT_MODEL,
      system: KNOWLEDGE_NODE_EDIT_SYSTEM,
      tools: [],
      skills: [],
      mcp_servers: [],
    };
    const reusable = this.options.reusableResources;
    if (
      reusable &&
      !record.runtime.agentId &&
      !record.runtime.environmentId &&
      !record.runtime.mutations.agent &&
      !record.runtime.mutations.environment
    ) {
      record.runtime = (
        await this.store.mutate(
          this.options.identity,
          record.localTaskId,
          (runtime) => ({
            ...runtime,
            agentId: reusable.agentId,
            environmentId: reusable.environmentId,
          }),
        )
      ).runtime;
    }
    const agentId =
      record.runtime.agentId ??
      (await this.once(
        record,
        "agent",
        agentBody,
        async () =>
          zhipuResourceId(await this.api.create("/v1/agents", agentBody)),
        (runtime, id) => ({ ...runtime, agentId: id }),
      ));
    const environmentBody = {
      name: `FrontMind node editor ${record.operationId}`,
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allowed_hosts: [],
          allow_package_managers: false,
          allow_mcp_servers: false,
        },
      },
    };
    const environmentId =
      record.runtime.environmentId ??
      (await this.once(
        record,
        "environment",
        environmentBody,
        async () =>
          zhipuResourceId(
            await this.api.create("/v1/environments", environmentBody),
          ),
        (runtime, id) => ({ ...runtime, environmentId: id }),
      ));
    const sessionBody = {
      agent: { type: "agent", id: agentId, version: 1 },
      environment_id: environmentId,
      title: "知识节点文字修改 · Low",
      metadata: {
        frontmind_operation: record.operationId,
        frontmind_node_edit: "low_v1",
      },
      resources: [],
    };
    const sessionId = await this.once(
      record,
      "session",
      sessionBody,
      async () =>
        zhipuResourceId(await this.api.create("/v1/sessions", sessionBody)),
      (runtime, id) => ({ ...runtime, sessionId: id }),
    );
    await input.onSession(sessionId);
    const commandKey = "node-edit";
    const promptHash = nodeEditSha256(input.prompt);
    let current = await this.store.mutate(
      this.options.identity,
      record.localTaskId,
      (runtime) => {
        const old = runtime.commands.find(
          (command) => command.key === commandKey,
        );
        if (old) {
          if (old.providerPromptHash !== promptHash)
            throw new Error("KNOWLEDGE_NODE_EDIT_REQUEST_CONFLICT");
          return runtime;
        }
        return {
          ...runtime,
          commands: [
            ...runtime.commands,
            {
              key: commandKey,
              intentId: input.intentId,
              prompt: input.prompt,
              providerPromptHash: promptHash,
              attachments: [],
              beforeEventIds: [],
              beforeFileIds: [],
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
    );
    if (!current.runtime.commands[0]!.eventId) {
      // A lost send acknowledgement is reconciled by its exact text hash.
      const events = await this.api.listAll(
        `/v1/sessions/${sessionId}/events`,
        { order: "asc" },
      );
      const matches = events.filter(
        (event) =>
          event.type === "user.message" &&
          nodeEditSha256(eventText(event.content)) === promptHash,
      );
      if (matches.length > 1)
        throw new Error("KNOWLEDGE_NODE_EDIT_COMMAND_AMBIGUOUS");
      let eventId = matches[0] ? zhipuResourceId(matches[0]) : undefined;
      if (!eventId) {
        // Refused funding proves the model command was never sent. Keep it
        // outside the transport fence so it cannot become an unknown send.
        if (!current.runtime.mutations.send)
          await (this.options.authorize ?? authorizeManagedAiCommand)({
            identity: this.options.identity,
            localTaskId: record.localTaskId,
            operationId: record.operationId,
            sessionId,
            commandKey,
            model: "glm-5.3",
            effort: "low",
          });
        try {
          eventId = await this.once(
            record,
            "send",
            { sessionId, promptHash },
            async () => {
              try {
                const response = await this.api.sendMessage(
                  sessionId,
                  input.prompt,
                );
                return zhipuResourceId((response.data as unknown[])[0]);
              } catch (error) {
                if (error instanceof ZhipuManagedError && !error.outcomeUnknown)
                  await (this.options.reject ?? rejectManagedAiCommand)({
                    localTaskId: record.localTaskId,
                    commandKey,
                  });
                throw error;
              }
            },
          );
        } catch (error) {
          // Reconciliation below may still see an acknowledged event after a
          // transport failure. It never sends the command a second time.
          if (
            !(error instanceof ZhipuManagedError && error.outcomeUnknown) &&
            !(
              error instanceof Error &&
              error.message === "KNOWLEDGE_NODE_EDIT_SEND_UNCERTAIN"
            )
          )
            throw error;
        }
      }
      if (eventId)
        current = await this.store.mutate(
          this.options.identity,
          record.localTaskId,
          (runtime) => ({
            ...runtime,
            commands: runtime.commands.map((command) => ({
              ...command,
              eventId,
            })),
          }),
        );
    }
    const deadline = Date.now() + (this.options.deadlineMs ?? 10 * 60_000);
    do {
      const [session, events] = await Promise.all([
        this.api.request("GET", `/v1/sessions/${sessionId}`),
        this.api.listAll(`/v1/sessions/${sessionId}/events`, { order: "asc" }),
      ]);
      const accepted = events.filter(
        (event) =>
          event.type === "user.message" &&
          nodeEditSha256(eventText(event.content)) === promptHash,
      );
      if (accepted.length > 1)
        throw new Error("KNOWLEDGE_NODE_EDIT_COMMAND_AMBIGUOUS");
      if (accepted[0] && !current.runtime.commands[0]!.eventId) {
        const eventId = zhipuResourceId(accepted[0]);
        current = await this.store.mutate(
          this.options.identity,
          record.localTaskId,
          (runtime) => ({
            ...runtime,
            commands: runtime.commands.map((command) => ({
              ...command,
              eventId,
            })),
          }),
        );
      }
      const usage = await (this.options.observe ?? observeManagedAiUsage)({
        identity: this.options.identity,
        localTaskId: record.localTaskId,
        operationId: record.operationId,
        sessionId,
        model: "glm-5.3",
        commands: current.runtime.commands,
        events,
        session,
      });
      if (usage.shouldInterrupt) {
        await this.once(record, "interrupt", { sessionId }, async () => {
          await this.api.request("POST", `/v1/sessions/${sessionId}/events`, {
            events: [{ type: "user.interrupt" }],
          });
          return sessionId;
        });
        throw new Error("KNOWLEDGE_NODE_EDIT_BALANCE_EXHAUSTED");
      }
      if (
        events.some(
          (event) =>
            event.type === "agent.tool_use" ||
            event.type === "agent.mcp_tool_use",
        )
      )
        throw new Error("KNOWLEDGE_NODE_EDIT_TOOLS_FORBIDDEN");
      const sentAt = events.findIndex(
        (event) =>
          event.type === "user.message" &&
          nodeEditSha256(eventText(event.content)) === promptHash,
      );
      const output =
        sentAt >= 0
          ? events
              .slice(sentAt + 1)
              .filter((event) => event.type === "agent.message")
          : [];
      if (events.some((event) => event.type === "session.error"))
        throw new Error("KNOWLEDGE_NODE_EDIT_PROVIDER_FAILED");
      if (session.status === "idle" && output.length) {
        if (output.length !== 1)
          throw new Error("KNOWLEDGE_NODE_EDIT_OUTPUT_INVALID");
        return {
          sessionId,
          contentMarkdown: parseKnowledgeNodeEditOutput(
            eventText(output[0]!.content),
          ),
        };
      }
      if (session.status === "terminated")
        throw new Error("KNOWLEDGE_NODE_EDIT_TERMINATED");
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.pollMs ?? 2_000),
      );
    } while (Date.now() < deadline);
    await this.once(record, "interrupt", { sessionId }, async () => {
      await this.api.request("POST", `/v1/sessions/${sessionId}/events`, {
        events: [{ type: "user.interrupt" }],
      });
      return sessionId;
    });
    throw new Error("KNOWLEDGE_NODE_EDIT_TIMEOUT");
  }
}
