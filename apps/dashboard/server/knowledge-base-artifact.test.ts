import { describe, expect, it } from "vitest";

import {
  assertKnowledgeBaseV4FinalOutputResourceContract,
  collectKnowledgeArchiveDescriptors,
  KnowledgeBaseFinalOutputResourceContractError,
  knowledgeArchiveBoundDescriptorHash,
  knowledgeArchivePhysicalDescriptorHash,
} from "./knowledge-base-artifact";

describe("knowledge-base ZIP descriptor normalization", () => {
  it("preserves database-sized provider identities without rewriting them", () => {
    const outputItemId = "o".repeat(255);
    const fileId = "f".repeat(255);
    expect(
      collectKnowledgeArchiveDescriptors([
        {
          id: outputItemId,
          type: "output_file",
          file_id: fileId,
          filename: "knowledge.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        outputItemId,
        fileId,
      }),
    ]);
  });

  it.each([
    ["fileId", { file_id: "f".repeat(256) }],
    ["outputItemId", { id: "o".repeat(256) }],
  ])("drops an overlong %s instead of truncating it", (_label, identity) => {
    expect(
      collectKnowledgeArchiveDescriptors([
        {
          id: "output-1",
          type: "output_file",
          file_id: "file-1",
          filename: "knowledge.zip",
          mime_type: "application/zip",
          ...identity,
        },
      ]),
    ).toEqual([]);
  });

  it("drops conflicting file identity aliases without hiding a valid sibling", () => {
    expect(
      collectKnowledgeArchiveDescriptors([
        {
          id: "output-1",
          type: "output_file",
          file_id: "file-a",
          fileId: "file-b",
          filename: "knowledge.zip",
          mime_type: "application/zip",
        },
        {
          id: "output-2",
          type: "output_file",
          file_id: "file-valid",
          filename: "knowledge-valid.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        outputItemId: "output-2",
        fileId: "file-valid",
      }),
    ]);
  });

  it("drops a numeric artifact identity that cannot be represented losslessly", () => {
    expect(
      collectKnowledgeArchiveDescriptors([
        {
          id: "output-1",
          type: "output_file",
          file_id: Number.MAX_SAFE_INTEGER + 1,
          filename: "knowledge.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toEqual([]);
  });

  it("drops identity whitespace instead of silently rewriting it", () => {
    expect(
      collectKnowledgeArchiveDescriptors([
        {
          id: "output-1",
          type: "output_file",
          file_id: " file-1 ",
          filename: "knowledge.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toEqual([]);
    expect(
      collectKnowledgeArchiveDescriptors([
        {
          id: "output-1",
          type: "output_file",
          file_id: "file-1",
          file_url: " https://api.example/v1/files/file-1/content ",
          filename: "knowledge.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toEqual([]);
  });

  it("does not reject an unrelated text message solely for its long provider id", () => {
    expect(
      collectKnowledgeArchiveDescriptors([
        {
          id: "message-" + "m".repeat(300),
          role: "assistant",
          type: "message",
          content: "ordinary text",
        },
      ]),
    ).toEqual([]);
  });

  it("drops an object parent output identity instead of stringifying it", () => {
    expect(
      collectKnowledgeArchiveDescriptors([
        {
          id: { providerId: "assistant-1" },
          role: "assistant",
          type: "message",
          content: [
            {
              type: "output_file",
              file_id: "package-1",
              filename: "knowledge.zip",
              mime_type: "application/zip",
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("derives a stable bounded child identity from the complete 255-character parent id", () => {
    const outputFor = (parentId: string) => [
      {
        id: parentId,
        role: "assistant",
        type: "output_message",
        content: [
          {
            type: "output_file",
            file_id: "package-1",
            filename: "knowledge.zip",
            mime_type: "application/zip",
          },
        ],
      },
    ];
    const parentId = `${"p".repeat(254)}a`;
    const first = collectKnowledgeArchiveDescriptors(outputFor(parentId))[0]!;
    const repeated = collectKnowledgeArchiveDescriptors(
      outputFor(parentId),
    )[0]!;
    const differentLastCharacter = collectKnowledgeArchiveDescriptors(
      outputFor(`${"p".repeat(254)}b`),
    )[0]!;
    const contracted = assertKnowledgeBaseV4FinalOutputResourceContract(
      outputFor(parentId),
    );

    expect(parentId).toHaveLength(255);
    expect(first.outputItemId).toMatch(/^content:[a-f0-9]{64}$/);
    expect(first.outputItemId).toHaveLength(72);
    expect(repeated.outputItemId).toBe(first.outputItemId);
    expect(contracted.outputItemId).toBe(first.outputItemId);
    expect(differentLastCharacter.outputItemId).not.toBe(first.outputItemId);
  });

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

describe("schema-v4 final output resource contract", () => {
  it("accepts duplicate projections of one strictly typed physical ZIP", () => {
    expect(
      assertKnowledgeBaseV4FinalOutputResourceContract([
        {
          id: "assistant-final",
          role: "assistant",
          type: "output_message",
          content: [
            {
              type: "output_file",
              file_url:
                "https://api.example/v1/files/package-final/content?sig=one",
              filename: "knowledge.zip",
              mime_type: "application/zip",
            },
          ],
        },
        {
          id: "package-projection",
          type: "output_file",
          file_id: "package-final",
          file_url: "https://cdn.example/knowledge.zip?sig=two",
          filename: "knowledge.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toMatchObject({
      fileId: "package-final",
      filename: "knowledge.zip",
      mimeType: "application/zip",
      outputItemIds: expect.arrayContaining([
        "assistant-final:content:0",
        "package-projection",
      ]),
    });
  });

  it.each([
    [
      "legacy file type",
      {
        type: "file",
        file_id: "package-final",
        filename: "knowledge.zip",
        mime_type: "application/zip",
      },
    ],
    [
      "missing MIME",
      {
        type: "output_file",
        file_id: "package-final",
        filename: "knowledge.zip",
      },
    ],
    [
      "x-zip MIME",
      {
        type: "output_file",
        file_id: "package-final",
        filename: "knowledge.zip",
        mime_type: "application/x-zip-compressed",
      },
    ],
    [
      "wrong MIME",
      {
        type: "output_file",
        file_id: "package-final",
        filename: "knowledge.zip",
        mime_type: "application/pdf",
      },
    ],
    [
      "non-ZIP filename",
      {
        type: "output_file",
        file_id: "package-final",
        filename: "knowledge.bin",
        mime_type: "application/zip",
      },
    ],
  ])("rejects a %s projection", (_label, resource) => {
    expect(() =>
      assertKnowledgeBaseV4FinalOutputResourceContract([resource]),
    ).toThrowError(
      expect.objectContaining({
        name: "KnowledgeBaseFinalOutputResourceContractError",
        code: "INVALID",
      }),
    );
  });

  it("rejects a valid ZIP accompanied by a PDF", () => {
    expect(() =>
      assertKnowledgeBaseV4FinalOutputResourceContract([
        {
          type: "output_file",
          file_id: "package-final",
          filename: "knowledge.zip",
          mime_type: "application/zip",
        },
        {
          type: "output_file",
          file_id: "extra-pdf",
          filename: "extra.pdf",
          mime_type: "application/pdf",
        },
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "KnowledgeBaseFinalOutputResourceContractError",
        code: "AMBIGUOUS",
      }),
    );
  });

  it("keeps legacy descriptor collection compatible with type=file and filename-only ZIP detection", () => {
    const legacy = [
      {
        type: "file",
        file_id: "legacy-package",
        filename: "legacy.zip",
      },
    ];
    expect(collectKnowledgeArchiveDescriptors(legacy)).toHaveLength(1);
    expect(() =>
      assertKnowledgeBaseV4FinalOutputResourceContract(legacy),
    ).toThrow(KnowledgeBaseFinalOutputResourceContractError);
  });
});
