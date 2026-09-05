import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_BASE_MANIFEST_MAX_LEAVES,
  KNOWLEDGE_BASE_MANIFEST_MIN_LEAVES,
  KNOWLEDGE_BASE_MANIFEST_KIND,
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
    const createManifest = (count: number, branchCount: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `leaf-${index + 1}`,
        title: `Leaf ${index + 1}`,
        branchId: `branch-${(index % branchCount) + 1}`,
        branchTitle: `Branch ${(index % branchCount) + 1}`,
      }));

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
