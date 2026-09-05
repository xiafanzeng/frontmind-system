import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { manualServiceOrderResponseSchema } from "./manual-service-order";

const fixturePath = path.resolve(
  process.cwd(),
  "shared/contracts/manual-service-order-v1.fixture.json",
);
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText) as {
  fixtureId: string;
  externalWechatFlow: Record<string, unknown>;
  legacyElectronicSignatureFlow: Record<string, unknown>;
};

describe("shared manual-service-order response contract", () => {
  it("matches the exact fixture shared with Website", () => {
    expect(fixture.fixtureId).toBe(
      "frontmind-manual-service-order-v1-2026-08-02",
    );
    expect(createHash("sha256").update(fixtureText).digest("hex")).toBe(
      "e3e9f0c4a5a83fc41313b40e72b75da583dbf6c4feb796e133bb1d3144f87513",
    );
  });

  it("parses every new and legacy response without inventing production fields", () => {
    for (const response of [
      ...Object.values(fixture.externalWechatFlow),
      ...Object.values(fixture.legacyElectronicSignatureFlow),
    ]) {
      expect(manualServiceOrderResponseSchema.safeParse(response).success).toBe(
        true,
      );
    }

    const created = fixture.externalWechatFlow.created as Record<
      string,
      Record<string, unknown>
    >;
    const authorized = fixture.externalWechatFlow.authorized as Record<
      string,
      Record<string, unknown>
    >;
    expect(created.order).not.toHaveProperty("amountFen");
    expect(authorized.order).toMatchObject({
      status: "payment_required",
      contractAuthorizationMode: "external_wechat",
    });
    expect(JSON.stringify(fixture.externalWechatFlow)).not.toMatch(
      /contractId|signingUrl|signedAt/,
    );
  });
});
