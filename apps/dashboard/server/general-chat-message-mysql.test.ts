import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentEvents,
  agentOperations,
  agentTasks,
  apiCredentials,
  conversations,
  conversationTurns,
  messages,
  users,
} from "../drizzle/schema";
import {
  listSnapshots,
  loadPersistedMessages,
  loadSnapshotMessageRetention,
  persistSnapshot,
  runConversationWriteTransaction,
  type ConversationSnapshot,
} from "./conversation-router";
import {
  cachedOutput,
  persistAssistantProjection,
} from "./frontmind-v2-chat-router";

const databaseUrl = process.env.FRONTMIND_GENERAL_CHAT_TEST_MYSQL_URL;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

(databaseUrl ? describe : describe.skip)(
  "general-chat projection ownership on isolated MySQL",
  () => {
    let pool: Pool;
    let db: ReturnType<typeof drizzle>;
    const credentialId = randomUUID();
    let userId: number;
    const publicMessageId = (id: string) => id.slice(`u${userId}:`.length);
    const transaction = <T>(run: (tx: any) => Promise<T>) =>
      runConversationWriteTransaction(db, run);

    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (
        url.protocol !== "mysql:" ||
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        !/^\/[a-zA-Z0-9_]*acceptance[a-zA-Z0-9_]*$/.test(url.pathname)
      )
        throw new Error("Local disposable acceptance database required");
      pool = mysql.createPool({
        uri: databaseUrl,
        connectionLimit: 4,
        timezone: "Z",
      });
      db = drizzle(pool);
      const [createdUser] = await db
        .insert(users)
        .values({
          username: `general-acceptance-${randomUUID()}`,
          displayName: "General chat acceptance",
        })
        .$returningId();
      userId = createdUser.id;
      const existing = await db
        .select({ version: apiCredentials.version })
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, userId));
      await db.insert(apiCredentials).values({
        id: credentialId,
        userId,
        version: Math.max(0, ...existing.map((row) => row.version)) + 1,
        encryptedKey: "acceptance-only",
        encryptionIv: "0".repeat(32),
        encryptionAuthTag: "0".repeat(32),
        fingerprint: "0".repeat(32),
        provider: "zhipu",
        upstreamModel: "glm-5.3",
        upstreamEffort: "high",
      });
    });
    afterAll(async () => {
      await pool?.end();
    });

    async function fixture(withPdf = true) {
      const id = `general-${randomUUID()}`;
      const storedId = `u${userId}:${id}`;
      const taskId = randomUUID();
      const operationId = randomUUID();
      const turnId = randomUUID();
      const pdfTurnId = randomUUID();
      const firstUserId = `question-${randomUUID()}`;
      const pdfUserId = `pdf-${randomUUID()}`;
      const eventId = `welcome-${randomUUID()}`;
      const eventRowId = randomUUID();
      const sentAt = new Date("2026-09-10T09:17:20Z");
      const user = (messageId: string, text: string, timestamp: number) => ({
        id: messageId,
        role: "user" as const,
        content: text,
        timestamp,
      });
      const firstUser = user(
        firstUserId,
        "你是什么模型",
        sentAt.getTime() - 30_000,
      );
      const pdfUser = user(
        pdfUserId,
        "这个文件讲了什么",
        sentAt.getTime() + 300_000,
      );
      await db.insert(agentOperations).values({
        id: operationId,
        provider: "zhipu",
        scope: "managed_user",
        accountUserId: userId,
        operationType: "dashboard.general-chat",
        contractName: "dashboard.general-chat",
        contractRevision: 2,
        idempotencyKeyHash: hash(operationId),
        requestHash: hash(taskId),
        schemaHash: hash("test"),
        apiCredentialId: credentialId,
        credentialVersion: 1,
        publicProfile: "frontmind-base",
        upstreamModel: "glm-5.3",
        status: "running",
      });
      await db.insert(agentTasks).values({
        id: taskId,
        operationId,
        createMarker: randomUUID(),
        title: "acceptance",
        providerState: "running",
        providerTaskId: randomUUID(),
      });
      await db.insert(conversations).values({
        id: storedId,
        userId,
        apiCredentialId: credentialId,
        title: "ordinary chat",
        status: "running",
        upstreamTaskId: taskId,
        previousResponseId: taskId,
      });
      await db.insert(conversationTurns).values({
        id: turnId,
        conversationId: storedId,
        userId,
        apiCredentialId: credentialId,
        clientRequestId: firstUserId,
        operationType: "general_chat_v2",
        upstreamTaskId: taskId,
        metadata: { agentTaskId: taskId, userMessageId: firstUserId },
        status: "completed",
      });
      await db.insert(messages).values({
        id: `u${userId}:${firstUserId}`,
        conversationId: storedId,
        turnId,
        userId,
        role: "user",
        content: firstUser.content,
        sequence: 0,
        sentAt: new Date(firstUser.timestamp),
      });
      await db.insert(agentEvents).values({
        id: eventRowId,
        taskId,
        providerEventId: eventId,
        eventType: "assistant_message",
        providerTimestampMs: sentAt.getTime(),
        normalizedPayload: {
          kind: "provider_event",
          type: "assistant_message",
          providerOriginalRank: 1,
        },
      });
      const [operation] = await db
        .select()
        .from(agentOperations)
        .where(eq(agentOperations.id, operationId));
      const [task] = await db
        .select()
        .from(agentTasks)
        .where(eq(agentTasks.id, taskId));
      const projection = {
        operation,
        task,
        event: {
          id: eventId,
          type: "assistant_message" as const,
          timestamp: sentAt.getTime(),
          providerOriginalRank: 1,
        },
        turn: {
          id: turnId,
          conversationId: storedId,
          messageSequence: 0,
          attachmentFileIds: [],
          metadata: { userMessageId: firstUserId },
        },
        upstreamOutputId: eventRowId,
        text: "我是 FrontMind 通用智能体，可以帮助你处理问题和完成任务。",
        localized: [],
      };
      await transaction((executor) =>
        persistAssistantProjection({ ...projection, executor }),
      );
      const [welcome] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, storedId),
            eq(messages.role, "assistant"),
          ),
        );
      if (withPdf) {
        await db.insert(conversationTurns).values({
          id: pdfTurnId,
          conversationId: storedId,
          userId,
          apiCredentialId: credentialId,
          clientRequestId: pdfUserId,
          operationType: "general_chat_v2",
          upstreamTaskId: taskId,
          metadata: { agentTaskId: taskId, userMessageId: pdfUserId },
          status: "running",
        });
        await db.insert(messages).values({
          id: `u${userId}:${pdfUserId}`,
          conversationId: storedId,
          turnId: pdfTurnId,
          userId,
          role: "user",
          content: pdfUser.content,
          sequence: 7,
          sentAt: new Date(pdfUser.timestamp),
        });
      }
      const snapshot: ConversationSnapshot = {
        id,
        title: "ordinary chat",
        status: "running",
        executionKind: "general_chat_v2",
        taskId,
        previousResponseId: taskId,
        messages: [firstUser, pdfUser],
        createdAt: firstUser.timestamp,
        updatedAt: pdfUser.timestamp,
      };
      return {
        id,
        storedId,
        welcome,
        projection,
        snapshot,
        firstUserId,
        pdfUserId,
        pdfTurnId,
      };
    }

    it("keeps a hidden welcome row through snapshot sync and restores the same identity and slot", async () => {
      const f = await fixture();
      expect(f.welcome.sequence).toBe(1);
      await db
        .update(messages)
        .set({ deletedAt: new Date() })
        .where(eq(messages.id, f.welcome.id));
      await transaction((tx) =>
        persistSnapshot(tx, userId, {
          ...f.snapshot,
          deletedMessageIds: [publicMessageId(f.welcome.id)],
          messages: [
            ...f.snapshot.messages,
            {
              id: publicMessageId(f.welcome.id),
              role: "assistant",
              content: "stale browser echo",
              timestamp: f.welcome.sentAt.getTime(),
              generalChat: f.welcome.metadata!.generalChat as NonNullable<
                ConversationSnapshot["messages"][number]["generalChat"]
              >,
            },
          ],
        }),
      );
      const [hidden] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, f.welcome.id));
      expect(hidden).toMatchObject({
        id: f.welcome.id,
        sequence: 1,
        turnId: f.projection.turn.id,
      });
      expect(hidden.deletedAt).not.toBeNull();
      expect(hidden.content).toBe(f.welcome.content);
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, f.storedId));
      expect(conversation.deletedMessageIds).not.toContain(
        publicMessageId(f.welcome.id),
      );
      await transaction((executor) =>
        persistAssistantProjection({ ...f.projection, executor }),
      );
      const [restored] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, f.welcome.id));
      expect(restored).toMatchObject({
        id: f.welcome.id,
        sequence: 1,
        deletedAt: null,
        createdAt: f.welcome.createdAt,
      });
      const rows = await loadPersistedMessages(db, userId, f.storedId, null);
      expect(rows.map((row) => row.id)).toEqual([
        f.firstUserId,
        publicMessageId(f.welcome.id),
        f.pdfUserId,
      ]);
      expect(rows[1].generalChat).toMatchObject({
        userMessageId: f.firstUserId,
        userSequence: 0,
        rank: 1,
      });
    });

    it("allocates above hidden sequence slots under the real unique index", async () => {
      const f = await fixture(false);
      await db
        .update(messages)
        .set({ sequence: 8, deletedAt: new Date() })
        .where(eq(messages.id, f.welcome.id));
      await transaction(async (tx) => {
        await tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, f.storedId))
          .for("update");
        const retained = await loadSnapshotMessageRetention(
          tx,
          userId,
          f.storedId,
          null,
        );
        expect(retained.preservedServerOwnedMessageIds).toContain(f.welcome.id);
        expect(
          retained.persistedSequenceByPublicMessageId.get(
            publicMessageId(f.welcome.id),
          ),
        ).toBe(8);
        await persistSnapshot(tx, userId, f.snapshot);
      });
      const [pdf] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, `u${userId}:${f.pdfUserId}`));
      expect(pdf.sequence).toBe(9);
      const [hidden] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, f.welcome.id));
      expect(hidden.sequence).toBe(8);
      expect(hidden.deletedAt).not.toBeNull();
    });

    it("repairs existing late historical rows on both read paths without changing database sequences", async () => {
      const f = await fixture();
      const oldMetadata = { ...f.welcome.metadata };
      const {
        userMessageId: _user,
        userSequence: _sequence,
        rank: _rank,
        ...identity
      } = oldMetadata.generalChat as Record<string, unknown>;
      oldMetadata.generalChat = identity;
      await db
        .update(messages)
        .set({ sequence: 8, metadata: oldMetadata })
        .where(eq(messages.id, f.welcome.id));
      const loaded = await loadPersistedMessages(db, userId, f.storedId, null);
      const listed = (await listSnapshots(userId, null, db)).find(
        (row) => row.id === f.id,
      )!;
      for (const rows of [loaded, listed.messages]) {
        expect(rows.map((row) => row.id)).toEqual([
          f.firstUserId,
          publicMessageId(f.welcome.id),
          f.pdfUserId,
        ]);
        expect(rows[1]).toMatchObject({
          serverSequence: 8,
          generalChat: {
            userMessageId: f.firstUserId,
            userSequence: 0,
            rank: 1,
          },
        });
      }
      const [stored] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, f.welcome.id));
      expect(stored.sequence).toBe(8);
      expect(stored.metadata).toEqual(oldMetadata);
    });

    it.each([false, true])("orders cumulative polling output and retains unbound legacy rows (missing user link: %s)", async (missingUserLink) => {
      const f = await fixture();
      const event = {
        id: `pdf-answer-${randomUUID()}`,
        type: "assistant_message" as const,
        timestamp: f.snapshot.updatedAt + 1000,
        providerOriginalRank: 4,
      };
      const eventRowId = randomUUID();
      await db.insert(agentEvents).values({
        id: eventRowId,
        taskId: f.projection.task.id,
        providerEventId: event.id,
        eventType: event.type,
        providerTimestampMs: event.timestamp,
        normalizedPayload: {
          kind: "provider_event",
          type: event.type,
          providerOriginalRank: 4,
        },
      });
      await transaction((executor) =>
        persistAssistantProjection({
          ...f.projection,
          executor,
          event,
          upstreamOutputId: eventRowId,
          text: "PDF 摘要",
          turn: {
            ...f.projection.turn,
            id: f.pdfTurnId,
            messageSequence: 7,
            metadata: { userMessageId: f.pdfUserId },
          },
        }),
      );
      await db
        .update(messages)
        .set({ sequence: 9 })
        .where(eq(messages.id, f.welcome.id));
      if (missingUserLink)
        await db.update(messages).set({ turnId: null }).where(and(
          eq(messages.conversationId, f.storedId),
          eq(messages.role, "user"),
        ));
      const output = await cachedOutput(f.projection.task.id, db);
      if (missingUserLink) {
        expect(output.map((row) => row.general_chat.turnId)).toEqual([
          f.pdfTurnId, f.projection.turn.id,
        ]);
        expect(output.map((row) => row.server_sequence)).toEqual([8, 9]);
        expect(output.every((row) => row.general_chat.userSequence === undefined)).toBe(true);
        return;
      }
      expect(output.map((row) => row.general_chat.turnId)).toEqual([
        f.projection.turn.id,
        f.pdfTurnId,
      ]);
      expect(output.map((row) => row.server_sequence)).toEqual([9, 8]);
      expect(output.map((row) => row.general_chat.userSequence)).toEqual([
        0, 7,
      ]);
      expect(output.map((row) => row.general_chat.rank)).toEqual([1, 4]);
      expect(output[1].content).toEqual([
        { type: "output_text", text: "PDF 摘要" },
      ]);
    });
  },
);
