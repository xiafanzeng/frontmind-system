import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parsePromotionMarker,
  planSuccessfulRetention,
} from "../ghcr-success-retention.mjs";
import { buildPromotionMarker } from "../mark-ghcr-promoted.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/ghcr-package-versions.json", import.meta.url),
    "utf8",
  ),
);

test("keeps successful window, explicit rollback pointers and OCI attachments", () => {
  const plan = planSuccessfulRetention(fixture, {
    keepSuccessful: 2,
    graceHours: 48,
    now: Date.parse("2026-08-02T00:00:00Z"),
  });

  assert.deepEqual(
    new Set(plan.protectedDigests),
    new Set([fixture[0].name, fixture[1].name, fixture[2].name]),
  );
  assert.deepEqual(
    plan.deletions.map((decision) => decision.version.id),
    [104],
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 106).reason,
    "grace-period",
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 105).reason,
    "conservative-unpromoted-build",
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 107).reason,
    "protected-success-or-linked-artifact",
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 108).reason,
    "conservative-linked-artifact",
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 109).reason,
    "conservative-untagged-artifact",
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 110).reason,
    "conservative-unknown-tag",
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 111).reason,
    "protected-success-or-linked-artifact",
  );
});

test("does not trust a deployment marker copied to a different digest", () => {
  const tampered = structuredClone(fixture);
  tampered[0].metadata.container.tags[2] =
    tampered[1].metadata.container.tags[1];
  const plan = planSuccessfulRetention(tampered, {
    keepSuccessful: 2,
    graceHours: 0,
    now: Date.parse("2026-08-02T00:00:00Z"),
  });

  assert(!plan.promotedDigests.includes(tampered[0].name));
});

test("first promotion keeps every legacy sha and rollback version", () => {
  const versions = fixture.map((version, index) => ({
    ...version,
    metadata: {
      container: {
        tags: version.metadata.container.tags.filter(
          (tag) => index === 0 || !tag.startsWith("deployed-"),
        ),
      },
    },
  }));
  const plan = planSuccessfulRetention(versions, {
    keepSuccessful: 10,
    graceHours: 0,
  });

  assert.equal(plan.promotedDigests.length, 1);
  assert.equal(plan.deletions.length, 0);
  assert(
    plan.decisions.every(
      (decision) =>
        decision.reason === "insufficient-trusted-promotion-history",
    ),
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 105).action,
    "keep",
  );
  assert.equal(
    plan.decisions.find((decision) => decision.version.id === 103).action,
    "keep",
  );
});

test("promotion marker carries exact digest and immutable run identity", () => {
  const tag = fixture[0].metadata.container.tags[2];
  assert.deepEqual(parsePromotionMarker(tag), {
    timestamp: Date.parse("2026-08-01T12:00:00Z"),
    runId: "1001",
    attempt: "1",
    digest: fixture[0].name,
  });
});

test("promotion writer creates a marker accepted by the retention parser", () => {
  const tag = buildPromotionMarker({
    markerPrefix: "deployed",
    timestamp: "2026-08-02T01:02:03.456Z",
    runId: "123456789",
    attempt: "2",
    digest: fixture[0].name,
  });
  assert.equal(parsePromotionMarker(tag)?.digest, fixture[0].name);
  assert(tag.length <= 128);
});
