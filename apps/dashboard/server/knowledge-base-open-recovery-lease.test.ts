import { describe, expect, it } from "vitest";

import {
  knowledgeBaseBuilds,
  type KnowledgeBaseBuild,
} from "../drizzle/schema";
import {
  claimKnowledgeBaseOpenRecoveryBuild,
  releaseKnowledgeBaseOpenRecoveryLease,
  renewKnowledgeBaseOpenRecoveryLease,
} from "./knowledge-base-open-recovery-lease";

function openBuild(
  overrides: Partial<KnowledgeBaseBuild> = {},
): KnowledgeBaseBuild {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000100",
    userId: 1,
    conversationId: "conversation-1",
    status: "researching",
    generation: 3,
    stateEpoch: 7,
    activeTurnId: null,
    upstreamTaskId: "task-1",
    awaitingResponseSince: now,
    packageStorageKey: null,
    protocolErrorCode: null,
    recoveryLeaseOwnerHash: null,
    recoveryLeaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as KnowledgeBaseBuild;
}

function createLeaseExecutor(initial: KnowledgeBaseBuild) {
  const store = { build: initial };
  let transactionTail = Promise.resolve();
  return {
    store,
    executor: {
      transaction: async (run: (tx: any) => Promise<unknown>) => {
        let release!: () => void;
        const prior = transactionTail;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prior;
        try {
          const tx = {
            select: () => ({
              from: (table: unknown) => ({
                where: () => ({
                  limit: () => ({
                    for: async () =>
                      table === knowledgeBaseBuilds ? [store.build] : [],
                  }),
                }),
              }),
            }),
            update: (table: unknown) => ({
              set: (values: Partial<KnowledgeBaseBuild>) => ({
                where: async () => {
                  if (table === knowledgeBaseBuilds) {
                    store.build = { ...store.build, ...values };
                  }
                },
              }),
            }),
          };
          return await run(tx);
        } finally {
          release();
        }
      },
    },
  };
}

function claimInput(now: Date) {
  return {
    buildId: "00000000-0000-4000-8000-000000000100",
    expectedGeneration: 3,
    expectedStateEpoch: 7,
    expectedTaskId: "task-1",
    now,
    leaseMs: 5_000,
  };
}

describe("knowledge-base open-build recovery lease", () => {
  it("grants exactly one cross-process claim for a concurrent scan", async () => {
    const { executor } = createLeaseExecutor(openBuild());
    const now = new Date("2026-08-01T00:00:00.000Z");
    const [first, second] = await Promise.all([
      claimKnowledgeBaseOpenRecoveryBuild(claimInput(now), executor),
      claimKnowledgeBaseOpenRecoveryBuild(claimInput(now), executor),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((first || second)?.kind).toBe("reconcile");
  });

  it("permits takeover only after expiry and rejects the old owner", async () => {
    const { executor, store } = createLeaseExecutor(openBuild());
    const first = await claimKnowledgeBaseOpenRecoveryBuild(
      claimInput(new Date("2026-08-01T00:00:00.000Z")),
      executor,
    );
    expect(first).not.toBeNull();
    await expect(
      claimKnowledgeBaseOpenRecoveryBuild(
        claimInput(new Date("2026-08-01T00:00:04.999Z")),
        executor,
      ),
    ).resolves.toBeNull();

    const takeover = await claimKnowledgeBaseOpenRecoveryBuild(
      claimInput(new Date("2026-08-01T00:00:05.000Z")),
      executor,
    );
    expect(takeover).not.toBeNull();
    expect(takeover!.leaseToken).not.toBe(first!.leaseToken);
    await expect(
      releaseKnowledgeBaseOpenRecoveryLease(
        {
          buildId: first!.build.id,
          generation: first!.build.generation,
          leaseToken: first!.leaseToken,
        },
        executor,
      ),
    ).resolves.toBe(false);
    await expect(
      releaseKnowledgeBaseOpenRecoveryLease(
        {
          buildId: takeover!.build.id,
          generation: takeover!.build.generation,
          leaseToken: takeover!.leaseToken,
        },
        executor,
      ),
    ).resolves.toBe(true);
    expect(store.build.recoveryLeaseExpiresAt).toBeNull();
  });

  it("uses generation, state epoch and task as stale-page CAS coordinates", async () => {
    const { executor } = createLeaseExecutor(openBuild());
    const base = claimInput(new Date("2026-08-01T00:00:00.000Z"));
    await expect(
      claimKnowledgeBaseOpenRecoveryBuild(
        { ...base, expectedGeneration: 2 },
        executor,
      ),
    ).resolves.toBeNull();
    await expect(
      claimKnowledgeBaseOpenRecoveryBuild(
        { ...base, expectedStateEpoch: 6 },
        executor,
      ),
    ).resolves.toBeNull();
    await expect(
      claimKnowledgeBaseOpenRecoveryBuild(
        { ...base, expectedTaskId: "old-task" },
        executor,
      ),
    ).resolves.toBeNull();
  });

  it("renews only for the owner and loses renewal when a turn takes authority", async () => {
    const { executor, store } = createLeaseExecutor(openBuild());
    const claim = await claimKnowledgeBaseOpenRecoveryBuild(
      claimInput(new Date("2026-08-01T00:00:00.000Z")),
      executor,
    );
    expect(claim).not.toBeNull();
    await expect(
      renewKnowledgeBaseOpenRecoveryLease(
        {
          buildId: claim!.build.id,
          generation: claim!.build.generation,
          leaseToken: "wrong-owner",
          now: new Date("2026-08-01T00:00:01.000Z"),
          leaseMs: 5_000,
        },
        executor,
      ),
    ).resolves.toBeNull();
    await expect(
      renewKnowledgeBaseOpenRecoveryLease(
        {
          buildId: claim!.build.id,
          generation: claim!.build.generation,
          leaseToken: claim!.leaseToken,
          now: new Date("2026-08-01T00:00:01.000Z"),
          leaseMs: 5_000,
        },
        executor,
      ),
    ).resolves.toEqual(new Date("2026-08-01T00:00:06.000Z"));

    store.build = { ...store.build, activeTurnId: "turn-new" };
    await expect(
      renewKnowledgeBaseOpenRecoveryLease(
        {
          buildId: claim!.build.id,
          generation: claim!.build.generation,
          leaseToken: claim!.leaseToken,
          now: new Date("2026-08-01T00:00:02.000Z"),
          leaseMs: 5_000,
        },
        executor,
      ),
    ).resolves.toBeNull();
  });
});
