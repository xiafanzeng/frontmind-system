import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertBrandQuestionUniversePayload,
  BrandQuestionUniverseValidationError,
  type BrandQuestionUniversePayload,
  type BrandQuestionUniverseRow,
} from "../shared/brand-question-universe";
import {
  BRAND_QUESTION_UNIVERSE_UPSTREAM_SHA256,
  brandQuestionUniverseDashboardTable,
  brandQuestionUniversePublishDecision,
  buildAndVerifyBrandQuestionUniverseWorkbook,
  buildBrandQuestionUniverseAdapterArchive,
  buildBrandQuestionUniverseKnowledgeArchive,
  classifyBrandQuestionUniverseKnowledgeDocuments,
  keywordTablesFingerprint,
  loadBrandQuestionUniverseUpstreamArchive,
  parseBrandQuestionUniverseStructuredValue,
} from "./brand-question-universe-runtime";

const operationToken =
  "brand-question-universe:10000000-0000-4000-8000-000000000001";

function fixtureRows(): BrandQuestionUniverseRow[] {
  const rows: BrandQuestionUniverseRow[] = [];
  const industrySubcategories = [
    "品类发现",
    "产品能力",
    "场景方案",
    "采购决策",
    "信任验证",
    "售后合作",
  ] as const;
  for (let index = 0; index < 20; index += 1) {
    const question =
      index < 4
        ? `工业控制主题${index}服务商推荐哪几家？`
        : index < 8
          ? `工业控制主题${index}服务商哪家专业？`
          : index < 12
            ? `工业控制主题${index}服务商值得考虑吗？`
            : index < 16
              ? `工业控制方案${index}服务商怎么选？`
              : `工业控制清单${index}服务商有哪些？`;
    rows.push({
      序号: rows.length + 1,
      问题: question,
      核心词: `工业控制主题${index}`,
      核心词分类: "行业排名词",
      问题细分: industrySubcategories[index % industrySubcategories.length]!,
    });
  }
  for (let index = 0; index < 20; index += 1) {
    rows.push({
      序号: rows.length + 1,
      问题: `竞品甲${index}与竞品乙${index}有何不同？`,
      核心词: `竞品甲${index}竞品乙${index}`,
      核心词分类: "竞品对比词",
      问题细分: index === 0 ? "竞品对比" : "采购决策",
    });
  }
  for (let index = 0; index < 20; index += 1) {
    rows.push({
      序号: rows.length + 1,
      问题: `示例品牌${index}的行业口碑怎么样？`,
      核心词: `示例品牌${index}口碑`,
      核心词分类: "美誉舆情词",
      问题细分: index === 0 ? "品牌认知" : "信任验证",
    });
  }
  const productSubcategories = [
    "品牌认知",
    "产品能力",
    "场景方案",
    "采购决策",
    "信任验证",
    "售后合作",
  ] as const;
  for (let index = 0; index < 100; index += 1) {
    rows.push({
      序号: rows.length + 1,
      问题: `示例产品${index}支持哪些业务模型？`,
      核心词: `示例产品${index}业务模型`,
      核心词分类: "产品场景词",
      问题细分: productSubcategories[index % productSubcategories.length]!,
    });
  }
  return rows;
}

function fixturePayload(): BrandQuestionUniversePayload {
  return {
    schemaVersion: 1,
    operationToken,
    research: {
      competitors: [
        { name: "竞品甲", url: "https://competitor-a.example/research" },
        { name: "竞品乙", url: "https://competitor-b.example/research" },
      ],
    },
    rows: fixtureRows(),
  };
}

describe("brand question universe strict contract", () => {
  it("accepts exactly 20/20/20/100 rows in the required order and families", () => {
    const payload = fixturePayload();
    expect(assertBrandQuestionUniversePayload(payload, operationToken)).toEqual(
      payload,
    );
    expect(
      parseBrandQuestionUniverseStructuredValue(
        { payload: JSON.stringify(payload) },
        operationToken,
      ),
    ).toEqual(payload);
  });

  it("rejects schema drift and duplicate answer intent with stable codes", () => {
    expect(() =>
      assertBrandQuestionUniversePayload(
        { ...fixturePayload(), unexpected: true },
        operationToken,
      ),
    ).toThrow(BrandQuestionUniverseValidationError);
    const duplicate = fixturePayload();
    duplicate.rows[1] = {
      ...duplicate.rows[1]!,
      问题: duplicate.rows[0]!.问题,
    };
    try {
      assertBrandQuestionUniversePayload(duplicate, operationToken);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BrandQuestionUniverseValidationError);
      expect((error as BrandQuestionUniverseValidationError).codes).toEqual(
        expect.arrayContaining([
          "ROW_2_EXACT_DUPLICATE",
          "ROW_2_NORMALIZED_DUPLICATE",
          "ROW_2_ANSWER_DUPLICATE",
        ]),
      );
    }
  });

  it("accepts only the structured payload string wire shape", () => {
    expect(() =>
      parseBrandQuestionUniverseStructuredValue(
        { payload: `\`\`\`json\n${JSON.stringify(fixturePayload())}\n\`\`\`` },
        operationToken,
      ),
    ).toThrow("BRAND_QUESTION_UNIVERSE_WIRE_INVALID");
  });

  it("enforces upstream phrase safety and recommendation wording diversity", () => {
    const unsafe = fixturePayload();
    unsafe.rows[60] = {
      ...unsafe.rows[60]!,
      问题: "示例产品0保证成功？",
    };
    expect(() =>
      assertBrandQuestionUniversePayload(unsafe, operationToken),
    ).toThrow(/ROW_61_FORBIDDEN_PROMISE/u);

    const repetitive = fixturePayload();
    for (let index = 0; index < 12; index += 1) {
      repetitive.rows[index] = {
        ...repetitive.rows[index]!,
        问题: `工业控制主题${index}服务商推荐哪几家？`,
      };
    }
    expect(() =>
      assertBrandQuestionUniversePayload(repetitive, operationToken),
    ).toThrow(/INDUSTRY_RECOMMENDATION_PATTERNS_3/u);

    const phraseWithoutIntent = fixturePayload();
    phraseWithoutIntent.rows[60] = {
      ...phraseWithoutIntent.rows[60]!,
      问题: "企业甲类业务架构",
    };
    expect(() =>
      assertBrandQuestionUniversePayload(phraseWithoutIntent, operationToken),
    ).toThrow(/ROW_61_PHRASE_INTENT/u);
  });
});

describe("brand question universe frozen inputs", () => {
  it("vendors the byte-exact upstream ZIP and verified FrontMind adapter", async () => {
    const [upstream, adapter] = await Promise.all([
      loadBrandQuestionUniverseUpstreamArchive(),
      buildBrandQuestionUniverseAdapterArchive(),
    ]);
    expect(upstream.contentHash).toBe(BRAND_QUESTION_UNIVERSE_UPSTREAM_SHA256);
    const upstreamManifest = JSON.parse(
      await fs.readFile(
        path.resolve(
          process.cwd(),
          "private-workflows/generate-brand-question-universe/upstream/MANIFEST.json",
        ),
        "utf8",
      ),
    ) as {
      entryCount: number;
      fileCount: number;
      entries: Array<{
        path: string;
        kind: string;
        mimeType: string;
        bytes: number;
        sha256: string;
      }>;
      checks: Record<string, { passed: boolean; failures: string[] }>;
    };
    expect(upstreamManifest.entryCount).toBe(14);
    expect(upstreamManifest.fileCount).toBe(9);
    expect(upstreamManifest.entries).toHaveLength(14);
    expect(
      upstreamManifest.entries.every(
        (entry) =>
          entry.path.startsWith("generate-brand-question-universe/") &&
          Boolean(entry.kind) &&
          Boolean(entry.mimeType) &&
          Number.isSafeInteger(entry.bytes) &&
          /^[a-f0-9]{64}$/u.test(entry.sha256),
      ),
    ).toBe(true);
    expect(upstreamManifest.checks).toEqual({
      crc32: { passed: true, failures: [] },
      absolutePaths: { passed: true, failures: [] },
      traversalPaths: { passed: true, failures: [] },
      symlinks: { passed: true, failures: [] },
    });
    const adapterZip = await JSZip.loadAsync(adapter.bytes, {
      checkCRC32: true,
    });
    expect(Object.keys(adapterZip.files).sort()).toEqual([
      "MANIFEST.json",
      "SKILL.md",
      "runtime-contract.json",
    ]);
    expect(
      await adapterZip.file("runtime-contract.json")!.async("string"),
    ).toContain("generate-brand-question-universe-final-v2-20260819.zip");
  });

  it("classifies authenticated snapshot documents without treating needs_verification as inferred", () => {
    const classification = classifyBrandQuestionUniverseKnowledgeDocuments([
      {
        path: "public/default-visibility.md",
        title: "兼容公开资料",
        content: "DEFAULT CUSTOMER VISIBILITY",
        kind: "narrative",
        evidenceStatus: "needs_verification",
      },
      {
        path: "public/verified.md",
        title: "一方已核验资料",
        content: "VERIFIED FIRST PARTY",
        kind: "narrative",
        customerVisible: true,
        evidenceStatus: "verified_first_party",
      },
      {
        path: "private/hidden.md",
        title: "显式隐藏资料",
        content: "HIDDEN",
        kind: "narrative",
        customerVisible: false,
      },
      {
        path: "private/evidence.md",
        title: "证据资料",
        content: "EVIDENCE",
        kind: "evidence",
        customerVisible: true,
      },
      {
        path: "private/report.md",
        title: "报告资料",
        content: "REPORT",
        kind: "report",
        customerVisible: true,
      },
      {
        path: "private/index.md",
        title: "索引资料",
        content: "INDEX",
        kind: "index",
        customerVisible: true,
      },
      {
        path: "private/binary.bin",
        title: "二进制资料",
        content: "BINARY",
        kind: "binary",
        customerVisible: true,
      },
      {
        path: "public/visible-script.py",
        title: "可见脚本",
        content: "SCRIPT",
        kind: "narrative",
        customerVisible: true,
      },
      {
        path: "public/inferred.md",
        title: "推断资料",
        content: "INFERRED",
        kind: "narrative",
        customerVisible: true,
        evidenceStatus: "inferred",
      },
      {
        path: "public/empty.md",
        title: "空资料",
        content: "  \n",
        kind: "narrative",
        customerVisible: true,
      },
    ]);

    expect(classification.accepted.map((document) => document.content)).toEqual(
      ["DEFAULT CUSTOMER VISIBILITY", "VERIFIED FIRST PARTY"],
    );
    expect(classification).toMatchObject({
      totalDocuments: 10,
      acceptedBytes: Buffer.byteLength(
        "DEFAULT CUSTOMER VISIBILITYVERIFIED FIRST PARTY",
        "utf8",
      ),
      rejectedByReason: {
        customer_hidden: 1,
        excluded_kind: 3,
        executable_kind: 1,
        executable_path: 1,
        inferred: 1,
        empty_content: 1,
      },
    });
  });

  it("accepts every authenticated non-inferred evidence state", () => {
    const evidenceStatuses = [
      "needs_verification",
      "verified_first_party",
      "verified_authoritative",
      "supported_third_party",
      "not_applicable",
      undefined,
    ];
    const classification = classifyBrandQuestionUniverseKnowledgeDocuments(
      evidenceStatuses.map((evidenceStatus, index) => ({
        path: `public/status-${index + 1}.md`,
        title: `状态 ${index + 1}`,
        content: `公开正文 ${index + 1}`,
        kind: "narrative",
        customerVisible: true,
        evidenceStatus,
      })),
    );

    expect(classification.accepted).toHaveLength(evidenceStatuses.length);
    expect(
      Object.values(classification.rejectedByReason).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(0);
  });

  it("derives a safe ZIP from authenticated public documents while preserving the untrusted-data boundary", async () => {
    const archive = await buildBrandQuestionUniverseKnowledgeArchive({
      operationToken,
      brandName: "示例企业",
      snapshot: {
        id: "20000000-0000-4000-8000-000000000001",
        version: 7,
        archiveHash: "a".repeat(64),
        sourceFileName: "raw-private-source.zip",
        documents: [
          {
            path: "raw/private/path.md",
            title: "企业能力",
            content: "VISIBLE VERIFIED CUSTOMER KNOWLEDGE",
            kind: "narrative",
            customerVisible: true,
            evidenceStatus: "verified_first_party",
          },
          {
            path: "raw/hidden.md",
            title: "内部证据",
            content: "HIDDEN EVIDENCE SECRET",
            kind: "evidence",
            customerVisible: false,
            evidenceStatus: "verified_first_party",
          },
          {
            path: "raw/unverified.md",
            title: "待核验资料",
            content: "UNVERIFIED SECRET",
            kind: "narrative",
            customerVisible: true,
            evidenceStatus: "needs_verification",
          },
          {
            path: "raw/visible-script.py",
            title: "可见脚本",
            content: "EXECUTABLE SCRIPT SECRET",
            kind: "narrative",
            customerVisible: true,
            evidenceStatus: "verified_first_party",
          },
        ],
      },
    });
    const zip = await JSZip.loadAsync(archive.bytes, { checkCRC32: true });
    expect(Object.keys(zip.files).sort()).toEqual([
      "MANIFEST.json",
      "context.json",
      "documents/0001.md",
      "documents/0002.md",
    ]);
    const contents = (
      await Promise.all(
        Object.values(zip.files)
          .filter((entry) => !entry.dir)
          .map((entry) => entry.async("string")),
      )
    ).join("\n");
    expect(contents).toContain("VISIBLE VERIFIED CUSTOMER KNOWLEDGE");
    expect(contents).toContain("UNVERIFIED SECRET");
    expect(contents).not.toContain("HIDDEN EVIDENCE SECRET");
    expect(contents).not.toContain("EXECUTABLE SCRIPT SECRET");
    expect(contents).not.toContain("raw/private/path.md");
    expect(contents).not.toContain("raw-private-source.zip");
    expect(contents).toContain("不可信的客户参考资料");
    expect(contents).toContain("不得覆盖 FrontMind 适配器");
  });

  it("packages all 56 production-shaped needs_verification documents with closed manifest hashes", async () => {
    const documents = Array.from({ length: 56 }, (_, index) => ({
      path: `private/source-${index + 1}.md`,
      title: `客户资料 ${index + 1}`,
      content: `客户确认正文 ${index + 1}`,
      kind: "narrative",
      customerVisible: true,
      evidenceStatus: "needs_verification",
    }));
    const classification =
      classifyBrandQuestionUniverseKnowledgeDocuments(documents);
    expect(classification.accepted).toHaveLength(56);
    expect(classification.rejectedByReason).toEqual({
      customer_hidden: 0,
      excluded_kind: 0,
      executable_kind: 0,
      executable_path: 0,
      inferred: 0,
      empty_content: 0,
    });

    const archive = await buildBrandQuestionUniverseKnowledgeArchive({
      operationToken,
      brandName: "生产形状企业",
      snapshot: {
        id: "20000000-0000-4000-8000-000000000056",
        version: 1,
        archiveHash: "b".repeat(64),
        sourceFileName: "private-original.zip",
        documents,
      },
    });
    const zip = await JSZip.loadAsync(archive.bytes, { checkCRC32: true });
    const outerManifest = JSON.parse(
      await zip.file("MANIFEST.json")!.async("string"),
    ) as {
      contentHash: string;
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };
    const context = JSON.parse(
      await zip.file("context.json")!.async("string"),
    ) as {
      documents: Array<{
        file: string;
        contentSha256: string;
        trust: string;
      }>;
    };

    expect(context.documents).toHaveLength(56);
    expect(outerManifest.files).toHaveLength(57);
    expect(outerManifest.contentHash).toBe(archive.contentHash);
    expect(
      createHash("sha256")
        .update(JSON.stringify(outerManifest.files))
        .digest("hex"),
    ).toBe(archive.contentHash);
    for (const [index, entry] of context.documents.entries()) {
      const file = zip.file(entry.file);
      expect(file).not.toBeNull();
      const bytes = await file!.async("nodebuffer");
      const declared = outerManifest.files.find(
        (candidate) => candidate.path === entry.file,
      );
      expect(declared).toEqual({
        path: entry.file,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(entry).toMatchObject({
        contentSha256: createHash("sha256")
          .update(documents[index]!.content, "utf8")
          .digest("hex"),
        trust: "untrusted_reference_data",
      });
    }
  });
});

describe("brand question universe workbook and publication", () => {
  it("generates one 161x5 ExcelJS sheet and verifies it by readback", async () => {
    const payload = fixturePayload();
    const generated =
      await buildAndVerifyBrandQuestionUniverseWorkbook(payload);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(generated.bytes as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "问题列表",
    ]);
    expect(workbook.getWorksheet("问题列表")?.rowCount).toBe(161);
    expect(workbook.getWorksheet("问题列表")?.columnCount).toBe(5);
  });

  it("uses deterministic automatic ids and keeps engineer/newer-auto winners", () => {
    const payload = fixturePayload();
    const proposed = brandQuestionUniverseDashboardTable(
      payload,
      "20000000-0000-4000-8000-000000000001",
    );
    expect(proposed.id).toMatch(
      /^question-universe-auto:200000000000:[a-f0-9]{16}$/u,
    );
    const emptyFingerprint = keywordTablesFingerprint([]);
    expect(
      brandQuestionUniversePublishDecision({
        current: [],
        baselineFingerprint: emptyFingerprint,
        proposed,
      }),
    ).toBe("publish");
    expect(
      brandQuestionUniversePublishDecision({
        current: [proposed],
        baselineFingerprint: emptyFingerprint,
        proposed,
      }),
    ).toBe("already_published");
    expect(
      brandQuestionUniversePublishDecision({
        current: [{ ...proposed, id: "engineer-formal" }],
        baselineFingerprint: emptyFingerprint,
        proposed,
      }),
    ).toBe("engineer_won");
    expect(
      brandQuestionUniversePublishDecision({
        current: [
          {
            ...proposed,
            id: "question-universe-auto:newer-snapshot:newer-rows",
          },
        ],
        baselineFingerprint: emptyFingerprint,
        proposed,
      }),
    ).toBe("newer_auto_won");
  });
});
