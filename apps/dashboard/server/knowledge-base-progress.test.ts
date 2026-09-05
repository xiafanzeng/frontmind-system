import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES,
  KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES,
  KNOWLEDGE_BASE_MANIFEST_KIND,
  KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
  KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY,
  KNOWLEDGE_BASE_PROGRESS_KIND,
  KnowledgeBaseProgressError,
  applyKnowledgeBaseProgressEnvelope,
  assertKnowledgeBaseProtocolOperation,
  assertKnowledgeBasePresentationMatchesState,
  assertKnowledgeBaseReadyForPackage,
  canPackageKnowledgeBase,
  classifyKnowledgeBaseUpstreamTaskStatus,
  createKnowledgeBaseProgressState,
  formatKnowledgeBaseProgressEnvelope,
  formatKnowledgeBasePresentationEnvelope,
  getKnowledgeBaseProgressSummary,
  parseKnowledgeBaseProgressEnvelope,
  parseKnowledgeBasePresentationEnvelope,
  parseKnowledgeBaseReopenEnvelope,
  formatKnowledgeBaseManifestEnvelope,
  parseKnowledgeBaseManifestEnvelope,
  shouldShowKnowledgeBaseCheckmark,
  validateProductionKnowledgeBaseLeafManifest,
  validateKnowledgeBaseManifestForTreePolicy,
  validateStoredKnowledgeBaseResearchCoverage,
  knowledgeBaseTreePolicy,
} from "./knowledge-base-progress";
import type {
  KnowledgeBaseLeafManifestEntry,
  KnowledgeBaseProgressEnvelope,
} from "./knowledge-base-progress";

const manifest: KnowledgeBaseLeafManifestEntry[] = [
  { id: "identity.name", title: "企业名称", branchId: "identity" },
  { id: "identity.position", title: "企业定位", branchId: "identity" },
  { id: "product.primary", title: "核心产品", branchId: "product" },
];

describe("knowledge base upstream status classifier", () => {
  it.each(["completed", "complete", "succeeded", "done", "finished"])(
    "classifies %s as a successful terminal status",
    (status) => {
      expect(classifyKnowledgeBaseUpstreamTaskStatus(status)).toMatchObject({
        phase: "succeeded",
        settled: true,
        terminal: true,
        failed: false,
      });
    },
  );

  it.each(["failed", "error", "cancelled", "canceled"])(
    "classifies %s as a failed terminal status",
    (status) => {
      expect(classifyKnowledgeBaseUpstreamTaskStatus(status)).toMatchObject({
        settled: true,
        terminal: true,
        failed: true,
      });
    },
  );

  it("keeps streaming and interaction-ready states distinct", () => {
    expect(
      classifyKnowledgeBaseUpstreamTaskStatus("in-progress"),
    ).toMatchObject({ phase: "active", settled: false });
    expect(
      classifyKnowledgeBaseUpstreamTaskStatus("awaiting_user"),
    ).toMatchObject({
      phase: "awaiting_input",
      settled: true,
      terminal: false,
    });
  });
});

describe("knowledge base v4 operation identity", () => {
  it("classifies a well-formed envelope from an older turn as an idempotent stale operation", () => {
    expectProgressError(
      () =>
        assertKnowledgeBaseProtocolOperation(
          {
            schemaVersion: 2,
            operationId: `kbv2_${"a".repeat(64)}`,
            turnId: "00000000-0000-4000-8000-000000000001",
          },
          {
            operationId: `kbv2_${"b".repeat(64)}`,
            turnId: "00000000-0000-4000-8000-000000000002",
            requireV4: true,
          },
        ),
      "STALE_OPERATION",
    );
  });

  it("keeps a legacy envelope on a v4 build as a real protocol error", () => {
    expectProgressError(
      () =>
        assertKnowledgeBaseProtocolOperation(
          { schemaVersion: 1 },
          {
            operationId: `kbv2_${"b".repeat(64)}`,
            turnId: "00000000-0000-4000-8000-000000000002",
            requireV4: true,
          },
        ),
      "INVALID_ENVELOPE",
    );
  });
});

describe("knowledge base streaming envelope boundary", () => {
  it("never parses JSON from an unclosed protocol comment", () => {
    const partial = `<!-- FRONTMIND_KB_PROGRESS
${JSON.stringify({
  kind: "frontmind.knowledge-base.progress",
  schemaVersion: 1,
  revision: 0,
  transition: {
    leafId: "identity.name",
    from: "current",
    to: "confirmed",
  },
})}`;
    expectProgressError(
      () => parseKnowledgeBaseProgressEnvelope(partial),
      "INVALID_ENVELOPE",
    );
  });

  it("repairs an unescaped quoted name before strict protocol validation", () => {
    const leaves = Array.from({ length: 8 }, (_, index) => ({
      id: `${index + 1}.1`,
      title: index === 0 ? '企业"深度"定位' : `节点 ${index + 1}`,
      branchId: `branch-${index + 1}`,
      branchTitle: `业务分支 ${index + 1}`,
    }));
    const malformed = JSON.stringify({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 1,
      leaves,
    }).replace('企业\\"深度\\"定位', '企业"深度"定位');

    expect(
      parseKnowledgeBaseManifestEnvelope(
        `节点正文\n<!-- FRONTMIND_KB_MANIFEST\n${malformed}\n-->`,
      ).leaves[0]?.title,
    ).toBe('企业"深度"定位');
  });

  it("deduplicates identical canonical protocol candidates but rejects conflicts", () => {
    const leaves = Array.from({ length: 8 }, (_, index) => ({
      id: `${index + 1}.1`,
      title: `节点 ${index + 1}`,
      branchId: `branch-${index + 1}`,
      branchTitle: `业务分支 ${index + 1}`,
    }));
    const first = formatKnowledgeBaseManifestEnvelope({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 1,
      leaves,
    });
    expect(
      parseKnowledgeBaseManifestEnvelope(`${first}\n${first}`).leaves,
    ).toHaveLength(8);

    const conflicting = formatKnowledgeBaseManifestEnvelope({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 1,
      leaves: leaves.map((leaf, index) =>
        index === 0 ? { ...leaf, title: "冲突标题" } : leaf,
      ),
    });
    expectProgressError(
      () => parseKnowledgeBaseManifestEnvelope(`${first}\n${conflicting}`),
      "INVALID_MANIFEST",
    );
  });

  it("skips malformed trusted bare fragments when one unique final object is valid", () => {
    const leaves = Array.from({ length: 8 }, (_, index) => ({
      id: `${index + 1}.1`,
      title: `节点 ${index + 1}`,
      branchId: `branch-${index + 1}`,
      branchTitle: `业务分支 ${index + 1}`,
    }));
    const staleFragment = JSON.stringify({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 1,
      leaves: [{ id: "partial" }],
    });
    const finalObject = JSON.stringify({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 1,
      leaves,
    });

    expect(
      parseKnowledgeBaseManifestEnvelope(
        `旧片段\n${staleFragment}\n${finalObject}`,
      ).leaves,
    ).toEqual(leaves);
  });

  it("fails closed when an official marked envelope is malformed", () => {
    const leaves = Array.from({ length: 8 }, (_, index) => ({
      id: `${index + 1}.1`,
      title: `节点 ${index + 1}`,
      branchId: `branch-${index + 1}`,
      branchTitle: `业务分支 ${index + 1}`,
    }));
    const validBare = JSON.stringify({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 1,
      leaves,
    });
    expectProgressError(
      () =>
        parseKnowledgeBaseManifestEnvelope(
          `<!-- FRONTMIND_KB_MANIFEST\n{"kind":"${KNOWLEDGE_BASE_MANIFEST_KIND}","schemaVersion":1,"leaves":[}\n-->\n${validBare}`,
        ),
      "INVALID_MANIFEST",
    );
  });

  it("rejects duplicate protocol keys after transport repair", () => {
    expectProgressError(
      () =>
        parseKnowledgeBaseProgressEnvelope(
          '<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress","kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":0,"transition":{"leafId":"1.1","from":"current","to":"confirmed"}}\n-->',
        ),
      "INVALID_ENVELOPE",
    );
  });
});

function envelope(
  revision: number,
  leafId: string,
  from: "current" | "needs_verification",
  to: "confirmed" | "direct_prefilled" | "needs_verification",
): KnowledgeBaseProgressEnvelope {
  return {
    kind: KNOWLEDGE_BASE_PROGRESS_KIND,
    schemaVersion: 1,
    revision,
    transition: { leafId, from, to },
  };
}

function expectProgressError(
  action: () => unknown,
  code: KnowledgeBaseProgressError["code"],
) {
  try {
    action();
    throw new Error("Expected KnowledgeBaseProgressError");
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeBaseProgressError);
    expect((error as KnowledgeBaseProgressError).code).toBe(code);
  }
}

describe("knowledge base leaf manifest validation", () => {
  const createManifest = (count: number, branchCount = 7) =>
    Array.from({ length: count }, (_, index) => ({
      id: `leaf-${index + 1}`,
      title: `Leaf ${index + 1}`,
      branchId: `branch-${(index % branchCount) + 1}`,
      branchTitle: `Branch ${(index % branchCount) + 1}`,
    }));

  const researchCoverage = (
    leaves: readonly KnowledgeBaseLeafManifestEntry[],
    uploadsRead = 0,
  ) => ({
    officialPages: {
      discovered: 12,
      attempted: 12,
      succeeded: 12,
      failed: 0,
    },
    publicQueries: 6,
    officialDocuments: 1,
    uploadsRead,
    sourceCount: 12,
    productFamilies: [
      { id: "primary", name: "Primary offer", leafIds: [leaves[2]!.id] },
    ],
    dimensions: [
      "enterprise_identity",
      "team_and_organization",
      "products_and_services",
      "capabilities_and_delivery",
      "industries_scenarios_and_cases",
      "differentiation_and_evidence",
      "cooperation_delivery_and_support",
    ].map((id, index) => ({
      id,
      status: "covered" as const,
      leafIds: [leaves[index]!.id],
    })),
    stopReason: "coverage_complete" as const,
  });

  it("keeps small manifests available for the pure state machine", () => {
    const state = createKnowledgeBaseProgressState(manifest);

    expect(state.leaves).toHaveLength(3);
    expect(state.currentLeafId).toBe("identity.name");
    expect(state.leaves.map((leaf) => leaf.status)).toEqual([
      "current",
      "pending",
      "pending",
    ]);
  });

  it("enforces 8–115 leaves without fixing the top-level branch count", () => {
    expect(
      validateProductionKnowledgeBaseLeafManifest(
        createManifest(KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES, 4),
      ),
    ).toHaveLength(KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES);
    expect(
      validateProductionKnowledgeBaseLeafManifest(
        createManifest(KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES, 9),
      ),
    ).toHaveLength(KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES);
    expectProgressError(
      () =>
        validateProductionKnowledgeBaseLeafManifest(
          createManifest(KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES - 1, 3),
        ),
      "INVALID_MANIFEST",
    );
    expectProgressError(
      () =>
        validateProductionKnowledgeBaseLeafManifest(
          createManifest(KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES + 1, 12),
        ),
      "INVALID_MANIFEST",
    );
  });

  it("pins legacy builds to 8–115 and deep builds to 30–115", () => {
    const legacyLeaves = createManifest(8);
    const deepLeaves = createManifest(30);
    const maximumDeepLeaves = createManifest(115);
    expect(
      validateKnowledgeBaseManifestForTreePolicy(
        {
          kind: KNOWLEDGE_BASE_MANIFEST_KIND,
          schemaVersion: 1,
          leaves: legacyLeaves,
        },
        KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY,
      ).leaves,
    ).toHaveLength(8);
    expect(
      validateKnowledgeBaseManifestForTreePolicy(
        {
          kind: KNOWLEDGE_BASE_MANIFEST_KIND,
          schemaVersion: 2,
          operationId: "deep-start",
          turnId: "00000000-0000-4000-8000-000000000002",
          leaves: deepLeaves,
          researchCoverage: researchCoverage(deepLeaves),
        },
        KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        { expectedUploadsRead: 0 },
      ).leaves,
    ).toHaveLength(30);
    expect(
      validateKnowledgeBaseManifestForTreePolicy(
        {
          kind: KNOWLEDGE_BASE_MANIFEST_KIND,
          schemaVersion: 2,
          operationId: "deep-start-max",
          turnId: "00000000-0000-4000-8000-000000000002",
          leaves: maximumDeepLeaves,
          researchCoverage: researchCoverage(maximumDeepLeaves),
        },
        KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
      ).leaves,
    ).toHaveLength(115);
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          {
            kind: KNOWLEDGE_BASE_MANIFEST_KIND,
            schemaVersion: 2,
            operationId: "deep-start",
            turnId: "00000000-0000-4000-8000-000000000002",
            leaves: createManifest(29),
            researchCoverage: researchCoverage(createManifest(29)),
          },
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        ),
      "MANIFEST_LEAF_COUNT_BELOW_MIN",
    );
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          {
            kind: KNOWLEDGE_BASE_MANIFEST_KIND,
            schemaVersion: 2,
            operationId: "deep-start",
            turnId: "00000000-0000-4000-8000-000000000002",
            leaves: createManifest(116),
            researchCoverage: researchCoverage(createManifest(116)),
          },
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        ),
      "INVALID_MANIFEST",
    );
  });

  it("does not let a Website-sized prefill lower a new Dashboard build policy", () => {
    const websiteSizedLeaves = createManifest(20);
    const parsed = parseKnowledgeBaseManifestEnvelope({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 2,
      operationId: "dashboard-from-website-prefill",
      turnId: "00000000-0000-4000-8000-000000000002",
      leaves: websiteSizedLeaves,
      researchCoverage: researchCoverage(websiteSizedLeaves),
    });
    expect(parsed.leaves).toHaveLength(20);
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          parsed,
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        ),
      "MANIFEST_LEAF_COUNT_BELOW_MIN",
    );
  });

  it("requires a normalized and internally consistent research ledger for v2", () => {
    const leaves = createManifest(30);
    const base = {
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 2 as const,
      operationId: "deep-start",
      turnId: "00000000-0000-4000-8000-000000000002",
      leaves,
    };
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          base,
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        ),
      "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE",
    );
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          {
            ...base,
            researchCoverage: {
              ...researchCoverage(leaves),
              officialPages: {
                discovered: 12,
                attempted: 12,
                succeeded: 12,
                failed: 1,
              },
            },
          },
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        ),
      "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE",
    );
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          { ...base, researchCoverage: researchCoverage(leaves, 2) },
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
          { expectedUploadsRead: 1 },
        ),
      "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE",
    );
  });

  it("accepts source-limited coverage only after exhausting the discovered queue", () => {
    const leaves = createManifest(30);
    const base = {
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 2 as const,
      operationId: "source-limited-start",
      turnId: "00000000-0000-4000-8000-000000000002",
      leaves,
    };
    const sourceLimited = {
      ...researchCoverage(leaves),
      officialPages: {
        discovered: 5,
        attempted: 5,
        succeeded: 3,
        failed: 2,
      },
      stopReason: "source_limited" as const,
      limitationReason: "官网公开队列已经全部尝试，只有三个页面可以正常读取。",
    };
    expect(
      validateKnowledgeBaseManifestForTreePolicy(
        { ...base, researchCoverage: sourceLimited },
        KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
      ).researchCoverage,
    ).toMatchObject({ stopReason: "source_limited" });
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          {
            ...base,
            researchCoverage: {
              ...sourceLimited,
              officialPages: {
                discovered: 6,
                attempted: 5,
                succeeded: 3,
                failed: 2,
              },
            },
          },
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        ),
      "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE",
    );
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          {
            ...base,
            researchCoverage: {
              ...sourceLimited,
              limitationReason: undefined,
            },
          },
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        ),
      "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE",
    );
  });

  it("accepts budget-reached coverage only when a declared cap was reached", () => {
    const leaves = createManifest(30);
    const base = {
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 2 as const,
      operationId: "budget-start",
      turnId: "00000000-0000-4000-8000-000000000002",
      leaves,
    };
    const budgetReached = {
      ...researchCoverage(leaves),
      publicQueries: 30,
      stopReason: "budget_reached" as const,
      limitationReason:
        "已达到公开检索预算，七个业务维度均已形成事实或明确缺口。",
    };
    expect(
      validateKnowledgeBaseManifestForTreePolicy(
        { ...base, researchCoverage: budgetReached },
        KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
      ).researchCoverage,
    ).toMatchObject({ stopReason: "budget_reached", publicQueries: 30 });
    expectProgressError(
      () =>
        validateKnowledgeBaseManifestForTreePolicy(
          {
            ...base,
            researchCoverage: { ...budgetReached, publicQueries: 29 },
          },
          KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        ),
      "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE",
    );
  });

  it("accepts the exact research caps and rejects every counter above them", () => {
    const leaves = createManifest(30);
    const base = {
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 2 as const,
      operationId: "research-cap-start",
      turnId: "00000000-0000-4000-8000-000000000002",
      leaves,
    };
    const atCaps = {
      ...researchCoverage(leaves, 100),
      officialPages: {
        discovered: 200,
        attempted: 200,
        succeeded: 120,
        failed: 80,
      },
      publicQueries: 30,
      officialDocuments: 30,
    };
    expect(
      validateKnowledgeBaseManifestForTreePolicy(
        { ...base, researchCoverage: atCaps },
        KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
        { expectedUploadsRead: 100 },
      ).researchCoverage,
    ).toMatchObject({
      officialPages: { attempted: 200, succeeded: 120 },
      publicQueries: 30,
      officialDocuments: 30,
      uploadsRead: 100,
    });

    for (const researchCoverageAboveCap of [
      {
        ...atCaps,
        officialPages: {
          discovered: 201,
          attempted: 201,
          succeeded: 120,
          failed: 81,
        },
      },
      {
        ...atCaps,
        officialPages: {
          discovered: 121,
          attempted: 121,
          succeeded: 121,
          failed: 0,
        },
      },
      { ...atCaps, publicQueries: 31 },
      { ...atCaps, officialDocuments: 31 },
      { ...atCaps, uploadsRead: 101 },
    ]) {
      expectProgressError(
        () =>
          validateKnowledgeBaseManifestForTreePolicy(
            { ...base, researchCoverage: researchCoverageAboveCap },
            KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
          ),
        "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE",
      );
    }
  });

  it("revalidates persisted research relationships before publication", () => {
    const leaves = createManifest(30);
    expect(
      validateStoredKnowledgeBaseResearchCoverage(researchCoverage(leaves), {
        knownLeafIds: leaves.map((leaf) => leaf.id),
        totalLeafCount: leaves.length,
      }),
    ).toMatchObject({ stopReason: "coverage_complete" });

    expectProgressError(
      () =>
        validateStoredKnowledgeBaseResearchCoverage(
          {
            ...researchCoverage(leaves),
            dimensions: researchCoverage(leaves).dimensions.map(
              (dimension, index) =>
                index === 0
                  ? { ...dimension, leafIds: ["unknown-leaf"] }
                  : dimension,
            ),
          },
          {
            knownLeafIds: leaves.map((leaf) => leaf.id),
            totalLeafCount: leaves.length,
          },
        ),
      "MANIFEST_RESEARCH_COVERAGE_INCOMPLETE",
    );
  });

  it("rejects an unknown persisted policy instead of silently downgrading it", () => {
    expectProgressError(() => knowledgeBaseTreePolicy(99), "INVALID_STATE");
  });

  it("requires every branch id to keep one stable title", () => {
    const leaves = Array.from({ length: 40 }, (_, index) => ({
      id: `leaf-${index + 1}`,
      title: `Leaf ${index + 1}`,
      branchId: `branch-${(index % 4) + 1}`,
      branchTitle: `Branch ${(index % 4) + 1}`,
    }));
    leaves[4]!.branchTitle = "Conflicting title";

    expectProgressError(
      () => validateProductionKnowledgeBaseLeafManifest(leaves),
      "INVALID_MANIFEST",
    );
  });

  it("accepts exactly one hidden production manifest envelope", () => {
    const leaves = Array.from({ length: 42 }, (_, index) => ({
      id: `leaf-${index + 1}`,
      title: `Leaf ${index + 1}`,
      branchId: `branch-${(index % 5) + 1}`,
      branchTitle: `Branch ${(index % 5) + 1}`,
    }));
    const serialized = formatKnowledgeBaseManifestEnvelope({
      kind: KNOWLEDGE_BASE_MANIFEST_KIND,
      schemaVersion: 1,
      leaves,
    });

    expect(parseKnowledgeBaseManifestEnvelope(serialized).leaves).toHaveLength(
      42,
    );
  });

  it("accepts the bare manifest JSON returned by a real upstream task", () => {
    const leaves = Array.from({ length: 8 }, (_, index) => ({
      id: `${index + 1}.1`,
      title: `节点 ${index + 1}`,
      branchId: `branch-${index + 1}`,
      branchTitle: `业务分支 ${index + 1}`,
    }));
    const rawOutput = [
      "知识树统计：8 个业务分支，8 个叶子节点。",
      JSON.stringify({
        kind: "frontmind.knowledge-base.manifest",
        schemaVersion: 1,
        leaves,
      }),
      JSON.stringify({
        kind: "frontmind.workflow-state",
        schemaVersion: 1,
        currentLeafId: "1.1",
      }),
      JSON.stringify({
        kind: "frontmind.knowledge-base.presentation",
        schemaVersion: 1,
        leafId: "1.1",
      }),
    ].join("\n");

    expect(parseKnowledgeBaseManifestEnvelope(rawOutput).leaves).toEqual(
      leaves,
    );
  });
});

describe("knowledge base single-leaf progression", () => {
  it("confirms only the current leaf and advances exactly one position", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    const next = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "confirmed"),
    );

    expect(initial.leaves.map((leaf) => leaf.status)).toEqual([
      "current",
      "pending",
      "pending",
    ]);
    expect(next.leaves.map((leaf) => leaf.status)).toEqual([
      "confirmed",
      "current",
      "pending",
    ]);
    expect(next.currentLeafId).toBe("identity.position");
    expect(next.revision).toBe(1);
    expect(getKnowledgeBaseProgressSummary(next)).toMatchObject({
      handled: 1,
      total: 3,
      overall: 1 / 3,
      confirmed: 1,
      directPrefilled: 0,
    });
  });

  it("keeps needs_verification active until that same leaf is handled", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    const needsVerification = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "needs_verification"),
    );

    expect(needsVerification.currentLeafId).toBe("identity.name");
    expect(needsVerification.leaves[0].status).toBe("needs_verification");
    expect(getKnowledgeBaseProgressSummary(needsVerification).overall).toBe(0);
    expect(canPackageKnowledgeBase(needsVerification)).toBe(false);

    const confirmed = applyKnowledgeBaseProgressEnvelope(
      needsVerification,
      envelope(1, "identity.name", "needs_verification", "confirmed"),
    );
    expect(confirmed.currentLeafId).toBe("identity.position");
    expect(confirmed.leaves[0].status).toBe("confirmed");
  });

  it("counts direct prefill as handled without presenting it as confirmed", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    const next = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "direct_prefilled"),
    );

    expect(next.leaves[0].status).toBe("direct_prefilled");
    expect(shouldShowKnowledgeBaseCheckmark("direct_prefilled")).toBe(false);
    expect(shouldShowKnowledgeBaseCheckmark("confirmed")).toBe(true);
    expect(getKnowledgeBaseProgressSummary(next)).toMatchObject({
      handled: 1,
      total: 3,
      overall: 1 / 3,
      confirmed: 0,
      directPrefilled: 1,
    });
  });
});

describe("model progress envelope boundary", () => {
  it("round-trips v4 presentation operation identity", () => {
    const presentation = {
      kind: "frontmind.knowledge-base.presentation" as const,
      schemaVersion: 2 as const,
      operationId: `kbv2_${"a".repeat(64)}`,
      turnId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      leafId: "identity.position",
      imageState: "no_eligible_asset" as const,
      assetIds: [],
      imageCount: 0,
    };

    expect(
      parseKnowledgeBasePresentationEnvelope(
        formatKnowledgeBasePresentationEnvelope(presentation),
      ),
    ).toEqual(presentation);
  });

  it("does not expose the removed reopen transition in protocol v4", () => {
    expectProgressError(
      () =>
        parseKnowledgeBaseReopenEnvelope({
          kind: "frontmind.knowledge-base.reopen",
          schemaVersion: 2,
          operationId: `kbv2_${"a".repeat(64)}`,
          turnId: "00000000-0000-4000-8000-000000000001",
          revision: 3,
          leafId: "identity.name",
        }),
      "INVALID_ENVELOPE",
    );
  });

  it("extracts one hidden machine-readable envelope from model output", () => {
    const expected = envelope(0, "identity.name", "current", "confirmed");
    const output = [
      "请确认以上企业名称。",
      formatKnowledgeBaseProgressEnvelope(expected),
    ].join("\n\n");

    expect(parseKnowledgeBaseProgressEnvelope(output)).toEqual(expected);
  });

  it("accepts canonical progress and presentation objects emitted as bare JSON", () => {
    const expected = envelope(0, "identity.name", "current", "confirmed");
    const presentation = {
      kind: "frontmind.knowledge-base.presentation" as const,
      schemaVersion: 1 as const,
      revision: 1,
      leafId: "identity.position",
      imageState: "no_eligible_asset" as const,
      assetIds: [],
      imageCount: 0,
    };
    const output = `${JSON.stringify(expected)}\n${JSON.stringify(presentation)}`;

    expect(parseKnowledgeBaseProgressEnvelope(output)).toEqual(expected);
    expect(parseKnowledgeBasePresentationEnvelope(output)).toEqual(
      presentation,
    );
  });

  it("rejects a jump to a non-current leaf", () => {
    const state = createKnowledgeBaseProgressState(manifest);
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(
          state,
          envelope(0, "product.primary", "current", "confirmed"),
        ),
      "WRONG_LEAF",
    );
  });

  it("rejects stale updates and updates whose from status is false", () => {
    const state = createKnowledgeBaseProgressState(manifest);
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(
          state,
          envelope(1, "identity.name", "current", "confirmed"),
        ),
      "STALE_REVISION",
    );
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(
          state,
          envelope(0, "identity.name", "needs_verification", "confirmed"),
        ),
      "FROM_STATUS_MISMATCH",
    );
  });

  it("rejects batch envelopes and rollback transitions", () => {
    const state = createKnowledgeBaseProgressState(manifest);
    const first = formatKnowledgeBaseProgressEnvelope(
      envelope(0, "identity.name", "current", "confirmed"),
    );
    const second = formatKnowledgeBaseProgressEnvelope(
      envelope(0, "identity.position", "current", "confirmed"),
    );

    expectProgressError(
      () => parseKnowledgeBaseProgressEnvelope(`${first}\n${second}`),
      "INVALID_ENVELOPE",
    );
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(state, {
          kind: KNOWLEDGE_BASE_PROGRESS_KIND,
          schemaVersion: 1,
          revision: 0,
          transitions: [
            {
              leafId: "identity.name",
              from: "current",
              to: "confirmed",
            },
          ],
        }),
      "INVALID_ENVELOPE",
    );
    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(state, {
          kind: KNOWLEDGE_BASE_PROGRESS_KIND,
          schemaVersion: 1,
          revision: 0,
          transition: {
            leafId: "identity.name",
            from: "current",
            to: "pending",
          },
        }),
      "INVALID_TRANSITION",
    );
  });

  it("requires the presentation envelope to identify the post-transition leaf", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    const next = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "confirmed"),
    );
    const presentation = formatKnowledgeBasePresentationEnvelope({
      kind: "frontmind.knowledge-base.presentation",
      schemaVersion: 1,
      revision: 1,
      leafId: "identity.position",
      imageState: "attached",
      assetIds: ["asset-identity-position"],
      imageCount: 1,
    });

    expect(parseKnowledgeBasePresentationEnvelope(presentation)).toMatchObject({
      revision: 1,
      leafId: "identity.position",
      imageState: "attached",
      assetIds: ["asset-identity-position"],
      imageCount: 1,
    });
    expect(() =>
      assertKnowledgeBasePresentationMatchesState(next, presentation),
    ).not.toThrow();
  });

  it("keeps a revised leaf as the presentation target", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    const revised = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "needs_verification"),
    );
    const presentation = formatKnowledgeBasePresentationEnvelope({
      kind: "frontmind.knowledge-base.presentation",
      schemaVersion: 1,
      revision: 1,
      leafId: "identity.name",
    });

    expect(() =>
      assertKnowledgeBasePresentationMatchesState(revised, presentation),
    ).not.toThrow();
  });

  it("uses a null presentation only after the final leaf", () => {
    const one = applyKnowledgeBaseProgressEnvelope(
      createKnowledgeBaseProgressState(manifest),
      envelope(0, "identity.name", "current", "confirmed"),
    );
    const two = applyKnowledgeBaseProgressEnvelope(
      one,
      envelope(1, "identity.position", "current", "confirmed"),
    );
    const completed = applyKnowledgeBaseProgressEnvelope(
      two,
      envelope(2, "product.primary", "current", "confirmed"),
    );
    const presentation = formatKnowledgeBasePresentationEnvelope({
      kind: "frontmind.knowledge-base.presentation",
      schemaVersion: 1,
      revision: 3,
      leafId: null,
    });

    expect(() =>
      assertKnowledgeBasePresentationMatchesState(completed, presentation),
    ).not.toThrow();
    expectProgressError(
      () =>
        assertKnowledgeBasePresentationMatchesState(
          completed,
          formatKnowledgeBasePresentationEnvelope({
            kind: "frontmind.knowledge-base.presentation",
            schemaVersion: 1,
            revision: 3,
            leafId: "product.primary",
          }),
        ),
      "WRONG_LEAF",
    );
  });

  it("rejects stale, wrong, missing and duplicate presentation envelopes", () => {
    const next = applyKnowledgeBaseProgressEnvelope(
      createKnowledgeBaseProgressState(manifest),
      envelope(0, "identity.name", "current", "confirmed"),
    );
    const stale = formatKnowledgeBasePresentationEnvelope({
      kind: "frontmind.knowledge-base.presentation",
      schemaVersion: 1,
      revision: 0,
      leafId: "identity.position",
    });
    const wrong = formatKnowledgeBasePresentationEnvelope({
      kind: "frontmind.knowledge-base.presentation",
      schemaVersion: 1,
      revision: 1,
      leafId: "product.primary",
    });

    expectProgressError(
      () => assertKnowledgeBasePresentationMatchesState(next, stale),
      "STALE_REVISION",
    );
    expectProgressError(
      () => assertKnowledgeBasePresentationMatchesState(next, wrong),
      "WRONG_LEAF",
    );
    expectProgressError(
      () => assertKnowledgeBasePresentationMatchesState(next, "正文"),
      "INVALID_ENVELOPE",
    );
    expectProgressError(
      () =>
        parseKnowledgeBasePresentationEnvelope(
          `${wrong}\n${formatKnowledgeBasePresentationEnvelope({
            kind: "frontmind.knowledge-base.presentation",
            schemaVersion: 1,
            revision: 1,
            leafId: "identity.position",
          })}`,
        ),
      "INVALID_ENVELOPE",
    );
  });
});

describe("knowledge base package gate", () => {
  it("blocks packaging until every leaf is confirmed or directly prefilled", () => {
    const initial = createKnowledgeBaseProgressState(manifest);
    expect(canPackageKnowledgeBase(initial)).toBe(false);
    expectProgressError(
      () => assertKnowledgeBaseReadyForPackage(initial),
      "PACKAGING_BLOCKED",
    );

    const one = applyKnowledgeBaseProgressEnvelope(
      initial,
      envelope(0, "identity.name", "current", "confirmed"),
    );
    const two = applyKnowledgeBaseProgressEnvelope(
      one,
      envelope(1, "identity.position", "current", "direct_prefilled"),
    );
    const completed = applyKnowledgeBaseProgressEnvelope(
      two,
      envelope(2, "product.primary", "current", "confirmed"),
    );

    expect(completed.currentLeafId).toBeNull();
    expect(getKnowledgeBaseProgressSummary(completed)).toMatchObject({
      handled: 3,
      total: 3,
      overall: 1,
      overallPercent: 100,
      confirmed: 2,
      directPrefilled: 1,
    });
    expect(canPackageKnowledgeBase(completed)).toBe(true);
    expect(() => assertKnowledgeBaseReadyForPackage(completed)).not.toThrow();

    expectProgressError(
      () =>
        applyKnowledgeBaseProgressEnvelope(
          completed,
          envelope(3, "product.primary", "current", "confirmed"),
        ),
      "NO_CURRENT_LEAF",
    );
  });
});
