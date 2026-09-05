import { createHash } from "node:crypto";

import { knowledgeBaseSnapshots } from "../../drizzle/schema";
import {
  canonicalSiteContentPlanSha256,
  knowledgeCoverageInventoryV1Schema,
  SITEOPS_CONTENT_PLAN_V2_FILENAME,
  type KnowledgeCoverageInventoryV1,
} from "../../shared/siteops-content-plan";

type KnowledgeSnapshot = typeof knowledgeBaseSnapshots.$inferSelect;
export type SupplementalKnowledgeDocument = {
  id: string;
  path: string;
  title: string;
  content: string;
  kind: string;
  customerVisible: true;
};

export type SupplementalKnowledgeMedia = {
  id: string;
  sha256: string;
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  caption: string | null;
  alt: string | null;
  size: number;
  width: number;
  height: number;
  sourceDocumentIds: string[];
};

type InventoryDocument = {
  id?: string;
  path: string;
  title: string;
  content: string;
  kind?: string;
  branchTitle?: string;
};

function sourceDocumentId(document: InventoryDocument) {
  return String(document.id || document.path).slice(0, 191);
}

function compact(value: string, max: number) {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

function documentTopics(
  document: InventoryDocument,
): KnowledgeCoverageInventoryV1["documents"][number]["topics"] {
  const text = `${document.branchTitle ?? ""} ${document.title} ${document.path} ${document.content}`;
  const topics: KnowledgeCoverageInventoryV1["documents"][number]["topics"] =
    [];
  const add = (topic: (typeof topics)[number], pattern: RegExp) => {
    if (pattern.test(text)) topics.push(topic);
  };
  add("company", /公司|企业|品牌|团队|使命|愿景|简介|关于/u);
  add("product", /产品|设备|软件|平台|型号|功能/u);
  add("service", /服务|解决方案|业务|咨询|交付/u);
  add("application", /应用|场景|行业方案|适用于|面向/u);
  add("case_study", /案例|客户故事|实践|项目成果/u);
  add("knowledge", /博客|知识|科普|指南|洞察|白皮书|研究/u);
  add("company_news", /企业新闻|公司新闻|企业动态|公司动态|新闻中心/u);
  add("faq", /FAQ|常见问题|问答|Q&A|？|\?/iu);
  add("contact", /联系|电话|手机|邮箱|地址|@/u);
  return topics.length > 0 ? [...new Set(topics)] : ["other"];
}

function evidenceUnitCount(content: string) {
  return evidenceUnits(content).length;
}

function evidenceUnits(content: string) {
  const raw = content
    .split(/\n\s*\n|(?<=[。！？.!?])\s+/u)
    .map((value) => value.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  return raw.flatMap((value) => {
    if (Array.from(value).length <= 2_000) return [value];
    const characters = Array.from(value);
    const chunks: string[] = [];
    for (let offset = 0; offset < characters.length; offset += 2_000) {
      chunks.push(characters.slice(offset, offset + 2_000).join(""));
    }
    return chunks;
  });
}

function publicDocuments(
  snapshot: KnowledgeSnapshot,
  supplementalDocuments: readonly SupplementalKnowledgeDocument[],
): InventoryDocument[] {
  return [
    ...snapshot.documents.filter(
      (document) =>
        document.customerVisible !== false &&
        document.kind !== "evidence" &&
        document.evidenceStatus !== "inferred",
    ),
    ...supplementalDocuments,
  ];
}

/** Complete coverage ledger for 2.9. It intentionally performs no route
 * selection and no first-N sampling. Full document bodies continue to travel
 * in the source dossier; this inventory binds every eligible document to the
 * provider's later used/omitted decision. */
export function knowledgeCoverageInventoryFromSnapshot(
  snapshot: KnowledgeSnapshot,
  supplementalDocuments: readonly SupplementalKnowledgeDocument[] = [],
  supplementalMedia: readonly SupplementalKnowledgeMedia[] = [],
) {
  if (!snapshot.archiveHash) {
    throw new Error("SITEOPS_KNOWLEDGE_ARCHIVE_HASH_MISSING");
  }
  const documents = publicDocuments(snapshot, supplementalDocuments);
  const documentIds = new Set(documents.map(sourceDocumentId));
  const contacts: KnowledgeCoverageInventoryV1["contacts"] = [];
  const contactKeys = new Set<string>();
  const addContact = (
    kind: "email" | "phone" | "address",
    value: string,
    sourceId: string,
  ) => {
    const normalized = compact(value, 512);
    const key = `${kind}:${normalized.toLocaleLowerCase()}`;
    if (!normalized || contactKeys.has(key)) return;
    contactKeys.add(key);
    contacts.push({ kind, value: normalized, sourceDocumentIds: [sourceId] });
  };
  for (const document of documents) {
    const sourceId = sourceDocumentId(document);
    for (const email of document.content.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
    ) ?? []) {
      addContact("email", email, sourceId);
    }
    for (const phone of document.content.match(
      /(?:\+?86[-\s]?)?(?:1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})/gu,
    ) ?? []) {
      addContact("phone", phone, sourceId);
    }
    for (const match of document.content.matchAll(
      /(?:办公地址|联系地址|公司地址|地址)\s*[:：]\s*([^\n]{4,500})/gu,
    )) {
      addContact("address", match[1] ?? "", sourceId);
    }
  }
  const facts = documents.flatMap((document) => {
    const sourceId = sourceDocumentId(document);
    return evidenceUnits(document.content).map((statement, index) => ({
      id: `fact-${createHash("sha256")
        .update(`${sourceId}:${index}:${statement}`, "utf8")
        .digest("hex")
        .slice(0, 32)}`,
      statement,
      sourceDocumentId: sourceId,
    }));
  });
  const faqs = documents.flatMap((document) => {
    const units = evidenceUnits(document.content);
    const sourceId = sourceDocumentId(document);
    return units.flatMap((question, index) => {
      if (!/[？?]$/u.test(question)) return [];
      const answer = units[index + 1];
      if (!answer || /[？?]$/u.test(answer)) return [];
      return [
        {
          id: `faq-${createHash("sha256")
            .update(`${sourceId}:${index}:${question}:${answer}`, "utf8")
            .digest("hex")
            .slice(0, 32)}`,
          question: compact(question, 1_000),
          answer: compact(answer, 4_000),
          sourceDocumentIds: [sourceId],
        },
      ];
    });
  });
  return knowledgeCoverageInventoryV1Schema.parse({
    schemaVersion: 1,
    source: "frozen_knowledge_snapshot",
    snapshotId: snapshot.id,
    archiveSha256: snapshot.archiveHash,
    documents: documents.map((document) => ({
      id: sourceDocumentId(document),
      path: document.path.slice(0, 512),
      title: compact(document.title || document.path, 255),
      kind: String(document.kind || "document").slice(0, 64),
      contentSha256: createHash("sha256")
        .update(document.content, "utf8")
        .digest("hex"),
      characterCount: Array.from(document.content).length,
      evidenceUnitCount: evidenceUnitCount(document.content),
      topics: documentTopics(document),
    })),
    entities: documents.map((document) => ({
      id: `entity-${createHash("sha256")
        .update(sourceDocumentId(document), "utf8")
        .digest("hex")
        .slice(0, 32)}`,
      label: compact(document.title || document.path, 255),
      kind: String(document.kind || "document").slice(0, 64),
      sourceDocumentIds: [sourceDocumentId(document)],
    })),
    facts,
    faqs,
    contacts,
    media: [
      ...snapshot.assets.flatMap((asset) => {
        if (
          !asset.id ||
          asset.id.startsWith("customer-media:") ||
          !asset.sha256 ||
          !/^[a-f0-9]{64}$/iu.test(asset.sha256) ||
          asset.ownership !== "first_party" ||
          !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType) ||
          !Number.isInteger(asset.size) ||
          asset.size < 1 ||
          asset.size > 8 * 1024 * 1024
        ) {
          return [];
        }
        const sourceIds = (asset.documentIds ?? []).filter((value) =>
          documentIds.has(value),
        );
        return [
          {
            id: asset.id.slice(0, 191),
            sha256: asset.sha256.toLowerCase(),
            path: String(asset.path || asset.key || asset.id).slice(0, 1_024),
            mimeType: asset.mimeType.slice(0, 191),
            caption: asset.caption ? compact(asset.caption, 1_000) : null,
            alt: asset.alt ? compact(asset.alt, 500) : null,
            size: asset.size,
            width: asset.width && asset.width <= 20_000 ? asset.width : null,
            height:
              asset.height && asset.height <= 20_000 ? asset.height : null,
            sourceDocumentIds: sourceIds,
          },
        ];
      }),
      ...supplementalMedia.map((asset) => ({
        id: asset.id.slice(0, 191),
        sha256: asset.sha256.toLowerCase(),
        path: asset.path.slice(0, 1_024),
        mimeType: asset.mimeType,
        caption: asset.caption ? compact(asset.caption, 1_000) : null,
        alt: asset.alt ? compact(asset.alt, 500) : null,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        sourceDocumentIds: asset.sourceDocumentIds.filter((value) =>
          documentIds.has(value),
        ),
      })),
    ],
  });
}

export function knowledgeCoverageInventoryAttachment(
  inventory: KnowledgeCoverageInventoryV1,
) {
  const parsed = knowledgeCoverageInventoryV1Schema.parse(inventory);
  const inventorySha256 = canonicalSiteContentPlanSha256(parsed);
  const bytes = Buffer.from(
    `${JSON.stringify({ ...parsed, inventorySha256 })}\n`,
    "utf8",
  );
  return {
    inventorySha256,
    attachment: {
      filename: "frontmind-knowledge-coverage-inventory-v1.json",
      mime_type: "application/json",
      file_data: `data:application/json;base64,${bytes.toString("base64")}`,
    } as const,
    requiredOutputFilename: SITEOPS_CONTENT_PLAN_V2_FILENAME,
  };
}
