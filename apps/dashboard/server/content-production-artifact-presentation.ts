import { createHash } from "node:crypto";
import {
  contentProductionArtifactName,
  projectContentProductionMarkdown,
} from "../shared/content-production-public";

/** Derive a download response in memory after normal artifact authorization.
 * Never write the copy back to storage or modify a Runner/Pack member. */
export function contentProductionPresentationArtifact(input: {
  bytes: Buffer;
  filename: string;
  mimeType: string;
}) {
  let bytes = input.bytes;
  let filename = contentProductionArtifactName(input.filename);
  const markdown =
    /\.md$/iu.test(input.filename) && bytes.length <= 2_000_000
      ? bytes.toString("utf8")
      : null;
  // Final article prose, JSON, DOCX, HTML, ZIPs and uploaded source materials
  // retain all original bytes. Only original workflow review pages get copies.
  const review =
    markdown !== null &&
    (/^#\s+(?:Reference Pack (?:路由|输入)|P0\s*(?:路由|例文确认|品牌深度品宣.*蓝图确认)|单问题例文确认|E1 应答简报|Pattern 确认|普通文章蓝图确认|具体问题研究输入|核心定位方向选择|竞品确认|.*(?:定位|比较对象|蓝图)确认)\s*$/mu.test(
      markdown,
    ) ||
      (/^## 您可以选择\s*$/mu.test(markdown) &&
        /确认并导出 Reference Pack|确认蓝图/u.test(markdown)));
  if (review) {
    const translated = projectContentProductionMarkdown(markdown!);
    if (translated !== markdown) {
      bytes = Buffer.from(translated, "utf8");
      filename = filename.replace(/\.md$/iu, "（中文展示）.md");
    }
  }
  return {
    bytes,
    filename,
    mimeType: input.mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    presentationCopy: bytes !== input.bytes,
  };
}
