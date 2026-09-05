import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Database,
  Download,
  FileText,
  Images,
  Search,
} from "lucide-react";

import MarkdownRenderer from "@/components/MarkdownRenderer";
import { Input } from "@/components/ui/input";
import type { KnowledgeAsset, KnowledgeDocument } from "@shared/dashboard";

type KnowledgeDisplayAsset = KnowledgeAsset & {
  sectionHint?: string;
  source?: string;
  title?: string;
  documentPath?: string;
};

export type KnowledgeSnapshotView = {
  id: string;
  version: number;
  sourceFileName: string;
  documents: KnowledgeDocument[];
  assets: KnowledgeDisplayAsset[];
  documentCount: number;
  imageCount: number;
  characterCount: number;
  totalBytes: number;
  archiveHash?: string | null;
  archiveAvailable?: boolean;
  createdAt: Date | number | string;
};

function archiveFileName(filePath: string) {
  return filePath.replaceAll("\\", "/").split("/").pop()?.toLowerCase() || "";
}

function splitMarkdownSections(content: string) {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line) && current.some((item) => item.trim())) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some((item) => item.trim()))
    sections.push(current.join("\n").trim());
  return sections.filter(Boolean);
}

function sectionHeading(content: string) {
  return content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || "";
}

function normalizedMatchValue(value: string | undefined) {
  return (value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("\\", "/")
    .replace(/https?:\/\//g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const genericAssetTerms = new Set([
  "asset",
  "assets",
  "company",
  "image",
  "images",
  "knowledge",
  "kb",
  "media",
  "photo",
  "photos",
  "picture",
  "pictures",
  "www",
  "com",
  "cn",
  "企业",
  "图片",
  "图像",
  "照片",
  "素材",
  "知识库",
]);

function matchingTerms(value: string) {
  let normalizedValue = value.replaceAll("\\", "/");
  try {
    normalizedValue = decodeURI(normalizedValue);
  } catch {
    // Keep the original text when an imported source contains malformed escapes.
  }
  return normalizedValue
    .split("/")
    .flatMap((part) => {
      const withoutExtension = part.replace(/\.[^.]+$/, "");
      return withoutExtension.split(/[_.\-\s]+/);
    })
    .map((part) => normalizedMatchValue(part))
    .filter(
      (part) =>
        part.length >= 2 && !genericAssetTerms.has(part) && !/^\d+$/.test(part),
    );
}

function assetPathTerms(asset: KnowledgeDisplayAsset) {
  return matchingTerms(asset.path);
}

function includesMeaningful(haystack: string, needle: string) {
  return needle.length >= 2 && haystack.includes(needle);
}

function directReferenceScore(asset: KnowledgeDisplayAsset, section: string) {
  const normalizedSection = section.toLowerCase().replaceAll("\\", "/");
  const assetPath = asset.path.replaceAll("\\", "/").toLowerCase();
  const assetName = archiveFileName(assetPath);
  if (asset.url && normalizedSection.includes(asset.url.toLowerCase()))
    return 1_000;
  if (normalizedSection.includes(assetPath)) return 980;
  if (assetName.length > 3 && normalizedSection.includes(assetName)) return 960;
  return 0;
}

function contextualAssetScore(input: {
  asset: KnowledgeDisplayAsset;
  document: KnowledgeDocument;
  section: string;
}) {
  const { asset, document, section } = input;
  const normalizedSection = normalizedMatchValue(section);
  const normalizedHeading = normalizedMatchValue(sectionHeading(section));
  const normalizedDocument = normalizedMatchValue(
    `${document.title} ${document.path}`,
  );
  let score = 0;

  const sectionHint = normalizedMatchValue(asset.sectionHint);
  if (sectionHint) {
    if (
      includesMeaningful(normalizedHeading, sectionHint) ||
      includesMeaningful(sectionHint, normalizedHeading)
    ) {
      score += 120;
    } else if (includesMeaningful(normalizedSection, sectionHint)) {
      score += 90;
    } else if (includesMeaningful(normalizedDocument, sectionHint)) {
      score += 70;
    }
  }

  const documentPath = normalizedMatchValue(asset.documentPath);
  if (
    documentPath &&
    (includesMeaningful(normalizedDocument, documentPath) ||
      includesMeaningful(documentPath, normalizedDocument))
  ) {
    score += 100;
  }

  for (const value of [asset.caption, asset.alt, asset.title]) {
    const normalized = normalizedMatchValue(value);
    if (!normalized) continue;
    if (
      includesMeaningful(normalizedHeading, normalized) ||
      includesMeaningful(normalized, normalizedHeading)
    ) {
      score += 45;
    } else if (includesMeaningful(normalizedSection, normalized)) {
      score += 32;
    } else if (includesMeaningful(normalizedDocument, normalized)) {
      score += 18;
    }
  }

  const sourceValue = asset.sourcePageUrl || asset.source;
  const source = normalizedMatchValue(sourceValue);
  if (source) {
    if (includesMeaningful(normalizedSection, source)) score += 55;
    else if (
      includesMeaningful(normalizedDocument, source) ||
      includesMeaningful(source, normalizedDocument)
    )
      score += 40;
    for (const term of matchingTerms(sourceValue || "")) {
      if (includesMeaningful(normalizedHeading, term)) score += 28;
      else if (includesMeaningful(normalizedSection, term)) score += 18;
      else if (includesMeaningful(normalizedDocument, term)) score += 12;
    }
  }

  for (const term of assetPathTerms(asset)) {
    if (includesMeaningful(normalizedHeading, term)) score += 20;
    else if (includesMeaningful(normalizedSection, term)) score += 12;
    else if (includesMeaningful(normalizedDocument, term)) score += 8;
  }
  return score;
}

type AssetPlacement = {
  bySection: Map<string, Map<number, KnowledgeDisplayAsset[]>>;
  relatedByDocument: Map<string, KnowledgeDisplayAsset[]>;
};

function placeKnowledgeAssets(snapshot: KnowledgeSnapshotView): AssetPlacement {
  const bySection = new Map<string, Map<number, KnowledgeDisplayAsset[]>>();
  const relatedByDocument = new Map<string, KnowledgeDisplayAsset[]>();
  const documentSections = snapshot.documents.map((document) => ({
    document,
    sections: splitMarkdownSections(document.content),
  }));
  const fallbackDocument = snapshot.documents[0];

  for (const asset of snapshot.assets.filter((candidate) => candidate.url)) {
    const explicitDocumentIds = new Set(asset.documentIds || []);
    const explicitDocuments = documentSections.filter(({ document }) =>
      document.id ? explicitDocumentIds.has(document.id) : false,
    );
    if (explicitDocuments.length > 0) {
      for (const explicitDocument of explicitDocuments) {
        const documentMap =
          bySection.get(explicitDocument.document.path) ||
          new Map<number, KnowledgeDisplayAsset[]>();
        const sectionAssets = documentMap.get(0) || [];
        sectionAssets.push(asset);
        documentMap.set(0, sectionAssets);
        bySection.set(explicitDocument.document.path, documentMap);
      }
      continue;
    }
    let best:
      | {
          documentPath: string;
          sectionIndex: number;
          score: number;
        }
      | undefined;

    for (const entry of documentSections) {
      entry.sections.forEach((section, sectionIndex) => {
        const directScore = directReferenceScore(asset, section);
        const score =
          directScore ||
          contextualAssetScore({
            asset,
            document: entry.document,
            section,
          });
        if (!best || score > best.score) {
          best = {
            documentPath: entry.document.path,
            sectionIndex,
            score,
          };
        }
      });
    }

    if (best && best.score > 0) {
      const documentMap =
        bySection.get(best.documentPath) ||
        new Map<number, KnowledgeDisplayAsset[]>();
      const sectionAssets = documentMap.get(best.sectionIndex) || [];
      sectionAssets.push(asset);
      documentMap.set(best.sectionIndex, sectionAssets);
      bySection.set(best.documentPath, documentMap);
      continue;
    }

    if (fallbackDocument) {
      const related = relatedByDocument.get(fallbackDocument.path) || [];
      related.push(asset);
      relatedByDocument.set(fallbackDocument.path, related);
    }
  }

  return { bySection, relatedByDocument };
}

function assetDisplayName(asset: KnowledgeDisplayAsset) {
  return (
    asset.caption?.trim() ||
    asset.alt?.trim() ||
    asset.title?.trim() ||
    archiveFileName(asset.path)
      .replace(/\.[^.]+$/, "")
      .replaceAll(/[_-]+/g, " ")
  );
}

function knowledgeAssetRoleRank(asset: KnowledgeDisplayAsset) {
  return asset.displayRole === "hero"
    ? 0
    : asset.displayRole === "inline"
      ? 1
      : asset.displayRole === "badge"
        ? 2
        : 1;
}

function sortedKnowledgeAssets(assets: KnowledgeDisplayAsset[]) {
  return [...assets].sort(
    (left, right) =>
      knowledgeAssetRoleRank(left) - knowledgeAssetRoleRank(right),
  );
}

function knowledgeAssetImageClass(asset: KnowledgeDisplayAsset) {
  if (asset.displayRole === "badge") {
    return "aspect-square max-h-40 w-full rounded-2xl bg-white object-contain p-3";
  }
  if (
    [
      "brand_identity",
      "product_ui",
      "product_diagram",
      "certificate_badge",
      "document_figure",
    ].includes(asset.assetType || "")
  ) {
    return "aspect-[4/3] w-full rounded-2xl bg-[#f6f3f8] object-contain p-3";
  }
  return "aspect-[4/3] w-full rounded-2xl bg-[#f6f3f8] object-cover";
}

function isExternalHttpUrl(value: string | undefined) {
  return /^https?:\/\//i.test(value || "");
}

function assetSource(asset: KnowledgeDisplayAsset) {
  return asset.sourcePageUrl || asset.source;
}

const KNOWLEDGE_BRANCH_LABELS: Record<string, string> = {
  identity: "企业身份",
  company: "企业信息",
  "company-identity": "企业身份",
  team: "团队与组织",
  products: "产品与服务",
  product: "产品与服务",
  capabilities: "能力体系",
  "core-capabilities": "核心能力",
  industries: "行业与场景",
  "customers-industries": "客户与行业",
  cases: "案例与成果",
  differentiation: "品牌差异化",
  cooperation: "合作与支持",
};

function knowledgeDocumentCategory(document: KnowledgeDocument) {
  const branchTitle = document.branchTitle?.trim();
  if (branchTitle && /\p{Script=Han}/u.test(branchTitle)) return branchTitle;

  const branchId = document.branchId?.trim().toLowerCase();
  if (branchId) {
    const normalizedBranchId = branchId
      .replace(/^\d+[_-]*/, "")
      .replace(/_/g, "-");
    const localized =
      KNOWLEDGE_BRANCH_LABELS[branchId] ||
      KNOWLEDGE_BRANCH_LABELS[normalizedBranchId];
    if (localized) return localized;
  }

  return document.kind === "overview" ? "分支综述" : "正式知识";
}

function KnowledgeImageGrid({
  assets,
  ariaLabel,
  alternating = false,
}: {
  assets: KnowledgeDisplayAsset[];
  ariaLabel: string;
  alternating?: boolean;
}) {
  const sortedAssets = sortedKnowledgeAssets(assets);
  const primaryAssets = sortedAssets.filter(
    (asset) => asset.displayRole !== "badge",
  );
  const badgeAssets = sortedAssets.filter(
    (asset) => asset.displayRole === "badge",
  );
  const renderAsset = (asset: KnowledgeDisplayAsset) => {
    const displayName = assetDisplayName(asset);
    return (
      <figure key={asset.key} className="min-w-0">
        <img
          src={asset.url}
          alt={asset.alt?.trim() || displayName}
          loading="lazy"
          className={knowledgeAssetImageClass(asset)}
        />
        <figcaption className="px-1 pt-2 text-xs leading-5 text-[#716a80]">
          <span className="block break-words font-medium text-[#51495d]">
            {displayName}
          </span>
          {isExternalHttpUrl(assetSource(asset)) && (
            <a
              href={assetSource(asset)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex text-[#6d3497] hover:underline"
            >
              查看图片来源
            </a>
          )}
        </figcaption>
      </figure>
    );
  };

  return (
    <div
      aria-label={ariaLabel}
      className={`grid h-full gap-3 border-[#e8e1ee] bg-white p-4 ${
        alternating ? "lg:order-first lg:border-r" : "lg:border-l"
      }`}
    >
      {primaryAssets.map(renderAsset)}
      {badgeAssets.length > 0 && (
        <div
          aria-label={`${ariaLabel}徽章`}
          className="grid grid-cols-2 gap-3 border-t border-[#eee7f2] pt-3 sm:grid-cols-3"
        >
          {badgeAssets.map(renderAsset)}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeBaseViewer({
  snapshot,
  loading = false,
  showArchiveDownload = true,
}: {
  snapshot?: KnowledgeSnapshotView | null;
  loading?: boolean;
  showArchiveDownload?: boolean;
}) {
  const [view, setView] = useState<"knowledge" | "assets">("knowledge");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assetPage, setAssetPage] = useState(0);

  const formalDocuments = useMemo(
    () =>
      snapshot?.documents.filter(
        (document) =>
          document.customerVisible !== false &&
          !["evidence", "report", "index"].includes(document.kind || ""),
      ) || [],
    [snapshot],
  );
  useEffect(() => {
    setView("knowledge");
    setSelectedPath(
      formalDocuments.find((document) => document.kind === "overview")?.path ??
        formalDocuments[0]?.path ??
        snapshot?.documents[0]?.path ??
        null,
    );
    setAssetPage(0);
  }, [snapshot?.id]);

  const filteredDocuments = useMemo(() => {
    if (!snapshot) return [];
    const documents = formalDocuments;
    const keyword = search.trim().toLowerCase();
    if (!keyword) return documents;
    return documents.filter(
      (document) =>
        document.title.toLowerCase().includes(keyword) ||
        document.path.toLowerCase().includes(keyword) ||
        document.content.toLowerCase().includes(keyword),
    );
  }, [formalDocuments, search, snapshot]);

  const selectedDocument =
    filteredDocuments.find((document) => document.path === selectedPath) ||
    filteredDocuments[0] ||
    formalDocuments[0];
  const documentSections = useMemo(
    () =>
      selectedDocument ? splitMarkdownSections(selectedDocument.content) : [],
    [selectedDocument],
  );
  const assetPlacement = useMemo(
    () => (snapshot ? placeKnowledgeAssets(snapshot) : null),
    [snapshot],
  );
  const selectedSectionAssets = selectedDocument
    ? assetPlacement?.bySection.get(selectedDocument.path)
    : undefined;
  const selectedRelatedAssets = selectedDocument
    ? sortedKnowledgeAssets(
        assetPlacement?.relatedByDocument.get(selectedDocument.path) || [],
      )
    : [];
  const assetPageSize = 24;
  const assetPageCount = Math.max(
    1,
    Math.ceil((snapshot?.assets.length || 0) / assetPageSize),
  );
  const pagedAssets = sortedKnowledgeAssets(snapshot?.assets || []).slice(
    assetPage * assetPageSize,
    assetPage * assetPageSize + assetPageSize,
  );
  if (loading) {
    return (
      <div className="grid min-h-[520px] place-items-center rounded-[20px] border border-[#e8e1ee] bg-white/80">
        <div className="text-center text-sm text-[#716a80]">
          <Database className="mx-auto mb-3 h-7 w-7 animate-pulse text-[#5b2a86]" />
          正在加载知识库
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="grid min-h-[520px] place-items-center rounded-[20px] border border-dashed border-[#d8cde3] bg-white/65 px-6 text-center">
        <div className="max-w-md">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#5b2a86]/10 text-[#5b2a86]">
            <BookOpen className="h-6 w-6" />
          </div>
          <h2 className="mt-5 text-xl font-semibold text-[#171321]">
            尚未发布知识库
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#716a80]">
            在“构建流程”中完成全部节点后，点击“更新知识库”同步最终内容；管理员也可以上传已有知识库文件。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {showArchiveDownload &&
        snapshot.sourceFileName.toLowerCase().endsWith(".zip") &&
        snapshot.archiveAvailable === true &&
        /^[a-f0-9]{64}$/i.test(snapshot.archiveHash || "") && (
          <div className="flex justify-end">
            <a
              href={`/api/dashboard/knowledge/snapshots/${encodeURIComponent(snapshot.id)}/archive`}
              download={snapshot.sourceFileName}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#5b2a86] px-4 text-sm font-medium text-white shadow-sm transition hover:bg-[#49216c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b2a86] focus-visible:ring-offset-2"
            >
              <Download className="h-4 w-4" />
              下载成品 ZIP
            </a>
          </div>
        )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          ["知识文档", `${snapshot.documentCount} 篇`],
          ["图片资产", `${snapshot.imageCount} 张`],
          ["内容字数", snapshot.characterCount.toLocaleString("zh-CN")],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-[#e8e1ee] bg-white px-4 py-3 shadow-[0_8px_24px_rgba(33,19,58,.045)]"
          >
            <p className="text-xs text-[#716a80]">{label}</p>
            <p className="mt-1 text-lg font-semibold text-[#5b2a86]">{value}</p>
          </div>
        ))}
      </div>

      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label="知识库内容视图"
      >
        {(
          [
            ["knowledge", "正式知识"],
            ["assets", `图片素材 ${snapshot.imageCount}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => {
              setView(id);
              setSearch("");
              if (id === "knowledge") {
                setSelectedPath(
                  formalDocuments.find(
                    (document) => document.kind === "overview",
                  )?.path ??
                    formalDocuments[0]?.path ??
                    null,
                );
              }
            }}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
              view === id
                ? "border-[#5b2a86] bg-[#5b2a86] text-white"
                : "border-[#ded5e6] bg-white text-[#5d5569] hover:bg-[#f5f0f8]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "assets" ? (
        <section className="overflow-hidden rounded-[20px] border border-[#e8e1ee] bg-white shadow-[0_18px_48px_rgba(33,19,58,.07)]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e8e1ee] px-5 py-4 sm:px-7">
            <div>
              <p className="text-xs font-semibold text-[#5b2a86]">
                第一方图片素材
              </p>
              <h2 className="mt-1 text-xl font-semibold text-[#171321]">
                已验证并随知识库交付的图片
              </h2>
            </div>
            <span className="text-sm text-[#716a80]">
              第 {assetPage + 1} / {assetPageCount} 页
            </span>
          </header>
          {pagedAssets.length > 0 ? (
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {pagedAssets.map((asset) => {
                const displayName = assetDisplayName(asset);
                return (
                  <figure key={asset.id || asset.key} className="min-w-0">
                    <img
                      src={asset.url}
                      alt={asset.alt?.trim() || displayName}
                      loading="lazy"
                      className={knowledgeAssetImageClass(asset)}
                    />
                    <figcaption className="px-1 pt-2 text-xs leading-5 text-[#716a80]">
                      <span className="block break-words font-medium text-[#51495d]">
                        {displayName}
                      </span>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-64 place-items-center text-sm text-[#716a80]">
              当前知识库没有已验证图片
            </div>
          )}
          {assetPageCount > 1 && (
            <footer className="flex justify-end gap-2 border-t border-[#e8e1ee] px-5 py-4">
              <button
                type="button"
                disabled={assetPage === 0}
                onClick={() => setAssetPage((page) => Math.max(0, page - 1))}
                className="rounded-lg border border-[#ded5e6] px-3 py-1.5 text-sm disabled:opacity-40"
              >
                上一页
              </button>
              <button
                type="button"
                disabled={assetPage >= assetPageCount - 1}
                onClick={() =>
                  setAssetPage((page) => Math.min(assetPageCount - 1, page + 1))
                }
                className="rounded-lg border border-[#ded5e6] px-3 py-1.5 text-sm disabled:opacity-40"
              >
                下一页
              </button>
            </footer>
          )}
        </section>
      ) : (
        <div className="grid min-h-[650px] overflow-hidden rounded-[20px] border border-[#e8e1ee] bg-white shadow-[0_18px_48px_rgba(33,19,58,.07)] lg:grid-cols-[290px_minmax(0,1fr)]">
          <aside className="border-b border-[#e8e1ee] bg-[#fbf9fd] p-4 lg:border-b-0 lg:border-r">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a94a8]" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索全部知识内容"
                className="border-[#e1d8e8] bg-white pl-9"
              />
            </div>
            <p className="mb-2 mt-5 px-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#9a94a8]">
              正式知识目录
            </p>
            <div className="max-h-[510px] space-y-1 overflow-y-auto pr-1 custom-scrollbar">
              {filteredDocuments.map((document) => (
                <button
                  key={document.path}
                  type="button"
                  onClick={() => setSelectedPath(document.path)}
                  className={`flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left transition ${
                    selectedDocument?.path === document.path
                      ? "bg-[#5b2a86] text-white"
                      : "text-[#4f485c] hover:bg-[#eee8f2]"
                  }`}
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {document.title}
                    </span>
                    <span
                      className={`mt-0.5 block truncate text-xs ${
                        selectedDocument?.path === document.path
                          ? "text-white/60"
                          : "text-[#9a94a8]"
                      }`}
                    >
                      {knowledgeDocumentCategory(document)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <article className="min-w-0 p-5 sm:p-8 lg:p-10">
            {selectedDocument ? (
              <>
                <div className="mb-6">
                  <p className="text-xs font-semibold text-[#5b2a86]">
                    正式知识
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[#171321]">
                    {selectedDocument.title}
                  </h2>
                </div>
                <div className="space-y-6">
                  {documentSections.map((section, index) => {
                    const sectionAssets =
                      selectedSectionAssets?.get(index) || [];
                    return (
                      <section
                        key={`${selectedDocument.path}-${index}`}
                        className={`overflow-hidden rounded-[22px] border border-[#e8e1ee] bg-[#fbf9fd] ${
                          sectionAssets.length > 0
                            ? "grid items-start lg:grid-cols-[minmax(0,1fr)_minmax(280px,.72fr)]"
                            : ""
                        }`}
                      >
                        <div className="min-w-0 p-5 sm:p-7">
                          <MarkdownRenderer
                            content={section}
                            className="max-w-none text-[15px] leading-7"
                          />
                        </div>
                        {sectionAssets.length > 0 && (
                          <KnowledgeImageGrid
                            assets={sectionAssets.slice(0, 3)}
                            ariaLabel={`${sectionHeading(section) || "知识正文"}配图`}
                            alternating={index % 2 === 1}
                          />
                        )}
                      </section>
                    );
                  })}
                  {selectedRelatedAssets.length > 0 && (
                    <section
                      aria-label="相关图片"
                      className="overflow-hidden rounded-[22px] border border-[#e8e1ee] bg-[#fbf9fd]"
                    >
                      <div className="flex items-center gap-3 border-b border-[#e8e1ee] px-5 py-4 sm:px-7">
                        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#5b2a86]/10 text-[#5b2a86]">
                          <Images className="h-4 w-4" />
                        </span>
                        <h3 className="text-base font-semibold text-[#2e2738]">
                          相关图片
                        </h3>
                      </div>
                      <KnowledgeImageGrid
                        assets={selectedRelatedAssets.slice(0, 3)}
                        ariaLabel="相关图片配图"
                      />
                    </section>
                  )}
                </div>
              </>
            ) : (
              <div className="grid h-full place-items-center text-sm text-[#716a80]">
                没有匹配的知识内容
              </div>
            )}
          </article>
        </div>
      )}
    </div>
  );
}
