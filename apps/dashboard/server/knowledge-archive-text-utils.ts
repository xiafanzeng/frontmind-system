import path from "node:path";

export function stripLeadingKnowledgeArchiveFrontmatter(markdown: string) {
  return markdown.replace(
    /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/,
    "",
  );
}

export function knowledgeArchiveFormalText(content: string) {
  const retainedLines: string[] = [];
  const lines = stripLeadingKnowledgeArchiveFrontmatter(content).split(/\r?\n/);
  let excludedSectionDepth: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] || "";
    const heading = rawLine.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const depth = heading[1]!.length;
      if (excludedSectionDepth !== undefined && depth <= excludedSectionDepth) {
        excludedSectionDepth = undefined;
      }
      if (
        /(?:原始|证据|引用|参考)?来源|素材清单|展示素材|机器清单|证据状态|状态头|sources?|references?|asset inventory/i.test(
          heading[2] || "",
        )
      ) {
        excludedSectionDepth = depth;
      }
      continue;
    }
    if (excludedSectionDepth !== undefined) continue;
    if (
      /^\s*>\s*.*(?:状态|status)\s*[:：].*(?:来源|source)\s*[:：]/i.test(
        rawLine,
      ) ||
      /^\s*[-*]\s+(?:node_id|path|evidence_status|source_ids|status)\s*[:：]/i.test(
        rawLine,
      )
    ) {
      continue;
    }
    if (rawLine.trim().startsWith("|")) {
      const tableLines: string[] = [];
      let tableIndex = index;
      while (
        tableIndex < lines.length &&
        (lines[tableIndex] || "").trim().startsWith("|")
      ) {
        tableLines.push(lines[tableIndex] || "");
        tableIndex += 1;
      }
      index = tableIndex - 1;
      const tableText = tableLines.join("\n");
      if (!/(?:来源|出处|证据链接|source|url)/i.test(tableText)) {
        retainedLines.push(tableText);
      }
      continue;
    }
    retainedLines.push(rawLine);
  }
  return retainedLines
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)>\]]+/gi, "")
    .replace(/<[^>]+>/g, "");
}

export function markedKnowledgeArchiveFormalContent(content: string) {
  const startMarker = "<!-- FRONTMIND_FORMAL_CONTENT_START -->";
  const endMarker = "<!-- FRONTMIND_FORMAL_CONTENT_END -->";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (
    start < 0 ||
    end <= start ||
    content.indexOf(startMarker, start + startMarker.length) >= 0 ||
    content.indexOf(endMarker, end + endMarker.length) >= 0
  ) {
    return undefined;
  }
  return content.slice(start + startMarker.length, end);
}

export function effectiveKnowledgeArchiveCharacterCount(value: string) {
  return Array.from(
    value
      .replace(/\s/g, "")
      .replace(
        /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]/g,
        "",
      ),
  ).length;
}

export function decodeKnowledgeArchiveHeader(
  value: string | undefined,
  fallback: string,
) {
  if (!value) return fallback;
  try {
    return decodeURIComponent(value).slice(0, 512);
  } catch {
    return value.slice(0, 512);
  }
}

export function parseDashboardRevisionHeader(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("看板版本号无效，请刷新后重试");
  }
  return Number(value);
}

export function safeKnowledgeArchivePath(value: string) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 512);
}

export function validateKnowledgeArchiveEntryPath(value: string) {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value)
  ) {
    throw new Error("知识库 ZIP 包含不安全的文件路径");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("知识库 ZIP 包含不安全的文件路径");
  }
  const normalized = parts.join("/");
  if (normalized.length > 512) {
    throw new Error("知识库 ZIP 中的文件路径过长");
  }
  return normalized;
}

export function knowledgeArchiveTitleFromPath(filePath: string) {
  return (
    path
      .basename(filePath, path.extname(filePath))
      .replace(/^\d+[._-]*/, "")
      .replace(/[-_]+/g, " ")
      .trim() || "知识文档"
  );
}

function htmlToMarkdownLikeText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeKnowledgeArchiveTextDocument(
  filePath: string,
  content: string,
) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html" || extension === ".htm") {
    return htmlToMarkdownLikeText(content);
  }
  if (extension === ".json") {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(content), null, 2)}\n\`\`\``;
    } catch {
      return content;
    }
  }
  return content.replace(/^\uFEFF/, "").trim();
}
