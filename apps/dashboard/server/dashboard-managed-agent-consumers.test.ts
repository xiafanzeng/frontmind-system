import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedCredential } from "./auth-service";

const mocks = vi.hoisted(() => ({
  factory: vi.fn(),
  create: vi.fn(),
  send: vi.fn(),
  download: vi.fn(),
}));
vi.mock("./credential-agent-client", () => ({
  createCredentialAgentClient: mocks.factory,
}));

import { createBrandQuestionUpstreamTask } from "./brand-question-portfolio-api";
import {
  createResponseLogicTask,
  RESPONSE_LOGIC_STRUCTURED_OUTPUT_SCHEMA,
} from "./response-logic-api";
import { knowledgeBaseUpstreamModelForCredential } from "./knowledge-base-api";
import { downloadArchiveBytes } from "./dashboard-api";

const credential: DecryptedCredential = {
  id: "frozen-key",
  userId: 41,
  version: 7,
  apiKey: "test-only-key",
  fingerprint: "test",
  status: "retired",
  verifiedAt: null,
  agentProfile: "pro",
  provider: "zhipu",
  upstreamModel: "glm-5.3",
  upstreamEffort: "max",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({
    taskId: "original-session",
    raw: { id: "original-session" },
  });
  mocks.send.mockResolvedValue({
    taskId: "original-session",
    raw: { id: "original-session" },
  });
  mocks.factory.mockReturnValue({
    createTask: mocks.create,
    sendMessage: mocks.send,
    downloadArtifact: mocks.download,
  });
});

describe("Dashboard provider migration preserves business consumers", () => {
  it("continues response logic in the original session with the frozen key, files and schema", async () => {
    const attachments = [
      { file_id: "original-skill", filename: "original-skill.zip" },
    ];
    const input = {
      credential,
      accountUserId: 42,
      apiKey: credential.apiKey,
      baseUrl: "https://api.example.test",
      prompt: "Original instructions\n保留原输入",
      attachments,
      agentProfile: "manus-1.6-max",
      idempotencyKey: "original-turn-id",
    };
    expect((await createResponseLogicTask(input)).ok).toBe(true);
    const first = mocks.create.mock.calls[0]![0];
    expect(first.attachments).toEqual(attachments);
    expect(first.structuredOutputSchema).toBe(
      RESPONSE_LOGIC_STRUCTURED_OUTPUT_SCHEMA,
    );
    expect(first.prompt).toBe(
      `${input.prompt}\n\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: input.idempotencyKey })}`,
    );
    expect(
      (
        await createResponseLogicTask({
          ...input,
          taskId: "original-session",
          idempotencyKey: "next-turn-id",
        })
      ).ok,
    ).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "original-session",
        attachments,
        structuredOutputSchema: RESPONSE_LOGIC_STRUCTURED_OUTPUT_SCHEMA,
      }),
    );
    expect(mocks.factory).toHaveBeenLastCalledWith(
      credential,
      expect.objectContaining({ accountUserId: 42, intentId: "next-turn-id" }),
    );
  });

  it("routes brand questions through the frozen provider without changing original inputs", async () => {
    const attachments = [{ file_id: "skill-file", filename: "skill.zip" }];
    await createBrandQuestionUpstreamTask({
      credential,
      accountUserId: 42,
      apiKey: credential.apiKey,
      baseUrl: "https://api.example.test",
      prompt: "原品牌问题业务指令",
      attachments,
      idempotencyKey: "brand-intent",
    });
    expect(mocks.factory).toHaveBeenCalledWith(
      credential,
      expect.objectContaining({ accountUserId: 42, intentId: "brand-intent" }),
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments,
        interactiveMode: false,
        locale: "zh-CN",
        structuredOutputSchema: expect.any(Object),
      }),
    );
    expect(mocks.create.mock.calls[0]![0].prompt).toBe(
      '原品牌问题业务指令\n\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"brand-intent"}',
    );
  });

  it("selects frozen Zhipu or historical Manus models and rejects conflicting metadata", () => {
    expect(knowledgeBaseUpstreamModelForCredential(credential)).toBe("glm-5.3");
    expect(
      knowledgeBaseUpstreamModelForCredential({
        upstreamModel: "manus-1.6-max",
      }),
    ).toBe("manus-1.6-max");
    expect(() =>
      knowledgeBaseUpstreamModelForCredential({
        provider: "zhipu",
        upstreamModel: "manus-1.6",
      }),
    ).toThrow();
    expect(() =>
      knowledgeBaseUpstreamModelForCredential({
        provider: "manus",
        upstreamModel: "glm-5.3",
      }),
    ).toThrow();
  });

  it("downloads opaque Zhipu artifacts through the owned server adapter into the existing ZIP parser", async () => {
    const bytes = Buffer.from("PK original archive bytes");
    mocks.download.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/zip" },
      data: Readable.from(bytes),
    });
    const result = await downloadArchiveBytes({
      credential,
      accountUserId: 42,
      apiKey: credential.apiKey,
      baseUrl: "https://api.example.test",
      descriptor: {
        filename: "original.zip",
        fileId: "output-1",
        url: "zhipu-file:output-1",
        outputItemId: "event-1",
      },
    });
    expect(result).toEqual({ buffer: bytes, filename: "original.zip" });
    expect(mocks.download).toHaveBeenCalledWith("output-1");
    expect(mocks.factory).toHaveBeenCalledWith(credential, {
      accountUserId: 42,
    });
    mocks.download.mockClear();
    await expect(
      downloadArchiveBytes({
        credential,
        accountUserId: 42,
        apiKey: credential.apiKey,
        baseUrl: "https://api.example.test",
        descriptor: {
          filename: "original.zip",
          fileId: "different-file",
          url: "zhipu-file:output-1",
          outputItemId: "event-1",
        },
      }),
    ).rejects.toThrow();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
