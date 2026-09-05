import { fromMarkdown } from "mdast-util-from-markdown";

type PositionedMarkdownNode = {
  type?: string;
  url?: string;
  value?: string;
  children?: PositionedMarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

type SourceEdit = { start: number; end: number; replacement: string };

const HTML_IMAGE_TAG = /<img\b[^>]*>/giu;
const DATA_IMAGE_URL = /data:image\/[a-z0-9.+-]+(?:;[^\s<>'"`)\]]*)?/giu;

function sourceRange(node: PositionedMarkdownNode) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    Number(end) >= Number(start)
    ? { start: Number(start), end: Number(end) }
    : null;
}

function addMatchesWithinNode(
  node: PositionedMarkdownNode,
  expression: RegExp,
  edits: SourceEdit[],
) {
  const range = sourceRange(node);
  if (!range || typeof node.value !== "string") return;
  expression.lastIndex = 0;
  for (const match of node.value.matchAll(expression)) {
    if (match.index === undefined) continue;
    edits.push({
      start: range.start + match.index,
      end: range.start + match.index + match[0].length,
      replacement: "",
    });
  }
}

function collectCustomerImageEdits(
  node: PositionedMarkdownNode,
  edits: SourceEdit[],
) {
  const type = String(node.type || "");
  const range = sourceRange(node);
  if (range && (type === "image" || type === "imageReference")) {
    edits.push({ ...range, replacement: "" });
    return;
  }
  if (
    range &&
    (type === "link" || type === "definition") &&
    /^data:image\//iu.test(String(node.url || "").trim())
  ) {
    edits.push({ ...range, replacement: "" });
    return;
  }
  if (type === "html") {
    addMatchesWithinNode(node, HTML_IMAGE_TAG, edits);
    addMatchesWithinNode(node, DATA_IMAGE_URL, edits);
  } else if (type === "text") {
    // A bare data URL is text, not an image node. The AST position keeps this
    // cleanup confined to customer-visible text instead of protocol JSON.
    addMatchesWithinNode(node, DATA_IMAGE_URL, edits);
  }
  for (const child of node.children || []) {
    collectCustomerImageEdits(child, edits);
  }
}

function mergedSourceEdits(edits: SourceEdit[]) {
  const ordered = edits
    .filter((edit) => edit.end > edit.start)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: SourceEdit[] = [];
  for (const edit of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || edit.start > previous.end) {
      merged.push({ ...edit });
      continue;
    }
    previous.end = Math.max(previous.end, edit.end);
  }
  return merged;
}

/**
 * Remove model-authored image projections from customer Markdown while
 * preserving every unrelated source byte. Protocol envelopes must be parsed
 * before calling this function; it never fetches or resolves image URLs.
 */
export function normalizeKnowledgeBaseCustomerMarkdownImages(markdown: string) {
  const source = String(markdown || "");
  if (!source) return { markdown: "", removedImageCount: 0 } as const;

  const tree = fromMarkdown(source) as PositionedMarkdownNode;
  const edits: SourceEdit[] = [];
  collectCustomerImageEdits(tree, edits);
  const merged = mergedSourceEdits(edits);
  if (merged.length === 0) {
    return { markdown: source, removedImageCount: 0 } as const;
  }

  let cursor = 0;
  let normalized = "";
  for (const edit of merged) {
    normalized += source.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  normalized += source.slice(cursor);
  return {
    markdown: normalized,
    removedImageCount: merged.length,
  } as const;
}
