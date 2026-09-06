import { afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  agentTasks,
  conversations,
  conversationTurns,
} from "../drizzle/schema";
import { cleanupContentProductionConversation } from "./content-production-cleanup";

const mocks = vi.hoisted(() => ({ credential: vi.fn(), client: vi.fn() }));
vi.mock("./auth-service", () => ({
  getDecryptedCredentialForAccountById: mocks.credential,
}));
vi.mock("./credential-agent-client", () => ({
  createCredentialAgentClient: mocks.client,
}));

function fixture() {
  const operation = {
    id: "operation-original",
    apiCredentialId: "credential-original",
    credentialVersion: 3,
  };
  const runtime = {
    revision: 1,
    intentId: "intent-original",
    model: "glm-5.3",
    effort: "high",
    mutations: {
      "content-workflow-vault": {
        state: "acknowledged",
        resourceId: "vault-original",
      },
    } as Record<string, { state: string; resourceId?: string }>,
  };
  const task = {
    id: "task-original",
    providerRuntime: {
      dashboardManaged: runtime,
      generalPurpose: {
        revision: 1,
        accountUserId: 7,
        purpose: "content_production",
        knowledgeBase: null,
        knowledgeText: null,
      },
    },
  };
  const data = new Map<unknown, unknown[]>([
    [
      conversations,
      [{ upstreamTaskId: task.id, previousResponseId: "task-previous" }],
    ],
    [
      conversationTurns,
      [{ upstreamTaskId: task.id }, { upstreamTaskId: "task-from-turn" }],
    ],
    [agentTasks, [{ task, operation }]],
  ]);
  const predicates: { table: unknown; sql: string; params: unknown[] }[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const query = {
          innerJoin: () => query,
          limit: () => query,
          where: (expression: any) => {
            predicates.push({
              table,
              ...new MySqlDialect().sqlToQuery(expression),
            });
            return query;
          },
          then: (resolve: any, reject: any) =>
            Promise.resolve(data.get(table) ?? []).then(resolve, reject),
        };
        return query;
      },
    }),
  };
  const credential = {
    id: operation.apiCredentialId,
    version: 3,
    provider: "zhipu",
    userId: 7,
  };
  const cleanup = vi.fn().mockResolvedValue(undefined);
  mocks.credential.mockResolvedValue(credential);
  mocks.client.mockReturnValue({ deleteContentProductionResources: cleanup });
  const input = {
    db: db as any,
    userId: 7,
    conversationId: "u7:conversation",
    projectAssignmentId: null,
  };
  return {
    input,
    data,
    predicates,
    operation,
    task,
    runtime,
    credential,
    cleanup,
  };
}

afterEach(() => vi.resetAllMocks());

describe("content-production conversation cleanup", () => {
  it("uses only server-linked task IDs and the original frozen credential before deleting dedicated resources", async () => {
    const f = fixture();
    await cleanupContentProductionConversation(f.input);
    expect(f.predicates[0].params).toEqual(["u7:conversation", 7]);
    expect(f.predicates[0].sql).toContain(
      "`conversations`.`projectAssignmentId` is null",
    );
    expect(f.predicates[1].params).toEqual([
      "u7:conversation",
      7,
      "general_chat_v2",
    ]);
    expect(f.predicates[2].params).toEqual([
      "task-original",
      "task-previous",
      "task-from-turn",
      7,
      "managed_user",
      "zhipu",
      "dashboard.general-chat",
      2,
    ]);
    expect(mocks.credential).toHaveBeenCalledWith(7, "credential-original");
    expect(mocks.client).toHaveBeenCalledWith(f.credential, {
      accountUserId: 7,
      localTaskId: "task-original",
      operationId: "operation-original",
      intentId: "intent-original",
      model: "glm-5.3",
      effort: "high",
    });
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([null, "project-a"])(
    "does not read task bindings or credentials without an owned conversation in scope %s",
    async (scope) => {
      const f = fixture();
      f.data.set(conversations, []);
      await cleanupContentProductionConversation({
        ...f.input,
        projectAssignmentId: scope,
      });
      expect(f.predicates).toHaveLength(1);
      expect(f.predicates[0].params).toEqual(
        scope ? ["u7:conversation", 7, scope] : ["u7:conversation", 7],
      );
      expect(mocks.credential).not.toHaveBeenCalled();
      expect(f.cleanup).not.toHaveBeenCalled();
    },
  );

  it("does not decrypt credentials for tasks without an acknowledged dedicated Vault", async () => {
    const f = fixture();
    f.runtime.mutations = {};
    await cleanupContentProductionConversation(f.input);
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("does not attach cleanup to enterprise QA or ordinary General tasks", async () => {
    const f = fixture();
    f.task.providerRuntime.generalPurpose.purpose = "enterprise_qa";
    await cleanupContentProductionConversation(f.input);
    delete (f.task.providerRuntime as any).generalPurpose;
    await cleanupContentProductionConversation(f.input);
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id: "credential-original", version: 4, provider: "zhipu" },
    { id: "new-key", version: 3, provider: "zhipu" },
  ])(
    "preserves the conversation when the original credential cannot be used: %j",
    async (credential) => {
      const f = fixture();
      mocks.credential.mockResolvedValue(credential);
      await expect(
        cleanupContentProductionConversation(f.input),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(mocks.client).not.toHaveBeenCalled();
    },
  );

  it("propagates a sanitized cleanup failure so local deletion cannot proceed", async () => {
    const f = fixture();
    f.cleanup.mockRejectedValue(new Error("upstream private detail"));
    await expect(
      cleanupContentProductionConversation(f.input),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "内容任务的云端资源尚未删除，会话已保留，请重试删除。",
    });
  });

  it("does not require a removed key when provider cleanup already completed and local deletion is retried", async () => {
    const f = fixture();
    f.runtime.mutations["delete-content-workflow-vault"] = {
      state: "acknowledged",
      resourceId: "vault-original",
    };
    await cleanupContentProductionConversation(f.input);
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  });
});
