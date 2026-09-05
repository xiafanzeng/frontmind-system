import { describe, expect, it } from "vitest";

import type { KnowledgeAsset } from "../shared/dashboard";

import {
  KnowledgeBasePackageBindingError,
  assertKnowledgeBasePackageMatchesBuild,
  canonicalPackagedKnowledgeBaseLeafMarkdown,
  knowledgeBaseMarkdownSha256,
  selectLegacyKnowledgeBaseLogoAsset,
} from "./knowledge-base-package-validation";

const logoSha256 = "a".repeat(64);
const customerSha256 = "c".repeat(64);
const expectedOfficialLogoUpload = {
  sourceSha256: logoSha256,
  fileId: "file-official-logo",
  filename: "company-logo.png",
  mimeType: "image/png",
  sizeBytes: 42,
};

function fixture() {
  return {
    nodes: [
      {
        leafId: "1.1",
        title: "一句话定位",
        branchId: "identity",
        branchTitle: "企业身份",
        ordinal: 0,
        status: "confirmed",
        contentMarkdown: "## 1.1 一句话定位\n\nFrontMind 超前智能。",
        contentSha256: knowledgeBaseMarkdownSha256(
          "## 1.1 一句话定位\n\nFrontMind 超前智能。",
        ),
      },
      {
        leafId: "1.2",
        title: "公司主体",
        branchId: "identity",
        branchTitle: "企业身份",
        ordinal: 1,
        status: "direct_prefilled",
        contentMarkdown: "## 1.2 公司主体\n\n北京示例公司。",
        contentSha256: knowledgeBaseMarkdownSha256(
          "## 1.2 公司主体\n\n北京示例公司。",
        ),
      },
    ],
    documents: [
      {
        id: "1.1",
        path: "leaves/1.1.md",
        kind: "leaf" as const,
        title: "一句话定位",
        branchId: "identity",
        branchTitle: "企业身份",
        order: 0,
        customerVisible: true,
        content: "## 1.1 一句话定位\r\n\r\nFrontMind 超前智能。\r\n",
      },
      {
        id: "1.2",
        path: "leaves/1.2.md",
        kind: "leaf" as const,
        title: "公司主体",
        branchId: "identity",
        branchTitle: "企业身份",
        order: 1,
        customerVisible: true,
        content: "## 1.2 公司主体\n\n北京示例公司。",
      },
    ],
    assets: [
      {
        id: "logo",
        key: "logo.png",
        path: "visual_assets/logo.png",
        mimeType: "image/png",
        size: 42,
        sha256: logoSha256,
        assetType: "brand_identity",
        displayRole: "badge",
      },
    ] as KnowledgeAsset[],
    expectedLogoSha256: logoSha256,
  };
}

function officialLogoUploadFixture() {
  const input = fixture();
  Object.assign(input.assets[0]!, {
    sourceKind: "official_logo_upload" as const,
    sourceUploadIndex: 0,
    sourceUploadFileId: expectedOfficialLogoUpload.fileId,
    sourceUploadFilename: expectedOfficialLogoUpload.filename,
    sourceUploadMimeType: expectedOfficialLogoUpload.mimeType,
    sourceUploadSizeBytes: expectedOfficialLogoUpload.sizeBytes,
    sourceUploadSha256: expectedOfficialLogoUpload.sourceSha256,
    ownership: "first_party" as const,
    assetType: "brand_identity" as const,
    displayRole: "badge" as const,
  });
  return {
    ...input,
    packageSchemaVersion: 4 as const,
    expectedCustomerUploads: [],
    expectedOfficialLogoUpload,
  };
}

describe("knowledge-base final package binding", () => {
  it("accepts the exact confirmed leaf set and original Logo bytes", () => {
    expect(assertKnowledgeBasePackageMatchesBuild(fixture())).toMatchObject({
      leafCount: 2,
      logoSha256,
    });
  });

  it("compares the single formal block, excluding the evidence appendix", () => {
    const input = fixture();
    input.documents[0]!.content = `# 外层成品标题\n\n<!-- FRONTMIND_FORMAL_CONTENT_START -->\n\n## 1.1 一句话定位\n\nFrontMind 超前智能。\n\n<!-- FRONTMIND_FORMAL_CONTENT_END -->\n\n## 证据与核验\n\n- 内部证据`;
    expect(
      canonicalPackagedKnowledgeBaseLeafMarkdown(input.documents[0]!.content),
    ).toBe(input.nodes[0]!.contentMarkdown);
    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).not.toThrow();
  });

  it("rejects replacing one leaf with a same-count document", () => {
    const input = fixture();
    input.documents[1] = { ...input.documents[1]!, id: "1.3" };
    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).toThrow(
      "缺少已确认节点：1.2",
    );
  });

  it("rejects branch, order, content and Logo substitutions", () => {
    const mutations = [
      (input: ReturnType<typeof fixture>) => {
        input.documents[0]!.branchId = "products";
      },
      (input: ReturnType<typeof fixture>) => {
        input.documents[0]!.order = 9;
      },
      (input: ReturnType<typeof fixture>) => {
        input.documents[0]!.content = "被替换的正文";
      },
      (input: ReturnType<typeof fixture>) => {
        input.assets[0]!.sha256 = "b".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const input = fixture();
      mutate(input);
      expect(() => assertKnowledgeBasePackageMatchesBuild(input)).toThrow(
        KnowledgeBasePackageBindingError,
      );
    }
  });

  it("rejects empty or unconfirmed nodes", () => {
    const input = fixture();
    input.nodes[1]!.status = "current";
    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).toThrow(
      "仍有未确认节点",
    );
  });

  it("accepts a pinned v3 sparse order and extra visuals without weakening leaf hashes", () => {
    const input = fixture();
    input.documents[0]!.order = 10;
    input.documents[1]!.order = 20;
    input.assets.push(
      {
        id: "hero",
        key: "hero.webp",
        path: "visual_assets/hero.webp",
        mimeType: "image/webp",
        size: 100,
        sha256: "b".repeat(64),
        assetType: "environment_photo",
        displayRole: "hero",
      },
      {
        id: "product",
        key: "product.webp",
        path: "visual_assets/product.webp",
        mimeType: "image/webp",
        size: 100,
        sha256: "c".repeat(64),
        assetType: "product_ui",
        displayRole: "inline",
      },
    );
    input.assets[0]!.assetType = "brand_identity";
    input.assets[0]!.displayRole = "badge";

    expect(
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        legacyV3Compatibility: true,
      }),
    ).toMatchObject({ leafCount: 2, logoSha256 });
    expect(
      selectLegacyKnowledgeBaseLogoAsset({ assets: input.assets }),
    ).toMatchObject({ id: "logo", sha256: logoSha256 });

    input.documents[1]!.content = "被替换的正文";
    expect(() =>
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        legacyV3Compatibility: true,
      }),
    ).toThrow("正文与客户已确认版本不一致");
  });

  it("rejects ambiguous legacy brand badges instead of guessing a Logo", () => {
    const input = fixture();
    input.assets[0]!.assetType = "brand_identity";
    input.assets[0]!.displayRole = "badge";
    input.assets.push({
      ...input.assets[0]!,
      id: "alternate-logo",
      key: "alternate.png",
      path: "visual_assets/alternate.png",
      sha256: "d".repeat(64),
    });
    expect(() =>
      selectLegacyKnowledgeBaseLogoAsset({ assets: input.assets }),
    ).toThrow("多个不同的品牌 Logo");

    expect(() =>
      selectLegacyKnowledgeBaseLogoAsset({
        assets: [
          {
            ...input.assets[0]!,
            assetType: "product_ui",
            displayRole: "hero",
          },
        ],
      }),
    ).toThrow("未唯一标记官方主 Logo");
  });

  it("binds schema v4 to the exact customer-upload hash and leaf set", () => {
    const input = fixture();
    input.assets[0]!.sourceKind = "official_web";
    input.assets.push({
      id: "customer-office",
      key: "customer-office.png",
      path: "09_media_assets/customer-office.png",
      mimeType: "image/png",
      size: 88,
      sha256: customerSha256,
      branchId: "identity",
      documentIds: ["1.2"],
      sourceKind: "user_upload",
      sourceUploadSha256: customerSha256,
      sourceUploadFilename: "office.png",
      sourceUploadMimeType: "image/png",
      ownership: "first_party",
      assetType: "customer_supplied",
      displayRole: "inline",
    });

    expect(
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        packageSchemaVersion: 4,
        expectedCustomerUploads: [
          {
            sourceSha256: customerSha256,
            leafIds: ["1.2"],
            filenames: ["office.png"],
            mimeTypes: ["image/png"],
          },
        ],
      }),
    ).toMatchObject({ customerUploadCount: 1 });
  });

  it("safely maps the exact legacy leaf- alias without rewriting asset references", () => {
    const input = fixture();
    input.documents[0]!.id = "leaf-1.1";
    input.documents[1]!.id = "leaf-1.2";
    input.assets[0]!.sourceKind = "official_web";
    input.assets.push({
      id: "customer-office",
      key: "customer-office.png",
      path: "09_media_assets/customer-office.png",
      mimeType: "image/png",
      size: 88,
      sha256: customerSha256,
      branchId: "identity",
      documentIds: ["leaf-1.2"],
      sourceKind: "user_upload",
      sourceUploadSha256: customerSha256,
      sourceUploadFilename: "office.png",
      sourceUploadMimeType: "image/png",
      ownership: "first_party",
      assetType: "customer_supplied",
      displayRole: "inline",
    });

    expect(
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        packageSchemaVersion: 4,
        expectedCustomerUploads: [
          {
            sourceSha256: customerSha256,
            leafIds: ["1.2"],
            filenames: ["office.png"],
            mimeTypes: ["image/png"],
          },
        ],
      }),
    ).toMatchObject({ leafCount: 2, customerUploadCount: 1 });
    expect(input.documents.map((document) => document.id)).toEqual([
      "leaf-1.1",
      "leaf-1.2",
    ]);
    expect(input.assets[1]!.documentIds).toEqual(["leaf-1.2"]);
  });

  it("rejects an ambiguous raw-plus-prefixed v4 leaf identity", () => {
    const input = fixture();
    input.documents[1] = { ...input.documents[0]!, id: "leaf-1.1" };
    expect(() =>
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        packageSchemaVersion: 4,
      }),
    ).toThrow("节点标识无法与已确认版本唯一对应：1.1");
  });

  it("accepts one formal block already stored in the approved presentation", () => {
    const input = fixture();
    const stored = `# 外层首轮展示\n\n<!-- FRONTMIND_FORMAL_CONTENT_START -->\n\n## 1.1 一句话定位\n\nFrontMind 超前智能。\n\n<!-- FRONTMIND_FORMAL_CONTENT_END -->\n\n## 内部证据`;
    input.nodes[0]!.contentMarkdown = stored;
    input.nodes[0]!.contentSha256 = knowledgeBaseMarkdownSha256(stored);
    input.documents[0]!.content = `# 成品外壳\n\n<!-- FRONTMIND_FORMAL_CONTENT_START -->\n\n## 1.1 一句话定位\n\nFrontMind 超前智能。\n\n<!-- FRONTMIND_FORMAL_CONTENT_END -->\n\n## 另一份内部证据`;

    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).not.toThrow();
  });

  it("binds a dedicated official Logo upload without counting it as a customer image", () => {
    expect(
      assertKnowledgeBasePackageMatchesBuild(officialLogoUploadFixture()),
    ).toMatchObject({
      logoSha256,
      customerUploadCount: 0,
    });
  });

  it.each([
    [
      "index",
      (input: ReturnType<typeof officialLogoUploadFixture>) => {
        input.assets[0]!.sourceUploadIndex = 1;
      },
    ],
    [
      "file id",
      (input: ReturnType<typeof officialLogoUploadFixture>) => {
        input.assets[0]!.sourceUploadFileId = "another-file";
      },
    ],
    [
      "filename",
      (input: ReturnType<typeof officialLogoUploadFixture>) => {
        input.assets[0]!.sourceUploadFilename = "another-logo.png";
      },
    ],
    [
      "MIME type",
      (input: ReturnType<typeof officialLogoUploadFixture>) => {
        input.assets[0]!.sourceUploadMimeType = "image/webp";
      },
    ],
    [
      "size",
      (input: ReturnType<typeof officialLogoUploadFixture>) => {
        input.assets[0]!.sourceUploadSizeBytes = 43;
      },
    ],
    [
      "source hash",
      (input: ReturnType<typeof officialLogoUploadFixture>) => {
        input.assets[0]!.sourceUploadSha256 = "d".repeat(64);
      },
    ],
  ])("rejects a mismatched official Logo upload %s", (_label, mutate) => {
    const input = officialLogoUploadFixture();
    mutate(input);
    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).toThrow(
      "官方主 Logo 与服务端原始上传账本不一致",
    );
  });

  it("rejects an uploaded-Logo provenance claim without a server ledger", () => {
    const { expectedOfficialLogoUpload: _ledger, ...input } =
      officialLogoUploadFixture();
    expect(() => assertKnowledgeBasePackageMatchesBuild(input)).toThrow(
      "服务端没有对应上传账本",
    );
  });

  it("rejects a schema v3 archive when the server ledger contains customer images", () => {
    const input = fixture();
    input.assets[0]!.sourceKind = "official_web";

    expect(() =>
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        packageSchemaVersion: 3,
        expectedCustomerUploads: [
          {
            sourceSha256: customerSha256,
            leafIds: ["1.2"],
            filenames: ["office.png"],
            mimeTypes: ["image/png"],
          },
        ],
      }),
    ).toThrow("旧版最终 ZIP 合同不能绑定客户上传图片");
  });

  it.each([
    ["missing", (input: ReturnType<typeof fixture>) => input.assets.pop()],
    [
      "wrong leaf",
      (input: ReturnType<typeof fixture>) => {
        input.assets[1]!.documentIds = ["1.1"];
      },
    ],
    [
      "wrong source hash",
      (input: ReturnType<typeof fixture>) => {
        input.assets[1]!.sourceUploadSha256 = "d".repeat(64);
      },
    ],
  ])("rejects schema v4 customer-upload %s", (_label, mutate) => {
    const input = fixture();
    input.assets[0]!.sourceKind = "official_web";
    input.assets.push({
      id: "customer-office",
      key: "customer-office.png",
      path: "09_media_assets/customer-office.png",
      mimeType: "image/png",
      size: 88,
      sha256: customerSha256,
      branchId: "identity",
      documentIds: ["1.2"],
      sourceKind: "user_upload",
      sourceUploadSha256: customerSha256,
      sourceUploadFilename: "office.png",
      sourceUploadMimeType: "image/png",
      ownership: "first_party",
      assetType: "customer_supplied",
      displayRole: "inline",
    });
    mutate(input);

    expect(() =>
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        packageSchemaVersion: 4,
        expectedCustomerUploads: [
          {
            sourceSha256: customerSha256,
            leafIds: ["1.2"],
            filenames: ["office.png"],
            mimeTypes: ["image/png"],
          },
        ],
      }),
    ).toThrow(KnowledgeBasePackageBindingError);
  });

  it("rejects an additional crawled image under schema v4", () => {
    const input = fixture();
    input.assets[0]!.sourceKind = "official_web";
    input.assets.push({
      ...input.assets[0]!,
      id: "crawled-office",
      key: "crawled-office.png",
      path: "09_media_assets/crawled-office.png",
      sha256: "f".repeat(64),
      assetType: "environment_photo",
      displayRole: "inline",
    });

    expect(() =>
      assertKnowledgeBasePackageMatchesBuild({
        ...input,
        packageSchemaVersion: 4,
        expectedCustomerUploads: [],
      }),
    ).toThrow("必须只包含首轮已绑定的同一张官方主 Logo");
  });
});
