import { describe, expect, it } from "vitest";

import {
  filePreviewSource,
  managedLocalAssetContentUrl,
} from "./file-preview-source";

describe("filePreviewSource", () => {
  it("routes only Dashboard local asset identities to local content", () => {
    expect(managedLocalAssetContentUrl(`asset_${"a".repeat(30)}`)).toBe(
      `/api/frontmind/v2/assets/asset_${"a".repeat(30)}/content`,
    );
    expect(managedLocalAssetContentUrl("provider-file-1")).toBeNull();
  });
  it("prefers in-session bytes and keeps their immutable deadline", () => {
    const file = new File(["pdf"], "report.pdf", { type: "application/pdf" });
    expect(
      filePreviewSource({
        id: "attachment-1",
        type: "file",
        name: "report.pdf",
        file,
        fileId: "owned-id",
        expiresAt: 123,
      }),
    ).toEqual({ kind: "local", file, expiresAt: 123 });
  });

  it("never infers a URL from an opaque file ID", () => {
    expect(
      filePreviewSource({
        id: "attachment-2",
        type: "file",
        name: "report.pdf",
        fileId: "/folder/中文 # file",
        expiresAt: 456,
      }),
    ).toEqual({
      kind: "owned_file",
      fileId: "/folder/中文 # file",
      expiresAt: 456,
    });
    expect(
      filePreviewSource({
        id: "attachment-3",
        type: "file",
        name: "legacy.pdf",
        fileId: "https://files.example/url-looking-id",
      }),
    ).toEqual({
      kind: "owned_file",
      fileId: "https://files.example/url-looking-id",
      expiresAt: undefined,
    });
    expect(
      filePreviewSource({
        id: "attachment-4",
        type: "file",
        name: "reserved.pdf",
        fileId: "  folder/%2F?#[]@!$&'()+,;= ",
      }),
    ).toEqual({
      kind: "owned_file",
      fileId: "  folder/%2F?#[]@!$&'()+,;= ",
      expiresAt: undefined,
    });
  });
});
