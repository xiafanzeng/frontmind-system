const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PLACEHOLDER_MARKERS = [
  "replace-with",
  "change-me",
  "example.com",
  "example.net",
  "example.org",
];

/**
 * Resolve the canonical browser-facing Agent URL without ever returning an
 * invalid or placeholder value. Production links must use HTTPS; local HTTP
 * remains available for development and tests.
 */
export function configuredFrontMindPublicUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.FRONTMIND_PUBLIC_URL?.trim();
  if (!raw) return null;
  if (
    PLACEHOLDER_MARKERS.some((marker) =>
      raw.toLocaleLowerCase("en-US").includes(marker),
    )
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const localHttp =
    env.NODE_ENV !== "production" &&
    parsed.protocol === "http:" &&
    LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  return parsed.toString().replace(/\/+$/, "");
}

export function isFrontMindPublicUrlConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  return configuredFrontMindPublicUrl(env) !== null;
}

export function assertFrontMindPublicUrlConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured = configuredFrontMindPublicUrl(env);
  if (!configured) {
    throw new Error(
      "FRONTMIND_PUBLIC_URL must be a non-placeholder HTTPS URL in production",
    );
  }
  return configured;
}
