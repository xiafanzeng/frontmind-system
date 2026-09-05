import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  knowledgeBaseUploadEvidenceStorageKey,
  KNOWLEDGE_BASE_UPLOAD_EVIDENCE_ORPHAN_GRACE_MS,
  optionalKnowledgeBaseUploadEvidenceStorageKey,
  parseKnowledgeBaseUploadEvidenceStorageKey,
  removeKnowledgeBaseUploadEvidenceIfOrphaned,
  sweepOrphanedKnowledgeBaseUploadEvidence,
} from "./knowledge-base-upload-evidence-lifecycle";

const BUILD_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
] as const;

const sweepAfterGrace = () =>
  new Date(Date.now() + KNOWLEDGE_BASE_UPLOAD_EVIDENCE_ORPHAN_GRACE_MS + 1_000);

function lifecycleDb(activeBuilds: boolean[]) {
  let index = 0;
  return {
    async transaction<T>(callback: (tx: any) => Promise<T>) {
      const active = activeBuilds[index++] ?? false;
      const query = {
        from() {
          return query;
        },
        where() {
          return query;
        },
        limit() {
          return query;
        },
        for() {
          return Promise.resolve(active ? [{ id: "active-build" }] : []);
        },
      };
      return callback({ select: () => query });
    },
  };
}

function evidencePath(
  root: string,
  input: { userId?: number; buildId?: string; generation?: number } = {},
) {
  const storageKey = knowledgeBaseUploadEvidenceStorageKey({
    userId: input.userId ?? 7,
    buildId: input.buildId ?? BUILD_IDS[0],
    generation: input.generation ?? 1,
  });
  return {
    storageKey,
    absolutePath: path.join(root, ...storageKey.split("/")),
  };
}

async function installEvidence(
  root: string,
  input: { userId?: number; buildId?: string; generation?: number } = {},
) {
  const evidence = evidencePath(root, input);
  await mkdir(evidence.absolutePath, { recursive: true });
  await writeFile(path.join(evidence.absolutePath, "ledger.json"), "evidence");
  return evidence;
}

describe("knowledge-base upload evidence lifecycle", () => {
  it("accepts only the exact build-generation evidence scope", () => {
    const storageKey = knowledgeBaseUploadEvidenceStorageKey({
      userId: 7,
      buildId: BUILD_IDS[0],
      generation: 3,
    });
    expect(storageKey).toBe(
      `knowledge-builds/7/${BUILD_IDS[0]}/generation-3/upload-evidence`,
    );
    expect(parseKnowledgeBaseUploadEvidenceStorageKey(storageKey)).toEqual({
      userId: 7,
      buildId: BUILD_IDS[0],
      generation: 3,
    });
    for (const invalid of [
      `knowledge-builds/7/${BUILD_IDS[0]}/generation-3`,
      `knowledge-builds/7/${BUILD_IDS[0]}/generation-3/upload-evidence/ledger.json`,
      `knowledge-builds/7/${BUILD_IDS[0]}/generation-3/../upload-evidence`,
      `knowledge-builds/7/${BUILD_IDS[0]}\\generation-3\\upload-evidence`,
      `/knowledge-builds/7/${BUILD_IDS[0]}/generation-3/upload-evidence`,
      `knowledge-builds/07/${BUILD_IDS[0]}/generation-3/upload-evidence`,
    ]) {
      expect(parseKnowledgeBaseUploadEvidenceStorageKey(invalid)).toBeNull();
    }
  });

  it("preserves the existing uppercase UUID acceptance and round-trips it", () => {
    const buildId = BUILD_IDS[0].toUpperCase();
    const storageKey = knowledgeBaseUploadEvidenceStorageKey({
      userId: 7,
      buildId,
      generation: 3,
    });
    expect(storageKey).toBe(
      `knowledge-builds/7/${buildId}/generation-3/upload-evidence`,
    );
    expect(parseKnowledgeBaseUploadEvidenceStorageKey(storageKey)).toEqual({
      userId: 7,
      buildId,
      generation: 3,
    });
  });

  it("keeps legacy non-UUID build cleanup available without inventing a scope", () => {
    expect(
      optionalKnowledgeBaseUploadEvidenceStorageKey({
        userId: 7,
        buildId: "legacy-build",
        generation: 1,
      }),
    ).toBeNull();
  });

  it("removes an orphan scope idempotently without deleting artifact siblings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-kb-evidence-"));
    try {
      const evidence = await installEvidence(root);
      const sibling = path.join(
        path.dirname(evidence.absolutePath),
        "official-logo.bin",
      );
      await writeFile(sibling, "logo");
      const db = lifecycleDb([false, false]);

      await expect(
        removeKnowledgeBaseUploadEvidenceIfOrphaned({
          storageKey: evidence.storageKey,
          expectedUserId: 7,
          db,
          assetRoot: root,
        }),
      ).resolves.toBe("removed");
      await expect(access(evidence.absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(sibling, "utf8")).resolves.toBe("logo");
      await expect(
        removeKnowledgeBaseUploadEvidenceIfOrphaned({
          storageKey: evidence.storageKey,
          expectedUserId: 7,
          db,
          assetRoot: root,
        }),
      ).resolves.toBe("missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never removes evidence while the exact build generation is active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-kb-evidence-"));
    try {
      const evidence = await installEvidence(root);
      await expect(
        removeKnowledgeBaseUploadEvidenceIfOrphaned({
          storageKey: evidence.storageKey,
          db: lifecycleDb([true]),
          assetRoot: root,
        }),
      ).resolves.toBe("active");
      await expect(
        readFile(path.join(evidence.absolutePath, "ledger.json"), "utf8"),
      ).resolves.toBe("evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unlinks a target symlink without following it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-kb-evidence-"));
    const outside = await mkdtemp(
      path.join(tmpdir(), "frontmind-kb-evidence-outside-"),
    );
    try {
      const evidence = evidencePath(root);
      await mkdir(path.dirname(evidence.absolutePath), { recursive: true });
      await writeFile(path.join(outside, "sentinel"), "outside");
      await symlink(outside, evidence.absolutePath, "dir");

      await expect(
        sweepOrphanedKnowledgeBaseUploadEvidence({
          db: lifecycleDb([false]),
          assetRoot: root,
          limit: 1,
          cursor: "",
          now: sweepAfterGrace(),
        }),
      ).resolves.toMatchObject({ scanned: 1, removed: 1, failed: 0 });
      await expect(lstat(evidence.absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(path.join(outside, "sentinel"), "utf8"),
      ).resolves.toBe("outside");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink in an ancestor without touching the destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-kb-evidence-"));
    const outside = await mkdtemp(
      path.join(tmpdir(), "frontmind-kb-evidence-outside-"),
    );
    try {
      const outsideEvidence = path.join(
        outside,
        BUILD_IDS[0],
        "generation-1",
        "upload-evidence",
      );
      await mkdir(outsideEvidence, { recursive: true });
      await writeFile(path.join(outsideEvidence, "sentinel"), "outside");
      await mkdir(path.join(root, "knowledge-builds"), { recursive: true });
      await symlink(outside, path.join(root, "knowledge-builds", "7"), "dir");
      const evidence = evidencePath(root);

      await expect(
        removeKnowledgeBaseUploadEvidenceIfOrphaned({
          storageKey: evidence.storageKey,
          db: lifecycleDb([false]),
          assetRoot: root,
        }),
      ).rejects.toThrow("包含符号链接");
      await expect(
        readFile(path.join(outsideEvidence, "sentinel"), "utf8"),
      ).resolves.toBe("outside");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("bounds a sweep, preserves active builds and advances past them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-kb-evidence-"));
    try {
      const evidence = await Promise.all(
        BUILD_IDS.map((buildId) => installEvidence(root, { buildId })),
      );
      const first = await sweepOrphanedKnowledgeBaseUploadEvidence({
        db: lifecycleDb([true, false]),
        assetRoot: root,
        limit: 2,
        cursor: "",
        now: sweepAfterGrace(),
      });
      expect(first).toMatchObject({
        scanned: 2,
        active: 1,
        removed: 1,
        failed: 0,
        truncated: true,
      });
      await expect(access(evidence[0]!.absolutePath)).resolves.toBeUndefined();
      await expect(access(evidence[1]!.absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(evidence[2]!.absolutePath)).resolves.toBeUndefined();

      const second = await sweepOrphanedKnowledgeBaseUploadEvidence({
        db: lifecycleDb([false]),
        assetRoot: root,
        limit: 2,
        cursor: first.nextCursor,
        now: sweepAfterGrace(),
      });
      expect(second).toMatchObject({ scanned: 1, removed: 1, failed: 0 });
      await expect(access(evidence[2]!.absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a failed account-deletion orphan on a later bounded pass", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-kb-evidence-"));
    try {
      const evidence = await installEvidence(root);
      const failingDb = {
        async transaction() {
          throw new Error("temporary database failure");
        },
      };
      await expect(
        sweepOrphanedKnowledgeBaseUploadEvidence({
          db: failingDb,
          assetRoot: root,
          limit: 1,
          cursor: "",
          now: sweepAfterGrace(),
        }),
      ).resolves.toMatchObject({ scanned: 1, failed: 1, removed: 0 });
      await expect(access(evidence.absolutePath)).resolves.toBeUndefined();

      await expect(
        sweepOrphanedKnowledgeBaseUploadEvidence({
          db: lifecycleDb([false]),
          assetRoot: root,
          limit: 1,
          cursor: "",
          now: sweepAfterGrace(),
        }),
      ).resolves.toMatchObject({ scanned: 1, failed: 0, removed: 1 });
      await expect(access(evidence.absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers a new orphan scope for 24 hours before removing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-kb-evidence-"));
    try {
      const evidence = await installEvidence(root);
      const observedAt = new Date();

      await expect(
        sweepOrphanedKnowledgeBaseUploadEvidence({
          db: lifecycleDb([false]),
          assetRoot: root,
          limit: 1,
          cursor: "",
          now: observedAt,
        }),
      ).resolves.toMatchObject({
        scanned: 1,
        removed: 0,
        deferredYoung: 1,
        failed: 0,
      });
      await expect(access(evidence.absolutePath)).resolves.toBeUndefined();

      await expect(
        sweepOrphanedKnowledgeBaseUploadEvidence({
          db: lifecycleDb([false]),
          assetRoot: root,
          limit: 1,
          cursor: "",
          now: new Date(
            observedAt.getTime() +
              KNOWLEDGE_BASE_UPLOAD_EVIDENCE_ORPHAN_GRACE_MS +
              1_000,
          ),
        }),
      ).resolves.toMatchObject({
        scanned: 1,
        removed: 1,
        deferredYoung: 0,
        failed: 0,
      });
      await expect(access(evidence.absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
