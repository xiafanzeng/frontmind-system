import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { createHash } from "node:crypto";
import {
  apiCredentials,
  attachments,
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  messages,
  upstreamResources,
  userUsageOwners,
  users,
} from "../drizzle/schema";
import {
  buildMessageMetadata,
  collectSnapshotResourceRefs,
  conversationSyncMysqlErrorCode,
  conversationSnapshotSchema,
  discardClientClaimedServerOwnedKnowledgeBaseMessages,
  getActiveCredentialId,
  listSnapshots,
  loadPersistedMessages,
  matchesAuthoritativeKnowledgeBaseMessageTuple,
  mergeConversationMessages,
  mergeConversationTaskPointers,
  permanentlyDeleteConversation,
  reconstructKnowledgeBaseUserMessageAttachments,
  reconstructKnowledgeBasePresentationInlineImages,
  repairSnapshotMessageIds,
  retryConversationSyncTransaction,
  resolveSnapshotCredentialId,
  sanitizeKnowledgeBaseDeletionTombstones,
  validateUpstreamResourceAccess,
  type ConversationSnapshot,
} from "./conversation-router";

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

function createSelectExecutor(rowsForTable: (table: unknown) => unknown[]) {
  const selectedTables: unknown[] = [];
  const select = vi.fn(() => ({
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
  }));
  return { executor: { select }, selectedTables };
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
        alt: "customer-proof.jpg",
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
        alt: "earlier-proof.png",
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
        src: "/api/knowledge-base/artifacts/build-1/logo",
        alt: "official-logo.png",
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
        src: "/api/knowledge-base/artifacts/build-1/logo",
        alt: "official-logo.png",
      },
    ]);
  });

  it("hydrates only the authoritative initial-node logo in history and list snapshots", async () => {
    const content = "## 1.1 一句话定位\n\n初始正文";
    const contentSha256 = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const presentationKey = createHash("sha256")
      .update(["build-1", 1, 0, "1.1", contentSha256].join(":"))
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
          generation: 1,
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
      buildGeneration: 1,
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

    const { executor: historyExecutor } = createSelectExecutor(rowsForTable);
    const history = await loadPersistedMessages(
      historyExecutor,
      7,
      "u7:conversation-1",
      null,
    );
    expect(history[0]?.inlineImages).toEqual([
      {
        src: "/api/knowledge-base/artifacts/build-1/logo",
        alt: "official-logo.png",
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
        src: "/api/knowledge-base/artifacts/build-1/logo",
        alt: "official-logo.png",
      },
    ]);
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
        publicMessageId: `msg-kb-presentation-${presentationKey}`,
        knowledgeBase: authoritativeKnowledgeBase,
        turn,
        build,
        publicConversationId: "conversation-1",
      }),
    ).toBe(true);
    expect(
      matchesAuthoritativeKnowledgeBaseMessageTuple({
        message: { ...authoritativeMessage, content: "伪造覆盖正文" },
        publicMessageId: `msg-kb-presentation-${presentationKey}`,
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

  it("falls back to the assigned delivery admin only when the customer has no key", async () => {
    let credentialQueryCount = 0;
    const { executor, selectedTables } = createSelectExecutor((table) => {
      if (table === users) return [{ role: "user" }];
      if (table === userUsageOwners) return [{ deliveryAdminId: 42 }];
      if (table === apiCredentials) {
        credentialQueryCount += 1;
        return credentialQueryCount === 1
          ? []
          : [{ id: "credential-delivery-admin" }];
      }
      return [];
    });

    await expect(getActiveCredentialId(executor, 7)).resolves.toBe(
      "credential-delivery-admin",
    );
    expect(selectedTables).toEqual([
      users,
      apiCredentials,
      userUsageOwners,
      apiCredentials,
    ]);
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
    expect(selectedTables).toEqual([upstreamResources, apiCredentials]);
    expect(selectedTables).not.toContain(userUsageOwners);
  });
});

describe("legacy upstream resource ownership validation", () => {
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

  it("uses the selected credential against the exact encoded resource URL", async () => {
    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    await validateUpstreamResourceAccess(
      "sk-owner",
      "file",
      "file/with spaces",
      async (input, init) => {
        requestedUrl = String(input);
        requestedHeaders = init?.headers;
        return new Response(null, { status: 200 });
      },
    );

    expect(requestedUrl).toContain("/v1/files/file%2Fwith%20spaces");
    expect(requestedHeaders).toMatchObject({
      API_KEY: "sk-owner",
      Authorization: "Bearer sk-owner",
    });
  });

  it.each([401, 403, 404])(
    "rejects an unprovable resource when upstream returns %s",
    async (status) => {
      await expect(
        validateUpstreamResourceAccess(
          "sk-wrong",
          "task",
          "task-victim",
          async () => new Response(null, { status }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("does not bind resources when upstream validation is unavailable", async () => {
    await expect(
      validateUpstreamResourceAccess("sk-owner", "task", "task-1", async () => {
        throw new Error("timeout");
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
