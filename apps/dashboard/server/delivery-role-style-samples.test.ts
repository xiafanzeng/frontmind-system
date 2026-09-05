import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "./auth-service";
import { publishWebsiteStyleSamples } from "./delivery-role-service";

const actor = {
  id: 31,
  role: "delivery_member",
  username: "engineer",
  displayName: "工程师",
  engineerRoleType: "ai_operations_engineer",
} as AuthenticatedUser;

const validSamples = [1, 2, 3].map((index) => ({
  fileId: `file-${index}`,
  filename: `style-${index}.png`,
  mimeType: "image/png",
  sizeBytes: 1_024,
  label: `风格 ${index}`,
}));

const publish = (samples: typeof validSamples) =>
  publishWebsiteStyleSamples({
    actor,
    projectAssignmentId: "a2c8dc65-4cb3-4c78-982f-0f05a6b22e8c",
    ticketId: "297769f5-9ec5-4d64-9c3a-9abdb603632d",
    expectedWorkflowRevision: 1,
    samples,
  });

describe("website style sample publishing contract", () => {
  it("rejects batches that do not contain exactly three samples", async () => {
    await expect(publish(validSamples.slice(0, 2))).rejects.toMatchObject({
      code: "CONFLICT",
      message: "每批必须提交恰好三张图片样例",
    });
  });

  it("rejects non-image files before touching project state", async () => {
    await expect(
      publish([
        ...validSamples.slice(0, 2),
        {
          ...validSamples[2]!,
          filename: "style-3.pdf",
          mimeType: "application/pdf",
        },
      ]),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("PNG、JPEG 或 WebP"),
    });
  });

  it("rejects a duplicated uploaded resource", async () => {
    await expect(
      publish([
        validSamples[0]!,
        validSamples[1]!,
        { ...validSamples[2]!, fileId: validSamples[0]!.fileId },
      ]),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "三张图片样例不能重复",
    });
  });
});
