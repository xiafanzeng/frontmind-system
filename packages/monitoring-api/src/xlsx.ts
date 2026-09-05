import ExcelJS from "exceljs";
import type { Response } from "express";
import type {
  MonitoringExportSection,
  MonitoringRepository,
} from "@frontmind/monitoring-db";
import type { MonitoringScope } from "@frontmind/monitoring-contracts";

type Sheet = ExcelJS.Worksheet;
type ColumnDefinition = { header: string; width: number };

/**
 * Writes rows through ExcelJS's streaming writer so answer bodies are not copied
 * into a second in-memory workbook/ZIP representation during export.
 */
export async function streamRunWorkbook(
  repository: MonitoringRepository,
  ownerId: string,
  runId: string,
  response: Response,
) {
  const data = await repository.getRunExportData(ownerId, runId);
  const actualCitationSources = data.sources.filter(
    (source) => source.citationProvenance === "explicit",
  );
  const billingByAttempt = new Map(
    data.billing.map((item) => [item.attemptId, item] as const),
  );
  const quotedTotal = data.billing.reduce(
    (total, item) => total + BigInt(item.quotedTenThousandths),
    0n,
  );
  const consumedTotal = data.billing.reduce(
    (total, item) =>
      total +
      (item.settlementStatus === "consumed"
        ? BigInt(item.settledTenThousandths)
        : 0n),
    0n,
  );
  response.status(200);
  response.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="frontmind-run-${runId}.xlsx"`,
  );
  response.setHeader("Cache-Control", "private, no-store");

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: response,
    useStyles: true,
    useSharedStrings: false,
    zip: { zlib: { level: 6 } },
  });
  workbook.creator = "FrontMind Monitoring System";
  workbook.created = new Date();

  const summary = createSheet(workbook, "运行摘要", [
    { header: "字段", width: 22 },
    { header: "值", width: 42 },
  ]);
  addRows(summary, [
    ["运行ID", data.run.id],
    ["状态", data.run.status],
    ["触发方式", data.run.trigger],
    ["预计采集", data.run.expectedAttempts],
    ["成功", data.run.completedAttempts],
    ["失败", data.run.failedAttempts],
    ["停止", data.run.stoppedAttempts],
    [
      "本次报价（人民币元）",
      data.billing.length ? formatCnyTenThousandths(quotedTotal) : "未计价",
    ],
    [
      "本次实际消费（人民币元）",
      data.billing.length ? formatCnyTenThousandths(consumedTotal) : "未计价",
    ],
    ["实际引用数", actualCitationSources.length],
    ["全部返回来源数", data.discoveredSources.length],
    ["开始时间", data.run.startedAt?.toISOString() ?? ""],
    ["完成时间", data.run.completedAt?.toISOString() ?? ""],
    ["创建时间", data.run.createdAt.toISOString()],
  ]);
  finishSheet(summary);

  const config = createSheet(workbook, "配置快照", [
    { header: "字段", width: 22 },
    { header: "值", width: 60 },
  ]);
  addRows(config, [
    ["配置版本", data.version.version],
    ["监控名称", safeCell(data.version.name)],
    ["主品牌", safeCell(data.brand.mainBrand)],
    ["品牌别名", safeCell(data.brand.aliases.join("、"))],
    ["问题数", data.questionRows.length],
    ["平台数", data.platformRows.length],
    ["重复次数", data.version.repetitions],
    ["预计采集", data.version.expectedAttempts],
    ...data.platformRows.map((platform, index) => [
      `平台 ${index + 1}`,
      safeCell(
        [
          platform.displayName || platform.providerCodeSnapshot,
          platform.clientType === "web" ? "网页版" : "手机版",
          platform.mode === "reasoning_search" ? "深度思考" : "标准问答",
          platform.screenshot === 1
            ? "全部截图"
            : platform.screenshot === 2
              ? "提及品牌时截图"
              : "不截图",
          platform.clientType === "mobile"
            ? "供应商默认位置"
            : platform.regionCode || "供应商默认位置",
        ].join(" | "),
      ),
    ]),
    ["配置哈希", data.version.configurationHash],
  ]);
  finishSheet(config);

  const questions = createSheet(workbook, "问题清单", [
    { header: "序号", width: 10 },
    { header: "问题", width: 60 },
  ]);
  for (const row of data.questionRows)
    addRow(questions, [row.ordinal + 1, safeCell(row.questionSnapshot)]);
  finishSheet(questions);

  const answers = createSheet(workbook, "回答明细", [
    { header: "回答ID", width: 38 },
    { header: "问题", width: 52 },
    { header: "平台", width: 20 },
    { header: "端", width: 10 },
    { header: "轮次", width: 10 },
    { header: "状态", width: 18 },
    { header: "答案", width: 60 },
    { header: "思考过程", width: 60 },
    { header: "品牌提及", width: 12 },
    { header: "提及位置", width: 12 },
    { header: "引用证据", width: 30 },
    { header: "错误", width: 48 },
  ]);
  for (const row of data.attempts) {
    addRow(answers, [
      row.attempt.id,
      safeCell(row.attempt.question),
      row.attempt.providerCode,
      row.attempt.clientType,
      row.attempt.repetition,
      row.attempt.status,
      safeCell(row.result?.answerMarkdown ?? ""),
      safeCell(row.result?.reasoningMarkdown ?? ""),
      row.result?.brandMentioned ?? false,
      row.result?.mentionPosition ?? "",
      citationProvenanceLabel(row.result?.citationProvenance),
      safeCell(row.attempt.errorMessage ?? ""),
    ]);
  }
  finishSheet(answers);

  const revisionToAttempt = new Map(
    data.attempts.flatMap((row) =>
      row.result
        ? [[row.result.currentRevisionId, row.attempt.id] as const]
        : [],
    ),
  );
  const sources = createSheet(workbook, "引用来源", [
    { header: "回答ID", width: 38 },
    { header: "序号", width: 10 },
    { header: "标题", width: 44 },
    { header: "域名", width: 30 },
    { header: "URL", width: 60 },
    { header: "引用文本", width: 60 },
    { header: "引用证据", width: 30 },
  ]);
  for (const source of actualCitationSources) {
    addRow(sources, [
      revisionToAttempt.get(source.revisionId) ?? "",
      source.ordinal + 1,
      safeCell(source.title),
      source.domain,
      safeCell(source.url),
      safeCell(source.citedText ?? ""),
      citationProvenanceLabel(source.citationProvenance),
    ]);
  }
  finishSheet(sources);

  const discoveredSources = createSheet(workbook, "返回来源", [
    { header: "回答ID", width: 38 },
    { header: "序号", width: 10 },
    { header: "标题", width: 44 },
    { header: "站点", width: 24 },
    { header: "域名", width: 30 },
    { header: "URL", width: 60 },
    { header: "摘要", width: 60 },
    { header: "发布日期", width: 16 },
    { header: "实际引用", width: 12 },
    { header: "引用判定", width: 30 },
  ]);
  for (const source of data.discoveredSources) {
    addRow(discoveredSources, [
      revisionToAttempt.get(source.revisionId) ?? "",
      source.ordinal + 1,
      safeCell(source.title),
      safeCell(source.siteName ?? ""),
      safeCell(source.domain),
      safeCell(source.url),
      safeCell(source.summary ?? ""),
      source.publishedAt ?? "",
      source.isCited,
      returnedSourceCitationLabel(source.citationProvenance, source.isCited),
    ]);
  }
  finishSheet(discoveredSources);

  const sourceCountByRevision = new Map<string, number>();
  for (const source of actualCitationSources) {
    sourceCountByRevision.set(
      source.revisionId,
      (sourceCountByRevision.get(source.revisionId) || 0) + 1,
    );
  }
  const mediaByRevision = new Map<
    string,
    { total: number; archiveFailures: number }
  >();
  for (const item of data.media) {
    const current = mediaByRevision.get(item.revisionId) || {
      total: 0,
      archiveFailures: 0,
    };
    current.total += 1;
    if (item.archiveStatus === "failed") current.archiveFailures += 1;
    mediaByRevision.set(item.revisionId, current);
  }

  const evidence = createSheet(workbook, "证据与模型", [
    { header: "回答ID", width: 38 },
    { header: "平台", width: 20 },
    { header: "状态", width: 18 },
    { header: "报价（人民币元）", width: 20 },
    { header: "结算状态", width: 16 },
    { header: "实际消费（人民币元）", width: 22 },
    { header: "品牌提及", width: 12 },
    { header: "提及位置", width: 12 },
    { header: "引用数", width: 12 },
    { header: "媒体数", width: 12 },
    { header: "归档失败", width: 12 },
    { header: "配置版本", width: 12 },
  ]);
  for (const row of data.attempts) {
    const revisionId = row.result?.currentRevisionId;
    const media = revisionId ? mediaByRevision.get(revisionId) : undefined;
    const billing = billingByAttempt.get(row.attempt.id);
    addRow(evidence, [
      row.attempt.id,
      row.attempt.providerCode,
      row.attempt.status,
      billing
        ? formatCnyTenThousandths(BigInt(billing.quotedTenThousandths))
        : "",
      billing ? settlementStatusLabel(billing.settlementStatus) : "未计价",
      billing?.settlementStatus === "consumed"
        ? formatCnyTenThousandths(BigInt(billing.settledTenThousandths))
        : billing
          ? "0.00"
          : "",
      row.result?.brandMentioned ?? false,
      row.result?.mentionPosition ?? "",
      revisionId ? sourceCountByRevision.get(revisionId) || 0 : 0,
      media?.total || 0,
      media?.archiveFailures || 0,
      data.version.version,
    ]);
  }
  finishSheet(evidence);

  const media = createSheet(workbook, "媒体附件", [
    { header: "回答ID", width: 38 },
    { header: "媒体ID", width: 38 },
    { header: "类型", width: 14 },
    { header: "受保护访问路径", width: 48 },
    { header: "缩略图访问路径", width: 52 },
    { header: "MIME", width: 20 },
    { header: "字节数", width: 14 },
    { header: "归档状态", width: 18 },
  ]);
  for (const item of data.media) {
    addRow(media, [
      revisionToAttempt.get(item.revisionId) ?? "",
      item.id,
      item.type,
      item.accessPath ?? "",
      item.thumbnailAccessPath ?? "",
      item.mimeType ?? "",
      item.sizeBytes ?? "",
      item.archiveStatus,
    ]);
  }
  finishSheet(media);

  await workbook.commit();
}

/**
 * Exports exactly one owner-checked monitoring scope. Unlike the legacy run
 * export, this workbook never widens a filter to an entire run and never
 * includes billing or provider identifiers.
 */
export async function streamMonitoringWorkbook(
  repository: MonitoringRepository,
  ownerId: string,
  scope: MonitoringScope,
  sections: readonly MonitoringExportSection[],
  response: Response,
) {
  const data = await repository.getMonitoringExportData(
    ownerId,
    scope,
    sections,
  );
  const selected = new Set(sections);
  response.status(200);
  response.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="frontmind-monitoring-${scope.monitorId}.xlsx"`,
  );
  response.setHeader("Cache-Control", "private, no-store");

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: response,
    useStyles: true,
    useSharedStrings: false,
    zip: { zlib: { level: 6 } },
  });
  workbook.creator = "FrontMind Monitoring System";
  workbook.created = new Date();

  if (selected.has("overview")) {
    const sheet = createSheet(workbook, "监控概览", [
      { header: "字段", width: 24 },
      { header: "值", width: 60 },
    ]);
    addRows(sheet, [
      ["监控ID", data.monitor.id],
      ["监控名称", safeCell(data.monitor.name)],
      ["监控状态", data.monitor.status],
      ["配置版本", data.monitor.version],
      ["主品牌", safeCell(data.monitor.mainBrand)],
      ["统计时区", data.monitor.timezone],
      ["开始（含）", data.scope.from.toISOString()],
      ["结束（不含）", data.scope.to.toISOString()],
      ["问题筛选", data.scope.questionId ?? "全部"],
      ["平台筛选", data.scope.platformId ?? "全部"],
      [
        "统计主体",
        data.scope.subject.kind === "self"
          ? safeCell(data.monitor.mainBrand)
          : safeCell(data.scope.subject.name),
      ],
      ["回答数", data.answerCount],
    ]);
    finishSheet(sheet);
  }

  if (selected.has("answers")) {
    const sheet = createSheet(workbook, "问答明细", [
      { header: "回答ID", width: 38 },
      { header: "运行时间", width: 26 },
      { header: "问题", width: 60 },
      { header: "平台", width: 24 },
      { header: "端", width: 10 },
      { header: "模式", width: 16 },
      { header: "轮次", width: 10 },
      { header: "状态", width: 18 },
      { header: "回答正文", width: 80 },
      { header: "思考过程", width: 80 },
      { header: "搜索关键词", width: 42 },
      { header: "情感", width: 14 },
      { header: "主体提及", width: 12 },
      { header: "主体位置", width: 12 },
      { header: "真实引用数", width: 14 },
      { header: "返回来源数", width: 14 },
      { header: "引用证据", width: 30 },
    ]);
    for (const answer of data.answers) {
      addRow(sheet, [
        answer.answerId,
        answer.runCreatedAt.toISOString(),
        safeCell(answer.question),
        safeCell(answer.platformDisplayName),
        answer.clientType,
        answer.mode,
        answer.repetition,
        answer.status,
        safeCell(answer.answerMarkdown),
        safeCell(answer.reasoningMarkdown ?? ""),
        safeCell(answer.searchKeywords.join("、")),
        answer.sentiment ?? "",
        answer.mentioned,
        answer.position ?? "",
        answer.citationCount,
        answer.referenceCount,
        citationProvenanceLabel(answer.citationProvenance),
      ]);
    }
    finishSheet(sheet);
  }

  if (selected.has("metrics")) {
    const sheet = createSheet(workbook, "指标汇总", [
      { header: "指标", width: 28 },
      { header: "值", width: 24 },
    ]);
    const metrics = data.metrics;
    addRows(sheet, [
      ["运行数", metrics.runs],
      ["尝试数", metrics.attempts],
      ["有效回答数", metrics.answers],
      ["主体提及回答数", metrics.mentionedAnswers],
      ["主体提及率", metrics.mentionRate ?? ""],
      ["主体平均位置", metrics.averagePosition ?? ""],
      ["Top 1 占比", metrics.top1Rate ?? ""],
      ["Top 3 占比", metrics.top3Rate ?? ""],
      ["Top 10 占比", metrics.top10Rate ?? ""],
      ["真实引用数", metrics.citationCount],
      ["返回来源数", metrics.discoveredSourceCount],
      ["唯一来源域名数", metrics.uniqueDomainCount],
      ["正向", metrics.sentiments?.positive ?? "不适用于竞品主体"],
      ["中性", metrics.sentiments?.neutral ?? "不适用于竞品主体"],
      ["负向", metrics.sentiments?.negative ?? "不适用于竞品主体"],
      ["未知情感", metrics.sentiments?.unknown ?? "不适用于竞品主体"],
    ]);
    finishSheet(sheet);
  }

  if (selected.has("trends")) {
    const sheet = createSheet(workbook, "趋势", [
      { header: "日期", width: 16 },
      { header: "运行数", width: 12 },
      { header: "尝试数", width: 12 },
      { header: "回答数", width: 12 },
      { header: "提及数", width: 12 },
      { header: "提及率", width: 14 },
      { header: "平均位置", width: 14 },
      { header: "Top 1", width: 12 },
      { header: "Top 3", width: 12 },
      { header: "Top 10", width: 12 },
      { header: "真实引用数", width: 14 },
      { header: "返回来源数", width: 14 },
    ]);
    for (const point of data.trends) {
      addRow(sheet, [
        point.date,
        point.metrics.runs,
        point.metrics.attempts,
        point.metrics.answers,
        point.metrics.mentionedAnswers,
        point.metrics.mentionRate ?? "",
        point.metrics.averagePosition ?? "",
        point.metrics.top1Rate ?? "",
        point.metrics.top3Rate ?? "",
        point.metrics.top10Rate ?? "",
        point.metrics.citationCount,
        point.metrics.discoveredSourceCount,
      ]);
    }
    finishSheet(sheet);
  }

  if (selected.has("competitors")) {
    const sheet = createSheet(workbook, "竞品", [
      { header: "竞品", width: 36 },
      { header: "出现次数", width: 14 },
      { header: "回答数", width: 14 },
      { header: "提及率", width: 14 },
      { header: "平均位置", width: 14 },
      { header: "高位曝光（Top 3）", width: 20 },
    ]);
    for (const competitor of data.competitors) {
      addRow(sheet, [
        safeCell(competitor.name),
        competitor.appearances,
        competitor.answerCount,
        competitor.mentionRate ?? "",
        competitor.averagePosition ?? "",
        competitor.highPositionExposure ?? "",
      ]);
    }
    finishSheet(sheet);
  }

  if (selected.has("citations")) {
    const sheet = createSheet(workbook, "真实引用", [
      { header: "回答ID", width: 38 },
      { header: "运行时间", width: 26 },
      { header: "序号", width: 10 },
      { header: "标题", width: 48 },
      { header: "域名", width: 32 },
      { header: "URL", width: 70 },
      { header: "引用文本", width: 70 },
      { header: "供应商位置", width: 14 },
    ]);
    for (const citation of data.citations) {
      addRow(sheet, [
        citation.answerId,
        citation.runCreatedAt.toISOString(),
        citation.ordinal + 1,
        safeCell(citation.title),
        safeCell(citation.domain),
        safeCell(citation.url),
        safeCell(citation.citedText ?? ""),
        citation.providerPosition ?? "",
      ]);
    }
    finishSheet(sheet);
  }

  if (selected.has("sources")) {
    const sheet = createSheet(workbook, "返回来源", [
      { header: "回答ID", width: 38 },
      { header: "运行时间", width: 26 },
      { header: "序号", width: 10 },
      { header: "标题", width: 48 },
      { header: "站点", width: 28 },
      { header: "域名", width: 32 },
      { header: "URL", width: 70 },
      { header: "摘要", width: 70 },
      { header: "发布日期", width: 16 },
      { header: "真实引用", width: 12 },
    ]);
    for (const source of data.sources) {
      addRow(sheet, [
        source.answerId,
        source.runCreatedAt.toISOString(),
        source.ordinal + 1,
        safeCell(source.title),
        safeCell(source.siteName ?? ""),
        safeCell(source.domain),
        safeCell(source.url),
        safeCell(source.summary ?? ""),
        source.publishedAt ?? "",
        source.isCited,
      ]);
    }
    finishSheet(sheet);
  }

  await workbook.commit();
}

function createSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  name: string,
  columns: readonly ColumnDefinition[],
): Sheet {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = columns.map((column) => ({ width: column.width }));
  const header = sheet.addRow(columns.map((column) => column.header));
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF5B21B6" },
  };
  header.commit();
  return sheet;
}

function addRows(sheet: Sheet, rows: readonly (readonly unknown[])[]) {
  for (const row of rows) addRow(sheet, row);
}

function addRow(sheet: Sheet, values: readonly unknown[]) {
  sheet
    .addRow(
      values.map((value) =>
        typeof value === "string" ? safeCell(value) : value,
      ),
    )
    .commit();
}

function finishSheet(sheet: Sheet) {
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: {
      row: Math.max(1, sheet.rowCount),
      column: Math.max(1, sheet.columnCount),
    },
  };
  sheet.commit();
}

function citationProvenanceLabel(
  value: "explicit" | "legacy_assumed" | "unavailable" | undefined,
): string {
  if (value === "explicit") return "供应商明确 citationList";
  if (value === "legacy_assumed") return "旧版兼容推断（非明确引用）";
  return "供应商未提供 citationList";
}

function returnedSourceCitationLabel(
  provenance: "explicit" | "legacy_assumed" | "unavailable",
  isCited: boolean,
): string {
  if (provenance === "explicit") {
    return isCited ? "实际引用（citationList）" : "仅发现（referenceList）";
  }
  if (provenance === "legacy_assumed") {
    return "未证实引用（旧版兼容）";
  }
  return "未证实引用（未提供 citationList）";
}

function settlementStatusLabel(
  value: "reserved" | "consumed" | "released",
): string {
  if (value === "reserved") return "待结算";
  if (value === "consumed") return "已消费";
  return "已释放";
}

function formatCnyTenThousandths(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10_000n;
  const fraction = (absolute % 10_000n).toString().padStart(4, "0");
  const trimmedFraction = fraction.replace(/0+$/u, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${trimmedFraction}`;
}

function safeCell(value: string): string {
  const truncated =
    value.length > 32_000 ? `${value.slice(0, 31_980)}\n[内容已截断]` : value;
  return /^[\t\r\n ]*[=+\-@]/u.test(truncated) ? `'${truncated}` : truncated;
}
