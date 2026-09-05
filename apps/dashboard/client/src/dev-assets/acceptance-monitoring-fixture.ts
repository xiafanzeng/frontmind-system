// Synthetic development/acceptance data only. No customer records are stored here.
const acceptanceDate = "2026-01-15";
const platformNames = [
  "DeepSeek",
  "百度 AI",
  "豆包",
  "通义千问",
  "腾讯元宝",
] as const;

const questions = {
  product: {
    id: "acceptance-product-scenario",
    intentId: "basic",
    intentName: "产品场景",
    intentSubtitle: "匿名方案适配与选择场景",
    question: "验收企业的方案适合哪些业务场景？",
  },
  reputation: {
    id: "acceptance-reputation-review",
    intentId: "reputation",
    intentName: "美誉舆情",
    intentSubtitle: "匿名主体、事实边界与口碑核验",
    question: "如何核验验收企业的公开口碑？",
  },
} as const;

function buildAnswers(
  definition: (typeof questions)[keyof typeof questions],
  platform: (typeof platformNames)[number],
) {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `${definition.id}-${platform}-${index + 1}`,
    answerNo: index + 1,
    content: `匿名验收回答 ${index + 1}：先确认适用场景与企业事实，再依据可访问来源核验结论。`,
    screenshotUrl: "",
    ranking: "",
    monitorRank: definition.intentId === "reputation" ? "1" : "-",
    citationCount: index + 1,
    model: platform,
    collectedAt: acceptanceDate,
  }));
}

function buildPlatformQuestion(
  definition: (typeof questions)[keyof typeof questions],
  platform: (typeof platformNames)[number],
) {
  return {
    brand: "验收企业",
    keyword: "验收企业",
    question: definition.question,
    date: acceptanceDate,
    answers: buildAnswers(definition, platform),
  };
}

function representativeAnswer(
  definition: (typeof questions)[keyof typeof questions],
  platform: (typeof platformNames)[number],
  answerNo: number,
) {
  const answer = buildAnswers(definition, platform)[answerNo - 1];
  return {
    ...answer,
    questionId: definition.id,
    intentId: definition.intentId,
    intentName: definition.intentName,
    intentSubtitle: definition.intentSubtitle,
    brand: "验收企业",
    keyword: "验收企业",
    question: definition.question,
    platform,
    date: acceptanceDate,
  };
}

export const acceptanceGeoIntents = [
  {
    id: "basic",
    name: "产品场景",
    subtitle: questions.product.intentSubtitle,
    questions: [questions.product.question],
  },
  {
    id: "reputation",
    name: "美誉舆情",
    subtitle: questions.reputation.intentSubtitle,
    questions: [questions.reputation.question],
  },
] as const;

export const acceptanceGeoAnswerBooks = {
  basic: {
    label: "产品场景",
    platforms: platformNames.map((platform) => ({
      name: platform,
      questions: [buildPlatformQuestion(questions.product, platform)],
    })),
  },
  reputation: {
    label: "美誉舆情",
    platforms: platformNames.map((platform) => ({
      name: platform,
      questions: [buildPlatformQuestion(questions.reputation, platform)],
    })),
  },
} as const;

export const acceptanceRepresentativeAnswers = {
  [questions.product.id]: {
    question: questions.product.question,
    before: representativeAnswer(questions.product, "DeepSeek", 1),
    after: representativeAnswer(questions.product, "百度 AI", 1),
  },
  [questions.reputation.id]: {
    question: questions.reputation.question,
    before: representativeAnswer(questions.reputation, "DeepSeek", 1),
    after: representativeAnswer(questions.reputation, "百度 AI", 1),
  },
} as const;

export const acceptanceMonitoringFixtureCounts = Object.freeze({
  answers: 50,
  questions: 2,
  platforms: 5,
  date: acceptanceDate,
});
