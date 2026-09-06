import { afterEach, describe, expect, it, vi } from "vitest";

import {
  brandQuestionTaskContextErrorResponse,
  createBrandQuestionFileIdempotencyKey,
  createBrandQuestionTaskIdempotencyKey,
  createBrandQuestionUpstreamTask,
  publicBrandQuestionTask,
} from "./brand-question-portfolio-api";
import { BrandQuestionTaskContextError } from "./brand-question-task-context";

const transport = vi.hoisted(() => ({ createTask: vi.fn() }));
vi.mock("./credential-agent-client", () => ({
  createCredentialAgentClient: () => transport,
}));
const credential = {
  id: "credential-42",
  userId: 42,
  version: 1,
  provider: "zhipu" as const,
  apiKey: "synthetic-test-key",
  upstreamModel: "glm-5.3",
  upstreamEffort: "high" as const,
};

describe("brand question public task boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a strict task identity without upstream auth or metadata", () => {
    const credential = "sentinel-brand-question-credential";
    const task = publicBrandQuestionTask(
      {
        id: "task-brand-1",
        status: "created",
        API_KEY: credential,
        Authorization: `Bearer ${credential}`,
        metadata: {
          Cookie: credential,
          accessToken: "another-token",
        },
        output: [{ text: credential }],
      },
      "task-brand-1",
      credential,
    );
    const serialized = JSON.stringify(task);

    expect(task).toEqual({ id: "task-brand-1", status: "running" });
    expect(serialized).not.toContain(credential);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("api_key");
    expect(serialized).not.toContain("output");
    expect(serialized).not.toContain("metadata");
  });

  it("maps a quota-context change to an explicit stale conflict", () => {
    expect(
      brandQuestionTaskContextErrorResponse(
        new BrandQuestionTaskContextError(
          "BRAND_QUESTION_TASK_STALE",
          "问题额度或可选问题数量已变化，请重新生成品牌全域候选词",
        ),
      ),
    ).toEqual({
      status: 409,
      body: {
        error: {
          code: "BRAND_QUESTION_TASK_STALE",
          message: "问题额度或可选问题数量已变化，请重新生成品牌全域候选词",
        },
      },
    });
  });

  it("uses stable opaque keys for generated files and the upstream task", async () => {
    const taskIdempotencyKey = createBrandQuestionTaskIdempotencyKey({
      userId: 42,
      prompt: "bounded prompt",
      skillContentHash: "a".repeat(64),
      evidenceContentHash: "b".repeat(64),
    });
    expect(taskIdempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createBrandQuestionTaskIdempotencyKey({
        userId: 42,
        prompt: "bounded prompt",
        skillContentHash: "a".repeat(64),
        evidenceContentHash: "b".repeat(64),
      }),
    ).toBe(taskIdempotencyKey);
    expect(
      createBrandQuestionFileIdempotencyKey({
        taskIdempotencyKey,
        role: "evidence",
        contentHash: "b".repeat(64),
      }),
    ).toMatch(/^[a-f0-9]{64}$/);

    const post = transport.createTask.mockResolvedValue({
      taskId: "task-brand-idempotent",
      requestId: "request-brand-idempotent",
    });
    await createBrandQuestionUpstreamTask({
      credential,
      baseUrl: "https://agent-api.bigmodel.cn/api/agent/managed",
      apiKey: "secret-test-key",
      prompt: "bounded prompt",
      attachments: [],
      idempotencyKey: taskIdempotencyKey,
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("bounded prompt"),
        attachments: [],
        structuredOutputSchema: expect.objectContaining({
          required: ["payload"],
        }),
      }),
    );

    post.mockClear();
    await expect(
      createBrandQuestionUpstreamTask({
        credential,
        baseUrl: "https://agent-api.bigmodel.cn/api/agent/managed",
        apiKey: "secret-test-key",
        prompt: "界".repeat(3_001),
        attachments: [],
        idempotencyKey: taskIdempotencyKey,
      }),
    ).rejects.toThrow("UPSTREAM_PROMPT_EXCEEDS_3000_CHARACTERS");
    expect(post).not.toHaveBeenCalled();
  });
});
