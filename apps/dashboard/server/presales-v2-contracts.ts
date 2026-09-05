import { createHash } from "node:crypto";

import { z } from "zod";

import type { ManagedAgentProfile } from "../shared/manus-agent-profile";
import type { ManusV2StructuredOutputSchema } from "./manus-v2-client";

export const PRESALES_V2_CONTRACT_VERSION = 2 as const;

export const PRESALES_V2_CAPABILITIES = [
  "local-assets",
  "typed-results",
  "local-artifacts",
  "safe-events",
  "project-business-owner",
] as const;

export const PRESALES_V2_CONTRACT_NAMES = [
  "website.question-recommendation",
  "website.knowledge-base-candidate",
  "website.custom-question-classifier",
  "website.current-state-assessment",
  "website.optimization-forecast",
  "website.monitor-question-translation",
] as const;

export type PresalesV2ContractName =
  (typeof PRESALES_V2_CONTRACT_NAMES)[number];

export type PresalesV2Contract = {
  name: PresalesV2ContractName;
  revision: typeof PRESALES_V2_CONTRACT_VERSION;
  schemaHash: string;
  profile: ManagedAgentProfile;
  output: "structured" | "artifact";
  structuredOutputSchema: ManusV2StructuredOutputSchema | null;
};

type RestrictedSchema = {
  type: string | readonly string[];
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, RestrictedSchema>>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: RestrictedSchema;
};

const text = (): RestrictedSchema => ({ type: "string" });
const integer = (): RestrictedSchema => ({ type: "integer" });
const number = (): RestrictedSchema => ({ type: "number" });
const boolean = (): RestrictedSchema => ({ type: "boolean" });
const nullableText = (): RestrictedSchema => ({
  type: ["string", "null"],
});
const nullableInteger = (): RestrictedSchema => ({
  type: ["integer", "null"],
});
const nullableNumber = (): RestrictedSchema => ({
  type: ["number", "null"],
});
const literal = (
  type: "string" | "integer" | "boolean",
  value: string | number | boolean,
): RestrictedSchema => ({ type, enum: [value] });
const enumeration = (
  type: "string" | "integer",
  values: readonly (string | number)[],
): RestrictedSchema => ({ type, enum: values });
const nullableEnumeration = (values: readonly string[]): RestrictedSchema => ({
  type: ["string", "null"],
  enum: [...values, null],
});
const array = (items: RestrictedSchema): RestrictedSchema => ({
  type: "array",
  items,
});
const object = (
  properties: Readonly<Record<string, RestrictedSchema>>,
  nullable = false,
): RestrictedSchema => ({
  type: nullable ? ["object", "null"] : "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

const QUESTION_CATEGORIES = [
  "reputation",
  "product_scenario",
  "industry_ranking",
  "competitor_comparison",
] as const;

const PRODUCT_QA_INTENTS = [
  "offering_definition",
  "feature_mechanism",
  "scenario_fit",
  "delivery_usage",
  "support_boundary",
] as const;

const ASSESSMENT_DIMENSION_NAMES = [
  "semanticVisibility",
  "semanticCoherence",
  "semanticRichness",
  "semanticAuthority",
  "competitiveAdvantage",
] as const;

const FORECAST_ACTION_IDS = [
  "GEO_A1_entity_facts",
  "GEO_A2_ai_visibility",
  "GEO_A3_qa_assets",
  "GEO_A4_positioning_language",
  "GEO_A5_site_schema",
  "GEO_A6_distribution_citations",
] as const;

function dimensionSchema(indicator: RestrictedSchema): RestrictedSchema {
  return object({
    semanticVisibility: object({
      aiSearchVisibility: indicator,
      webSearchSov: indicator,
      multiPlatformCoverage: indicator,
    }),
    semanticCoherence: object({
      corePropositionHitRate: indicator,
      toneConsistency: indicator,
    }),
    semanticRichness: object({
      questionStageCoverage: indicator,
      semanticEntityRichness: indicator,
      contentFormatDiversity: indicator,
    }),
    semanticAuthority: object({
      authoritativeSourceRatio: indicator,
      structuredDataCompleteness: indicator,
      thirdPartyEndorsement: indicator,
    }),
    competitiveAdvantage: object({
      firstMentionRate: indicator,
      exclusiveSemanticSpace: indicator,
    }),
  });
}

const dimensionNarrativeSchema = object({
  currentFinding: text(),
  nextAction: text(),
});

function dimensionNarrativesSchema(nullable = false): RestrictedSchema {
  return object(
    {
      semanticVisibility: dimensionNarrativeSchema,
      semanticCoherence: dimensionNarrativeSchema,
      semanticRichness: dimensionNarrativeSchema,
      semanticAuthority: dimensionNarrativeSchema,
      competitiveAdvantage: dimensionNarrativeSchema,
    },
    nullable,
  );
}

const recommendationQuestionSchema = object({
  id: text(),
  category: enumeration("string", QUESTION_CATEGORIES),
  question: text(),
  questionEnglish: nullableText(),
  rationale: text(),
  enterpriseAnchor: nullableText(),
  offeringAnchor: nullableText(),
  competitorAnchor: nullableText(),
  qaIntent: nullableEnumeration(PRODUCT_QA_INTENTS),
  evidenceRefs: array(text()),
  selectable: boolean(),
});

const questionRecommendationSchema = object({
  questions: array(recommendationQuestionSchema),
});

const customQuestionClassifierSchema = object({
  decision: enumeration("string", ["accept", "reject"]),
  category: enumeration("string", [
    "reputation",
    "product_scenario",
    "competitor_comparison",
    "industry_ranking",
    "unrelated",
    "ambiguous",
  ]),
  enterpriseRelated: boolean(),
  reasonCode: enumeration("string", [
    "accepted",
    "industry_ranking",
    "enterprise_unrelated",
    "ambiguous",
  ]),
  reason: text(),
  questionEnglish: nullableText(),
  enterpriseAnchor: nullableText(),
  offeringAnchor: nullableText(),
  evidenceRefs: array(text()),
});

const assessmentIndicatorSchema = object({
  rawValue: nullableNumber(),
  measurementStatus: enumeration("string", [
    "measured",
    "derived",
    "unavailable",
  ]),
  confidence: number(),
  calculationBasis: text(),
  evidenceRefs: array(text()),
  limitations: array(text()),
});

const currentStateAssessmentSchema = object({
  schemaVersion: literal("integer", 2),
  assessmentType: literal("string", "question_baseline"),
  question: object({
    id: text(),
    text: text(),
    category: enumeration("string", QUESTION_CATEGORIES),
    rankingMetricEligible: boolean(),
  }),
  sample: object({
    selectedPlatforms: array(text()),
    repeatPerPlatform: literal("integer", 5),
    expectedResponses: integer(),
    successfulResponses: integer(),
    failedResponses: integer(),
  }),
  dimensions: dimensionSchema(assessmentIndicatorSchema),
  rankingDiagnostics: object({
    eligible: boolean(),
    totalObservations: integer(),
    rankedObservations: integer(),
    unmentionedObservations: integer(),
    averageRank: nullableNumber(),
    firstPlaceRate: nullableNumber(),
    top3Rate: nullableNumber(),
    top5Rate: nullableNumber(),
    competitorRankGap: nullableNumber(),
    calculationBasis: text(),
  }),
  platformBreakdown: array(
    object({
      platform: text(),
      responseCount: literal("integer", 5),
      successfulResponses: integer(),
      brandMentionRate: nullableNumber(),
      averageRank: nullableNumber(),
      factAccuracy: nullableNumber(),
      propositionHitRate: nullableNumber(),
      sourceCount: nullableInteger(),
      citationCount: nullableInteger(),
      referenceCount: nullableInteger(),
      sentiment: enumeration("string", [
        "positive",
        "neutral",
        "negative",
        "mixed",
        "unknown",
      ]),
      verdict: text(),
      evidenceRefs: array(text()),
    }),
  ),
  knowledgeVsAnswers: array(
    object({
      id: text(),
      topic: text(),
      verdict: enumeration("string", [
        "supported",
        "contradicted",
        "omitted",
        "unverifiable",
      ]),
      platform: nullableText(),
      runIndex: nullableInteger(),
      answerExcerpt: nullableText(),
      kbClaimId: nullableText(),
      kbClaimText: nullableText(),
      kbEvidenceRefs: array(text()),
      explanation: text(),
      recommendedAction: text(),
      confidence: number(),
    }),
  ),
  summary: text(),
  executiveSummary: text(),
  dimensionNarratives: dimensionNarrativesSchema(),
  priorityActions: array(
    object({
      priority: integer(),
      dimension: enumeration("string", ASSESSMENT_DIMENSION_NAMES),
      action: text(),
      expectedImpact: text(),
      evidenceRefs: array(text()),
    }),
  ),
  limitations: array(text()),
});

const forecastIndicatorSchema = object({
  measurementStatus: enumeration("string", ["projectable", "not_projectable"]),
  gapClosureLow: nullableNumber(),
  gapClosureHigh: nullableNumber(),
  effectType: enumeration("string", [
    "direct_asset",
    "observed_outcome",
    "not_applicable",
  ]),
  confidence: number(),
  actionIds: array(enumeration("string", FORECAST_ACTION_IDS)),
  rationale: text(),
  dependencies: array(text()),
  evidenceRefs: array(text()),
  timeToSignalWeeks: nullableInteger(),
  verificationMetric: text(),
});

const optimizationForecastSchema = object({
  schemaVersion: literal("integer", 2),
  forecastType: literal("string", "conditional_4_week"),
  horizonWeeks: literal("integer", 4),
  scenario: object({
    name: literal("string", "full_execution"),
    actionIds: array(enumeration("string", FORECAST_ACTION_IDS)),
    assumptions: array(text()),
    verificationWeeks: array(enumeration("integer", [2, 4])),
  }),
  dimensions: dimensionSchema(forecastIndicatorSchema),
  roadmap: array(
    object({
      phase: integer(),
      weeks: text(),
      title: text(),
      actions: array(text()),
      verificationGate: text(),
    }),
  ),
  summary: text(),
  executiveSummary: text(),
  dimensionNarratives: dimensionNarrativesSchema(),
  limitations: array(text()),
  claimGuardrails: object({
    isGuarantee: literal("boolean", false),
    planningAssumptionOnly: literal("boolean", true),
    requiresSameScopeRemeasurement: literal("boolean", true),
  }),
  brandMentionRateTarget: object(
    {
      low: number(),
      expected: number(),
      high: number(),
    },
    true,
  ),
});

const monitorQuestionTranslationSchema = object({
  schemaVersion: literal("integer", 1),
  sourceQuestionSha256: text(),
  questionEnglish: text(),
});

/**
 * Provider transport schemas use only Manus' restricted Structured Output
 * subset. Website remains authoritative for cardinality, cross-field rules,
 * ranges, text constraints, and all other business validation.
 */
export const PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS = {
  "website.question-recommendation": questionRecommendationSchema,
  "website.knowledge-base-candidate": null,
  "website.custom-question-classifier": customQuestionClassifierSchema,
  "website.current-state-assessment": currentStateAssessmentSchema,
  "website.optimization-forecast": optimizationForecastSchema,
  "website.monitor-question-translation": monitorQuestionTranslationSchema,
} as const satisfies Record<
  PresalesV2ContractName,
  ManusV2StructuredOutputSchema | null
>;

const profileByContract: Record<PresalesV2ContractName, ManagedAgentProfile> = {
  "website.question-recommendation": "frontmind-pro",
  "website.knowledge-base-candidate": "frontmind-base",
  "website.custom-question-classifier": "frontmind-base",
  "website.current-state-assessment": "frontmind-base",
  "website.optimization-forecast": "frontmind-base",
  "website.monitor-question-translation": "frontmind-base",
};

const outputByContract: Record<
  PresalesV2ContractName,
  PresalesV2Contract["output"]
> = {
  "website.question-recommendation": "structured",
  "website.knowledge-base-candidate": "artifact",
  "website.custom-question-classifier": "structured",
  "website.current-state-assessment": "structured",
  "website.optimization-forecast": "structured",
  "website.monitor-question-translation": "structured",
};

function canonicalContractJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalContractJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalContractJson(record[key])}`,
    )
    .join(",")}}`;
}

export function presalesV2CanonicalContractDescriptor(
  name: PresalesV2ContractName,
) {
  return {
    name,
    revision: PRESALES_V2_CONTRACT_VERSION,
    output: outputByContract[name],
    structured_output_schema: PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[name],
  };
}

export function presalesV2CanonicalContractHash(name: PresalesV2ContractName) {
  return createHash("sha256")
    .update(
      canonicalContractJson(presalesV2CanonicalContractDescriptor(name)),
      "utf8",
    )
    .digest("hex");
}

export const PRESALES_V2_CONTRACT_HASHES = Object.freeze(
  Object.fromEntries(
    PRESALES_V2_CONTRACT_NAMES.map((name) => [
      name,
      presalesV2CanonicalContractHash(name),
    ]),
  ) as Record<PresalesV2ContractName, string>,
);

export const presalesV2ContractSchema = z
  .object({
    name: z.enum(PRESALES_V2_CONTRACT_NAMES),
    revision: z.literal(PRESALES_V2_CONTRACT_VERSION),
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export function resolvePresalesV2Contract(
  input: z.infer<typeof presalesV2ContractSchema>,
): PresalesV2Contract {
  const expectedHash = PRESALES_V2_CONTRACT_HASHES[input.name];
  if (input.schemaHash !== expectedHash) {
    throw new PresalesV2ContractError("CONTRACT_HASH_MISMATCH", 409);
  }
  return {
    ...input,
    profile: profileByContract[input.name],
    output: outputByContract[input.name],
    structuredOutputSchema: PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[input.name],
  };
}

export function presalesV2StructuredPrompt(contract: PresalesV2Contract) {
  return [
    "FRONTMIND_PRESALES_CONTRACT=" +
      JSON.stringify({
        name: contract.name,
        revision: contract.revision,
        schemaHash: contract.schemaHash,
      }),
    "Return exactly one structured output result.",
    "Return the canonical top-level JSON object required by this contract.",
    "Do not stringify the object or wrap it in Markdown or a code fence.",
  ].join("\n");
}

export class PresalesV2ContractError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "PresalesV2ContractError";
  }
}
