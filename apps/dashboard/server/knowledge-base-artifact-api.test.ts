import { describe, expect, it } from "vitest";

import { KnowledgeBuildArtifactError } from "./knowledge-build-artifact-store";
import { resolveKnowledgeBaseArtifactDescriptor } from "./knowledge-base-artifact-api";

const buildId = "123e4567-e89b-42d3-a456-426614174000";

function build(overrides: Record<string, unknown> = {}) {
  return {
    id: buildId,
    userId: 7,
    generation: 2,
    status: "confirming" as const,
    skillVersion: "4",
    revision: 8,
    logoStorageKey:
      "knowledge-builds/7/123e4567-e89b-42d3-a456-426614174000/generation-2/official-logo.bin",
    logoSha256: "a".repeat(64),
    logoBytes: 123,
    logoFilename: "品牌/logo.png",
    logoMimeType: "image/png",
    packageStorageKey: null,
    packageArchiveSha256: null,
    packageSizeBytes: null,
    packageFilename: null,
    ...overrides,
  };
}

describe("knowledge-base same-origin artifact contract", () => {
  it("serves only the deterministic build-generation Logo path", () => {
    expect(resolveKnowledgeBaseArtifactDescriptor(build(), "logo")).toEqual(
      expect.objectContaining({
        kind: "logo",
        bytes: 123,
        mimeType: "image/png",
        disposition: "inline",
        filename: "品牌_logo.png",
      }),
    );
    expect(() =>
      resolveKnowledgeBaseArtifactDescriptor(
        build({ logoStorageKey: "knowledge-builds/7/other/logo.bin" }),
        "logo",
      ),
    ).toThrow(KnowledgeBuildArtifactError);
  });

  it("does not expose a package before it is durably ready", () => {
    expect(() =>
      resolveKnowledgeBaseArtifactDescriptor(build(), "package"),
    ).toThrow("尚未完成持久化和校验");
  });

  it("exposes the validated immutable package with attachment semantics", () => {
    const descriptor = resolveKnowledgeBaseArtifactDescriptor(
      build({
        status: "ready_to_publish",
        packageStorageKey:
          "knowledge-builds/7/123e4567-e89b-42d3-a456-426614174000/generation-2/knowledge-base.zip",
        packageArchiveSha256: "b".repeat(64),
        packageSizeBytes: 456,
        packageFilename: "最终知识库.zip",
      }),
      "package",
    );
    expect(descriptor).toEqual(
      expect.objectContaining({
        sha256: "b".repeat(64),
        bytes: 456,
        mimeType: "application/zip",
        disposition: "attachment",
      }),
    );
  });
});
