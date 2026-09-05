import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESALES_V2_CONTRACT_HASHES } from "./presales-v2-contracts";
import {
  acquirePresalesV2Task,
  readPresalesV2Task,
  updatePresalesV2Task,
} from "./presales-v2-store";

let assetDirectory: string;
const input = {
  idempotencyKey: "frozen-zhipu-task",
  requestHash: "a".repeat(64),
  projectId: "isolated-store-test",
  contract: {
    name: "website.question-recommendation" as const,
    revision: 2 as const,
    schemaHash: PRESALES_V2_CONTRACT_HASHES["website.question-recommendation"],
  },
  profile: "frontmind-pro" as const,
  upstreamModel: "glm-5.3",
  provider: "zhipu" as const,
  credentialId: "test-credential",
  credentialVersion: 1,
};

beforeEach(async () => {
  assetDirectory = await mkdtemp(path.join(tmpdir(), "website-runtime-test-"));
  vi.stubEnv("FRONTMIND_DASHBOARD_ASSET_DIR", assetDirectory);
  vi.stubEnv("WEBSITE_ZHIPU_EFFORT", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(assetDirectory, { recursive: true, force: true });
});

describe("Website task effort identity", () => {
  it("defaults new Zhipu tasks to high and leaves Manus tasks unchanged", async () => {
    const zhipu = await acquirePresalesV2Task(input);
    expect(zhipu).toMatchObject({
      state: "acquired",
      record: {
        providerRuntime: {
          revision: 1,
          model: "glm-5.3",
          effort: "high",
          mutations: {},
        },
      },
    });
    const manus = await acquirePresalesV2Task({
      ...input,
      idempotencyKey: "manus-task",
      provider: "manus",
    });
    expect(manus.state).toBe("acquired");
    if (manus.state !== "conflict")
      expect(manus.record.providerRuntime).toBeUndefined();
  });

  it.each(["low", "high", "max"] as const)(
    "freezes %s across environment changes, retries and attempted updates",
    async (effort) => {
      vi.stubEnv("WEBSITE_ZHIPU_EFFORT", effort);
      const created = await acquirePresalesV2Task(input);
      if (created.state === "conflict") throw new Error("Unexpected conflict");
      vi.stubEnv("WEBSITE_ZHIPU_EFFORT", "invalid-after-restart");
      const replay = await acquirePresalesV2Task(input);
      expect(replay).toMatchObject({
        state: "existing",
        record: { providerRuntime: { effort } },
      });
      await expect(
        updatePresalesV2Task(created.record.localTaskId, (record) => ({
          ...record,
          providerRuntime: {
            ...record.providerRuntime!,
            effort: effort === "high" ? "max" : "high",
          },
        })),
      ).rejects.toThrow("PRESALES_V2_FROZEN_OPERATION_MUTATION");
      expect(
        (await readPresalesV2Task(created.record.localTaskId))?.providerRuntime
          ?.effort,
      ).toBe(effort);
    },
  );

  it("rejects invalid new-task configuration before creating an idempotency reservation", async () => {
    vi.stubEnv("WEBSITE_ZHIPU_EFFORT", "turbo");
    await expect(acquirePresalesV2Task(input)).rejects.toThrow(
      "INVALID_WEBSITE_ZHIPU_EFFORT",
    );
    vi.stubEnv("WEBSITE_ZHIPU_EFFORT", "high");
    expect(await acquirePresalesV2Task(input)).toMatchObject({
      state: "acquired",
    });
  });

  it("does not retrofit an effort onto historical Zhipu task files", async () => {
    const created = await acquirePresalesV2Task(input);
    if (created.state === "conflict") throw new Error("Unexpected conflict");
    const target = path.join(
      assetDirectory,
      "presales-v2/tasks",
      `${createHash("sha256").update(created.record.localTaskId).digest("hex")}.json`,
    );
    const historical = JSON.parse(await readFile(target, "utf8"));
    delete historical.providerRuntime;
    await writeFile(target, JSON.stringify(historical));
    const replay = await acquirePresalesV2Task(input);
    if (replay.state === "conflict") throw new Error("Unexpected conflict");
    expect(replay.record.providerRuntime).toBeUndefined();
    await expect(
      updatePresalesV2Task(created.record.localTaskId, (record) => ({
        ...record,
        providerRuntime: {
          revision: 1,
          model: "glm-5.3",
          effort: "high",
          mutations: {},
        },
      })),
    ).rejects.toThrow("PRESALES_V2_FROZEN_OPERATION_MUTATION");
    await expect(
      updatePresalesV2Task(created.record.localTaskId, (record) => ({
        ...record,
        providerRuntime: { revision: 1, model: "glm-5.3", mutations: {} },
      })),
    ).resolves.toMatchObject({
      providerRuntime: { model: "glm-5.3" },
    });
  });
});
