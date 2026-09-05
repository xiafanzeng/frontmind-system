// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mediaSchema } from "../../../packages/monitoring-contracts/src/results";
import { monitoringAnswerDetailOutputSchema } from "../../../packages/monitoring-contracts/src/monitoring-read";
import {
  adminOperationDetailOutputSchema, adminRunListOutputSchema,
  adminUserListOutputSchema, publicUserSchema, runDetailOutputSchema,
} from "../../../packages/monitoring-contracts/src/outputs";
import { publisherMediaOutputSchema } from "../../../packages/monitoring-contracts/src/publishing";
import { usernameSchema } from "../../../packages/monitoring-contracts/src/admin";

const id = "11111111-1111-5111-8111-111111111111";
const accessPath = `/api/monitoring/media/${id}`;
const media = {
  id, revisionId: id, type: "screenshot", ordinal: 0, archiveStatus: "archived",
  accessPath, thumbnailAccessPath: `${accessPath}?variant=thumbnail`,
  mimeType: "image/png", sizeBytes: 123,
};

describe("monitoring output paths on the unified API host", () => {
  it("accepts archived media returned by run and answer repositories", () => {
    expect(mediaSchema.parse(media).accessPath).toBe(accessPath);
    expect(runDetailOutputSchema.shape.media.parse([media])[0]?.accessPath).toBe(accessPath);
    expect(monitoringAnswerDetailOutputSchema.shape.archivedScreenshots.parse([media])[0]?.accessPath).toBe(accessPath);
  });
  it("accepts the scoped media logo and rejects unscoped or external URLs", () => {
    const path = `/api/monitoring/publisher/media-logos/${id}/${"a".repeat(64)}`;
    const schema = publisherMediaOutputSchema.shape.logoUrl;
    expect(schema.parse(path)).toBe(path);
    expect(schema.safeParse(path.replace("/api/monitoring/", "/api/")).success).toBe(false);
    expect(schema.safeParse(`https://other.test${path}`).success).toBe(false);
  });
});

it("accepts Dashboard display labels without relaxing standalone login inputs", () => {
  const username = "customer [42]";
  expect(publicUserSchema.parse({ id, username, role: "user", status: "active" }).username).toBe(username);
  for (const schema of [adminUserListOutputSchema, adminRunListOutputSchema, adminOperationDetailOutputSchema]) {
    expect(schema.shape.username.parse(username)).toBe(username);
    expect(schema.shape.username.safeParse("x".repeat(129)).success).toBe(false);
  }
  expect(usernameSchema.safeParse(username).success).toBe(false);
});
