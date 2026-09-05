export type MediaCitationRow = readonly [
  domain: string,
  media: string,
  citations: number,
  share: string,
];

export type ContentCitationRow = readonly [
  title: string,
  media: string,
  domain: string,
  url: string,
  citations: number,
  share: string,
];

export type QuestionCitationRow = readonly [
  model: string,
  question: string,
  title: string,
  url: string,
  media: string,
  date: string,
];

export type CitationDistributionData = {
  mediaRows: MediaCitationRow[];
  contentRows: ContentCitationRow[];
  questionRows: QuestionCitationRow[];
};

export const citationRecordCounts = {
  media: 112,
  content: 346,
  question: 705,
  total: 1163,
} as const;

export const citationModelLabels: Readonly<Record<string, string>> = {
  baiduai: "百度 AI",
  yuanbao: "腾讯元宝",
  doubao: "豆包",
  qianwen: "通义千问",
  deepseek: "DeepSeek",
};

export const citationDistributionDataUrl =
  "/citation-distribution-20260727-101630.b64";

let citationDataPromise: Promise<CitationDistributionData> | null = null;

export async function decodeCitationDistributionPayload(
  encodedPayload: string,
): Promise<CitationDistributionData> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("当前浏览器不支持引用数据解压，请升级后重试。");
  }

  const normalizedPayload = encodedPayload.replace(/\s+/g, "");
  const binary = globalThis.atob(normalizedPayload);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const compressedStream = new Response(buffer).body;
  if (!compressedStream) {
    throw new Error("无法读取引用分析数据。");
  }

  const decompressed = compressedStream.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const json = await new Response(decompressed).text();
  const [mediaRows, contentRows, questionRows] = JSON.parse(json) as [
    MediaCitationRow[],
    ContentCitationRow[],
    QuestionCitationRow[],
  ];

  if (
    mediaRows.length !== citationRecordCounts.media ||
    contentRows.length !== citationRecordCounts.content ||
    questionRows.length !== citationRecordCounts.question
  ) {
    throw new Error("引用分析数据不完整，请重新导入。");
  }

  return { mediaRows, contentRows, questionRows };
}

export function loadCitationDistributionData() {
  citationDataPromise ??= fetch(citationDistributionDataUrl, {
    cache: "force-cache",
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error("引用分析数据加载失败。");
      }
      return response.text();
    })
    .then(decodeCitationDistributionPayload);

  return citationDataPromise;
}
