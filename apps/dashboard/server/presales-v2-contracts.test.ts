import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PRESALES_V2_CONTRACT_HASHES,
  PRESALES_V2_CAPABILITIES,
  presalesV2CanonicalContractDescriptor,
  PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS,
  presalesV2ContractSchema,
  resolvePresalesV2Contract,
} from "./presales-v2-contracts";

const FORBIDDEN_PROVIDER_SCHEMA_KEYS = new Set([
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "oneOf",
  "allOf",
  "$ref",
]);

function inspectRestrictedSchema(value: unknown, objectDepth = 0): number {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  const schema = value as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    expect(FORBIDDEN_PROVIDER_SCHEMA_KEYS.has(key)).toBe(false);
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  let deepestObject = objectDepth;
  if (types.includes("object")) {
    const nextDepth = objectDepth + 1;
    deepestObject = nextDepth;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toBeTruthy();
    const properties = schema.properties as Record<string, unknown>;
    expect([...(schema.required as string[])].sort()).toEqual(
      Object.keys(properties).sort(),
    );
    for (const property of Object.values(properties)) {
      deepestObject = Math.max(
        deepestObject,
        inspectRestrictedSchema(property, nextDepth),
      );
    }
  }
  if (schema.items) {
    deepestObject = Math.max(
      deepestObject,
      inspectRestrictedSchema(schema.items, objectDepth),
    );
  }
  return deepestObject;
}

describe("Presales v2 contracts", () => {
  it("advertises immutable Website project business-owner attribution", () => {
    expect(PRESALES_V2_CAPABILITIES).toContain("project-business-owner");
  });

  it("binds every readiness hash to the canonical exact Provider descriptor", () => {
    const canonical = (value: unknown): string => {
      if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) {
        return `[${value.map(canonical).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
    };
    for (const [name, expected] of Object.entries(
      PRESALES_V2_CONTRACT_HASHES,
    )) {
      const descriptor = presalesV2CanonicalContractDescriptor(
        name as keyof typeof PRESALES_V2_CONTRACT_HASHES,
      );
      expect(
        createHash("sha256").update(canonical(descriptor)).digest("hex"),
      ).toBe(expected);
      expect(expected).not.toBe(
        createHash("sha256").update(`${name}@2`).digest("hex"),
      );
      expect(descriptor.structured_output_schema).toBe(
        PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[
          name as keyof typeof PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS
        ],
      );
    }
  });

  it("freezes all six hashes/profiles and selects a schema only for typed contracts", () => {
    for (const [name, schemaHash] of Object.entries(
      PRESALES_V2_CONTRACT_HASHES,
    )) {
      const contract = resolvePresalesV2Contract(
        presalesV2ContractSchema.parse({ name, revision: 2, schemaHash }),
      );
      expect(contract.profile).toBe(
        name === "website.question-recommendation"
          ? "frontmind-pro"
          : "frontmind-base",
      );
      expect(contract.schemaHash).toBe(schemaHash);
      expect(contract.structuredOutputSchema).toBe(
        PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[
          name as keyof typeof PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS
        ],
      );
      expect(contract.output).toBe(
        name === "website.knowledge-base-candidate" ? "artifact" : "structured",
      );
    }
  });

  it("fails closed for unknown, stale, mismatched, or caller-selected models", () => {
    const recommendationHash =
      PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"];
    expect(() =>
      presalesV2ContractSchema.parse({
        name: "website.unknown",
        revision: 2,
        schemaHash: recommendationHash,
      }),
    ).toThrow();
    expect(() =>
      presalesV2ContractSchema.parse({
        name: "website.question-recommendation",
        revision: 1,
        schemaHash: recommendationHash,
      }),
    ).toThrow();
    expect(() =>
      resolvePresalesV2Contract({
        name: "website.question-recommendation",
        revision: 2,
        schemaHash: "0".repeat(64),
      }),
    ).toThrow(/CONTRACT_HASH_MISMATCH/u);
    expect(() =>
      presalesV2ContractSchema.parse({
        name: "website.question-recommendation",
        revision: 2,
        schemaHash: recommendationHash,
        agentProfile: "frontmind-base",
      }),
    ).toThrow();
  });

  it("uses five distinct restricted root-object schemas and leaves KB on artifacts", () => {
    const expectedRoots = {
      "website.question-recommendation": ["questions"],
      "website.custom-question-classifier": [
        "decision",
        "category",
        "enterpriseRelated",
        "reasonCode",
        "reason",
        "questionEnglish",
        "enterpriseAnchor",
        "offeringAnchor",
        "evidenceRefs",
      ],
      "website.current-state-assessment": [
        "schemaVersion",
        "assessmentType",
        "question",
        "sample",
        "dimensions",
        "rankingDiagnostics",
        "platformBreakdown",
        "knowledgeVsAnswers",
        "summary",
        "executiveSummary",
        "dimensionNarratives",
        "priorityActions",
        "limitations",
      ],
      "website.optimization-forecast": [
        "schemaVersion",
        "forecastType",
        "horizonWeeks",
        "scenario",
        "dimensions",
        "roadmap",
        "summary",
        "executiveSummary",
        "dimensionNarratives",
        "limitations",
        "claimGuardrails",
        "brandMentionRateTarget",
      ],
      "website.monitor-question-translation": [
        "schemaVersion",
        "sourceQuestionSha256",
        "questionEnglish",
      ],
    } as const;

    expect(
      PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS["website.knowledge-base-candidate"],
    ).toBeNull();
    const selectedSchemas: unknown[] = [];
    for (const [name, expectedKeys] of Object.entries(expectedRoots)) {
      const schema = PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[
        name as keyof typeof expectedRoots
      ] as unknown as Record<string, unknown>;
      selectedSchemas.push(schema);
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(
        expectedKeys,
      );
      expect(inspectRestrictedSchema(schema)).toBeLessThanOrEqual(5);
    }
    expect(new Set(selectedSchemas).size).toBe(5);

    for (const name of [
      "website.current-state-assessment",
      "website.optimization-forecast",
    ] as const) {
      const properties = PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[name]
        .properties as Record<string, Record<string, unknown>>;
      expect(properties.schemaVersion).toEqual({
        type: "integer",
        enum: [2],
      });
      expect(properties.executiveSummary.type).toBe("string");
      expect(properties.dimensionNarratives.type).toBe("object");
    }

    const forecastProperties = PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[
      "website.optimization-forecast"
    ].properties as Record<string, Record<string, unknown>>;
    expect(forecastProperties.brandMentionRateTarget).toEqual({
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        low: { type: "number" },
        expected: { type: "number" },
        high: { type: "number" },
      },
      required: ["low", "expected", "high"],
    });

    const serialized = JSON.stringify(PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS);
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain("markdown");
  });
});
