import { createHash } from "node:crypto";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import { overlaySiteOpsRevisionMedia } from "./manus-provider";

const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

describe("SiteOps revision source media overlay", () => {
  it("preserves the parent source wrapper and installs exact public bytes", async () => {
    const parent = new JSZip();
    parent.file(
      "native-site/package.json",
      '{"scripts":{"build":"vite build"}}',
      { createFolders: false, date: new Date("2000-01-01T00:00:00.000Z") },
    );
    parent.file(
      "native-site/src/App.tsx",
      "export default function App(){}\n",
      { createFolders: false, date: new Date("2000-01-01T00:00:00.000Z") },
    );
    const parentBytes = await parent.generateAsync({ type: "nodebuffer" });
    const image = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]);
    const digest = sha256(image);
    const asset = {
      schemaVersion: 1 as const,
      localAssetId: "10000000-0000-4000-8000-000000000001",
      filename: "产品图.png",
      mimeType: "image/png" as const,
      sizeBytes: image.length,
      contentSha256: digest,
      width: 1,
      height: 1,
      publicPath: `/frontmind-user-media/${digest}.png`,
      siteOpsKnowledgeInputEpochId: "20000000-0000-4000-8000-000000000001",
      bytes: image,
    };

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-30T10:00:00.000Z"));
      const first = await overlaySiteOpsRevisionMedia(parentBytes, [asset]);
      vi.setSystemTime(new Date("2026-08-30T10:00:10.000Z"));
      const second = await overlaySiteOpsRevisionMedia(parentBytes, [asset]);

      expect(first.equals(second)).toBe(true);
      expect(sha256(first)).toBe(sha256(second));
      const overlaid = await JSZip.loadAsync(first, { checkCRC32: true });
      expect(
        Object.values(overlaid.files)
          .filter((entry) => entry.dir)
          .map((entry) => entry.name),
      ).toEqual([]);
      await expect(
        overlaid
          .file(`native-site/public/frontmind-user-media/${digest}.png`)!
          .async("nodebuffer"),
      ).resolves.toEqual(image);
      expect(overlaid.file("native-site/src/App.tsx")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when stable media bytes no longer match the coordinate", async () => {
    const parent = new JSZip();
    parent.file("package.json", "{}");
    const parentBytes = await parent.generateAsync({ type: "nodebuffer" });
    const image = Buffer.from("changed");
    await expect(
      overlaySiteOpsRevisionMedia(parentBytes, [
        {
          schemaVersion: 1,
          localAssetId: "10000000-0000-4000-8000-000000000001",
          filename: "product.webp",
          mimeType: "image/webp",
          sizeBytes: image.length,
          contentSha256: "0".repeat(64),
          width: 1,
          height: 1,
          publicPath: `/frontmind-user-media/${"0".repeat(64)}.webp`,
          siteOpsKnowledgeInputEpochId: "20000000-0000-4000-8000-000000000001",
          bytes: image,
        },
      ]),
    ).rejects.toMatchObject({
      code: "FRONTMIND_BUILD_REVISION_MEDIA_INVALID",
    });
  });
});
