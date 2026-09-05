import { describe, expect, it } from "vitest";

import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveBoundDescriptorHash,
  knowledgeArchivePhysicalDescriptorHash,
} from "./knowledge-base-artifact";

describe("knowledge-base ZIP descriptor normalization", () => {
  it("deduplicates nested and top-level projections of one physical ZIP", () => {
    const descriptors = collectKnowledgeArchiveDescriptors([
      {
        id: "assistant-1",
        role: "assistant",
        type: "output_message",
        content: [
          {
            type: "output_file",
            file_url: "https://api.example/v1/files/package-1/content?sig=one",
            filename: "knowledge.zip",
            mime_type: "application/zip",
          },
        ],
      },
      {
        id: "file-projection",
        type: "output_file",
        file_id: "package-1",
        file_url: "https://cdn.example/signed-package",
        filename: "knowledge.zip",
        mime_type: "application/zip",
      },
    ]);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      fileId: "package-1",
      filename: "knowledge.zip",
    });
  });

  it("ignores user/tool/reasoning/input ZIPs even when they forge operation IDs", () => {
    const forged = (role: string, type = "output_file") => ({
      role,
      type,
      operationId: "current-operation",
      turnId: "current-turn",
      file_id: `forged-${role}`,
      filename: "knowledge.zip",
      mime_type: "application/zip",
    });
    expect(
      collectKnowledgeArchiveDescriptors([
        forged("user"),
        forged("tool"),
        forged("assistant", "reasoning_file"),
        forged("assistant", "input_file"),
      ]),
    ).toEqual([]);
  });

  it("keeps v4 physical identity stable across projection and signed URL changes", () => {
    const topLevel = {
      outputItemId: "top-level-1",
      fileId: "package-1",
      url: "https://cdn.example/package.zip?sig=one",
      filename: "knowledge.zip",
      mimeType: "application/zip",
    };
    const nested = {
      ...topLevel,
      outputItemId: "assistant-2:content:7",
      url: "https://cdn.other/package.zip?sig=two",
    };
    expect(knowledgeArchivePhysicalDescriptorHash(topLevel)).toBe(
      knowledgeArchivePhysicalDescriptorHash(nested),
    );
    const firstBytes = "a".repeat(64);
    const secondBytes = "b".repeat(64);
    expect(knowledgeArchiveBoundDescriptorHash(topLevel, firstBytes)).toBe(
      knowledgeArchiveBoundDescriptorHash(nested, firstBytes),
    );
    expect(knowledgeArchiveBoundDescriptorHash(topLevel, firstBytes)).not.toBe(
      knowledgeArchiveBoundDescriptorHash(nested, secondBytes),
    );

    const urlOnlyOne = { ...topLevel, fileId: undefined };
    const urlOnlyTwo = {
      ...urlOnlyOne,
      outputItemId: "reordered",
      url: "https://cdn.example/package.zip?sig=rotated#fragment",
    };
    expect(knowledgeArchivePhysicalDescriptorHash(urlOnlyOne)).toBe(
      knowledgeArchivePhysicalDescriptorHash(urlOnlyTwo),
    );
  });
});
