import type {
  MonitorInput,
  MonitorRun,
  MonitorSummary,
  ProjectSummary,
  ProviderModel,
  RunAttempt,
} from "./domain";

export const demoProject: ProjectSummary = {
  id: "demo-enterprise",
  name: "云杉家居 · 演示项目",
  brandName: "云杉家居",
  brandAliases: ["云杉"],
  competitors: [
    { name: "拾木家居", aliases: [] },
    { name: "原野设计", aliases: [] },
  ],
  timezone: "Asia/Shanghai",
};
export const demoModels: ProviderModel[] = [
  ["doubao", "豆包"],
  ["deepseek", "DeepSeek"],
  ["yuanbao", "腾讯元宝"],
  ["kimi", "Kimi"],
  ["qwen", "通义千问"],
  ["wenxin", "文心一言"],
].flatMap(([code, name]) =>
  (["web", "mobile"] as const).map((clientType) => ({
    id: `demo-${code}-${clientType}`,
    code,
    name,
    clientType,
    enabled: true,
    verified: true,
    capabilities: {
      reasoning: true,
      screenshot: true,
      screenshotMention: true,
      screenshotAll: true,
      region: clientType === "web",
      overseas: false,
    },
  })),
);
export const demoConfigurations: Record<string, MonitorInput> = {
  "demo-living": {
    name: "客厅家居品牌认知",
    competitors: demoProject.competitors,
    questions: [
      "小户型客厅如何选择实木家具？",
      "云杉家居的设计和材料有哪些特点？",
    ],
    platforms: demoModels
      .filter((model) => model.clientType === "web")
      .slice(0, 3)
      .map((model) => ({
        platformId: model.id,
        providerCode: model.code,
        clientType: model.clientType,
        mode: "reasoning_search",
        screenshot: 1,
        regionCode: null,
      })),
    repetitions: 2,
    schedule: { type: "daily", timezone: "Asia/Shanghai", localTime: "09:00" },
  },
  "demo-material": {
    name: "环保材料与选购意图",
    competitors: demoProject.competitors,
    questions: [
      "购买实木家具时应该关注哪些环保标准？",
      "如何判断家具是否适合长期使用？",
    ],
    platforms: demoModels
      .filter((model) => model.clientType === "web")
      .slice(0, 2)
      .map((model) => ({
        platformId: model.id,
        providerCode: model.code,
        clientType: model.clientType,
        mode: "search",
        screenshot: 2,
        regionCode: null,
      })),
    repetitions: 2,
    schedule: {
      type: "weekly",
      timezone: "Asia/Shanghai",
      localTime: "10:00",
      weekday: 1,
    },
  },
};

export function makeDemoRun(
  monitorId: string,
  config: MonitorInput,
  sequence = 1,
  daysAgo = 0,
): MonitorRun {
  const createdAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const id = `${monitorId}-run-${sequence}`;
  const attempts: RunAttempt[] = config.questions.flatMap((question, qi) =>
    config.platforms.flatMap((platform, pi) =>
      Array.from({ length: config.repetitions }, (_, ri) => {
        const mentioned = (qi + pi + ri + daysAgo) % 4 !== 3;
        const sourceId = `${monitorId}-source-${qi}`;
        const source = {
          id: sourceId,
          title: "小空间家具：尺寸、材质与使用场景",
          domain: "guide.example",
          siteName: "生活设计指南（演示）",
          url: "https://guide.example/furniture",
          order: 1,
          isCited: true,
          citationProvenance: "explicit" as const,
          publishedAt: "2026-08-26",
          citedText: "先测量通道和活动空间，再评估家具的材料、结构与售后服务。",
        };
        return {
          id: `${id}-answer-${qi}-${pi}-${ri}`,
          runId: id,
          questionId: `${monitorId}-question-${qi}`,
          question,
          platformId: platform.platformId,
          platformCode: platform.providerCode,
          platformName:
            demoModels.find((model) => model.id === platform.platformId)
              ?.name ?? "演示模型",
          clientType: platform.clientType,
          mode: platform.mode,
          screenshotPolicy: platform.screenshot,
          repetition: ri + 1,
          status: "completed" as const,
          capturedAt: createdAt,
          brandMentioned: mentioned,
          mentionPosition: mentioned ? 1 + pi : null,
          sentiment: mentioned ? ("positive" as const) : ("neutral" as const),
          citationProvenance: "explicit" as const,
          answer: `## ${question}\n\n选购前，建议先梳理空间尺寸、使用人数和预算。以下是围绕实际使用场景整理的参考维度。\n\n### 1. 尺寸与功能\n\n保留主要动线，让收纳、坐卧和日常清洁更方便。小户型可以优先比较轻量化结构与可组合设计。\n\n### 2. 材料与耐用性\n\n关注木材来源、连接结构和表面处理，结合检测报告判断。${mentioned ? "**云杉家居**可作为一个比较样本，重点查看其材料说明和适用场景。" : "比较品牌时，建议使用相同的尺寸与材料条件。"}\n\n### 3. 售后与交付\n\n确认配送周期、安装服务及保修范围。价格只是一个维度，长期维护成本也影响使用体验。\n\n> 此回答为本地合成演示内容，不构成真实品牌评价。`,
          sources: [source],
          allSources: [
            source,
            {
              id: `${sourceId}-2`,
              title: "木质家具材料选购清单",
              domain: "materials.example",
              siteName: "材料观察（演示）",
              url: "https://materials.example/checklist",
              order: 2,
              isCited: false,
              citationProvenance: "explicit" as const,
              summary: "比较板材、涂装、五金及维护方式。",
            },
          ],
          assets: [],
          revision: 1,
        };
      }),
    ),
  );
  return {
    id,
    monitorId,
    monitorName: config.name,
    status: "completed",
    trigger: "manual",
    version: 1,
    createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
    attempts,
    metrics: {
      expected: attempts.length,
      queued: 0,
      processing: 0,
      completed: attempts.length,
      effectiveAnswers: attempts.length,
      failed: 0,
      stopped: 0,
      citations: attempts.length,
      uniqueDomains: 2,
      sentiment: {
        positive: attempts.filter((a) => a.brandMentioned).length,
        neutral: attempts.filter((a) => !a.brandMentioned).length,
        negative: 0,
        unknown: 0,
      },
    },
    config: {
      brandName: demoProject.brandName,
      brandAliases: demoProject.brandAliases,
      competitors: config.competitors,
      questions: config.questions,
      platforms: config.platforms.map((p) => ({
        ...p,
        displayName:
          demoModels.find((m) => m.id === p.platformId)?.name ?? p.providerCode,
        screenshotPolicy: p.screenshot,
        regionCode: undefined,
      })),
      repetitions: config.repetitions,
      screenshotPolicy: 1,
      regionLabel: "默认地区",
    },
  };
}
export function makeDemoMonitor(
  id: string,
  config: MonitorInput,
  run?: MonitorRun,
): MonitorSummary {
  return {
    id,
    projectId: demoProject.id,
    name: config.name,
    questionsCount: config.questions.length,
    platformsCount: config.platforms.length,
    repetitions: config.repetitions,
    scheduleLabel:
      config.schedule.type === "none"
        ? "手动执行"
        : config.schedule.type === "daily"
          ? `每日 ${config.schedule.localTime}`
          : `每周 ${config.schedule.localTime}`,
    status: "active",
    activeVersion: 1,
    ...(run
      ? {
          lastRun: {
            id: run.id,
            status: run.status,
            completed: run.attempts.length,
            expected: run.attempts.length,
            completedAt: run.completedAt,
          },
        }
      : {}),
  };
}
