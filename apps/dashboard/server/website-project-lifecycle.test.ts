import { describe, expect, it } from "vitest";

import {
  assertWebsiteProjectPhysicalDeleteEnabled,
  lockActiveWebsiteProjectLifecycle,
  WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED,
  WebsiteProjectInactiveError,
} from "./website-project-lifecycle";

function lifecycleExecutor(status: "active" | "deleting" | "deleted") {
  const operations: string[] = [];
  const query = {
    from: () => {
      operations.push("select-lifecycle");
      return query;
    },
    where: () => query,
    limit: () => query,
    for: async () => {
      operations.push("lock-lifecycle");
      return [{ status }];
    },
  };
  return {
    operations,
    executor: {
      insert: () => ({
        values: () => {
          operations.push("ensure-lifecycle");
          return {
            onDuplicateKeyUpdate: async () => {
              operations.push("serialize-lifecycle");
            },
          };
        },
      }),
      select: () => query,
    },
  };
}

describe("Website project lifecycle foundation", () => {
  it("creates and locks an active lifecycle before a caller can write", async () => {
    const { executor, operations } = lifecycleExecutor("active");
    await lockActiveWebsiteProjectLifecycle(executor, "project-d0-active");
    expect(operations).toEqual([
      "ensure-lifecycle",
      "serialize-lifecycle",
      "select-lifecycle",
      "lock-lifecycle",
    ]);
  });

  it.each(["deleting", "deleted"] as const)(
    "rejects %s lifecycle rows after taking the project lock",
    async (status) => {
      const { executor } = lifecycleExecutor(status);
      await expect(
        lockActiveWebsiteProjectLifecycle(executor, "project-d0-inactive"),
      ).rejects.toBeInstanceOf(WebsiteProjectInactiveError);
    },
  );

  it("enables physical deletion in D1 after every lifecycle fence ships", () => {
    expect(WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED).toBe(true);
    expect(() => assertWebsiteProjectPhysicalDeleteEnabled()).not.toThrow();
  });
});
