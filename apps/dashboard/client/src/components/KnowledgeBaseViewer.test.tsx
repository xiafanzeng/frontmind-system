import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import KnowledgeBaseViewer, {
  type KnowledgeSnapshotView,
} from "./KnowledgeBaseViewer";

const snapshot: KnowledgeSnapshotView = {
  id: "snapshot-1",
  version: 3,
  sourceFileName: "企业知识库.zip",
  documents: [
    {
      path: "01/company.md",
      title: "企业概览",
      content: "## 企业概览\n企业基本信息。",
    },
    {
      path: "02/products.md",
      title: "产品方案",
      content: "## 产品方案\n产品与解决方案。",
    },
  ],
  assets: [
    {
      key: "asset-1",
      path: "images/factory.jpg",
      mimeType: "image/jpeg",
      size: 2_048,
      url: "/api/dashboard/knowledge/assets/snapshot-1/0",
      branchId: "identity",
    },
    {
      key: "asset-2",
      path: "images/product-line.jpg",
      mimeType: "image/jpeg",
      size: 3_072,
      url: "/api/dashboard/knowledge/assets/snapshot-1/1",
      sectionHint: "产品方案",
      caption: "产品解决方案示意图",
      alt: "产品解决方案",
      source: "https://example.com/products",
    },
  ],
  documentCount: 2,
  imageCount: 2,
  characterCount: 22,
  totalBytes: 1_024,
  createdAt: "2026-07-25T08:00:00.000Z",
};

describe("KnowledgeBaseViewer", () => {
  it("offers the authenticated snapshot ZIP from the published knowledge view", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          archiveHash: "a".repeat(64),
          archiveAvailable: true,
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "下载成品 ZIP" })).toHaveAttribute(
      "href",
      "/api/dashboard/knowledge/snapshots/snapshot-1/archive",
    );
    expect(screen.getByRole("link", { name: "下载成品 ZIP" })).toHaveAttribute(
      "download",
      "企业知识库.zip",
    );
  });

  it("does not advertise a ZIP when the snapshot has no persisted archive hash", () => {
    render(<KnowledgeBaseViewer snapshot={snapshot} />);

    expect(screen.queryByRole("link", { name: "下载成品 ZIP" })).toBeNull();
  });

  it("does not advertise a historical ZIP whose archive bytes are unavailable", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          archiveHash: "a".repeat(64),
          archiveAvailable: false,
        }}
      />,
    );

    expect(screen.queryByRole("link", { name: "下载成品 ZIP" })).toBeNull();
  });

  it("can leave the ZIP action to the containing page header", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          archiveHash: "a".repeat(64),
          archiveAvailable: true,
        }}
        showArchiveDownload={false}
      />,
    );

    expect(screen.queryByRole("link", { name: "下载成品 ZIP" })).toBeNull();
  });

  it("keeps authoritative snapshot metrics but omits a decorative directory count", () => {
    render(<KnowledgeBaseViewer snapshot={snapshot} />);

    expect(screen.getByText("正式知识目录")).toBeTruthy();
    expect(screen.queryByText(/文档目录\s*·\s*2/)).toBeNull();
    expect(screen.getByText("2 篇")).toBeTruthy();
    expect(screen.getByText("2 张")).toBeTruthy();
    expect(screen.getByText("22")).toBeTruthy();
    expect(screen.queryByText("版本")).toBeNull();
    expect(screen.queryByText("V3")).toBeNull();
    expect(screen.queryByText("待关联图片资产")).toBeNull();
  });

  it("places unmatched images in a related-images section inside the knowledge document", () => {
    render(<KnowledgeBaseViewer snapshot={snapshot} />);

    const relatedSection = screen.getByRole("region", {
      name: "相关图片",
    });
    expect(
      within(relatedSection).getByRole("img", { name: "知识库配图" }),
    ).toBeTruthy();
    expect(within(relatedSection).queryByText("factory")).toBeNull();
    expect(screen.queryByText("待关联图片资产")).toBeNull();
  });

  it("sorts image roles and renders badges separately without cropping diagrams", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          assets: [
            {
              key: "badge",
              path: "images/certificate.png",
              mimeType: "image/png",
              size: 1_024,
              url: "/badge",
              alt: "认证徽章",
              assetType: "certificate_badge",
              displayRole: "badge",
            },
            {
              key: "inline",
              path: "images/asset-b.png",
              mimeType: "image/png",
              size: 2_048,
              url: "/inline",
              alt: "产品界面",
              assetType: "product_ui",
              displayRole: "inline",
            },
            {
              key: "hero",
              path: "images/brand-hero.jpg",
              mimeType: "image/jpeg",
              size: 3_072,
              url: "/hero",
              alt: "品牌主视觉",
              assetType: "case_photo",
              displayRole: "hero",
            },
          ],
          imageCount: 3,
        }}
      />,
    );

    const relatedSection = screen.getByRole("region", { name: "相关图片" });
    const images = within(relatedSection).getAllByRole("img");
    expect(images.map((image) => image.getAttribute("alt"))).toEqual([
      "品牌主视觉",
      "产品界面",
      "认证徽章",
    ]);
    expect(screen.getByLabelText("相关图片配图徽章")).toBeTruthy();
    expect(screen.getByRole("img", { name: "品牌主视觉" })).toHaveClass(
      "object-cover",
    );
    expect(screen.getByRole("img", { name: "产品界面" })).toHaveClass(
      "object-contain",
    );
    expect(screen.getByRole("img", { name: "认证徽章" })).toHaveClass(
      "object-contain",
      "aspect-square",
    );
  });

  it("uses image metadata to place an asset beside its matching section", () => {
    render(<KnowledgeBaseViewer snapshot={snapshot} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /产品方案/,
      }),
    );

    const productImages = screen.getByLabelText("产品方案配图");
    expect(
      within(productImages).getByRole("img", { name: "产品解决方案" }),
    ).toBeTruthy();
    expect(within(productImages).getByText("产品解决方案示意图")).toBeTruthy();
    expect(
      within(productImages).getByRole("link", { name: "查看图片来源" }),
    ).toHaveAttribute("href", "https://example.com/products");
    expect(screen.queryByRole("region", { name: "相关图片" })).toBeNull();
  });

  it("omits internal evidence controls and document metadata from formal knowledge", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          documents: [
            {
              id: "overview",
              path: "branches/company/00_overview.md",
              title: "企业正式综述",
              content: "## 企业正式综述\n可直接面向客户展示的内容。",
              kind: "overview",
              branchId: "identity",
              customerVisible: true,
              contentStatus: "limited_evidence",
            },
            {
              id: "leaf",
              path: "branches/company/identity.md",
              title: "企业定位",
              content: "## 企业定位\n正式知识叶子。",
              kind: "leaf",
              branchId: "identity",
              customerVisible: true,
            },
            {
              id: "report",
              path: "00_crawl_coverage_report.md",
              title: "官网采集报告",
              content: "## 页面摘录\n仅供证据核验。",
              kind: "report",
              customerVisible: false,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getAllByRole("heading", { name: "企业正式综述" }),
    ).toHaveLength(1);
    expect(screen.queryByText("仅供证据核验。")).toBeNull();
    expect(screen.queryByRole("tab", { name: "证据与来源" })).toBeNull();
    expect(
      screen.queryByText(/公开证据有限：本章节已整理当前可核验信息/),
    ).toBeNull();
    expect(screen.queryByText("branches/company/00_overview.md")).toBeNull();
    expect(screen.getAllByText("企业身份").length).toBeGreaterThan(0);
    expect(screen.queryByText("identity")).toBeNull();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("keeps section headings while removing a repeated document heading", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          documents: [
            {
              path: "branches/company/culture.md",
              title: "品牌命名与文化内涵「天印溯方」",
              content:
                "## 品牌命名与文化内涵「天印溯方」\n正文内容。\n\n### 文化脉络\n章节内容。",
              kind: "leaf",
              customerVisible: true,
            },
          ],
        }}
      />,
    );

    expect(
      screen.getAllByRole("heading", {
        name: "品牌命名与文化内涵「天印溯方」",
      }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "文化脉络" }),
    ).toBeInTheDocument();
    expect(screen.getByText("正文内容。")).toBeInTheDocument();
    expect(screen.getByText("章节内容。")).toBeInTheDocument();
  });

  it("does not show internal branch identifiers in the image gallery", () => {
    render(<KnowledgeBaseViewer snapshot={snapshot} />);

    fireEvent.click(screen.getByRole("tab", { name: "图片素材 2" }));

    expect(screen.queryByText("分支：identity")).toBeNull();
  });

  it("never renders imported image filenames as captions or alt text", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          assets: [
            {
              key: "private/storage/clinic-reception.jpg",
              path: "working-set/assets/clinic-reception.jpg",
              mimeType: "image/jpeg",
              size: 2_048,
              url: "/api/dashboard/knowledge/assets/snapshot-1/0",
              caption: "clinic-reception.jpg",
              alt: "images/clinic-signage.jpg",
            },
          ],
          imageCount: 1,
        }}
      />,
    );

    expect(screen.getByRole("img", { name: "知识库配图" })).toBeTruthy();
    expect(screen.queryByText("clinic-reception.jpg")).toBeNull();
    expect(screen.queryByText("clinic-signage.jpg")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "图片素材 1" }));
    expect(screen.getByRole("img", { name: "知识库配图" })).toBeTruthy();
    expect(screen.queryByText("clinic-reception.jpg")).toBeNull();
    expect(screen.queryByText("clinic-signage.jpg")).toBeNull();
  });

  it("uses a semantic official Logo label for filename-only historical metadata", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          assets: [
            {
              key: "historical-logo",
              path: "assets/customer-logo.png",
              mimeType: "image/png",
              size: 1_024,
              url: "/api/dashboard/knowledge/assets/snapshot-1/0",
              caption: "customer-logo.png",
              alt: "uploads/customer-logo.png",
              sourceKind: "official_logo_upload",
              assetType: "brand_identity",
              displayRole: "badge",
            },
          ],
          imageCount: 1,
        }}
      />,
    );

    expect(screen.getByRole("img", { name: "企业官方主 Logo" })).toBeTruthy();
    expect(screen.getByText("企业官方主 Logo")).toBeTruthy();
    expect(screen.queryByText("customer-logo.png")).toBeNull();
  });

  it("uses one manifest asset on every explicitly linked document", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          documents: [
            {
              id: "overview",
              path: "branches/products/00_overview.md",
              title: "产品综述",
              content: "## 产品综述\n产品正式综述。",
              kind: "overview",
              branchId: "products",
              customerVisible: true,
            },
            {
              id: "leaf",
              path: "branches/products/family-a.md",
              title: "产品族 A",
              content: "## 产品族 A\n产品族正式知识。",
              kind: "leaf",
              branchId: "products",
              customerVisible: true,
            },
          ],
          assets: [
            {
              id: "product-image",
              key: "product-image",
              path: "branches/products/images/family-a.webp",
              mimeType: "image/webp",
              size: 3_072,
              url: "/api/dashboard/knowledge/assets/snapshot-1/by-id/product-image",
              caption: "产品族 A 官方图片",
              documentIds: ["overview", "leaf"],
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("img", { name: "产品族 A 官方图片" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /产品族 A/ }));
    expect(screen.getByRole("img", { name: "产品族 A 官方图片" })).toBeTruthy();
  });

  it("shows sparse formal knowledge without an internal evidence notice", () => {
    render(
      <KnowledgeBaseViewer
        snapshot={{
          ...snapshot,
          documents: [
            {
              id: "sparse-overview",
              path: "branches/company/00_overview.md",
              title: "企业公开资料综述",
              content: "## 企业公开资料综述\n当前仅能确认企业名称与官网。",
              kind: "overview",
              customerVisible: true,
              contentStatus: "limited_evidence",
            },
          ],
        }}
      />,
    );

    expect(
      screen.queryByText(/公开证据有限：本章节已整理当前可核验信息/),
    ).toBeNull();
    expect(screen.getByText("当前仅能确认企业名称与官网。")).toBeTruthy();
  });
});
