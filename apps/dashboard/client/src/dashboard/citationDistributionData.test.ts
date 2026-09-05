import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  citationRecordCounts,
  decodeCitationDistributionPayload,
  type CitationDistributionData,
} from "./citationDistributionData";
import { buildPreviewQuestionCitationSummary } from "./UserBrandDashboard";

const syntheticCitationCounts = {
  "百度 AI|合成问题 A": 71,
  "百度 AI|合成问题 B": 70,
  "DeepSeek|合成问题 A": 71,
  "DeepSeek|合成问题 B": 70,
  "豆包|合成问题 A": 71,
  "豆包|合成问题 B": 70,
  "通义千问|合成问题 A": 71,
  "通义千问|合成问题 B": 70,
  "腾讯元宝|合成问题 A": 71,
  "腾讯元宝|合成问题 B": 70,
} as const;

const modelKeys = {
  "百度 AI": "baiduai",
  DeepSeek: "deepseek",
  豆包: "doubao",
  通义千问: "qianwen",
  腾讯元宝: "yuanbao",
} as const;

async function readSyntheticCitationFixture() {
  const mediaRows: CitationDistributionData["mediaRows"] = Array.from(
    { length: citationRecordCounts.media },
    (_, index) => [
      `source-${index}.example`,
      `合成信源 ${index}`,
      index + 1,
      `${index + 1}%`,
    ],
  );
  const contentRows: CitationDistributionData["contentRows"] = Array.from(
    { length: citationRecordCounts.content },
    (_, index) => [
      `合成内容 ${index}`,
      `合成信源 ${index % citationRecordCounts.media}`,
      `source-${index % citationRecordCounts.media}.example`,
      `https://source-${index % citationRecordCounts.media}.example/${index}`,
      index + 1,
      `${index + 1}%`,
    ],
  );
  const questionRows: CitationDistributionData["questionRows"] = Object.entries(
    syntheticCitationCounts,
  ).flatMap(([scope, count]) => {
    const [model, question] = scope.split("|") as [
      keyof typeof modelKeys,
      string,
    ];
    return Array.from({ length: count }, (_, index) => [
      modelKeys[model],
      question,
      `${question}的合成内容 ${index}`,
      `https://citations.example/${modelKeys[model]}/${question}/${index}`,
      `合成信源 ${index % citationRecordCounts.media}`,
      "2026-01-15",
    ]);
  });
  const encodedPayload = gzipSync(
    JSON.stringify([mediaRows, contentRows, questionRows]),
  ).toString("base64");
  return decodeCitationDistributionPayload(encodedPayload);
}

describe("citation distribution data", () => {
  it("preserves every row from an anonymous compressed fixture", async () => {
    const data = await readSyntheticCitationFixture();

    expect(data.mediaRows).toHaveLength(citationRecordCounts.media);
    expect(data.contentRows).toHaveLength(citationRecordCounts.content);
    expect(data.questionRows).toHaveLength(citationRecordCounts.question);
    expect(
      data.mediaRows.length +
        data.contentRows.length +
        data.questionRows.length,
    ).toBe(citationRecordCounts.total);

    expect(data.mediaRows[0]).toEqual([
      "source-0.example",
      "合成信源 0",
      1,
      "1%",
    ]);
    expect(data.questionRows.at(-1)?.[1]).toBe("合成问题 B");
  });

  it("matches all citations to the synthetic question and model dimensions", async () => {
    const { questionRows } = await readSyntheticCitationFixture();

    for (const [scope, totalCitations] of Object.entries(
      syntheticCitationCounts,
    )) {
      const [model, question] = scope.split("|");
      expect(
        buildPreviewQuestionCitationSummary(
          questionRows,
          question,
          model,
          "2026-01-15",
          "2026-01-15",
        )?.totalCitations,
        scope,
      ).toBe(totalCitations);
    }
    expect(
      Object.values(syntheticCitationCounts).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(705);
  });
});
