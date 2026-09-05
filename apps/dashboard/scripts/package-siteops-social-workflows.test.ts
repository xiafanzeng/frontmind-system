import { describe, expect, it } from "vitest";

import {
  SITEOPS_SOCIAL_WORKFLOWS,
  verifyAllSiteOpsSocialWorkflows,
} from "./package-siteops-social-workflows.mjs";

describe("SiteOps social runtime workflows", () => {
  it("verifies brand-safe channel contracts and manifests", async () => {
    const verified = await verifyAllSiteOpsSocialWorkflows();
    expect(verified).toHaveLength(2);
    expect(verified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "wechat",
          version: SITEOPS_SOCIAL_WORKFLOWS.wechat.version,
          manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          channel: "xiaohongshu",
          version: SITEOPS_SOCIAL_WORKFLOWS.xiaohongshu.version,
          manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]),
    );
  });
});
