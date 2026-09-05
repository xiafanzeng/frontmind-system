import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  knowledgeArtifactReceiptMatchesRequest,
  knowledgeImportReceiptSourceReference,
  resolveKnowledgeImportProjectOwner,
  websiteKnowledgeImportSchema,
} from "./knowledge-import-service";

function knowledgeImportRequest(
  schemaVersion: 2 | 3 | 4,
): Record<string, unknown> {
  if (schemaVersion === 4) {
    return {
      schemaVersion,
      companyName: "示例企业",
      candidate: {
        taskId: "task-website-kb-1",
        outputItemId: "output-1",
        fileId: "candidate-file-1",
        descriptorHash: "a".repeat(64),
        sha256: "b".repeat(64),
      },
      finalArtifact: {
        fileId: "final-file-1",
        filename: "示例企业_knowledge_base.zip",
        sha256: "c".repeat(64),
        archiveContractVersion: 3,
        validationProfile: "website-lead-v1",
        packageManifestSha256: "d".repeat(64),
        finalizerVersion: "website-kb-finalizer-v1",
      },
    };
  }
  return {
    schemaVersion,
    companyName: "示例企业",
    taskId: "task-website-kb-1",
    outputItemId: "output-1",
    fileId: "file-1",
    descriptorHash: "a".repeat(64),
    artifactSha256: "b".repeat(64),
    filename: "示例企业_knowledge_base.zip",
    ...(schemaVersion === 3
      ? {
          archiveContractVersion: 1,
          validationProfile: "website-lead-v1",
          packageManifestSha256: "c".repeat(64),
        }
      : {}),
  };
}

describe("website knowledge import v2/v3 contract", () => {
  it("requires a project-scoped task descriptor and artifact hash", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(2));
    expect(value).not.toHaveProperty("userId");
    expect(value.schemaVersion).toBe(2);
    expect(value).not.toHaveProperty("archiveContractVersion");
    expect(value).not.toHaveProperty("validationProfile");
    expect(value).not.toHaveProperty("packageManifestSha256");
  });

  it("accepts v3 with Website archive contract v1 or v2", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(3));
    expect(value).toMatchObject({
      schemaVersion: 3,
      archiveContractVersion: 1,
      validationProfile: "website-lead-v1",
      packageManifestSha256: "c".repeat(64),
    });
    expect(
      websiteKnowledgeImportSchema.parse({
        ...knowledgeImportRequest(3),
        archiveContractVersion: 2,
      }),
    ).toMatchObject({
      schemaVersion: 3,
      archiveContractVersion: 2,
      validationProfile: "website-lead-v1",
    });
  });

  it("accepts v4 with separate candidate lineage and finalized artifact", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(4));
    expect(value).toMatchObject({
      schemaVersion: 4,
      candidate: {
        taskId: "task-website-kb-1",
        outputItemId: "output-1",
        fileId: "candidate-file-1",
        descriptorHash: "a".repeat(64),
        sha256: "b".repeat(64),
      },
      finalArtifact: {
        fileId: "final-file-1",
        sha256: "c".repeat(64),
        archiveContractVersion: 3,
        validationProfile: "website-lead-v1",
        packageManifestSha256: "d".repeat(64),
        finalizerVersion: "website-kb-finalizer-v1",
      },
    });
  });

  it("rejects v4 with an unsupported archive contract or finalizer", () => {
    const request = knowledgeImportRequest(4) as any;
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...request,
        finalArtifact: {
          ...request.finalArtifact,
          archiveContractVersion: 2,
        },
      }),
    ).toThrow();
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...request,
        finalArtifact: {
          ...request.finalArtifact,
          finalizerVersion: "unknown-finalizer",
        },
      }),
    ).toThrow();
  });

  it.each([
    "archiveContractVersion",
    "validationProfile",
    "packageManifestSha256",
  ] as const)("requires v3 field %s", (field) => {
    const request = knowledgeImportRequest(3);
    delete request[field];
    expect(() => websiteKnowledgeImportSchema.parse(request)).toThrow();
  });

  it("rejects unknown v3 archive contracts, profiles, and malformed manifest hashes", () => {
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...knowledgeImportRequest(3),
        archiveContractVersion: 9,
      }),
    ).toThrow();
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...knowledgeImportRequest(3),
        validationProfile: "historical",
      }),
    ).toThrow();
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        ...knowledgeImportRequest(3),
        packageManifestSha256: "not-a-sha256",
      }),
    ).toThrow();
  });

  it("rejects a caller-supplied user id", () => {
    expect(() =>
      websiteKnowledgeImportSchema.parse({
        schemaVersion: 2,
        companyName: "示例企业",
        taskId: "task-website-kb-1",
        outputItemId: "output-1",
        descriptorHash: "a".repeat(64),
        artifactSha256: "b".repeat(64),
        filename: "kb.zip",
        userId: 99,
      }),
    ).toThrow();
  });

  it("recognizes the same artifact descriptor when a caller rotates only the idempotency key", () => {
    const value = websiteKnowledgeImportSchema.parse({
      schemaVersion: 2,
      companyName: "示例企业",
      taskId: "task-website-kb-1",
      outputItemId: "output-1",
      fileId: "file-1",
      descriptorHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      filename: "kb.zip",
    });
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          projectId: "project-1",
          taskId: value.taskId,
          outputItemId: value.outputItemId,
          fileId: value.fileId ?? null,
          descriptorHash: value.descriptorHash.toUpperCase(),
        },
        { projectId: "project-1", value },
      ),
    ).toBe(true);
  });

  it("does not replay a hash whose task descriptor belongs to a different output", () => {
    const value = websiteKnowledgeImportSchema.parse({
      schemaVersion: 2,
      companyName: "示例企业",
      taskId: "task-website-kb-1",
      outputItemId: "output-1",
      descriptorHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      filename: "kb.zip",
    });
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          projectId: "project-1",
          taskId: value.taskId,
          outputItemId: "output-other",
          fileId: null,
          descriptorHash: value.descriptorHash,
        },
        { projectId: "project-1", value },
      ),
    ).toBe(false);
  });

  it("does not treat a legacy v2 receipt as an already-validated v3 import", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(3));
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          projectId: "project-1",
          taskId: value.taskId,
          outputItemId: value.outputItemId,
          fileId: value.fileId ?? null,
          descriptorHash: value.descriptorHash,
          sourceReference: `project-1:${value.taskId}`,
        },
        { projectId: "project-1", value },
      ),
    ).toBe(false);
  });

  it("replays a v3 receipt only when its archive contract and manifest hash match", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(3));
    const input = { projectId: "project-1", value };
    const receipt = {
      projectId: "project-1",
      taskId: value.taskId,
      outputItemId: value.outputItemId,
      fileId: value.fileId ?? null,
      descriptorHash: value.descriptorHash,
      sourceReference: knowledgeImportReceiptSourceReference(input),
    };
    expect(knowledgeArtifactReceiptMatchesRequest(receipt, input)).toBe(true);
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          ...receipt,
          sourceReference: receipt.sourceReference.replace(
            value.packageManifestSha256,
            "d".repeat(64),
          ),
        },
        input,
      ),
    ).toBe(false);
  });

  it("binds Website archive contract v2 independently from v1", () => {
    const v1 = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(3));
    const v2 = websiteKnowledgeImportSchema.parse({
      ...knowledgeImportRequest(3),
      archiveContractVersion: 2,
    });

    expect(
      knowledgeImportReceiptSourceReference({
        projectId: "project-1",
        value: v2,
      }),
    ).toBe(`website-kb:v3:2:website-lead-v1:${v2.packageManifestSha256}`);
    expect(
      knowledgeImportReceiptSourceReference({
        projectId: "project-1",
        value: v2,
      }),
    ).not.toBe(
      knowledgeImportReceiptSourceReference({
        projectId: "project-1",
        value: v1,
      }),
    );
  });

  it("binds v4 receipts to candidate, final artifact, manifest, and finalizer", () => {
    const value = websiteKnowledgeImportSchema.parse(knowledgeImportRequest(4));
    const input = { projectId: "project-1", value };
    expect(knowledgeImportReceiptSourceReference(input)).toBe(
      [
        "website-kb:v4",
        value.finalArtifact.finalizerVersion,
        createHash("sha256")
          .update(
            [
              value.candidate.sha256,
              value.finalArtifact.sha256,
              value.finalArtifact.packageManifestSha256,
            ].join(":"),
          )
          .digest("hex"),
      ].join(":"),
    );
    expect(
      knowledgeArtifactReceiptMatchesRequest(
        {
          projectId: "project-1",
          taskId: value.candidate.taskId,
          outputItemId: value.candidate.outputItemId,
          fileId: value.finalArtifact.fileId,
          descriptorHash: value.candidate.descriptorHash,
          sourceReference: knowledgeImportReceiptSourceReference(input),
        },
        input,
      ),
    ).toBe(true);
  });

  it("allows repeated purchases for one project when they resolve to one account and enterprise", () => {
    expect(
      resolveKnowledgeImportProjectOwner(
        [
          {
            userId: 7,
            companyName: "示例企业",
            status: "completed",
          },
          {
            userId: 7,
            companyName: " 示例 企业 ",
            status: "completed",
          },
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

  it("rejects a project that resolves to multiple user accounts", () => {
    expect(() =>
      resolveKnowledgeImportProjectOwner(
        [
          { userId: 7, companyName: "示例企业", status: "completed" },
          { userId: 8, companyName: "示例企业", status: "completed" },
        ],
        "示例企业",
      ),
    ).toThrowError(expect.objectContaining({ code: "PROJECT_OWNER_CONFLICT" }));
  });

  it("rejects conflicting enterprise identities even when the account is the same", () => {
    expect(() =>
      resolveKnowledgeImportProjectOwner(
        [
          { userId: 7, companyName: "示例企业", status: "completed" },
          { userId: 7, companyName: "另一企业", status: "completed" },
        ],
        "示例企业",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PROJECT_ENTERPRISE_CONFLICT" }),
    );
  });
});
