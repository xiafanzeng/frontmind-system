import type { Request } from "express";

const UPSTREAM_VENDOR = ["ma", "nus"].join("");
const DEFAULT_UPSTREAM_BASE_URL = `https://api.${UPSTREAM_VENDOR}.im`;

export function configuredUpstreamBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw =
    env.FRONTMIND_UPSTREAM_BASE_URL?.trim() || DEFAULT_UPSTREAM_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    /[?#]/.test(raw)
  ) {
    return null;
  }

  return parsed.toString().replace(/\/+$/, "");
}

export function isUpstreamBaseUrlConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  return configuredUpstreamBaseUrl(env) !== null;
}

export function assertUpstreamBaseUrlConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured = configuredUpstreamBaseUrl(env);
  if (!configured) {
    throw new Error(
      "FRONTMIND_UPSTREAM_BASE_URL must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  return configured;
}

export function getUpstreamBaseUrl(_req?: Request) {
  return assertUpstreamBaseUrlConfigured();
}

export function getFrontMindApiKey(req: Request) {
  return req.frontmindCredential?.apiKey ?? "";
}

export function getFrontMindCredentials(req: Request) {
  return {
    apiKey: getFrontMindApiKey(req),
    baseUrl: getUpstreamBaseUrl(req),
  };
}

export function toUpstreamAgentProfile(agentProfile?: string) {
  switch (agentProfile) {
    case "frontmind-lite":
      return `${UPSTREAM_VENDOR}-1.6-lite`;
    case "frontmind-base":
      return `${UPSTREAM_VENDOR}-1.6`;
    case "frontmind-pro":
    case undefined:
    case "":
      return `${UPSTREAM_VENDOR}-1.6-max`;
    default:
      return agentProfile;
  }
}

export function translateTaskBodyForUpstream<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const next = { ...(body as Record<string, unknown>) };
  if (typeof next.agentProfile === "string") {
    next.agentProfile = toUpstreamAgentProfile(next.agentProfile);
  }
  return next as T;
}
