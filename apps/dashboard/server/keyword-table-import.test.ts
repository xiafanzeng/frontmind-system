import { describe, expect, it } from "vitest";

import {
  importedKeywordCategoryCounts,
  normalizeImportedKeywordTables,
} from "./keyword-table-import";

const workbookTable = {
  id: "question-list-1",
  title: "问题列表",
  columns: ["序号", "问题", "核心词", "核心词分类", "热度", "创建日期"],
  rows: [
    [
      "1",
      "硅基流动是做什么的公司？",
      "硅基流动",
      "品牌核心词",
      "8472",
      "2026-07-27",
    ],
    [
      "2",
      "大模型 API 成本怎么降低？",
      "API 成本",
      "场景痛点词",
      "32567",
      "2026-07-27",
    ],
    [
      "3",
      "什么是 AI 基础设施？",
      "AI 基础设施",
      "品类行业词",
      "23456",
      "2026-07-27",
    ],
    [
      "4",
      "硅基流动和阿里百炼哪个好？",
      "硅基流动 vs 阿里百炼",
      "竞品对比词",
      "31245",
      "2026-07-27",
    ],
  ],
};

describe("keyword workbook import", () => {
  it("maps the uploaded 核心词分类 values into the four customer labels", () => {
    const tables = normalizeImportedKeywordTables([workbookTable]);
    expect(tables[0]?.rows.map((row) => row[3])).toEqual([
      "美誉舆情词",
      "产品场景词",
      "行业排名词",
      "竞品对比词",
    ]);
    expect(importedKeywordCategoryCounts(tables)).toEqual({
      行业排名词: 1,
      竞品对比词: 1,
      美誉舆情词: 1,
      产品场景词: 1,
    });
  });

  it("rejects an unmapped category instead of publishing a wrong tag", () => {
    expect(() =>
      normalizeImportedKeywordTables([
        {
          ...workbookTable,
          rows: [["1", "问题", "核心词", "未知词类", "1", "2026-07-27"]],
        },
      ]),
    ).toThrow(/无法映射的核心词分类.*未知词类/);
  });

  it("rejects tabular keyword files without the required workbook headers", () => {
    const table = {
      id: "legacy-1",
      title: "旧词表",
      columns: ["问题", "热度"],
      rows: [["问题", "1"]],
    };
    expect(() => normalizeImportedKeywordTables([table])).toThrow(
      /缺少必需列：核心词、核心词分类/,
    );
    expect(importedKeywordCategoryCounts([table])).toBeNull();
  });
});
