import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  assertPresalesV2ZipSafe,
  PresalesV2ZipSafetyError,
} from "./presales-v2-zip-safety";

describe("presales v2 ZIP activation safety", () => {
  it("accepts a bounded archive containing ordinary directories and files", async () => {
    const zip = new JSZip();
    zip.file("knowledge/README.md", "validated content");
    zip.file("assets/logo.txt", "logo");
    await expect(
      assertPresalesV2ZipSafe(
        await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a path that JSZip had to sanitize", async () => {
    const zip = new JSZip();
    zip.file("../outside.txt", "escape");
    await expect(
      assertPresalesV2ZipSafe(await zip.generateAsync({ type: "nodebuffer" })),
    ).rejects.toBeInstanceOf(PresalesV2ZipSafetyError);
  });

  it("rejects a symbolic link", async () => {
    const zip = new JSZip();
    zip.file("link", "target", { unixPermissions: 0o120777 });
    await expect(
      assertPresalesV2ZipSafe(
        await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
      ),
    ).rejects.toBeInstanceOf(PresalesV2ZipSafetyError);
  });

  it("rejects a high-ratio expansion bomb before artifact activation", async () => {
    const zip = new JSZip();
    zip.file("bomb.txt", "A".repeat(2 * 1024 * 1024));
    await expect(
      assertPresalesV2ZipSafe(
        await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      ),
    ).rejects.toBeInstanceOf(PresalesV2ZipSafetyError);
  });
});
