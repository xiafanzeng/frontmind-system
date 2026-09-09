import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  knowledgeOriginalAttachments,
  streamKnowledgeWorkspaceZip,
} from "./knowledge-workbench-export";

describe("knowledge workspace streaming export", () => {
  it("produces an interoperable ZIP with streamed UTF-8 filenames and verified CRC", async () => {
    const chunks: Buffer[] = [];
    let reads = 0;
    for await (const chunk of streamKnowledgeWorkspaceZip([
      {
        name: "README.md",
        content: async function* () {
          yield Buffer.from("说明");
        },
      },
      {
        name: "originals/001-品牌资料.pdf",
        content: async function* () {
          for (let i = 0; i < 5; i++) {
            reads++;
            yield Buffer.alloc(64000, i);
          }
        },
      },
    ]))
      chunks.push(chunk);
    const zip = await JSZip.loadAsync(Buffer.concat(chunks), {
      checkCRC32: true,
    });
    expect(await zip.file("README.md")!.async("string")).toBe("说明");
    expect(
      (await zip.file("originals/001-品牌资料.pdf")!.async("nodebuffer"))
        .length,
    ).toBe(320000);
    expect(reads).toBe(5);
  });
  it("stops reading the current source when the consumer disconnects", async () => {
    let closed = false;
    const stream = streamKnowledgeWorkspaceZip([
      {
        name: "source.bin",
        content: async function* () {
          try {
            while (true) yield Buffer.alloc(100);
          } finally {
            closed = true;
          }
        },
      },
    ]);
    await stream.next();
    await stream.next();
    await stream.next();
    await stream.return(undefined);
    expect(closed).toBe(true);
  });
  it("rejects traversal paths", async () => {
    const stream = streamKnowledgeWorkspaceZip([
      {
        name: "../secrets",
        content: async function* () {
          yield Buffer.from("x");
        },
      },
    ]);
    await expect(stream.next()).rejects.toThrow("Invalid ZIP path");
  });
  it("distinguishes a proven empty source list from legacy missing metadata", () => {
    expect(knowledgeOriginalAttachments({ metadata: {} }).status).toBe(
      "legacy_manifest_unavailable",
    );
    expect(
      knowledgeOriginalAttachments({
        metadata: {
          knowledgeWorkbench: {
            originalAttachmentManifest: {
              schemaVersion: 1,
              status: "complete",
              expectedCount: 0,
              entries: [],
            },
          },
        },
      }),
    ).toMatchObject({ status: "complete", expectedCount: 0 });
    expect(
      knowledgeOriginalAttachments({
        metadata: {
          knowledgeWorkbench: {
            originalAttachmentManifest: {
              schemaVersion: 1,
              status: "complete",
              expectedCount: 1,
              entries: [],
            },
          },
        },
      }).status,
    ).toBe("incomplete");
  });
});
