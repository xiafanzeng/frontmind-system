import { describe, expect, it } from "vitest";

import {
  knowledgeArtifactReceiptMatchesRequest,
  knowledgeImportReceiptSourceReference,
  resolveKnowledgeImportProjectOwner,
  websiteKnowledgeImportSchema,
} from "./knowledge-import-service";

function request() {
  return {
    schemaVersion: 5 as const,
    companyName: "示例企业",
    candidateArtifactId: `artifact_${"a".repeat(64)}`,
    finalArtifactId: `artifact_${"b".repeat(64)}`,
    candidateSha256: "c".repeat(64),
    finalSha256: "d".repeat(64),
    packageManifestSha256: "e".repeat(64),
    finalizerVersion: "website-kb-finalizer-v1" as const,
  };
}

describe("website knowledge import v5 local-artifact contract", () => {
  it("accepts only exact local candidate/final identities and hashes", () => {
    expect(websiteKnowledgeImportSchema.parse(request())).toEqual(request());
    for (const field of [
      "candidateArtifactId",
      "finalArtifactId",
      "candidateSha256",
      "finalSha256",
      "packageManifestSha256",
      "finalizerVersion",
    ] as const) {
      const value = { ...request() } as Record<string, unknown>;
      delete value[field];
      expect(() => websiteKnowledgeImportSchema.parse(value)).toThrow();
    }
  });

  it("rejects every pre-v5 task/file contract and caller-supplied ownership", () => {
    for (const schemaVersion of [1, 2, 3, 4]) {
      expect(() =>
        websiteKnowledgeImportSchema.parse({
          ...request(),
          schemaVersion,
        }),
      ).toThrow();
    }
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...request(),
        taskId: "provider-task",
      }),
    ).toThrow();
    expect(() =>
      websiteKnowledgeImportSchema.parse({ ...request(), userId: 7 }),
    ).toThrow();
  });

  it("rejects Provider ids, malformed hashes, and a different finalizer", () => {
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...request(),
        candidateArtifactId: "provider-file-1",
      }),
    ).toThrow();
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...request(),
        finalSha256: "not-a-sha",
      }),
    ).toThrow();
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...request(),
        finalizerVersion: "website-kb-finalizer-v2",
      }),
    ).toThrow();
  });

  it("binds replay identity to project, both artifacts, all hashes, and finalizer", () => {
    const value = websiteKnowledgeImportSchema.parse(request());
    const input = { projectId: "project-1", value };
    const sourceReference = knowledgeImportReceiptSourceReference(input);
    expect(sourceReference).toMatch(
      /^website-kb:v5:website-kb-finalizer-v1:[a-f0-9]{64}$/u,
    );
    const receipt = {
      projectId: "project-1",
      taskId: value.candidateArtifactId,
      outputItemId: value.finalizerVersion,
      fileId: value.finalArtifactId,
      descriptorHash: value.candidateSha256,
      sourceReference,
    };
    expect(knowledgeArtifactReceiptMatchesRequest(receipt, input)).toBe(true);
    for (const changed of [
      { projectId: "project-2" },
      { taskId: `artifact_${"f".repeat(64)}` },
      { fileId: `artifact_${"f".repeat(64)}` },
      { descriptorHash: "f".repeat(64) },
      { sourceReference: sourceReference.replace(/.$/u, "0") },
    ]) {
      expect(
        knowledgeArtifactReceiptMatchesRequest(
          { ...receipt, ...changed },
          input,
        ),
      ).toBe(false);
    }
  });

  it("changes the bounded source reference for any content coordinate", () => {
    const first = websiteKnowledgeImportSchema.parse(request());
    const second = websiteKnowledgeImportSchema.parse({
      ...request(),
      finalSha256: "f".repeat(64),
    });
    expect(
      knowledgeImportReceiptSourceReference({
        projectId: "project-1",
        value: first,
      }),
    ).not.toBe(
      knowledgeImportReceiptSourceReference({
        projectId: "project-1",
        value: second,
      }),
    );
  });
});

describe("knowledge import project ownership", () => {
  it("allows repeated purchases only for one account and enterprise", () => {
    expect(
      resolveKnowledgeImportProjectOwner(
        [
          { userId: 7, companyName: "示例企业", status: "completed" },
          { userId: 7, companyName: " 示例 企业 ", status: "completed" },
          {
            userId: null,
            companyName: "示例企业",
            status: "pending_confirmation",
          },
        ],
        "示例企业",
      ),
    ).toEqual({
      userId: 7,
      companyName: "示例企业",
      purchaseCount: 2,
    });
  });

  it("rejects missing, conflicting user, and conflicting enterprise ownership", () => {
    expect(() => resolveKnowledgeImportProjectOwner([], "示例企业")).toThrow(
      expect.objectContaining({ code: "PROJECT_NOT_PROVISIONED" }),
    );
    expect(() =>
      resolveKnowledgeImportProjectOwner(
        [
          { userId: 7, companyName: "示例企业", status: "completed" },
          { userId: 8, companyName: "示例企业", status: "completed" },
        ],
        "示例企业",
      ),
    ).toThrow(expect.objectContaining({ code: "PROJECT_OWNER_CONFLICT" }));
    expect(() =>
      resolveKnowledgeImportProjectOwner(
        [{ userId: 7, companyName: "甲企业", status: "completed" }],
        "乙企业",
      ),
    ).toThrow(
      expect.objectContaining({ code: "PROJECT_ENTERPRISE_MISMATCH" }),
    );
  });
});
