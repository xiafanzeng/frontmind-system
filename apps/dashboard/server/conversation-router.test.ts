import { describe, expect, it, vi } from "vitest";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { createHash } from "node:crypto";
import {
  agentEvents,
  agentOperations,
  agentTasks,
  apiCredentials,
  attachments,
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  localAssets,
  messages,
  siteProjects,
  upstreamResources,
  userUsageOwners,
  users,
} from "../drizzle/schema";
import {
  assignBrowserOwnedSnapshotMessageSequences,
  authoritativeGeneralChatTurnIdForBrowserMessage,
  assertLocalImportHasNoProviderResources,
  buildMessageMetadata,
  collectSnapshotResourceRefs,
  conversationSyncMysqlErrorCode,
  conversationSnapshotSchema,
  discardClientClaimedServerOwnedKnowledgeBaseMessages,
  generalChatDispatchSettlementIsSafe,
  generalChatDispatchSettlementKind,
  getActiveCredentialId,
  listSnapshots,
  loadSnapshotResourceBindings,
  loadPersistedMessages,
  matchesAuthoritativeKnowledgeBaseMessageTuple,
  mergeConversationMessages,
  mergeConversationTaskPointers,
  permanentlyDeleteConversation,
  persistSnapshot,
  protectUnsettledGeneralChatBoundUserMessageTombstones,
  reconstructKnowledgeBaseUserMessageAttachments,
  reconstructKnowledgeBasePresentationInlineImages,
  repairSnapshotMessageIds,
  removeAcknowledgedGeneralChatDispatchMetadata,
  retryConversationSyncTransaction,
  resolveSnapshotCredentialId,
  sanitizeKnowledgeBaseDeletionTombstones,
  type ConversationSnapshot,
} from "./conversation-router";
import {
  KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT,
  knowledgeBaseCompletionMessagePublicId,
} from "../shared/knowledge-base-message";

type SnapshotMessage = ConversationSnapshot["messages"][number];

describe("conversation snapshot transaction retry", () => {
  it("finds a nested MySQL deadlock behind a wrapper error code", () => {
    const inner = Object.assign(new Error("deadlock"), {
      code: "ER_LOCK_DEADLOCK",
      errno: 1213,
    });
    const outer = Object.assign(new Error("Failed query"), {
      code: "ER_QUERY_WRAPPER",
      cause: inner,
    });

    expect(conversationSyncMysqlErrorCode(outer)).toBe("ER_LOCK_DEADLOCK");
    expect(conversationSyncMysqlErrorCode({ sqlState: "40001" })).toBe(
      "ER_LOCK_DEADLOCK",
    );
  });

  it("restarts the whole transaction after transient failures", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("deadlock"), { errno: 1213 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("duplicate create"), {
          code: "ER_DUP_ENTRY",
        }),
      )
      .mockResolvedValue("saved");

    await expect(
      retryConversationSyncTransaction(operation, { sleep }),
    ).resolves.toBe("saved");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("does not retry a deterministic application failure", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("forbidden"));

    await expect(
      retryConversationSyncTransaction(operation, {
        sleep: vi.fn(),
      }),
    ).rejects.toThrow("forbidden");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("server-owned SiteOps conversation boundary", () => {
  const snapshot: ConversationSnapshot = {
    id: "siteops:7",
    title: "官网任务与AI建站",
    messages: [],
    status: "awaiting_input",
    createdAt: 1,
    updatedAt: 1,
  };

  it("rejects an ordinary browser snapshot for a SiteOps conversation", async () => {
    const { executor } = createSelectExecutor((table) =>
      table === siteProjects
        ? [{ id: "site-project-1", conversationId: snapshot.id }]
        : [],
    );

    await expect(persistSnapshot(executor, 7, snapshot)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("does not expose a SiteOps conversation in the ordinary chat list", async () => {
    const row = {
      id: snapshot.id,
      userId: 7,
      projectAssignmentId: null,
      title: snapshot.title,
      status: snapshot.status,
      upstreamTaskId: null,
      previousResponseId: null,
      taskUrl: null,
      createdAt: new Date(snapshot.createdAt),
      updatedAt: new Date(snapshot.updatedAt),
      startedAt: null,
      completedAt: null,
      lastKnownOutputLength: 0,
      deletedMessageIds: [],
    };
    const { executor } = createSelectExecutor((table) => {
      if (table === conversations) return [row];
      if (table === siteProjects) return [{ conversationId: snapshot.id }];
      return [];
    });

    await expect(
      listSnapshots(7, null, executor as Parameters<typeof listSnapshots>[2]),
    ).resolves.toEqual([]);
  });
});

function message(
  id: string,
  role: SnapshotMessage["role"],
  timestamp: number,
  content = id,
): SnapshotMessage {
  return { id, role, timestamp, content };
}

function serverOwnedMessage(
  id: string,
  role: SnapshotMessage["role"],
  timestamp: number,
  kind: "pending_user" | "presentation",
): SnapshotMessage {
  return {
    ...message(id, role, timestamp),
    knowledgeBase: {
      schemaVersion: 1,
      kind,
      buildId: "build-1",
      operationKey: "operation-1",
      turnId: "turn-1",
      ...(kind === "presentation"
        ? {
            presentationKey: "presentation-1",
            generation: 1,
            revision: 1,
            leafId: "1.2",
          }
        : { clientRequestId: "request-1" }),
      serverOwned: true,
    },
  };
}

function serverOwnedGeneralChatMessage(
  id: string,
  timestamp: number,
): SnapshotMessage {
  return {
    ...message(id, "assistant", timestamp),
    generalChat: {
      schemaVersion: 1,
      kind: "assistant_projection",
      turnId: "88888888-8888-4888-8888-888888888888",
      agentTaskId: "99999999-9999-4999-8999-999999999999",
      providerEventId: "provider-event-1",
      serverOwned: true,
    },
  };
}

function createSelectExecutor(rowsForTable: (table: unknown) => unknown[]) {
  const selectedTables: unknown[] = [];
  const selectedFields: unknown[] = [];
  const select = vi.fn((fields?: unknown) => {
    selectedFields.push(fields);
    return {
      from: (table: unknown) => {
        selectedTables.push(table);
        const rows = rowsForTable(table);
        const query: {
          where: () => typeof query;
          orderBy: () => typeof query;
          limit: () => Promise<unknown[]>;
          then: Promise<unknown[]>["then"];
        } = {
          where: () => query,
          orderBy: () => query,
          limit: async () => rows,
          then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
        };
        return query;
      },
    };
  });
  return { executor: { select }, selectedFields, selectedTables };
}

describe("conversation multi-device merge", () => {
  it("reconstructs only customer upload chips from a durable knowledge-base turn", () => {
    const attachments = reconstructKnowledgeBaseUserMessageAttachments({
      knowledgeBase: { kind: "pending_user" },
      turn: {
        id: "turn-upload",
        status: "completed",
        attachmentFileIds: [
          "generated-skill-file",
          "customer-pdf",
          "customer-image",
        ],
        metadata: {
          attachmentsFrozen: true,
          userAttachmentCount: 2,
          recovery: {
            capturedClientAttachments: true,
            attachments: [
              { file_id: "customer-pdf", filename: "企业事实.pdf" },
              { file_id: "customer-image", filename: "门店照片.png" },
            ],
            attachmentManifest: [
              {
                filename: "企业事实.pdf",
                sizeBytes: 123,
                mimeType: "application/pdf",
                lastModified: 1,
                sha256: "a".repeat(64),
              },
              {
                filename: "门店照片.png",
                sizeBytes: 456,
                mimeType: "image/png",
                lastModified: 2,
                sha256: "b".repeat(64),
              },
            ],
          },
        },
      },
    });

    expect(attachments).toEqual([
      {
        id: "kb-user-attachment-turn-upload-1",
        type: "file",
        name: "企业事实.pdf",
        fileId: "customer-pdf",
      },
      {
        id: "kb-user-attachment-turn-upload-2",
        type: "file",
        name: "门店照片.png",
        fileId: "customer-image",
      },
    ]);
    expect(
      attachments?.some((item) => item.fileId === "generated-skill-file"),
    ).toBe(false);
  });

  it("reconstructs an initial-build upload from its completed turn binding", () => {
    expect(
      reconstructKnowledgeBaseUserMessageAttachments({
        knowledgeBase: { kind: "pending_user" },
        turn: {
          id: "turn-start",
          status: "completed",
          attachmentFileIds: ["generated-skill", "initial-brochure"],
          metadata: {
            userAttachmentCount: 1,
            recovery: {
              attachments: [
                {
                  file_id: "initial-brochure",
                  filename: "企业宣传册.pdf",
                },
              ],
            },
          },
        },
      }),
    ).toEqual([
      {
        id: "kb-user-attachment-turn-start-1",
        type: "file",
        name: "企业宣传册.pdf",
        fileId: "initial-brochure",
      },
    ]);
  });

  it("fails closed when the durable customer upload ledger is inconsistent", () => {
    const baseTurn = {
      id: "turn-upload",
      status: "completed" as const,
      attachmentFileIds: ["customer-pdf"],
      metadata: {
        userAttachmentCount: 1,
        recovery: {
          attachments: [
            { file_id: "customer-pdf", filename: "企业事实确认表.pdf" },
          ],
          attachmentManifest: [
            {
              filename: "另一份资料.pdf",
              sizeBytes: 123,
              mimeType: "application/pdf",
              lastModified: 1,
              sha256: "a".repeat(64),
            },
          ],
        },
      },
    };

    expect(
      reconstructKnowledgeBaseUserMessageAttachments({
        knowledgeBase: { kind: "pending_user" },
        turn: baseTurn,
      }),
    ).toBeUndefined();
    expect(
      reconstructKnowledgeBaseUserMessageAttachments({
        knowledgeBase: { kind: "pending_user" },
        turn: {
          ...baseTurn,
          attachmentFileIds: [],
          metadata: {
            ...baseTurn.metadata,
            recovery: {
              ...baseTurn.metadata.recovery,
              attachmentManifest: [
                {
                  ...baseTurn.metadata.recovery.attachmentManifest[0],
                  filename: "企业事实确认表.pdf",
                },
              ],
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("hydrates durable upload chips after processing and on a fresh conversation list", async () => {
    const knowledgeBase = {
      schemaVersion: 1 as const,
      serverOwned: true,
      kind: "pending_user" as const,
      buildId: "build-1",
      generation: 1,
      operationKey: "operation-upload",
      clientRequestId: "request-upload",
      turnId: "turn-upload",
      revision: 1,
      leafId: "1.2",
    };
    const userMessage: typeof messages.$inferSelect = {
      id: "u7:msg-kb-user-turn-upload",
      conversationId: "u7:conversation-1",
      turnId: "turn-upload",
      userId: 7,
      role: "user",
      content: "请参考这份 PDF",
      sequence: 4,
      metadata: { knowledgeBase },
      sentAt: new Date(2_000),
      createdAt: new Date(2_000),
      updatedAt: new Date(2_000),
      deletedAt: null,
    };
    const turn = {
      id: "turn-upload",
      conversationId: "u7:conversation-1",
      userId: 7,
      clientRequestId: "request-upload",
      buildId: "build-1",
      buildGeneration: 1,
      operationKey: "operation-upload",
      operationType: "revise",
      expectedRevision: 1,
      expectedLeafId: "1.2",
      attachmentFileIds: ["generated-skill-file", "customer-pdf"],
      metadata: {
        attachmentsFrozen: true,
        userAttachmentCount: 1,
        recovery: {
          capturedClientAttachments: true,
          attachments: [
            { file_id: "customer-pdf", filename: "企业事实确认表.pdf" },
          ],
          attachmentManifest: [
            {
              filename: "企业事实确认表.pdf",
              sizeBytes: 123,
              mimeType: "application/pdf",
              lastModified: 1,
              sha256: "a".repeat(64),
            },
          ],
        },
      },
      status: "completed",
    };
    const build = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
    };
    const conversation = {
      id: "u7:conversation-1",
      userId: 7,
      projectAssignmentId: null,
      title: "知识库",
      status: "awaiting_input",
      upstreamTaskId: "task-upload",
      previousResponseId: "task-upload",
      taskUrl: null,
      createdAt: new Date(1_000),
      updatedAt: new Date(3_000),
      startedAt: new Date(1_500),
      completedAt: null,
      deletedAt: null,
      lastKnownOutputLength: 0,
      deletedMessageIds: [],
    };
    const uploadedAt = new Date("2026-08-01T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-08-31T00:00:00.000Z");
    const rowsForTable = (table: unknown) => {
      if (table === conversations) return [conversation];
      if (table === messages) return [userMessage];
      if (table === attachments) return [];
      if (table === conversationTurns) return [turn];
      if (table === knowledgeBaseBuilds) return [build];
      if (table === knowledgeBaseBuildNodes) return [];
      if (table === upstreamResources)
        return [
          {
            upstreamId: "customer-pdf",
            createdAt: uploadedAt,
            uploadedAt,
            contentExpiresAt,
            contentDeletedAt: null,
          },
        ];
      return [];
    };
    const expectedAttachment = {
      id: "kb-user-attachment-turn-upload-1",
      type: "file",
      name: "企业事实确认表.pdf",
      fileId: "customer-pdf",
      expiresAt: contentExpiresAt.getTime(),
      expired: false,
    };

    const { executor: historyExecutor } = createSelectExecutor(rowsForTable);
    const history = await loadPersistedMessages(
      historyExecutor,
      7,
      "u7:conversation-1",
      null,
    );
    expect(history[0]?.attachments).toEqual([expectedAttachment]);

    const { executor: listExecutor } = createSelectExecutor(rowsForTable);
    const snapshots = await listSnapshots(
      7,
      null,
      listExecutor as Parameters<typeof listSnapshots>[2],
    );
    expect(snapshots[0]?.messages[0]?.attachments).toEqual([
      expectedAttachment,
    ]);

    const localAssetId = `asset_${"a".repeat(30)}`;
    const localRetainUntil = new Date("2026-09-14T00:00:00.000Z");
    const localTurn = {
      ...turn,
      attachmentFileIds: ["generated-skill-file", localAssetId],
      metadata: {
        ...turn.metadata,
        recovery: {
          ...turn.metadata.recovery,
          attachments: [
            {
              file_id: localAssetId,
              filename: "企业事实确认表.pdf",
            },
          ],
        },
      },
    };
    const localRowsForTable = (table: unknown) => {
      if (table === conversationTurns) return [localTurn];
      if (table === localAssets) {
        return [{ id: localAssetId, retainUntil: localRetainUntil }];
      }
      if (table === upstreamResources) return [];
      return rowsForTable(table);
    };
    const expectedLocalAttachment = {
      ...expectedAttachment,
      fileId: localAssetId,
      expiresAt: localRetainUntil.getTime(),
    };
    const { executor: localHistoryExecutor } =
      createSelectExecutor(localRowsForTable);
    const localHistory = await loadPersistedMessages(
      localHistoryExecutor,
      7,
      "u7:conversation-1",
      null,
    );
    expect(localHistory[0]?.attachments).toEqual([expectedLocalAttachment]);

    const { executor: localListExecutor } =
      createSelectExecutor(localRowsForTable);
    const localSnapshots = await listSnapshots(
      7,
      null,
      localListExecutor as Parameters<typeof listSnapshots>[2],
    );
    expect(localSnapshots[0]?.messages[0]?.attachments).toEqual([
      expectedLocalAttachment,
    ]);
  });

  it("reconstructs durable customer images only for their authoritative presentation leaf", async () => {
    const loadResources = vi.fn().mockResolvedValue([
      {
        kind: "customer_upload",
        outputItemId: null,
        fileId: null,
        sameOriginUrl:
          "/api/knowledge-base/artifacts/build-1/customer-uploads/turn-1/0/" +
          "a".repeat(64),
        filename: "customer-proof.jpg",
        mimeType: "image/jpeg",
        sha256: "a".repeat(64),
        sizeBytes: 456,
      },
    ]);
    const turn = {
      id: "turn-1",
      operationType: "revise",
      expectedLeafId: "1.2",
      attachmentFileIds: ["file-1"],
      metadata: {},
      status: "completed" as const,
    };
    const build = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
    };
    const node = {
      buildId: "build-1",
      leafId: "1.2",
      ordinal: 1,
      sourceTurnId: "turn-1",
    };

    await expect(
      reconstructKnowledgeBasePresentationInlineImages(
        {
          build,
          node,
          knowledgeBase: { kind: "presentation", leafId: "1.2" },
          turn,
        },
        loadResources,
      ),
    ).resolves.toEqual([
      {
        src:
          "/api/knowledge-base/artifacts/build-1/customer-uploads/turn-1/0/" +
          "a".repeat(64),
        alt: "知识库配图",
      },
    ]);
    expect(loadResources).toHaveBeenCalledWith("build-1", turn);

    loadResources.mockClear();
    await expect(
      reconstructKnowledgeBasePresentationInlineImages(
        {
          build,
          node,
          knowledgeBase: { kind: "presentation", leafId: "1.3" },
          turn,
        },
        loadResources,
      ),
    ).resolves.toBeUndefined();
    expect(loadResources).not.toHaveBeenCalled();
  });

  it("keeps conversation enrichment readable when optional customer images fail", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loadResources = vi
      .fn()
      .mockRejectedValue(new Error("historical upload ledger unavailable"));
    const turn = {
      id: "turn-optional-upload",
      operationType: "revise",
      expectedLeafId: "1.2",
      attachmentFileIds: ["file-optional-upload"],
      metadata: {},
      status: "completed" as const,
    };

    await expect(
      reconstructKnowledgeBasePresentationInlineImages(
        {
          build: {
            id: "build-1",
            userId: 7,
            conversationId: "conversation-1",
            logoStorageKey: null,
            logoSha256: null,
            logoBytes: null,
            logoFilename: null,
            logoMimeType: null,
          },
          node: {
            buildId: "build-1",
            leafId: "1.2",
            ordinal: 1,
            sourceTurnId: turn.id,
          },
          knowledgeBase: { kind: "presentation", leafId: "1.2" },
          turn,
        },
        loadResources,
      ),
    ).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      "[KnowledgeBaseCustomerUpload] enrichment_skipped",
      expect.stringContaining('"surface":"conversation"'),
    );
  });

  it("keeps an earlier customer image visible after the same leaf is revised again", async () => {
    const loadResources = vi.fn().mockResolvedValue([
      {
        kind: "customer_upload",
        outputItemId: null,
        fileId: null,
        sameOriginUrl:
          "/api/knowledge-base/artifacts/build-1/customer-uploads/turn-earlier/0/" +
          "b".repeat(64),
        filename: "earlier-proof.png",
        mimeType: "image/png",
        sha256: "b".repeat(64),
        sizeBytes: 789,
      },
    ]);
    const turn = {
      id: "turn-earlier",
      operationType: "revise",
      expectedLeafId: "1.2",
      attachmentFileIds: ["file-earlier"],
      metadata: {},
      status: "completed" as const,
    };

    await expect(
      reconstructKnowledgeBasePresentationInlineImages(
        {
          build: {
            id: "build-1",
            userId: 7,
            conversationId: "conversation-1",
            logoStorageKey: null,
            logoSha256: null,
            logoBytes: null,
            logoFilename: null,
            logoMimeType: null,
          },
          // The durable node can now point at a later revision. The earlier
          // completed turn still owns its own exact customer-upload ledger.
          node: {
            buildId: "build-1",
            leafId: "1.2",
            ordinal: 1,
            sourceTurnId: "turn-later",
          },
          knowledgeBase: { kind: "presentation", leafId: "1.2" },
          turn,
        },
        loadResources,
      ),
    ).resolves.toEqual([
      {
        src:
          "/api/knowledge-base/artifacts/build-1/customer-uploads/turn-earlier/0/" +
          "b".repeat(64),
        alt: "知识库配图",
      },
    ]);
    expect(loadResources).toHaveBeenCalledWith("build-1", turn);
  });

  it("reconstructs the initial logo even when the start turn has no expected leaf", async () => {
    const loadResources = vi.fn().mockResolvedValue([]);
    const build = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
      logoStorageKey: "knowledge-base/build-1/logo.png",
      logoSha256: "a".repeat(64),
      logoBytes: 123,
      logoFilename: "official-logo.png",
      logoMimeType: "image/png",
    };
    const node = {
      buildId: "build-1",
      leafId: "1.1",
      ordinal: 0,
      sourceTurnId: "turn-initial",
    };
    const initialTurn = {
      id: "turn-initial",
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      attachmentFileIds: [],
      metadata: {},
      status: "completed" as const,
    };

    await expect(
      reconstructKnowledgeBasePresentationInlineImages(
        {
          build,
          node,
          knowledgeBase: { kind: "presentation", leafId: "1.1" },
          turn: initialTurn,
        },
        loadResources,
      ),
    ).resolves.toEqual([
      {
        src: expect.stringMatching(
          /^\/api\/knowledge-base\/artifacts\/resources\//u,
        ),
        alt: "企业官方主 Logo",
      },
    ]);
    expect(loadResources).not.toHaveBeenCalled();

    await expect(
      reconstructKnowledgeBasePresentationInlineImages(
        {
          build,
          node: { ...node, sourceTurnId: "turn-revise" },
          knowledgeBase: { kind: "presentation", leafId: "1.1" },
          turn: {
            ...initialTurn,
            id: "turn-revise",
            operationType: "revise",
            expectedLeafId: "1.1",
          },
        },
        loadResources,
      ),
    ).resolves.toBeUndefined();

    await expect(
      reconstructKnowledgeBasePresentationInlineImages(
        {
          build,
          node: { ...node, sourceTurnId: "turn-logo-upload" },
          knowledgeBase: { kind: "presentation", leafId: "1.1" },
          turn: {
            ...initialTurn,
            id: "turn-logo-upload",
            operationType: "revise",
            expectedLeafId: "1.1",
            attachmentFileIds: ["file-official-logo"],
            metadata: {
              attachmentsFrozen: true,
              userAttachmentCount: 1,
              recovery: {
                capturedClientAttachments: true,
                attachmentManifest: [
                  {
                    filename: "official-logo.png",
                    mimeType: "image/png",
                    sizeBytes: 123,
                    sha256: "c".repeat(64),
                  },
                ],
                attachments: [
                  {
                    file_id: "file-official-logo",
                    filename: "official-logo.png",
                  },
                ],
                officialLogoUpload: {
                  verified: true,
                  index: 0,
                  fileId: "file-official-logo",
                  filename: "official-logo.png",
                  mimeType: "image/png",
                  sizeBytes: 123,
                  sourceSha256: "c".repeat(64),
                },
              },
              preparedDispatch: {
                requestBody: {
                  attachments: [
                    {
                      file_id: "file-official-logo",
                      filename: "official-logo.png",
                    },
                  ],
                },
              },
            },
          },
        },
        loadResources,
      ),
    ).resolves.toEqual([
      {
        src: expect.stringMatching(
          /^\/api\/knowledge-base\/artifacts\/resources\//u,
        ),
        alt: "企业官方主 Logo",
      },
    ]);
  });

  it("hydrates only the authoritative initial-node logo in history and list snapshots", async () => {
    const content = "## 1.1 一句话定位\n\n初始正文";
    const contentSha256 = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const presentationKey = createHash("sha256")
      .update(["build-1", 7, 0, "1.1", contentSha256].join(":"))
      .digest("hex");
    const presentationMessage: typeof messages.$inferSelect = {
      id: `u7:msg-kb-presentation-${presentationKey}`,
      conversationId: "u7:conversation-1",
      turnId: "turn-initial",
      userId: 7,
      role: "assistant",
      content,
      sequence: 2,
      metadata: {
        inlineImages: [
          { src: "https://client.invalid/forged-logo.png", alt: "伪造图片" },
        ],
        knowledgeBase: {
          schemaVersion: 1,
          serverOwned: true,
          kind: "presentation",
          buildId: "build-1",
          generation: 7,
          operationKey: "operation-initial",
          turnId: "turn-initial",
          presentationKey,
          revision: 0,
          leafId: "1.1",
        },
      },
      sentAt: new Date(2_000),
      createdAt: new Date(2_000),
      updatedAt: new Date(2_000),
      deletedAt: null,
    };
    const initialTurn = {
      id: "turn-initial",
      conversationId: "u7:conversation-1",
      userId: 7,
      clientRequestId: "request-initial",
      buildId: "build-1",
      buildGeneration: 7,
      operationKey: "operation-initial",
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      attachmentFileIds: [],
      metadata: {},
      status: "completed",
    };
    const authoritativeBuild = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
      generation: 7,
      logoStorageKey: "knowledge-base/build-1/logo.png",
      logoSha256: "a".repeat(64),
      logoBytes: 321,
      logoFilename: "official-logo.png",
      logoMimeType: "image/png",
    };
    const authoritativeNode = {
      buildId: "build-1",
      leafId: "1.1",
      ordinal: 0,
      sourceTurnId: "turn-initial",
    };
    const conversation = {
      id: "u7:conversation-1",
      userId: 7,
      projectAssignmentId: null,
      title: "知识库",
      status: "awaiting_input",
      upstreamTaskId: null,
      previousResponseId: null,
      taskUrl: null,
      createdAt: new Date(1_000),
      updatedAt: new Date(2_000),
      startedAt: null,
      completedAt: null,
      deletedAt: null,
      lastKnownOutputLength: 0,
      deletedMessageIds: [],
    };
    const rowsForTable = (table: unknown) => {
      if (table === conversations) return [conversation];
      if (table === messages) return [presentationMessage];
      if (table === attachments) return [];
      if (table === conversationTurns) return [initialTurn];
      if (table === knowledgeBaseBuilds) return [authoritativeBuild];
      if (table === knowledgeBaseBuildNodes) return [authoritativeNode];
      return [];
    };

    const { executor: historyExecutor, selectedFields: historySelectedFields } =
      createSelectExecutor(rowsForTable);
    const history = await loadPersistedMessages(
      historyExecutor,
      7,
      "u7:conversation-1",
      null,
    );
    expect(historySelectedFields).toContainEqual(
      expect.objectContaining({
        generation: knowledgeBaseBuilds.generation,
      }),
    );
    expect(history[0]?.inlineImages).toEqual([
      {
        src: expect.stringMatching(
          /^\/api\/knowledge-base\/artifacts\/resources\//u,
        ),
        alt: "企业官方主 Logo",
      },
    ]);

    const { executor: listExecutor } = createSelectExecutor(rowsForTable);
    const snapshots = await listSnapshots(
      7,
      null,
      listExecutor as Parameters<typeof listSnapshots>[2],
    );
    expect(snapshots[0]?.messages[0]?.inlineImages).toEqual([
      {
        src: expect.stringMatching(
          /^\/api\/knowledge-base\/artifacts\/resources\//u,
        ),
        alt: "企业官方主 Logo",
      },
    ]);
    expect(snapshots[0]?.messages[0]?.inlineImages).toEqual(
      history[0]?.inlineImages,
    );
  });

  it("repairs a provider assistant ID reused across two confirmed turns", () => {
    const repaired = repairSnapshotMessageIds([
      message("confirm-1", "user", 100, "确认"),
      message("provider-output", "assistant", 110, "节点 2.3"),
      message("confirm-2", "user", 120, "确认"),
      message("provider-output", "assistant", 130, "节点 2.4"),
    ]);

    expect(repaired.map((item) => item.id)).toEqual([
      "confirm-1",
      "provider-output",
      "confirm-2",
      "provider-output~2",
    ]);
    expect(repaired.map((item) => item.content)).toEqual([
      "确认",
      "节点 2.3",
      "确认",
      "节点 2.4",
    ]);
  });

  it("repairs duplicate attachment IDs without dropping either message", () => {
    const repaired = repairSnapshotMessageIds([
      {
        ...message("assistant-1", "assistant", 100),
        attachments: [
          { id: "asset", type: "image", name: "one.webp", fileId: "file-1" },
        ],
      },
      {
        ...message("assistant-2", "assistant", 110),
        attachments: [
          { id: "asset", type: "image", name: "two.webp", fileId: "file-2" },
        ],
      },
    ]);

    expect(
      repaired.flatMap((item) => item.attachments ?? []).map((item) => item.id),
    ).toEqual(["asset", "asset~2"]);
  });

  it("retains independent turns created on two devices", () => {
    const persisted = [
      message("user-a", "user", 100),
      message("assistant-a", "assistant", 110),
    ];
    const incoming = [
      message("user-b", "user", 105),
      message("assistant-b", "assistant", 115),
    ];

    expect(
      mergeConversationMessages(persisted, incoming, []).map((item) => item.id),
    ).toEqual(["user-a", "assistant-a", "user-b", "assistant-b"]);
  });

  it("never rewrites persisted KB turn order from same-second IDs", () => {
    const earlier = {
      ...serverOwnedMessage("z-earlier", "user", 100, "pending_user"),
      serverSequence: 0,
      knowledgeBase: {
        ...serverOwnedMessage("z-earlier", "user", 100, "pending_user")
          .knowledgeBase!,
        clientRequestId: "request-earlier",
        turnId: "turn-earlier",
      },
    };
    const later = {
      ...serverOwnedMessage("a-later", "user", 100, "pending_user"),
      serverSequence: 2,
      knowledgeBase: {
        ...serverOwnedMessage("a-later", "user", 100, "pending_user")
          .knowledgeBase!,
        clientRequestId: "request-later",
        turnId: "turn-later",
      },
    };

    expect(
      mergeConversationMessages([earlier, later], [], []).map(
        (item) => item.id,
      ),
    ).toEqual(["z-earlier", "a-later"]);
  });

  it("keeps server-sequenced history ahead of an unsequenced skewed client turn", () => {
    const persisted = [
      { ...message("persisted", "user", 200), serverSequence: 0 },
      { ...message("persisted-result", "assistant", 210), serverSequence: 1 },
    ];
    const incoming = [
      message("client-clock-earlier", "user", 100),
      message("client-clock-earlier-result", "assistant", 110),
    ];

    expect(
      mergeConversationMessages(persisted, incoming, []).map((item) => item.id),
    ).toEqual([
      "persisted",
      "persisted-result",
      "client-clock-earlier",
      "client-clock-earlier-result",
    ]);
  });

  it("keeps authoritative sequence for assistant-only prelude messages", () => {
    const persisted = [
      { ...message("z-earlier", "assistant", 100), serverSequence: 0 },
      { ...message("a-later", "assistant", 100), serverSequence: 1 },
    ];

    expect(
      mergeConversationMessages(persisted, [], []).map((item) => item.id),
    ).toEqual(["z-earlier", "a-later"]);
  });

  it("replaces the assistant projection for a known turn", () => {
    const persisted = [
      message("user-a", "user", 100),
      { ...message("placeholder", "assistant", 110), isStepsPlaceholder: true },
    ];
    const incoming = [
      message("user-a", "user", 100),
      message("final", "assistant", 120, "完成"),
    ];

    expect(
      mergeConversationMessages(persisted, incoming, []).map((item) => item.id),
    ).toEqual(["user-a", "final"]);
  });

  it("does not regress a final projection from a stale device placeholder", () => {
    const persisted = [
      message("user-a", "user", 100),
      message("final", "assistant", 120, "完整结果"),
    ];
    const incoming = [
      message("user-a", "user", 100),
      { ...message("placeholder", "assistant", 110), isStepsPlaceholder: true },
    ];

    expect(
      mergeConversationMessages(persisted, incoming, []).map((item) => item.id),
    ).toEqual(["user-a", "final"]);
  });

  it("applies deletion tombstones after merging", () => {
    const persisted = [
      message("user-a", "user", 100),
      message("assistant-a", "assistant", 110),
    ];

    expect(
      mergeConversationMessages(persisted, [], ["assistant-a"]).map(
        (item) => item.id,
      ),
    ).toEqual(["user-a"]);
  });

  it("does not apply deletion tombstones to server-owned KB messages", () => {
    const user = serverOwnedMessage("turn-1", "user", 100, "pending_user");
    const assistant = serverOwnedMessage(
      "presentation-1",
      "assistant",
      110,
      "presentation",
    );

    expect(
      mergeConversationMessages(
        [user, assistant],
        [],
        ["turn-1", "presentation-1"],
      ).map((item) => item.id),
    ).toEqual(["turn-1", "presentation-1"]);
    expect(
      sanitizeKnowledgeBaseDeletionTombstones(
        [user, assistant],
        [],
        ["turn-1", "presentation-1", "ordinary"],
      ),
    ).toEqual(["ordinary"]);
  });

  it("discards a client-forged server-owned assistant instead of persisting or protecting it", () => {
    const forged = {
      ...serverOwnedMessage(
        "forged-presentation",
        "assistant",
        120,
        "presentation",
      ),
      content: "伪造的已批准正文",
    };

    expect(
      discardClientClaimedServerOwnedKnowledgeBaseMessages([forged]),
    ).toEqual([]);
    expect(mergeConversationMessages([], [forged], [])).toEqual([]);
    expect(
      sanitizeKnowledgeBaseDeletionTombstones([], [forged], [forged.id]),
    ).toEqual([forged.id]);
  });

  it("requires the complete reserved tuple and deterministic content key for a persisted server message", () => {
    const content = "## 1.2 企业主体\n\n已批准正文";
    const markdownSha256 = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const turn = {
      id: "turn-1",
      conversationId: "u7:conversation-1",
      userId: 7,
      clientRequestId: "request-1",
      buildId: "build-1",
      buildGeneration: 1,
      operationKey: "operation-1",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
    };
    const build = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
    };
    const presentationKey = createHash("sha256")
      .update(["build-1", 1, 1, "1.2", markdownSha256].join(":"))
      .digest("hex");
    const authoritativeKnowledgeBase = {
      schemaVersion: 1 as const,
      serverOwned: true,
      kind: "presentation" as const,
      buildId: "build-1",
      generation: 1,
      operationKey: "operation-1",
      turnId: "turn-1",
      presentationKey,
      revision: 1,
      leafId: "1.2",
    };
    const authoritativeMessage = {
      id: `u7:msg-kb-presentation-${presentationKey}`,
      conversationId: "u7:conversation-1",
      turnId: "turn-1",
      userId: 7,
      role: "assistant",
      content,
    };

    expect(
      matchesAuthoritativeKnowledgeBaseMessageTuple({
        message: authoritativeMessage,
        knowledgeBase: authoritativeKnowledgeBase,
        turn,
        build,
        publicConversationId: "conversation-1",
      }),
    ).toBe(true);
    expect(
      matchesAuthoritativeKnowledgeBaseMessageTuple({
        message: { ...authoritativeMessage, content: "伪造覆盖正文" },
        knowledgeBase: authoritativeKnowledgeBase,
        turn,
        build,
        publicConversationId: "conversation-1",
      }),
    ).toBe(false);
    expect(
      matchesAuthoritativeKnowledgeBaseMessageTuple({
        message: {
          ...authoritativeMessage,
          id: `u8:msg-kb-presentation-${presentationKey}`,
        },
        knowledgeBase: authoritativeKnowledgeBase,
        turn,
        build,
        publicConversationId: "conversation-1",
      }),
    ).toBe(false);
  });

  it("does not let a larger stale projection overwrite a server-owned KB turn", () => {
    const persisted = [
      serverOwnedMessage("turn-1", "user", 100, "pending_user"),
      {
        ...serverOwnedMessage(
          "presentation-1",
          "assistant",
          110,
          "presentation",
        ),
        content: "已批准正文",
      },
    ];
    const stale = [
      message("turn-1", "user", 100, "确认"),
      message("stale-longer", "assistant", 120, "旧内容".repeat(1_000)),
    ];

    const merged = mergeConversationMessages(persisted, stale, []);
    expect(merged.map((item) => item.id)).toEqual(["turn-1", "presentation-1"]);
    expect(merged[1]?.content).toBe("已批准正文");
  });

  it("verifies an immutable completion receipt and rejects changed content", () => {
    const turn = {
      id: "turn-final",
      conversationId: "u7:conversation-1",
      userId: 7,
      clientRequestId: "request-final",
      buildId: "build-1",
      buildGeneration: 1,
      operationKey: "operation-final",
      expectedRevision: 8,
      expectedLeafId: "8.5",
      status: "completed",
    };
    const build = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
    };
    const knowledgeBase = {
      schemaVersion: 1 as const,
      serverOwned: true,
      kind: "completion" as const,
      buildId: build.id,
      generation: 1,
      operationKey: turn.operationKey,
      turnId: turn.id,
      revision: 9,
      leafId: null,
    };
    const publicMessageId = knowledgeBaseCompletionMessagePublicId({
      buildId: build.id,
      generation: 1,
      revision: 9,
    });
    const message = {
      id: `u7:${publicMessageId}`,
      conversationId: turn.conversationId,
      turnId: turn.id,
      userId: 7,
      role: "assistant",
      content: KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT,
    };

    expect(
      matchesAuthoritativeKnowledgeBaseMessageTuple({
        message,
        knowledgeBase,
        turn,
        build,
        publicConversationId: "conversation-1",
      }),
    ).toBe(true);
    expect(
      matchesAuthoritativeKnowledgeBaseMessageTuple({
        message: { ...message, content: "伪造完成" },
        knowledgeBase,
        turn,
        build,
        publicConversationId: "conversation-1",
      }),
    ).toBe(false);
  });

  it("converges an optimistic KB user id to the server turn id by clientRequestId", () => {
    const optimistic: SnapshotMessage = {
      ...message("optimistic-user", "user", 100, "确认"),
      knowledgeBase: {
        kind: "pending_user",
        clientRequestId: "request-1",
      },
    };
    const accepted = serverOwnedMessage("turn-1", "user", 100, "pending_user");

    // Only the locked database copy can be authoritative. The browser may
    // still carry its pre-reservation optimistic id when that copy arrives.
    const merged = mergeConversationMessages([accepted], [optimistic], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "turn-1",
      knowledgeBase: {
        clientRequestId: "request-1",
        turnId: "turn-1",
        serverOwned: true,
      },
    });
  });

  it("round-trips KB provenance through snapshot validation and message metadata", () => {
    const protectedMessage = {
      ...serverOwnedMessage("presentation-1", "assistant", 110, "presentation"),
      serverSequence: 7,
    };
    const parsed = conversationSnapshotSchema.parse({
      id: "conversation-1",
      title: "企业知识库构建",
      status: "awaiting_input",
      createdAt: 1,
      updatedAt: 2,
      messages: [protectedMessage],
    });

    expect(parsed.messages[0]?.knowledgeBase).toEqual(
      protectedMessage.knowledgeBase,
    );
    expect(parsed.messages[0]?.serverSequence).toBe(7);
    expect(buildMessageMetadata(parsed.messages[0]!).knowledgeBase).toEqual(
      protectedMessage.knowledgeBase,
    );
  });

  it("round-trips a strict browser-owned ordinary dispatch envelope through message metadata", () => {
    const generalChatDispatch = {
      schemaVersion: 1 as const,
      kind: "pending_user" as const,
      clientRequestId: "msg-pending-general-chat",
      providerPrompt: "正文\nZIP reference",
      localAssetIds: ["asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      localTaskId: null,
      modelProfile: "frontmind-pro" as const,
    };
    const parsed = conversationSnapshotSchema.parse({
      id: "conversation-pending-general-chat",
      title: "普通聊天",
      status: "idle",
      executionKind: "general_chat_v2",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: generalChatDispatch.clientRequestId,
          role: "user",
          content: "界面正文",
          timestamp: 1,
          generalChatDispatch,
        },
      ],
    });

    expect(parsed.messages[0]?.generalChatDispatch).toEqual(
      generalChatDispatch,
    );
    expect(
      buildMessageMetadata(parsed.messages[0]!).generalChatDispatch,
    ).toEqual(generalChatDispatch);
    expect(() =>
      conversationSnapshotSchema.parse({
        ...parsed,
        messages: [
          {
            ...parsed.messages[0],
            generalChatDispatch: {
              ...generalChatDispatch,
              localAssetIds: [
                "asset_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              ],
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("preserves the derived response-logic execution boundary in snapshots", () => {
    const parsed = conversationSnapshotSchema.parse({
      id: "response-conversation-1",
      title: "应答-示例问题",
      status: "running",
      executionKind: "response_logic",
      taskId: "provider-task-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    });

    expect(parsed.executionKind).toBe("response_logic");
  });

  it("does not let a stale device roll the task pointer from T2 back to T1", () => {
    const persisted = [
      message("user-turn-1", "user", 100),
      message("assistant-turn-1", "assistant", 110),
      message("user-turn-2", "user", 200),
      message("assistant-turn-2", "assistant", 210),
    ];
    const stale = [
      message("user-turn-1", "user", 100),
      message("assistant-turn-1", "assistant", 110),
    ];

    expect(
      mergeConversationTaskPointers({
        existing: { taskId: "T2", previousResponseId: "T2" },
        incoming: { taskId: "T1", previousResponseId: "T1" },
        persistedMessages: persisted,
        incomingMessages: stale,
        resourceCreatedAt: new Map([
          ["T1", 1_000],
          ["T2", 2_000],
        ]),
        existingUpdatedAt: 2_000,
        // Even a badly skewed client clock cannot defeat ledger ordering.
        incomingUpdatedAt: 99_000,
      }),
    ).toEqual({ taskId: "T2", previousResponseId: "T2" });
  });

  it("accepts the next task pointer when its user turn is current", () => {
    const currentMessages = [
      message("user-turn-1", "user", 100),
      message("assistant-turn-1", "assistant", 110),
      message("user-turn-2", "user", 200),
    ];

    expect(
      mergeConversationTaskPointers({
        existing: { taskId: "T1", previousResponseId: "T1" },
        incoming: { taskId: "T2", previousResponseId: "T2" },
        persistedMessages: currentMessages,
        incomingMessages: currentMessages,
        // MySQL task timestamps can share one-second precision.
        resourceCreatedAt: new Map([
          ["T1", 1_000],
          ["T2", 1_000],
        ]),
        existingUpdatedAt: 2_000,
        incomingUpdatedAt: 2_001,
      }),
    ).toEqual({ taskId: "T2", previousResponseId: "T2" });
  });
});

describe("server-owned general chat projection", () => {
  const taskId = "99999999-9999-4999-8999-999999999999";
  const turnId = "88888888-8888-4888-8888-888888888888";
  const pendingUser = {
    ...message("msg-general-pending", "user", 100, "界面正文"),
    generalChatDispatch: {
      schemaVersion: 1 as const,
      kind: "pending_user" as const,
      clientRequestId: "msg-general-pending",
      providerPrompt: "精确 Provider 正文",
      localAssetIds: [] as string[],
      localTaskId: null,
      modelProfile: "frontmind-pro" as const,
    },
  };
  const settledUser = message("msg-general-pending", "user", 100, "界面正文");
  const turnAuthority = new Map([
    [
      "msg-general-pending",
      {
        id: turnId,
        clientRequestId: "msg-general-pending",
        upstreamTaskId: taskId,
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        settlementKind: "acknowledged" as const,
        safeToSettle: true,
      },
    ],
  ]);

  it("settles a pending marker only from the exact acknowledged turn and does not revive it during merge", () => {
    const persistedForMerge = removeAcknowledgedGeneralChatDispatchMetadata({
      persistedMessages: [pendingUser],
      incomingMessages: [settledUser],
      executionKind: "general_chat_v2",
      taskId,
      previousResponseId: taskId,
      authority: {
        turnByClientRequestId: turnAuthority,
        persistedTurnIdByPublicMessageId: new Map([
          ["msg-general-pending", turnId],
        ]),
      },
    });
    const reloaded = mergeConversationMessages(
      persistedForMerge,
      [settledUser],
      [],
    );

    expect(reloaded[0]?.generalChatDispatch).toBeUndefined();
    expect(
      authoritativeGeneralChatTurnIdForBrowserMessage(
        reloaded[0]!,
        turnAuthority,
      ),
    ).toBe(turnId);
  });

  it("derives settlement only from an exact acknowledged or proven-rejected reservation", () => {
    expect(
      generalChatDispatchSettlementKind({
        reservationStatus: "acknowledged",
        rejectionProven: false,
      }),
    ).toBe("acknowledged");
    expect(
      generalChatDispatchSettlementKind({
        reservationStatus: "rejected",
        rejectionProven: true,
      }),
    ).toBe("rejected");
    for (const reservationStatus of [
      undefined,
      "preparation_failed",
      "preparing",
      "sending",
      "outcome_unknown",
      "ambiguous",
      "rejected",
    ]) {
      expect(
        generalChatDispatchSettlementIsSafe({
          reservationStatus,
          rejectionProven: false,
        }),
      ).toBe(false);
    }
  });

  it("allows a proven create rejection to clear without task pointers but keeps acknowledged markers until both pointers match", () => {
    const rejectedAuthority = new Map([
      [
        "msg-general-pending",
        {
          ...turnAuthority.get("msg-general-pending")!,
          settlementKind: "rejected" as const,
        },
      ],
    ]);
    expect(
      removeAcknowledgedGeneralChatDispatchMetadata({
        persistedMessages: [pendingUser],
        incomingMessages: [settledUser],
        executionKind: "general_chat_v2",
        authority: {
          turnByClientRequestId: rejectedAuthority,
          persistedTurnIdByPublicMessageId: new Map([
            ["msg-general-pending", turnId],
          ]),
        },
      })[0]?.generalChatDispatch,
    ).toBeUndefined();

    expect(
      removeAcknowledgedGeneralChatDispatchMetadata({
        persistedMessages: [pendingUser],
        incomingMessages: [settledUser],
        executionKind: "general_chat_v2",
        taskId,
        authority: {
          turnByClientRequestId: turnAuthority,
          persistedTurnIdByPublicMessageId: new Map([
            ["msg-general-pending", turnId],
          ]),
        },
      })[0]?.generalChatDispatch,
    ).toEqual(pendingUser.generalChatDispatch);
  });

  it("filters tombstones for an unsettled exact bound user while allowing settled users to be deleted", () => {
    const persistedBinding = new Map([["msg-general-pending", turnId]]);
    const unsettledAuthority = new Map([
      [
        "msg-general-pending",
        {
          ...turnAuthority.get("msg-general-pending")!,
          settlementKind: null,
          safeToSettle: false,
        },
      ],
    ]);
    expect(
      protectUnsettledGeneralChatBoundUserMessageTombstones(
        ["msg-general-pending", "other", "msg-general-pending"],
        {
          turnByClientRequestId: unsettledAuthority,
          persistedTurnIdByPublicMessageId: persistedBinding,
        },
      ),
    ).toEqual(["other"]);
    expect(
      protectUnsettledGeneralChatBoundUserMessageTombstones(
        ["msg-general-pending"],
        {
          turnByClientRequestId: turnAuthority,
          persistedTurnIdByPublicMessageId: persistedBinding,
        },
      ),
    ).toEqual(["msg-general-pending"]);
  });

  it("keeps pending when the database user message has no authoritative turn binding", () => {
    const result = removeAcknowledgedGeneralChatDispatchMetadata({
      persistedMessages: [pendingUser],
      incomingMessages: [settledUser],
      executionKind: "general_chat_v2",
      taskId,
      previousResponseId: taskId,
      authority: {
        turnByClientRequestId: turnAuthority,
        persistedTurnIdByPublicMessageId: new Map(),
      },
    });

    expect(result[0]?.generalChatDispatch).toEqual(
      pendingUser.generalChatDispatch,
    );
  });

  it("keeps pending for a different bound turn or a mismatched snapshot pointer", () => {
    const authority = {
      turnByClientRequestId: turnAuthority,
      persistedTurnIdByPublicMessageId: new Map([
        ["msg-general-pending", "77777777-7777-4777-8777-777777777777"],
      ]),
    };
    expect(
      removeAcknowledgedGeneralChatDispatchMetadata({
        persistedMessages: [pendingUser],
        incomingMessages: [settledUser],
        executionKind: "general_chat_v2",
        taskId,
        previousResponseId: taskId,
        authority,
      })[0]?.generalChatDispatch,
    ).toEqual(pendingUser.generalChatDispatch);
    expect(
      removeAcknowledgedGeneralChatDispatchMetadata({
        persistedMessages: [pendingUser],
        incomingMessages: [settledUser],
        executionKind: "general_chat_v2",
        taskId: "66666666-6666-4666-8666-666666666666",
        previousResponseId: "66666666-6666-4666-8666-666666666666",
        authority: {
          turnByClientRequestId: turnAuthority,
          persistedTurnIdByPublicMessageId: new Map([
            ["msg-general-pending", turnId],
          ]),
        },
      })[0]?.generalChatDispatch,
    ).toEqual(pendingUser.generalChatDispatch);
  });

  it("keeps an authoritative assistant projection when a stale browser omits or forges it", () => {
    const user = message("general-user", "user", 100, "你好");
    const authoritative = serverOwnedGeneralChatMessage(
      "general-assistant",
      110,
    );
    const forged = {
      ...serverOwnedGeneralChatMessage("forged-assistant", 120),
      content: "forged",
    };

    expect(
      mergeConversationMessages(
        [user, authoritative],
        [user, forged],
        [authoritative.id],
      ),
    ).toEqual([user, authoritative]);
    expect(
      assignBrowserOwnedSnapshotMessageSequences(
        [user, authoritative],
        new Map([
          [user.id, 0],
          [authoritative.id, 1],
        ]),
      ).map(({ message: item }) => item.id),
    ).toEqual([user.id]);
  });

  it("verifies and rebuilds general-chat metadata and execution kind from durable rows", async () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const generalChat = serverOwnedGeneralChatMessage(
      "general-assistant",
      2_000,
    ).generalChat!;
    const conversation = {
      id: "u7:conversation-general",
      userId: 7,
      projectAssignmentId: null,
      title: "通用聊天",
      status: "completed",
      upstreamTaskId: taskId,
      previousResponseId: taskId,
      taskUrl: null,
      createdAt: new Date(1_000),
      updatedAt: new Date(2_000),
      startedAt: new Date(1_100),
      completedAt: new Date(2_000),
      deletedAt: null,
      lastKnownOutputLength: 2,
      deletedMessageIds: [],
    };
    const messageRows = [
      {
        id: "u7:general-user",
        conversationId: conversation.id,
        turnId,
        userId: 7,
        role: "user",
        content: "你好",
        sequence: 0,
        metadata: null,
        sentAt: new Date(1_000),
        createdAt: new Date(1_000),
        updatedAt: new Date(1_000),
        deletedAt: null,
      },
      {
        id: "u7:general-assistant",
        conversationId: conversation.id,
        turnId,
        userId: 7,
        role: "assistant",
        content: "你好！",
        sequence: 1,
        metadata: { generalChat },
        sentAt: new Date(2_000),
        createdAt: new Date(2_000),
        updatedAt: new Date(2_000),
        deletedAt: null,
      },
    ];
    const { executor } = createSelectExecutor((table) => {
      if (table === conversations) return [conversation];
      if (table === messages) return messageRows;
      if (table === attachments) return [];
      if (table === conversationTurns) {
        return [
          {
            id: turnId,
            conversationId: conversation.id,
            userId: 7,
            apiCredentialId: "credential-general",
            operationType: "general_chat_v2",
            upstreamTaskId: taskId,
            metadata: { agentTaskId: taskId },
          },
        ];
      }
      if (table === agentTasks) {
        return [{ id: taskId, operationId, createdAt: new Date(1_100) }];
      }
      if (table === agentOperations) {
        return [
          {
            id: operationId,
            scope: "managed_user",
            accountUserId: 7,
            presalesProjectId: null,
            operationType: "dashboard.general-chat",
            contractName: "dashboard.general-chat",
            contractRevision: 2,
            apiCredentialId: "credential-general",
          },
        ];
      }
      if (table === agentEvents) {
        return [{ taskId, providerEventId: "provider-event-1" }];
      }
      return [];
    });

    const snapshots = await listSnapshots(
      7,
      null,
      executor as Parameters<typeof listSnapshots>[2],
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ executionKind: "general_chat_v2" });
    expect(snapshots[0]?.messages[1]).toMatchObject({
      id: "general-assistant",
      content: "你好！",
      generalChat,
    });
  });
});

describe("conversation server sequence projection", () => {
  const persistedMessage = (
    id: string,
    sequence: number,
  ): typeof messages.$inferSelect => ({
    id: `u7:${id}`,
    conversationId: "u7:conversation-1",
    turnId: null,
    userId: 7,
    role: "assistant",
    content: id,
    sequence,
    metadata: {},
    sentAt: new Date(1_000 + sequence),
    createdAt: new Date(1_000 + sequence),
    updatedAt: new Date(1_000 + sequence),
    deletedAt: null,
  });

  it("preserves the database sequence when loading the locked snapshot", async () => {
    const { executor } = createSelectExecutor((table) => {
      if (table === messages) return [persistedMessage("message-1", 7)];
      if (table === attachments) return [];
      return [];
    });

    const projected = await loadPersistedMessages(
      executor,
      7,
      "u7:conversation-1",
      null,
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: "message-1",
      serverSequence: 7,
    });
  });

  it("returns database sequences from the conversation list DTO", async () => {
    const messageRows = [
      persistedMessage("message-1", 4),
      persistedMessage("message-2", 5),
    ];
    const { executor } = createSelectExecutor((table) => {
      if (table === conversations) {
        return [
          {
            id: "u7:conversation-1",
            userId: 7,
            projectAssignmentId: null,
            title: "知识库",
            status: "awaiting_input",
            upstreamTaskId: null,
            previousResponseId: null,
            taskUrl: null,
            createdAt: new Date(1_000),
            updatedAt: new Date(2_000),
            startedAt: null,
            completedAt: null,
            lastKnownOutputLength: 0,
            deletedMessageIds: [],
          },
        ];
      }
      if (table === messages) return messageRows;
      if (table === attachments) return [];
      return [];
    });

    const projected = await listSnapshots(
      7,
      null,
      executor as Parameters<typeof listSnapshots>[2],
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]?.messages.map((item) => item.serverSequence)).toEqual([
      4, 5,
    ]);
  });
});

describe("conversation snapshot sequence allocation", () => {
  it("preserves ordinary and KB slots while appending new browser messages above the full maximum", () => {
    const ordinary = message("ordinary-existing", "user", 100);
    const knowledgeUser = {
      ...serverOwnedMessage("kb-user", "user", 110, "pending_user"),
      serverSequence: 1,
    };
    const knowledgePresentation = {
      ...serverOwnedMessage(
        "kb-presentation",
        "assistant",
        120,
        "presentation",
      ),
      serverSequence: 2,
    };
    const appended = message("ordinary-new", "user", 130);
    const persistedSequences = new Map([
      [ordinary.id, 0],
      [knowledgeUser.id, 1],
      [knowledgePresentation.id, 2],
    ]);

    expect(
      assignBrowserOwnedSnapshotMessageSequences(
        [ordinary, knowledgeUser, knowledgePresentation, appended],
        persistedSequences,
      ).map(({ message: item, sequence }) => [item.id, sequence]),
    ).toEqual([
      ["ordinary-existing", 0],
      ["ordinary-new", 3],
    ]);

    expect(
      assignBrowserOwnedSnapshotMessageSequences(
        [appended],
        persistedSequences,
      ).map(({ message: item, sequence }) => [item.id, sequence]),
    ).toEqual([["ordinary-new", 3]]);
  });

  it("commits without colliding with the real conversation-sequence unique index", async () => {
    const index = getTableConfig(messages).indexes.find(
      (candidate) =>
        candidate.config.name === "messages_conversation_sequence_uq",
    );
    expect(index?.config.unique).toBe(true);

    const conversationId = "u7:conversation-1";
    const initialRows = [
      {
        id: "ordinary-existing",
        sequence: 0,
        turnId: null as string | null,
        serverOwned: false,
      },
      {
        id: "kb-user",
        sequence: 1,
        turnId: "turn-1",
        serverOwned: true,
      },
      {
        id: "kb-presentation",
        sequence: 2,
        turnId: "turn-1",
        serverOwned: true,
      },
    ];
    let rows = structuredClone(initialRows);
    const transact = async (incoming: SnapshotMessage[]) => {
      const before = structuredClone(rows);
      try {
        const persisted = new Map(
          rows.map((row) => [row.id, row.sequence] as const),
        );
        rows = rows.filter((row) => row.serverOwned);
        for (const assigned of assignBrowserOwnedSnapshotMessageSequences(
          incoming,
          persisted,
        )) {
          if (
            rows.some(
              (row) =>
                row.sequence === assigned.sequence &&
                conversationId === "u7:conversation-1",
            )
          ) {
            throw Object.assign(new Error("duplicate sequence"), {
              code: "ER_DUP_ENTRY",
            });
          }
          rows.push({
            id: assigned.message.id,
            sequence: assigned.sequence,
            turnId: assigned.message.knowledgeBase?.turnId ?? null,
            serverOwned: false,
          });
        }
      } catch (error) {
        rows = before;
        throw error;
      }
    };

    await expect(
      transact([
        message("ordinary-existing", "user", 100),
        message("ordinary-new", "user", 130),
      ]),
    ).resolves.toBeUndefined();
    expect(rows).toEqual([
      initialRows[1],
      initialRows[2],
      expect.objectContaining({ id: "ordinary-existing", sequence: 0 }),
      expect.objectContaining({ id: "ordinary-new", sequence: 3 }),
    ]);
    expect(rows.filter((row) => row.serverOwned)).toEqual(initialRows.slice(1));

    await expect(
      transact([message("ordinary-new", "user", 140)]),
    ).resolves.toBeUndefined();
    expect(rows.map((row) => [row.id, row.sequence])).toEqual([
      ["kb-user", 1],
      ["kb-presentation", 2],
      ["ordinary-new", 3],
    ]);
  });
});

describe("conversation deletion", () => {
  it("physically deletes the owned conversation instead of marking it deleted", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const deleteFrom = vi.fn().mockReturnValue({ where });

    await permanentlyDeleteConversation(
      { delete: deleteFrom },
      7,
      "u7:conversation-1",
    );

    expect(deleteFrom).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("uses id plus project scope so a replacement engineer can delete project history without crossing A/B", async () => {
    const rows = [
      {
        id: "pproject-a:conversation-1",
        userId: 7,
        projectAssignmentId: "project-a",
      },
    ];
    const predicates: Array<{ sql: string; params: unknown[] }> = [];
    const deleteFrom = vi.fn((table: unknown) => {
      expect(table).toBe(conversations);
      return {
        where: async (expression: unknown) => {
          const query = new MySqlDialect().sqlToQuery(expression as any);
          predicates.push(query);
          const [id, projectAssignmentId] = query.params;
          const index = rows.findIndex(
            (row) =>
              row.id === id && row.projectAssignmentId === projectAssignmentId,
          );
          if (index >= 0) rows.splice(index, 1);
        },
      };
    });

    await permanentlyDeleteConversation(
      { delete: deleteFrom },
      99,
      "pproject-a:conversation-1",
      "project-b",
    );
    expect(rows).toHaveLength(1);

    await permanentlyDeleteConversation(
      { delete: deleteFrom },
      99,
      "pproject-a:conversation-1",
      "project-a",
    );
    expect(rows).toEqual([]);

    expect(predicates).toHaveLength(2);
    for (const predicate of predicates) {
      expect(predicate.sql).toContain("`conversations`.`id` = ?");
      expect(predicate.sql).toContain(
        "`conversations`.`projectAssignmentId` = ?",
      );
      expect(predicate.sql).not.toContain("`conversations`.`userId`");
    }
    expect(predicates[0]?.params).toEqual([
      "pproject-a:conversation-1",
      "project-b",
    ]);
    expect(predicates[1]?.params).toEqual([
      "pproject-a:conversation-1",
      "project-a",
    ]);
  });
});

describe("conversation credential binding", () => {
  it("uses the customer's direct key even when a delivery admin is assigned", async () => {
    const { executor, selectedTables } = createSelectExecutor((table) => {
      if (table === users) return [{ role: "user" }];
      if (table === apiCredentials) {
        return [{ id: "credential-customer" }];
      }
      if (table === userUsageOwners) {
        return [{ deliveryAdminId: 42 }];
      }
      return [];
    });

    await expect(getActiveCredentialId(executor, 7)).resolves.toBe(
      "credential-customer",
    );
    expect(selectedTables).toEqual([users, apiCredentials]);
    expect(selectedTables).not.toContain(userUsageOwners);
  });

  it("does not inherit the assigned delivery admin key when the customer has no key", async () => {
    const { executor, selectedTables } = createSelectExecutor((table) => {
      if (table === users) return [{ role: "user" }];
      if (table === userUsageOwners) return [{ deliveryAdminId: 42 }];
      if (table === apiCredentials) return [];
      return [];
    });

    await expect(getActiveCredentialId(executor, 7)).resolves.toBeUndefined();
    expect(selectedTables).toEqual([users, apiCredentials]);
    expect(selectedTables).not.toContain(userUsageOwners);
  });

  it("keeps an old task bound to its original credential after manager reassignment", async () => {
    const snapshot: ConversationSnapshot = {
      id: "conversation-old-task",
      title: "历史任务",
      status: "completed",
      taskId: "task-before-reassignment",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const { executor, selectedTables } = createSelectExecutor((table) => {
      if (table === upstreamResources) {
        return [
          {
            userId: 7,
            kind: "task",
            upstreamId: "task-before-reassignment",
            apiCredentialId: "credential-former-manager",
          },
        ];
      }
      if (table === apiCredentials) return [{ status: "retired" }];
      if (table === userUsageOwners) {
        return [{ deliveryAdminId: 99 }];
      }
      return [];
    });

    await expect(
      resolveSnapshotCredentialId(executor, 7, snapshot, {
        existingCredentialId: "credential-former-manager",
      }),
    ).resolves.toMatchObject({
      credentialId: "credential-former-manager",
    });
    expect(selectedTables).toContain(agentTasks);
    expect(selectedTables).toContain(upstreamResources);
    expect(selectedTables).toContain(apiCredentials);
    expect(selectedTables).not.toContain(userUsageOwners);
  });
});

describe("legacy upstream resource ownership validation", () => {
  const projectTaskId = "10101010-1010-4010-8010-101010101010";
  const projectOperationId = "20202020-2020-4020-8020-202020202020";
  const projectA = "30303030-3030-4030-8030-303030303030";
  const projectB = "40404040-4040-4040-8040-404040404040";
  const projectSnapshot: ConversationSnapshot = {
    id: "project-general-chat",
    title: "工程师通用聊天",
    executionKind: "general_chat_v2",
    status: "running",
    taskId: projectTaskId,
    previousResponseId: projectTaskId,
    createdAt: 1,
    updatedAt: 2,
    messages: [],
  };

  function projectGeneralChatRows(input: {
    persistedConversationId: string;
    projectAssignmentId: string;
    includeTurn?: boolean;
  }) {
    return (table: unknown) => {
      if (table === agentTasks) {
        return [
          {
            id: projectTaskId,
            operationId: projectOperationId,
            createdAt: new Date(10),
          },
        ];
      }
      if (table === agentOperations) {
        return [
          {
            id: projectOperationId,
            scope: "managed_user",
            accountUserId: 7,
            presalesProjectId: null,
            operationType: "dashboard.general-chat",
            contractName: "dashboard.general-chat",
            contractRevision: 2,
            apiCredentialId: "credential-project-general",
          },
        ];
      }
      if (table === conversationTurns) {
        return input.includeTurn === false
          ? []
          : [
              {
                conversationId: input.persistedConversationId,
                userId: 7,
                operationType: "general_chat_v2",
                upstreamTaskId: projectTaskId,
              },
            ];
      }
      if (table === conversations) {
        return [
          {
            id: input.persistedConversationId,
            userId: 7,
            projectAssignmentId: input.projectAssignmentId,
            deletedAt: null,
          },
        ];
      }
      return [];
    };
  }

  it("accepts an exact project-bound general-chat task and previous response", async () => {
    const persistedConversationId = `p${projectA}:${projectSnapshot.id}`;
    const { executor, selectedTables } = createSelectExecutor(
      projectGeneralChatRows({
        persistedConversationId,
        projectAssignmentId: projectA,
      }),
    );

    await expect(
      loadSnapshotResourceBindings(executor, 7, projectA, projectSnapshot),
    ).resolves.toEqual(
      new Map([
        [
          JSON.stringify(["task", projectTaskId]),
          expect.objectContaining({ domain: "general_chat_v2" }),
        ],
      ]),
    );
    expect(selectedTables).toContain(conversationTurns);
    expect(selectedTables).toContain(conversations);
  });

  it("rejects reuse of a project-A general-chat task in project B", async () => {
    const persistedConversationId = `p${projectA}:${projectSnapshot.id}`;
    const { executor } = createSelectExecutor(
      projectGeneralChatRows({
        persistedConversationId,
        projectAssignmentId: projectA,
      }),
    );

    await expect(
      loadSnapshotResourceBindings(executor, 7, projectB, projectSnapshot),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an unbound general-chat task in a project snapshot", async () => {
    const persistedConversationId = `p${projectA}:${projectSnapshot.id}`;
    const { executor } = createSelectExecutor(
      projectGeneralChatRows({
        persistedConversationId,
        projectAssignmentId: projectA,
        includeTurn: false,
      }),
    );

    await expect(
      loadSnapshotResourceBindings(executor, 7, projectA, projectSnapshot),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("project-binds an untagged task after legacy dual-domain classification", async () => {
    const untaggedSnapshot: ConversationSnapshot = { ...projectSnapshot };
    delete untaggedSnapshot.executionKind;
    const persistedConversationId = `p${projectA}:${projectSnapshot.id}`;
    const { executor: exactExecutor, selectedTables } = createSelectExecutor(
      projectGeneralChatRows({
        persistedConversationId,
        projectAssignmentId: projectA,
      }),
    );

    await expect(
      loadSnapshotResourceBindings(
        exactExecutor,
        7,
        projectA,
        untaggedSnapshot,
      ),
    ).resolves.toEqual(
      new Map([
        [
          JSON.stringify(["task", projectTaskId]),
          expect.objectContaining({ domain: "general_chat_v2" }),
        ],
      ]),
    );
    expect(selectedTables).toContain(upstreamResources);

    const { executor: crossProjectExecutor } = createSelectExecutor(
      projectGeneralChatRows({
        persistedConversationId,
        projectAssignmentId: projectA,
      }),
    );
    await expect(
      loadSnapshotResourceBindings(
        crossProjectExecutor,
        7,
        projectB,
        untaggedSnapshot,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates explicit general-chat task and asset references without reading the legacy ledger", async () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const operationId = "22222222-2222-4222-8222-222222222222";
    const assetId = "33333333-3333-4333-8333-333333333333";
    const snapshot: ConversationSnapshot = {
      id: "conversation-general-v2",
      title: "通用聊天",
      executionKind: "general_chat_v2",
      status: "running",
      taskId,
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          ...message("user-general", "user", 1),
          attachments: [
            { id: "image", type: "image", name: "input.png", fileId: assetId },
          ],
        },
      ],
    };
    const { executor, selectedTables } = createSelectExecutor((table) => {
      if (table === agentTasks) {
        return [{ id: taskId, operationId, createdAt: new Date(10) }];
      }
      if (table === agentOperations) {
        return [
          {
            id: operationId,
            scope: "managed_user",
            accountUserId: 7,
            presalesProjectId: null,
            operationType: "dashboard.general-chat",
            contractName: "dashboard.general-chat",
            contractRevision: 2,
            apiCredentialId: "credential-general",
          },
        ];
      }
      if (table === localAssets) {
        return [
          {
            id: assetId,
            scope: "managed_user",
            accountUserId: 7,
            presalesProjectId: null,
            createdAt: new Date(5),
          },
        ];
      }
      if (table === upstreamResources) {
        throw new Error("general-chat references must not touch legacy ledger");
      }
      return [];
    });

    await expect(
      loadSnapshotResourceBindings(executor, 7, null, snapshot),
    ).resolves.toEqual(
      new Map([
        [
          JSON.stringify(["task", taskId]),
          expect.objectContaining({
            domain: "general_chat_v2",
            apiCredentialId: "credential-general",
          }),
        ],
        [
          JSON.stringify(["file", assetId]),
          expect.objectContaining({ domain: "general_chat_v2" }),
        ],
      ]),
    );
    expect(selectedTables).not.toContain(upstreamResources);
  });

  it("rejects a general-chat task owned by another managed account", async () => {
    const taskId = "44444444-4444-4444-8444-444444444444";
    const operationId = "55555555-5555-4555-8555-555555555555";
    const snapshot: ConversationSnapshot = {
      id: "conversation-foreign-general-v2",
      title: "通用聊天",
      executionKind: "general_chat_v2",
      status: "running",
      taskId,
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const { executor } = createSelectExecutor((table) => {
      if (table === agentTasks) {
        return [{ id: taskId, operationId, createdAt: new Date(10) }];
      }
      if (table === agentOperations) {
        return [
          {
            id: operationId,
            scope: "managed_user",
            accountUserId: 8,
            presalesProjectId: null,
            operationType: "dashboard.general-chat",
            contractName: "dashboard.general-chat",
            contractRevision: 2,
            apiCredentialId: "credential-foreign",
          },
        ];
      }
      return [];
    });

    await expect(
      loadSnapshotResourceBindings(executor, 7, null, snapshot),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an expired local asset in the explicit general-chat domain", async () => {
    const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const snapshot: ConversationSnapshot = {
      id: "conversation-expired-general-asset",
      title: "通用聊天",
      executionKind: "general_chat_v2",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          ...message("user-expired-asset", "user", 1),
          attachments: [
            { id: "image", type: "image", name: "old.png", fileId: assetId },
          ],
        },
      ],
    };
    const { executor } = createSelectExecutor((table) => {
      if (table === localAssets) {
        return [
          {
            id: assetId,
            scope: "managed_user",
            accountUserId: 7,
            presalesProjectId: null,
            retainUntil: new Date(0),
            createdAt: new Date(0),
          },
        ];
      }
      return [];
    });

    await expect(
      loadSnapshotResourceBindings(executor, 7, null, snapshot),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts an untagged reference only when exactly one identity domain owns it", async () => {
    const taskId = "66666666-6666-4666-8666-666666666666";
    const operationId = "77777777-7777-4777-8777-777777777777";
    const snapshot: ConversationSnapshot = {
      id: "conversation-ambiguous",
      title: "旧客户端",
      status: "running",
      taskId,
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const { executor } = createSelectExecutor((table) => {
      if (table === agentTasks) {
        return [{ id: taskId, operationId, createdAt: new Date(10) }];
      }
      if (table === agentOperations) {
        return [
          {
            id: operationId,
            scope: "managed_user",
            accountUserId: 7,
            presalesProjectId: null,
            operationType: "dashboard.general-chat",
            contractName: "dashboard.general-chat",
            contractRevision: 2,
            apiCredentialId: "credential-general",
          },
        ];
      }
      if (table === upstreamResources) {
        return [
          {
            userId: 7,
            projectAssignmentId: null,
            kind: "task",
            upstreamId: taskId,
            apiCredentialId: "credential-legacy",
            createdAt: new Date(9),
          },
        ];
      }
      return [];
    });

    await expect(
      loadSnapshotResourceBindings(executor, 7, null, snapshot),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("ignores a foreign collision when an untagged reference has exactly one owned domain", async () => {
    const taskId = "88888888-8888-4888-8888-888888888888";
    const operationId = "99999999-9999-4999-8999-999999999999";
    const snapshot: ConversationSnapshot = {
      id: "conversation-owned-legacy-collision",
      title: "旧客户端",
      status: "running",
      taskId,
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    };
    const { executor } = createSelectExecutor((table) => {
      if (table === agentTasks) {
        return [{ id: taskId, operationId, createdAt: new Date(10) }];
      }
      if (table === agentOperations) {
        return [
          {
            id: operationId,
            scope: "managed_user",
            accountUserId: 8,
            presalesProjectId: null,
            operationType: "dashboard.general-chat",
            contractName: "dashboard.general-chat",
            contractRevision: 2,
            apiCredentialId: "credential-foreign-general",
          },
        ];
      }
      if (table === upstreamResources) {
        return [
          {
            userId: 7,
            projectAssignmentId: null,
            kind: "task",
            upstreamId: taskId,
            apiCredentialId: "credential-owned-legacy",
            createdAt: new Date(9),
          },
        ];
      }
      return [];
    });

    await expect(
      loadSnapshotResourceBindings(executor, 7, null, snapshot),
    ).resolves.toEqual(
      new Map([
        [
          JSON.stringify(["task", taskId]),
          expect.objectContaining({
            domain: "legacy_upstream",
            apiCredentialId: "credential-owned-legacy",
          }),
        ],
      ]),
    );
  });

  it("deduplicates task and file IDs before upstream validation", () => {
    const snapshot: ConversationSnapshot = {
      id: "conversation-1",
      title: "Legacy",
      status: "completed",
      taskId: "task-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          ...message("user-1", "user", 1),
          attachments: [
            { id: "a", type: "file", name: "a.txt", fileId: "file-1" },
            { id: "b", type: "file", name: "b.txt", fileId: "file-1" },
          ],
        },
      ],
    };

    expect(collectSnapshotResourceRefs([snapshot])).toEqual([
      { kind: "task", id: "task-1" },
      { kind: "file", id: "file-1" },
    ]);
  });

  it("caps the number of legacy resources validated in one request", () => {
    const snapshot: ConversationSnapshot = {
      id: "conversation-many-files",
      title: "Legacy",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          ...message("user-many", "user", 1),
          attachments: Array.from({ length: 201 }, (_, index) => ({
            id: `attachment-${index}`,
            type: "file" as const,
            name: `${index}.txt`,
            fileId: `file-${index}`,
          })),
        },
      ],
    };

    expect(() => collectSnapshotResourceRefs([snapshot])).toThrow(
      "单次最多迁移 200 个历史任务或文件",
    );
  });

  it("rejects every Provider-backed legacy import without a network probe", () => {
    expect(() =>
      assertLocalImportHasNoProviderResources([
        { kind: "task", id: "task-v1" },
        { kind: "file", id: "file-v1" },
      ]),
    ).toThrow("旧任务或文件会话不再导入");
    expect(() => assertLocalImportHasNoProviderResources([])).not.toThrow();
  });
});
