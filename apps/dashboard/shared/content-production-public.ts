import { fromMarkdown } from "mdast-util-from-markdown";

/** Public vocabulary only. Runner values, customer inputs and stored artifacts
 * retain their original identities; never use these labels as action values. */
export const CONTENT_PRODUCTION_PATTERNS = [
  ["P01", "单一对象推荐"],
  ["P02", "多对象推荐与选择指南"],
  ["P03", "场景解决方案"],
  ["P04", "事件报道"],
  ["P05", "指定对象对比"],
  ["P06", "口碑与可信度评估"],
] as const;

const patternNames: Record<string, string> = Object.fromEntries([
  ["P00", "品牌深度文章"],
  ...CONTENT_PRODUCTION_PATTERNS,
]);

export const CONTENT_PRODUCTION_PAUSE_TITLES: Record<string, string> = {
  awaiting_reference_pack_route: "选择品牌资料包",
  awaiting_reference_pack_input: "补充品牌资料",
  awaiting_question_research_inputs: "补充问题研究资料",
  awaiting_competitor_selection: "确认比较对象",
  awaiting_core_positioning_direction: "选择核心定位方向",
  awaiting_core_positioning_confirmation: "确认核心定位",
  awaiting_p0_route: "选择品牌文章制作方式",
  awaiting_p0_example_confirmation: "确认品牌文章参考例文",
  awaiting_p0_blueprint_confirmation: "确认品牌文章写作方案",
  awaiting_response_brief: "确认问题与写作要求",
  awaiting_pattern_confirmation: "确认文章类型",
  awaiting_example_confirmation: "确认问题文章参考例文",
  awaiting_question_positioning_confirmation: "确认本题差异化定位",
  awaiting_blueprint_confirmation: "确认文章写作方案",
};

export const CONTENT_PRODUCTION_LANGUAGE_CONTEXT = [
  "Customer presentation uses Chinese business terms: Reference Pack = 品牌资料包; P0/P00 = 品牌深度文章; Pattern = 文章类型; blueprint/蓝图 = 写作方案; Top20 = 参考例文 (at most two complete examples, never claim a top-20 ranking).",
  `Question pattern display names: ${CONTENT_PRODUCTION_PATTERNS.map(([id, label]) => `${id} = ${label}`).join("; ")}. Example route A = 参考例文的文风; B = 参考 AI 答案的文风. E1 = 确认问题与写作要求. Use these Chinese names in customer-facing progress, introductions, headings and choices instead of protocol abbreviations.`,
  "Keep original Runner commands, IDs, state, revisions, action values, Pack members, original review files and business deliverables unchanged. Read the full original review; present all its business content with only the controlled workflow labels translated. Never translate or paraphrase customer source text, quotations, code, source URLs or machine-readable JSON. Do not omit comparisons, evidence, choices or user confirmation pauses. Existing Sessions continue the same original Job. Name the unchanged review Markdown copies already requested for customer outputs review_<status>_r<revision>.md; the application provides Chinese display copies and external download aliases, which never replace originals or become Runner inputs.",
].join("\n\n");

const phrases: Array<[RegExp, string]> = [
  [/使用已有 Reference Pack/gu, "使用已有品牌资料包"],
  [/创建新的 Reference Pack/gu, "创建新的品牌资料包"],
  [
    /P0\s*(?:品牌深度品宣|品牌深度特写|品牌深度文章|品牌文章)/gu,
    "品牌深度文章",
  ],
  [/P00\s*[·：:]?\s*品牌深度特写/gu, "品牌深度文章"],
  [/P01\s*[·：:]?\s*单主体品类或服务推荐/gu, "单一对象推荐"],
  [/P02\s*[·：:]?\s*开放式多主体推荐/gu, "多对象推荐与选择指南"],
  [/P03\s*[·：:]?\s*产品或服务场景解决方案/gu, "场景解决方案"],
  [/P04\s*[·：:]?\s*事件新闻/gu, "事件报道"],
  [/P05\s*[·：:]?\s*明确对象对比/gu, "指定对象对比"],
  [/P06\s*[·：:]?\s*单主体口碑与可信度评估/gu, "口碑与可信度评估"],
  [/Reference Pack\s*路由/gu, "选择品牌资料包"],
  [/Reference Pack 输入/gu, "补充品牌资料"],
  [/\bReference Pack\b/gu, "品牌资料包"],
  [/P01\s*[–—~-]\s*P06/gu, "六种问题文章类型"],
  [/P00\s*[–—~-]\s*P06/gu, "品牌文章与六种问题文章类型"],
  [/P0 路由/gu, "品牌文章制作方式"],
  [/E1 应答简报/gu, "问题与写作要求"],
  [/\bPattern\b/gu, "文章类型"],
  [/\bTop20\s*例文/giu, "参考例文"],
  [/\bTop20\b/giu, "参考例文"],
  [/方案 A/gu, "参考例文的文风"],
  [/方案 B/gu, "参考 AI 答案的文风"],
  [/\bH2\s*\/\s*H3\b/gu, "章节与小节标题"],
  [/蓝图/gu, "写作方案"],
  [/单问题文章/gu, "问题文章"],
];

/** For app-owned labels and workflow prose, not arbitrary customer text. */
export function contentProductionPublicText(value: string): string {
  let text = value;
  for (const [expression, replacement] of phrases)
    text = text.replace(expression, replacement);
  return text
    .replace(/\bP0[0-6]\b/gu, (id) => patternNames[id] ?? id)
    .replace(/\bP0\b/gu, "品牌深度文章")
    .replace(
      /\b(?:positioning_ready|p0_ready|question_ready)\b/gu,
      (status) =>
        ({
          positioning_ready: "已确认定位",
          p0_ready: "已完成品牌文章",
          question_ready: "已备齐问题研究资料",
        })[status]!,
    )
    .replace(/\bE1\b/gu, "问题与写作要求")
    .replace(/\brevision\b/gu, "版本");
}

export function contentProductionPauseTitle(
  status: string | null,
  original: string | null,
) {
  return (
    CONTENT_PRODUCTION_PAUSE_TITLES[status ?? ""] ??
    (original ? contentProductionPublicText(original) : null)
  );
}

export function contentProductionTaskTitle(title: string): string {
  const separator = title.lastIndexOf(" · ");
  const start = separator < 0 ? 0 : separator + 3;
  const suffix = title.slice(start);
  const labels: Record<string, string> = {
    "建立新的 Reference Pack": "新建品牌资料包",
    刷新市场研究与定位: "更新品牌资料包",
    "创建或导入 P0": "制作品牌深度文章",
    撰写单问题文章: "围绕问题写文章",
  };
  return labels[suffix] ? title.slice(0, start) + labels[suffix] : title;
}

/** Keep source provenance and extension. Only known workflow-generated names
 * receive aliases; uploaded or unrelated filenames are not rewritten. */
export function contentProductionArtifactName(filename: string): string {
  if (/[/\\\r\n]/u.test(filename)) return filename;
  const review =
    /^(?:workflow[_-])?review[_-](?:(.+)[_-])?r(\d+)(\.[^.]+)$/iu.exec(
      filename,
    );
  if (review) {
    const stage = review[1] ?? "";
    const title =
      CONTENT_PRODUCTION_PAUSE_TITLES[stage] ??
      CONTENT_PRODUCTION_PAUSE_TITLES[`awaiting_${stage}`] ??
      (
        { p0: "品牌文章阶段确认", article: "问题文章阶段确认" } as Record<
          string,
          string
        >
      )[stage] ??
      "阶段确认";
    return `${title}_版本${review[2]}${review[3]}`;
  }
  const aliases: Array<[RegExp, string]> = [
    [/^(?:frontmind[_-])?reference[_ -]pack(?=[_. -]|$)/iu, "品牌资料包"],
    [/^p0[_-]blueprint(?=[_.-]|$)/iu, "品牌文章写作方案"],
    [/^article[_-]blueprint(?=[_.-]|$)/iu, "问题文章写作方案"],
    [/^p0[_-]title[_-]map(?=[_.-]|$)/iu, "品牌文章标题方案"],
    [/^article[_-]title[_-]map(?=[_.-]|$)/iu, "问题文章标题方案"],
    [/^p0(?=[_.-]|$)/iu, "品牌深度文章"],
    [/^article(?=[_.-]|$)/iu, "问题文章"],
  ];
  for (const [pattern, alias] of aliases) {
    if (pattern.test(filename)) return filename.replace(pattern, alias);
  }
  for (const [status, title] of Object.entries(
    CONTENT_PRODUCTION_PAUSE_TITLES,
  )) {
    if (filename.startsWith(`${status}_`) || filename.startsWith(`${status}.`))
      return title + filename.slice(status.length);
  }
  return filename;
}

/** Explicit opt-in keeps original artifact URLs and Pack handoff byte-exact. */
export function contentProductionArtifactUrl(value: string): string {
  if (
    !/^\/api\/frontmind\/v2\/artifacts\/[^/?#]+\/content(?:\?|$)/u.test(value)
  )
    return value;
  const url = new URL(value, "https://frontmind.invalid");
  url.searchParams.set("presentation", "zh");
  return `${url.pathname}${url.search}${url.hash}`;
}

type MarkdownNode = {
  type: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Translate only assistant-authored workflow prose. Source quotes, all code,
 * raw HTML, source/image URLs and machine identifiers remain byte-for-byte. */
export function projectContentProductionMarkdown(source: string): string {
  if (!source || source.length > 2_000_000) return source;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: MarkdownNode, artifactLabel = false) => {
    if (
      [
        "blockquote",
        "code",
        "inlineCode",
        "html",
        "image",
        "imageReference",
        "definition",
        "linkReference",
      ].includes(node.type)
    )
      return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "link") {
      // External source links (including their original labels) are evidence.
      const localizedUrl = node.url
        ? contentProductionArtifactUrl(node.url)
        : "";
      if (
        !node.url ||
        !/^\/api\/frontmind\/v2\/artifacts\/[^/?#]+\/content(?:\?|$)/u.test(
          node.url,
        ) ||
        start === undefined ||
        end === undefined
      )
        return;
      const raw = source.slice(start, end);
      const destination = raw.lastIndexOf(node.url);
      if (destination >= 0 && localizedUrl !== node.url)
        edits.push({
          start: start + destination,
          end: start + destination + node.url.length,
          text: localizedUrl,
        });
      artifactLabel = true;
    }
    if (node.type === "text" && start !== undefined && end !== undefined) {
      const raw = source.slice(start, end);
      // Bare URLs, paths and identifiers are not prose even without backticks.
      const translated =
        artifactLabel && contentProductionArtifactName(raw) !== raw
          ? contentProductionArtifactName(raw)
          : raw
              .split(
                /(“[^”]*”|「[^」]*」|"[^"\n]*"|(?:https?:\/\/|\/(?:mnt|tmp|api)\/)[^\s<>]+|[\w.-]+(?:[_/][\w.-]+)+|[\w.-]+\.(?:zip|json|md|docx|html))/gu,
              )
              .map((part, index) =>
                index % 2 ? part : contentProductionPublicText(part),
              )
              .join("");
      if (translated !== raw) edits.push({ start, end, text: translated });
    }
    node.children?.forEach((child) => visit(child, artifactLabel));
  };
  visit(fromMarkdown(source) as MarkdownNode);
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.start) + edit.text + text.slice(edit.end),
      source,
    );
}
