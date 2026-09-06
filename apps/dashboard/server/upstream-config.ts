import type { Request } from "express";

const DEFAULT_UPSTREAM_BASE_URL =
  "https://agent-api.bigmodel.cn/api/agent/managed";

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

  if (
    env.NODE_ENV === "production" &&
    parsed.toString().replace(/\/+$/, "") !== DEFAULT_UPSTREAM_BASE_URL
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
      "FRONTMIND_UPSTREAM_BASE_URL must be the Zhipu Managed Agents HTTPS endpoint in production",
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
    case "frontmind-base":
    case "frontmind-pro":
    case undefined:
    case "":
      return "glm-5.3";
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
