import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Dashboard production migration release contract", () => {
  it("keeps the restart-safe production migration controller contract", async () => {
    const [workflow, runbook] = await Promise.all([
      readFile(
        path.resolve(root, ".github/workflows/dashboard-ci.yml"),
        "utf8",
      ),
      readFile(path.resolve(root, "KNOWLEDGE_BASE_V2_DEPLOYMENT.md"), "utf8"),
    ]);

    expect(workflow).toMatch(
      /run: node scripts\/verify-api-usage-migration-schema\.mjs post/u,
    );
    for (const requiredGuard of [
      "本文不是常规发布入口",
      "docs/operations/RELEASE.md",
      "release-db-plan plan --json",
      "0045_knowledge_base_state_machine",
      ".frontmind-kb-v2-0045-complete-v3",
      "root-owned",
      "`0600`",
      "/readyz",
      "/healthz",
      "frontmind-contract-maintenance",
      "--allow-contract",
      "不得再次执行 migration",
      "migration 结果未知时只读重查 plan",
      "绝不盲目重跑",
      "restore 失败时保持 Dashboard 停写",
    ]) {
      expect(runbook).toContain(requiredGuard);
    }
    expect(runbook).not.toContain("pnpm db:migrate");
    expect(runbook).not.toContain("mysql -e");
  });
});
