import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentProductionPresentationArtifact } from "./content-production-artifact-presentation";

describe("content production presentation downloads", () => {
  it("derives a Chinese review copy without overwriting source bytes or source evidence", () => {
    const source =
      "# P0例文确认\n\nReference Pack\n\n> P0 原始引文\n\n[p0.docx](/api/frontmind/v2/artifacts/artifact_a/content?enterpriseProjectId=project-a)";
    const bytes = Buffer.from(source);
    const result = contentProductionPresentationArtifact({
      bytes,
      filename: "review_p0_r4.md",
      mimeType: "text/markdown",
    });
    expect(result.presentationCopy).toBe(true);
    expect(result.filename).toBe("品牌文章阶段确认_版本4（中文展示）.md");
    expect(result.bytes.toString()).toContain("品牌资料包");
    expect(result.bytes.toString()).toContain("> P0 原始引文");
    expect(result.bytes.toString()).toContain(
      "enterpriseProjectId=project-a&presentation=zh",
    );
    expect(bytes.toString()).toBe(source);
    expect(result.sha256).toBe(
      createHash("sha256").update(result.bytes).digest("hex"),
    );
  });

  it.each([
    ["Reference_Pack_v3.zip", "application/zip"],
    [
      "p0.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["p0_title_map.json", "application/json"],
    ["p0.html", "text/html"],
    ["article.md", "text/markdown"],
    ["客户材料.md", "text/markdown"],
    ["review_customer_input.md", "text/markdown"],
  ])(
    "retains original business artifact and input bytes for %s",
    (filename, mimeType) => {
      const bytes = Buffer.from(
        "文章与资料原文提到 Reference Pack、P0 和 P01。",
      );
      const result = contentProductionPresentationArtifact({
        bytes,
        filename,
        mimeType,
      });
      expect(result.bytes).toBe(bytes);
      expect(result.presentationCopy).toBe(false);
      expect(result.mimeType).toBe(mimeType);
    },
  );
});
