import { describe, expect, it } from "vitest";

import { buildKnowledgeBasePrompt } from "./knowledge-base-prompt-contract";
import { buildKnowledgeBaseTurnPrompt } from "./knowledge-base-turn-prompt";
import { KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_SENTENCE } from "./knowledge-base-materialized-completion-contract";

const expectation = {
  operationId: "operation-initial",
  buildId: "11111111-1111-4111-8111-111111111111",
  generation: 3,
  contentVersion: 1,
  skillContentHash: "a".repeat(64),
  treePolicyVersion: 2,
  companyName: "示例企业",
  companyWebsite: "https://example.test/",
  expectedUploadsRead: 1,
} as const;

describe("materialized knowledge-base prompt contract", () => {
  it("delivers every frozen coordinate and the logical Skill hash to the initial task", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: expectation.companyName,
      companyWebsite: expectation.companyWebsite,
      researchWebsites: [
        expectation.companyWebsite,
        "http://www.example.test/research?q=1",
      ],
      operatorNotes: "",
      attachments: [{ file_id: "file-1", filename: "facts.pdf" }],
      protocolOperation: {
        skillVersion: "5",
        operationId: expectation.operationId,
        turnId: "turn-initial",
      },
      initialBundleExpectation: expectation,
      treePolicyVersion: 2,
    });

    expect(prompt).toContain(
      `skillContentHash=${expectation.skillContentHash}`,
    );
    expect(prompt).toContain("必须逐字复制上述 skillContentHash");
    expect(prompt).toContain("不是 Skill ZIP 的物理 SHA-256");
    expect(prompt).toContain(
      `--expected-operation-id ${expectation.operationId}`,
    );
    expect(prompt).toContain(`--expected-build-id ${expectation.buildId}`);
    expect(prompt).toContain("--expected-generation 3");
    expect(prompt).toContain("--expected-content-version 1");
    expect(prompt).toContain(
      `--expected-skill-content-hash ${expectation.skillContentHash}`,
    );
    expect(prompt).toContain("--expected-tree-policy-version 2");
    expect(prompt).toContain("--expected-uploads-read 1");
    expect(prompt).toContain("expectedUploadsRead=1");
    expect(prompt).toContain(
      `--expected-company-base64url ${Buffer.from(
        JSON.stringify({
          name: expectation.companyName,
          website: expectation.companyWebsite,
        }),
        "utf8",
      ).toString("base64url")}`,
    );
    expect(prompt).toContain("company.name=示例企业");
    expect(prompt).toContain("company.website=https://example.test/");
    expect(prompt).toContain(
      'researchWebsites=["https://example.test/","http://www.example.test/research?q=1"]',
    );
    expect(prompt).toContain(KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_SENTENCE);
    expect(prompt).toContain("必须立即结束当前任务");
    expect(prompt).toContain("不得再调用工具");
  });

  it("fails before dispatch when the frozen hash or identity drifts", async () => {
    const input = {
      companyName: expectation.companyName,
      companyWebsite: expectation.companyWebsite,
      operatorNotes: "",
      attachments: [],
      protocolOperation: {
        skillVersion: "5",
        operationId: expectation.operationId,
        turnId: "turn-initial",
      },
      treePolicyVersion: 2,
    } as const;

    await expect(
      buildKnowledgeBasePrompt({
        ...input,
        initialBundleExpectation: {
          ...expectation,
          expectedUploadsRead: 0,
          skillContentHash: "invalid",
        },
      }),
    ).rejects.toThrow("冻结合同坐标不一致");
    await expect(
      buildKnowledgeBasePrompt({
        ...input,
        initialBundleExpectation: {
          ...expectation,
          expectedUploadsRead: 0,
          companyWebsite: null,
        },
      }),
    ).rejects.toThrow("冻结合同坐标不一致");
  });

  it("binds a leaf revision validator to every frozen base coordinate", async () => {
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 1,
      conversationId: "conversation-revision",
      userMessage: "补充这一节点的交付流程",
      attachments: [],
      skillVersion: "5",
      protocolOperation: {
        operationId: "operation-revision",
        turnId: "turn-revision",
      },
      materializedBase: {
        buildId: expectation.buildId,
        generation: 3,
        contentVersion: 7,
        packageSha256: "b".repeat(64),
        filename: "frontmind-kb-working-set.zip",
      },
      progressOverride: {
        build: { revision: 7, currentLeafId: "1.1" },
        branches: [
          {
            leaves: [
              {
                id: "1.1",
                title: "交付流程",
                branchTitle: "能力与交付",
                status: "current",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain("--expected-operation-id operation-revision");
    expect(prompt).toContain(`--expected-build-id ${expectation.buildId}`);
    expect(prompt).toContain("--expected-generation 3");
    expect(prompt).toContain("--expected-base-content-version 7");
    expect(prompt).toContain(
      `--expected-base-working-set-sha256 ${"b".repeat(64)}`,
    );
    expect(prompt).toContain("--expected-target-leaf-id 1.1");
    expect(prompt).toContain(KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_SENTENCE);
    expect(prompt).toContain("必须立即结束当前任务");
  });
});
