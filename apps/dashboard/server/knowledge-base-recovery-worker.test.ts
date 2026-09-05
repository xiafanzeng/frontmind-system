import { describe, expect, it, vi } from "vitest";

import { createKnowledgeBaseRecoverySweep } from "./knowledge-base-recovery-worker";

describe("knowledge-base production recovery sweep", () => {
  it("runs only reservation recovery and artifact cleanup", async () => {
    const recoverExpiredTurns = vi.fn().mockResolvedValue({
      failed: 1,
      scanned: 2,
      claimedTurnIds: ["turn-1"],
    });
    const cleanupArtifactCandidates = vi.fn().mockResolvedValue({
      scanned: 3,
      deleted: 1,
      retained: 2,
      failed: 1,
    });
    const sweep = createKnowledgeBaseRecoverySweep({
      recoverExpiredTurns,
      cleanupArtifactCandidates,
    });

    await expect(sweep()).resolves.toEqual({
      failed: 2,
      turns: {
        failed: 1,
        scanned: 2,
        claimedTurnIds: ["turn-1"],
      },
      artifacts: {
        scanned: 3,
        deleted: 1,
        retained: 2,
        failed: 1,
      },
    });
    expect(recoverExpiredTurns).toHaveBeenCalledOnce();
    expect(cleanupArtifactCandidates).toHaveBeenCalledOnce();
  });

  it("does not expose an open-build, migration or adoption hook", async () => {
    const recoverExpiredTurns = vi.fn().mockResolvedValue({ failed: 0 });
    const sweep = createKnowledgeBaseRecoverySweep({ recoverExpiredTurns });

    await expect(sweep()).resolves.toEqual({
      failed: 0,
      turns: { failed: 0 },
      artifacts: null,
    });
  });

  it("does not run cleanup after reservation recovery throws", async () => {
    const cleanupArtifactCandidates = vi.fn().mockResolvedValue({ failed: 0 });
    const sweep = createKnowledgeBaseRecoverySweep({
      recoverExpiredTurns: vi
        .fn()
        .mockRejectedValue(new Error("database unavailable")),
      cleanupArtifactCandidates,
    });

    await expect(sweep()).rejects.toThrow("database unavailable");
    expect(cleanupArtifactCandidates).not.toHaveBeenCalled();
  });
});
