#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const SHA_TAG_RE = /^sha-[a-f0-9]{40}$/;
const LINKED_TAG_RE = /^sha256-([a-f0-9]{64})\.(sig|att|sbom)$/;
const DEFAULT_GRACE_HOURS = 48;
const DEFAULT_KEEP = 10;

function tagsOf(version) {
  const tags = version?.metadata?.container?.tags;
  return Array.isArray(tags)
    ? tags.filter((tag) => typeof tag === "string")
    : [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parsePromotionMarker(tag, prefix = "deployed") {
  const marker = new RegExp(
    `^${escapeRegExp(prefix)}-v1-(\\d{8}T\\d{6}Z)-run-([0-9]+)-attempt-([0-9]+)-sha256-([a-f0-9]{64})$`,
  ).exec(tag);
  if (!marker) return null;

  const compact = marker[1];
  const timestamp = Date.parse(
    `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`,
  );
  if (!Number.isFinite(timestamp)) return null;

  return {
    timestamp,
    runId: marker[2],
    attempt: marker[3],
    digest: `sha256:${marker[4]}`,
  };
}

function promotionFor(version, prefix) {
  const digest = version?.name;
  if (!DIGEST_RE.test(digest ?? "")) return null;

  const markers = tagsOf(version)
    .map((tag) => parsePromotionMarker(tag, prefix))
    .filter((marker) => marker?.digest === digest)
    .sort((left, right) => right.timestamp - left.timestamp);
  return markers[0] ?? null;
}

function versionTime(version) {
  const timestamp = Date.parse(
    version?.updated_at ?? version?.created_at ?? "",
  );
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Build a deliberately conservative deletion plan from GitHub Packages API
 * container-version records. Untagged and unknown OCI artifacts are never
 * deleted because the API does not expose a reliable subject/referrer edge.
 */
export function planSuccessfulRetention(
  versions,
  {
    keepSuccessful = DEFAULT_KEEP,
    graceHours = DEFAULT_GRACE_HOURS,
    now = Date.now(),
    markerPrefix = "deployed",
  } = {},
) {
  if (!Array.isArray(versions))
    throw new TypeError("versions must be an array");
  if (!Number.isInteger(keepSuccessful) || keepSuccessful < 1) {
    throw new TypeError("keepSuccessful must be a positive integer");
  }
  if (!Number.isFinite(graceHours) || graceHours < 0) {
    throw new TypeError("graceHours must be a non-negative number");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(markerPrefix)) {
    throw new TypeError("markerPrefix must be a lowercase tag prefix");
  }

  const movingTags = new Set([
    `${markerPrefix}-current`,
    `${markerPrefix}-previous`,
  ]);
  const promoted = versions
    .map((version) => ({
      version,
      promotion: promotionFor(version, markerPrefix),
    }))
    .filter((item) => item.promotion)
    .sort(
      (left, right) =>
        right.promotion.timestamp - left.promotion.timestamp ||
        versionTime(right.version) - versionTime(left.version),
    );

  const protectedDigests = new Set(
    promoted.slice(0, keepSuccessful).map((item) => item.version.name),
  );
  for (const version of versions) {
    if (
      tagsOf(version).some((tag) => movingTags.has(tag)) &&
      DIGEST_RE.test(version.name ?? "")
    ) {
      protectedDigests.add(version.name);
    }
  }

  const protectedVersionIds = new Set();
  for (const version of versions) {
    if (protectedDigests.has(version.name)) protectedVersionIds.add(version.id);
    for (const tag of tagsOf(version)) {
      const linked = LINKED_TAG_RE.exec(tag);
      if (linked && protectedDigests.has(`sha256:${linked[1]}`)) {
        protectedVersionIds.add(version.id);
      }
    }
  }

  const graceMs = graceHours * 60 * 60 * 1000;
  const decisions = versions.map((version) => {
    const tags = tagsOf(version);
    const promotion = promotionFor(version, markerPrefix);

    if (protectedVersionIds.has(version.id)) {
      return {
        action: "keep",
        reason: "protected-success-or-linked-artifact",
        version,
      };
    }
    if (tags.length === 0) {
      return {
        action: "keep",
        reason: "conservative-untagged-artifact",
        version,
      };
    }
    if (tags.some((tag) => LINKED_TAG_RE.test(tag))) {
      return {
        action: "keep",
        reason: "conservative-linked-artifact",
        version,
      };
    }
    if (now - versionTime(version) < graceMs) {
      return { action: "keep", reason: "grace-period", version };
    }

    const immutableMarkers = tags.filter((tag) =>
      parsePromotionMarker(tag, markerPrefix),
    );
    const managedTags = tags.every(
      (tag) =>
        SHA_TAG_RE.test(tag) ||
        movingTags.has(tag) ||
        parsePromotionMarker(tag, markerPrefix),
    );
    if (!managedTags) {
      return { action: "keep", reason: "conservative-unknown-tag", version };
    }
    if (promotion || immutableMarkers.length > 0) {
      return {
        action: "delete",
        reason: "successful-version-outside-window",
        version,
      };
    }
    // A missing promotion marker usually means a failed build, but it can also
    // mean the server rollout succeeded while the registry marker write failed.
    // The Packages API cannot distinguish those states, so keep it.
    return { action: "keep", reason: "conservative-unpromoted-build", version };
  });

  // Until a complete success window exists, an unmarked legacy version may be
  // the server's current/previous rollback target. Bootstrap therefore fails
  // closed and starts pruning only after ten (or configured count) promotions.
  if (promoted.length < keepSuccessful) {
    for (const decision of decisions) {
      decision.action = "keep";
      decision.reason = "insufficient-trusted-promotion-history";
    }
  }

  return {
    keepSuccessful,
    markerPrefix,
    promotedDigests: promoted.map((item) => item.version.name),
    protectedDigests: [...protectedDigests],
    decisions,
    deletions: decisions.filter((decision) => decision.action === "delete"),
  };
}

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

async function githubRequest(url, token, { method = "GET" } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "frontmind-ghcr-success-retention",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${method} ${url} failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

async function listVersions({ apiUrl, owner, ownerType, packageName, token }) {
  const scope = ownerType.toLowerCase() === "organization" ? "orgs" : "users";
  const base = `${apiUrl}/${scope}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(packageName)}/versions`;
  const versions = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = await githubRequest(
      `${base}?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch))
      throw new Error("GitHub Packages returned a non-array response");
    versions.push(...batch);
    if (batch.length < 100) return { base, versions };
  }
  throw new Error("refusing to paginate more than 10,000 package versions");
}

async function main() {
  const owner = readArgument("--owner", process.env.GITHUB_REPOSITORY_OWNER);
  const ownerType = readArgument(
    "--owner-type",
    process.env.GITHUB_REPOSITORY_OWNER_TYPE ?? "User",
  );
  const packageName = readArgument("--package", null);
  const markerPrefix = readArgument("--marker-prefix", "deployed");
  const keepSuccessful = Number(
    readArgument("--keep-successful", String(DEFAULT_KEEP)),
  );
  const graceHours = Number(
    readArgument("--grace-hours", String(DEFAULT_GRACE_HOURS)),
  );
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const execute = process.argv.includes("--execute");

  if (!owner || !packageName || !token) {
    throw new Error(
      "--owner, --package and GH_TOKEN/GITHUB_TOKEN are required",
    );
  }
  if (!/^(User|Organization)$/i.test(ownerType)) {
    throw new Error("--owner-type must be User or Organization");
  }
  if (!Number.isInteger(keepSuccessful) || keepSuccessful < 10) {
    throw new Error("--keep-successful must be an integer >= 10");
  }

  const { base, versions } = await listVersions({
    apiUrl,
    owner,
    ownerType,
    packageName,
    token,
  });
  const plan = planSuccessfulRetention(versions, {
    keepSuccessful,
    graceHours,
    markerPrefix,
  });

  for (const decision of plan.decisions) {
    const tags = tagsOf(decision.version).join(",") || "<untagged>";
    console.log(
      `${decision.action.toUpperCase()} id=${decision.version.id} digest=${decision.version.name} tags=${tags} reason=${decision.reason}`,
    );
  }
  console.log(
    JSON.stringify({
      package: packageName,
      execute,
      versions: versions.length,
      promoted: plan.promotedDigests.length,
      protectedDigests: plan.protectedDigests.length,
      deletions: plan.deletions.length,
    }),
  );

  if (!execute) return;
  for (const { version } of plan.deletions) {
    await githubRequest(`${base}/${encodeURIComponent(version.id)}`, token, {
      method: "DELETE",
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
