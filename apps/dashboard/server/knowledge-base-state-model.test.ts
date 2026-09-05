import { describe, expect, it } from "vitest";

import {
  applyKnowledgeBaseProgressEnvelope,
  createKnowledgeBaseProgressState,
  getKnowledgeBaseProgressSummary,
  KnowledgeBaseProgressError,
  type KnowledgeBaseProgressEnvelope,
  type KnowledgeBaseProgressState,
} from "./knowledge-base-progress";

function randomGenerator(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value;
  };
}

function envelope(
  state: KnowledgeBaseProgressState,
  overrides: Partial<KnowledgeBaseProgressEnvelope> = {},
): KnowledgeBaseProgressEnvelope {
  const current = state.leaves.find(
    (leaf) => leaf.id === state.currentLeafId,
  )!;
  return {
    kind: "frontmind.knowledge-base.progress",
    schemaVersion: 1,
    revision: state.revision,
    transition: {
      leafId: current.id,
      from:
        current.status === "needs_verification"
          ? "needs_verification"
          : "current",
      to: "confirmed",
    },
    ...overrides,
  };
}

describe("knowledge-base modeled event sequences", () => {
  const sequenceCount = process.env.FRONTMIND_RELEASE_STATE_MODEL
    ? 10_000
    : 1_000;

  it(`preserves exactly-once traversal across ${sequenceCount} randomized sequences`, () => {
    for (let seed = 1; seed <= sequenceCount; seed += 1) {
      const random = randomGenerator(seed);
      let state = createKnowledgeBaseProgressState(
        Array.from({ length: 8 }, (_, index) => ({
          id: `1.${index + 1}`,
          title: `节点 ${index + 1}`,
          branchId: "identity",
          branchTitle: "企业身份",
        })),
      );
      const appliedRevisions = new Set<number>();

      for (let event = 0; event < 80; event += 1) {
        const before = state;
        if (!state.currentLeafId) {
          expect(getKnowledgeBaseProgressSummary(state).handled).toBe(8);
          continue;
        }

        const choice = random() % 5;
        let candidate = envelope(state);
        if (choice === 1 && state.revision > 0) {
          candidate = { ...candidate, revision: state.revision - 1 };
        } else if (choice === 2) {
          candidate = { ...candidate, revision: state.revision + 1 };
        } else if (choice === 3) {
          const other = state.leaves.find(
            (leaf) =>
              leaf.id !== state.currentLeafId && leaf.status === "pending",
          );
          if (other) {
            candidate = {
              ...candidate,
              transition: { ...candidate.transition, leafId: other.id },
            };
          }
        } else if (choice === 4) {
          candidate = {
            ...candidate,
            transition: {
              ...candidate.transition,
              to: "needs_verification",
            },
          };
        }

        try {
          state = applyKnowledgeBaseProgressEnvelope(state, candidate);
          expect(candidate.revision).toBe(before.revision);
          expect(appliedRevisions.has(candidate.revision)).toBe(false);
          appliedRevisions.add(candidate.revision);
          expect(state.revision).toBe(before.revision + 1);
        } catch (error) {
          expect(error).toBeInstanceOf(KnowledgeBaseProgressError);
          state = before;
        }

        const summary = getKnowledgeBaseProgressSummary(state);
        expect(summary.handled).toBeLessThanOrEqual(8);
        expect(summary.handled).toBeLessThanOrEqual(state.revision);
        expect(
          state.leaves.filter(
            (leaf) =>
              leaf.status === "current" ||
              leaf.status === "needs_verification",
          ).length,
        ).toBe(state.currentLeafId ? 1 : 0);
      }
    }
  });
});
