import { existsSync } from "node:fs";
import path from "node:path";

type Environment = NodeJS.ProcessEnv;

export type EsaRuntimeConfiguration =
  | {
      configured: true;
      credentialSource:
        | "environment"
        | "oidc"
        | "profile"
        | "ecs_ram_role"
        | "credentials_uri";
    }
  | {
      configured: false;
      code:
        | "ESA_RUNTIME_DISABLED"
        | "ESA_ADAPTER_NOT_REGISTERED"
        | "ESA_INSTANCE_NOT_CONFIGURED"
        | "ESA_SERVICE_IDENTITY_NOT_CONFIGURED";
      reason: string;
    };

function present(env: Environment, name: string) {
  return Boolean(env[name]?.trim());
}

function validCredentialsUri(raw: string | undefined) {
  if (!raw?.trim()) return false;
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Read-only readiness projection for the same standard credential chain used
 * by @alicloud/credentials. It checks only presence/shape and never returns a
 * credential value, fingerprint or secret.
 */
export function inspectEsaRuntimeConfiguration(input?: {
  env?: Environment;
  providerRegistered?: boolean;
  pathExists?: (filePath: string) => boolean;
}): EsaRuntimeConfiguration {
  const env = input?.env ?? process.env;
  if (env.FRONTMIND_ESA_ENABLED?.trim() !== "1") {
    return {
      configured: false,
      code: "ESA_RUNTIME_DISABLED",
      reason: "ESA 直接发布尚未启用",
    };
  }
  if (input?.providerRegistered === false) {
    return {
      configured: false,
      code: "ESA_ADAPTER_NOT_REGISTERED",
      reason: "ESA 官方 SDK 适配器尚未注册",
    };
  }
  const instanceId = env.FRONTMIND_ESA_INSTANCE_ID?.trim() ?? "";
  if (
    !instanceId ||
    instanceId.length > 191 ||
    /[\u0000-\u001f\u007f\s]/u.test(instanceId) ||
    /(?:replace[-_ ]with|your[-_ ]managed|example|placeholder)/iu.test(
      instanceId,
    )
  ) {
    return {
      configured: false,
      code: "ESA_INSTANCE_NOT_CONFIGURED",
      reason: "FrontMind 托管 ESA 套餐实例 ID 尚未配置",
    };
  }

  if (
    present(env, "ALIBABA_CLOUD_ACCESS_KEY_ID") &&
    present(env, "ALIBABA_CLOUD_ACCESS_KEY_SECRET")
  ) {
    return { configured: true, credentialSource: "environment" };
  }
  if (
    present(env, "ALIBABA_CLOUD_ROLE_ARN") &&
    present(env, "ALIBABA_CLOUD_OIDC_PROVIDER_ARN") &&
    present(env, "ALIBABA_CLOUD_OIDC_TOKEN_FILE")
  ) {
    return { configured: true, credentialSource: "oidc" };
  }
  const pathExists = input?.pathExists ?? existsSync;
  const explicitProfile = env.ALIBABA_CLOUD_CREDENTIALS_FILE?.trim();
  const defaultProfile = env.HOME?.trim()
    ? path.join(env.HOME.trim(), ".alibabacloud", "credentials")
    : null;
  if (
    (explicitProfile && pathExists(explicitProfile)) ||
    (!explicitProfile && defaultProfile && pathExists(defaultProfile))
  ) {
    return { configured: true, credentialSource: "profile" };
  }
  if (
    present(env, "ALIBABA_CLOUD_ECS_METADATA") &&
    env.ALIBABA_CLOUD_ECS_METADATA_DISABLED?.trim().toLowerCase() !== "true"
  ) {
    return { configured: true, credentialSource: "ecs_ram_role" };
  }
  if (validCredentialsUri(env.ALIBABA_CLOUD_CREDENTIALS_URI)) {
    return { configured: true, credentialSource: "credentials_uri" };
  }
  return {
    configured: false,
    code: "ESA_SERVICE_IDENTITY_NOT_CONFIGURED",
    reason:
      "ESA 缺少可用的阿里云标准服务身份（环境 STS/AK、OIDC、凭据文件、ECS RAM Role 或 Credentials URI）",
  };
}
