import { describe, expect, it } from "vitest";

import { dashboardPayloadSchema } from "../shared/dashboard";
import { resolveBrandKeywordSelection } from "./brand-keyword-selection";

const payload = dashboardPayloadSchema.parse({
  brandName: "测试品牌",
  headline: "测试品牌看板",
  keywordTables: [
    {
      id: "global-keywords",
      title: "品牌全域词库",
      columns: ["序号", "问题", "核心词分类"],
      rows: [
        ["1", "测试品牌和竞品相比有什么优势？", "竞品对比词"],
        ["2", "测试品牌适合哪些场景？", "无法识别"],
        ["3", "**测试品牌**适合吗？😀[citation:1]", "产品场景词"],
      ],
    },
  ],
});

describe("resolveBrandKeywordSelection", () => {
  it("resolves the trusted question and canonical category from one revision", () => {
    expect(
      resolveBrandKeywordSelection({
        workspace: { revision: 7, payload },
        reference: {
          dashboardRevision: 7,
          tableId: "global-keywords",
          rowIndex: 0,
        },
      }),
    ).toEqual({
      ok: true,
      selection: {
        question: "测试品牌和竞品相比有什么优势？",
        category: "competitor_comparison",
      },
    });
  });

  it("rejects a stale revision instead of selecting a changed row", () => {
    expect(
      resolveBrandKeywordSelection({
        workspace: { revision: 8, payload },
        reference: {
          dashboardRevision: 7,
          tableId: "global-keywords",
          rowIndex: 0,
        },
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("已更新") });
  });

  it("rejects unknown categories instead of falling back to reputation", () => {
    expect(
      resolveBrandKeywordSelection({
        workspace: { revision: 7, payload },
        reference: {
          dashboardRevision: 7,
          tableId: "global-keywords",
          rowIndex: 1,
        },
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("问题类型无法识别"),
    });
  });

  it("rejects duplicate table identifiers instead of silently choosing one", () => {
    const duplicatePayload = dashboardPayloadSchema.parse({
      ...payload,
      keywordTables: [payload.keywordTables[0], payload.keywordTables[0]],
    });

    expect(
      resolveBrandKeywordSelection({
        workspace: { revision: 7, payload: duplicatePayload },
        reference: {
          dashboardRevision: 7,
          tableId: "global-keywords",
          rowIndex: 0,
        },
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("标识重复"),
    });
  });

  it("locks the same normalized question text that the customer sees", () => {
    expect(
      resolveBrandKeywordSelection({
        workspace: { revision: 7, payload },
        reference: {
          dashboardRevision: 7,
          tableId: "global-keywords",
          rowIndex: 2,
        },
      }),
    ).toEqual({
      ok: true,
      selection: {
        question: "测试品牌适合吗？",
        category: "product_scenario",
      },
    });
  });
});
