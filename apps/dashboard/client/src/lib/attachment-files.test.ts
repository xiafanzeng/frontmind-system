import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  assertChatAttachmentSizes,
  chatAttachmentSizeError,
  MAX_CHAT_ATTACHMENT_BYTES,
  normalizedKnowledgeBaseUploadFilename,
  normalizedKnowledgeBaseUploadMimeType,
  prepareUploadFiles,
  sha256UploadFile,
} from "./attachment-files";

const mocks = vi.hoisted(() => ({
  inspectImageFile: vi.fn(),
}));

vi.mock("@/lib/image-inspection", () => ({
  inspectImageFile: mocks.inspectImageFile,
  formatFileSize: (bytes: number) => `${bytes}B`,
  formatImageInspectionSummary: (info: {
    width: number;
    height: number;
    pixels: number;
  }) => `${info.width}x${info.height} · ${info.pixels}`,
}));

describe("attachment-files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectImageFile.mockResolvedValue({
      width: 1600,
      height: 900,
      pixels: 1_440_000,
      size: 1024,
      isLarge: false,
      reasons: [],
    });
  });

  it("normalizes filenames identically before capture and manifest", () => {
    expect(normalizedKnowledgeBaseUploadFilename("  客户/补充😀.jpg  ")).toBe(
      "客户_补充😀.jpg",
    );
    expect(normalizedKnowledgeBaseUploadFilename("...")).toBe(
      "company_material",
    );
    expect(normalizedKnowledgeBaseUploadFilename("a".repeat(200))).toHaveLength(
      160,
    );
  });

  it("enforces the shared 100 MB chat attachment boundary", () => {
    const atLimit = { name: "at-limit.pdf", size: MAX_CHAT_ATTACHMENT_BYTES };
    const oversized = {
      name: "oversized.pdf",
      size: MAX_CHAT_ATTACHMENT_BYTES + 1,
    };

    expect(chatAttachmentSizeError(atLimit)).toBeNull();
    expect(chatAttachmentSizeError(oversized)).toBe(
      "文件“oversized.pdf”不能超过 100 MB",
    );
    expect(() => assertChatAttachmentSizes([atLimit])).not.toThrow();
    expect(() => assertChatAttachmentSizes([atLimit, oversized])).toThrow(
      "文件“oversized.pdf”不能超过 100 MB",
    );
  });

  it("keeps ordinary images as normal file uploads", async () => {
    const image = new File(["image-bytes"], "normal.png", {
      type: "image/png",
    });

    const result = await prepareUploadFiles([image]);

    expect(result.didZipLargeImages).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].file).toBe(image);
  });

  it("distinguishes equal metadata files by their exact SHA-256 bytes", async () => {
    const metadata = {
      type: "application/octet-stream",
      lastModified: 1_700_000_000_000,
    };
    const first = new File(["aaaa"], "same.bin", metadata);
    const second = new File(["bbbb"], "same.bin", metadata);

    expect(first.size).toBe(second.size);
    expect(first.lastModified).toBe(second.lastModified);
    expect(await sha256UploadFile(first)).not.toBe(
      await sha256UploadFile(second),
    );
  });

  it("normalizes image MIME from the filename when the browser leaves it empty", () => {
    expect(
      normalizedKnowledgeBaseUploadMimeType(
        new File(["svg"], "FrontMind_logo.svg"),
      ),
    ).toBe("image/svg+xml");
    expect(
      normalizedKnowledgeBaseUploadMimeType(new File(["jpeg"], "office.JPG")),
    ).toBe("image/jpeg");
  });

  it("packs oversized images into a lossless ZIP with original names", async () => {
    mocks.inspectImageFile.mockResolvedValueOnce({
      width: 25_893,
      height: 8_426,
      pixels: 218_134_818,
      size: 5_400_000,
      isLarge: true,
      reasons: ["总像素 218.1MP"],
    });
    const image = new File(["original-image-bytes"], "333.png", {
      type: "image/png",
    });

    const result = await prepareUploadFiles([image]);

    expect(result.didZipLargeImages).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].file.name).toMatch(
      /^frontmind-original-images-[0-9a-f]{8}\.zip$/,
    );
    expect(result.files[0].file.type).toBe("application/zip");

    const zip = await JSZip.loadAsync(result.files[0].file);
    expect(zip.file("original-images/333.png")).toBeTruthy();
    expect(await zip.file("original-images/333.png")?.async("string")).toBe(
      "original-image-bytes",
    );
  });

  it("packs only oversized images and leaves other files unchanged", async () => {
    mocks.inspectImageFile.mockResolvedValueOnce({
      width: 26_009,
      height: 8_270,
      pixels: 215_094_430,
      size: 7_000_000,
      isLarge: true,
      reasons: ["总像素 215.1MP"],
    });
    const image = new File(["image"], "large.png", { type: "image/png" });
    const pdf = new File(["pdf"], "brief.pdf", { type: "application/pdf" });

    const result = await prepareUploadFiles([image, pdf]);

    expect(result.files).toHaveLength(2);
    expect(result.files[0].file).toBe(pdf);
    expect(result.files[1].file.name).toMatch(
      /^frontmind-original-images-[0-9a-f]{8}\.zip$/,
    );
  });

  it("produces the same upload manifest metadata for the same original images", async () => {
    mocks.inspectImageFile.mockResolvedValue({
      width: 26_009,
      height: 8_270,
      pixels: 215_094_430,
      size: 7_000_000,
      isLarge: true,
      reasons: ["总像素 215.1MP"],
    });
    const image = new File(["same-image"], "large.png", {
      type: "image/png",
      lastModified: 1_700_000_000_000,
    });

    const first = (await prepareUploadFiles([image])).files[0]!.file;
    const second = (await prepareUploadFiles([image])).files[0]!.file;

    expect({
      name: first.name,
      size: first.size,
      type: first.type,
      lastModified: first.lastModified,
    }).toEqual({
      name: second.name,
      size: second.size,
      type: second.type,
      lastModified: second.lastModified,
    });
  });
});
