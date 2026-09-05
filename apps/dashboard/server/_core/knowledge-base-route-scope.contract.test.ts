import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("knowledge-base project-scope route mounting", () => {
  it.each([
    ["/api/knowledge-base/artifacts", "knowledgeBaseArtifactApi"],
    ["/api/knowledge-base", "knowledgeBaseApi"],
  ])(
    "validates and rejects delivery project scope before mounting %s",
    async (mountPath, routerName) => {
      const source = await fs.readFile(
        path.resolve("server/_core/index.ts"),
        "utf8",
      );
      const mountStart = source.indexOf(`"${mountPath}"`);
      const nextMount = source.indexOf("app.use(", mountStart + 1);
      const mount = source.slice(
        mountStart,
        nextMount === -1 ? undefined : nextMount,
      );

      expect(mountStart).toBeGreaterThan(-1);
      expect(mount).toMatch(
        new RegExp(
          `requireExpressAuth[\\s\\S]*enforceDeliveryProjectContext[\\s\\S]*rejectDeliveryMemberKnowledgeBaseProjectScope[\\s\\S]*${routerName}`,
          "u",
        ),
      );
    },
  );

  it("rejects delivery-member KB access before optional account credential resolution", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const mountStart = source.indexOf('"/api/knowledge-base"');
    const nextMount = source.indexOf("app.use(", mountStart + 1);
    const mount = source.slice(mountStart, nextMount);

    expect(
      mount.indexOf("rejectDeliveryMemberKnowledgeBaseProjectScope"),
    ).toBeLessThan(mount.indexOf("attachOptionalActiveCredential"));
  });
});
