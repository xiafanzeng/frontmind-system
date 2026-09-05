import { describe, expect, it, vi } from "vitest";

import { createKnowledgeBaseRecoverySweep } from "./knowledge-base-recovery-worker";

describe("knowledge-base production recovery sweep", () => {
  it("runs turn and open-build recovery and advances a fair cursor", async () => {
    const recoverExpiredTurns = vi
      .fn()
      .mockResolvedValue({ failed: 1, scanned: 2, claimedTurnIds: ["turn-1"] });
    const recoverOpenBuilds = vi
      .fn()
      .mockResolvedValueOnce({
        failed: 2,
        scanned: 100,
        hasMore: true,
        nextCursor: "build-100",
      })
      .mockResolvedValueOnce({
        failed: 0,
        scanned: 1,
        hasMore: false,
        nextCursor: "build-101",
      })
      .mockResolvedValueOnce({
        failed: 0,
        scanned: 0,
        hasMore: false,
        nextCursor: null,
      });
    const cleanupArtifactCandidates = vi.fn().mockResolvedValue({
      scanned: 3,
      deleted: 1,
      retained: 2,
      failed: 1,
    });
    const sweep = createKnowledgeBaseRecoverySweep({
      recoverExpiredTurns,
      recoverOpenBuilds,
      cleanupArtifactCandidates,
    });

    await expect(sweep()).resolves.toMatchObject({ failed: 4 });
    await expect(sweep()).resolves.toMatchObject({ failed: 2 });
    await expect(sweep()).resolves.toMatchObject({ failed: 2 });
    expect(recoverExpiredTurns).toHaveBeenCalledTimes(3);
    expect(recoverOpenBuilds.mock.calls).toEqual([
      [{ limit: 100, concurrency: 3 }],
      [{ limit: 100, concurrency: 3, afterBuildId: "build-100" }],
      [{ limit: 100, concurrency: 3 }],
    ]);
    expect(cleanupArtifactCandidates).toHaveBeenCalledTimes(3);
  });

  it("does not advance its cursor when an open-build scan throws", async () => {
    const recoverExpiredTurns = vi.fn().mockResolvedValue({ failed: 0 });
    const recoverOpenBuilds = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({
        failed: 0,
        hasMore: false,
        nextCursor: null,
      });
    const sweep = createKnowledgeBaseRecoverySweep({
      recoverExpiredTurns,
      recoverOpenBuilds,
    });

    await expect(sweep()).rejects.toThrow("database unavailable");
    await expect(sweep()).resolves.toMatchObject({ failed: 0 });
    expect(recoverOpenBuilds).toHaveBeenLastCalledWith({
      limit: 100,
      concurrency: 3,
    });
  });
});
