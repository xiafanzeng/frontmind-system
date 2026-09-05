import { describe, expect, it } from "vitest";

import { inspectEsaRuntimeConfiguration } from "./esa-config";

const base = {
  FRONTMIND_ESA_ENABLED: "1",
  FRONTMIND_ESA_INSTANCE_ID: "esa-managed-instance-1",
} satisfies NodeJS.ProcessEnv;

describe("ESA runtime configuration projection", () => {
  it("does not report configured from only enabled plus a registered handler", () => {
    expect(
      inspectEsaRuntimeConfiguration({
        env: { FRONTMIND_ESA_ENABLED: "1" },
        providerRegistered: true,
        pathExists: () => false,
      }),
    ).toMatchObject({
      configured: false,
      code: "ESA_INSTANCE_NOT_CONFIGURED",
    });
    expect(
      inspectEsaRuntimeConfiguration({
        env: base,
        providerRegistered: true,
        pathExists: () => false,
      }),
    ).toMatchObject({
      configured: false,
      code: "ESA_SERVICE_IDENTITY_NOT_CONFIGURED",
    });
  });

  it("accepts the official environment credential source without exposing it", () => {
    const configuration = inspectEsaRuntimeConfiguration({
      env: {
        ...base,
        ALIBABA_CLOUD_ACCESS_KEY_ID: "not-returned-id",
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: "not-returned-secret",
        ALIBABA_CLOUD_SECURITY_TOKEN: "not-returned-token",
      },
      providerRegistered: true,
      pathExists: () => false,
    });

    expect(configuration).toEqual({
      configured: true,
      credentialSource: "environment",
    });
    expect(JSON.stringify(configuration)).not.toMatch(/not-returned/u);
  });

  it("accepts an explicit OIDC short-lived identity and rejects placeholders", () => {
    expect(
      inspectEsaRuntimeConfiguration({
        env: {
          ...base,
          ALIBABA_CLOUD_ROLE_ARN: "acs:ram::123456789:role/frontmind",
          ALIBABA_CLOUD_OIDC_PROVIDER_ARN:
            "acs:ram::123456789:oidc-provider/frontmind",
          ALIBABA_CLOUD_OIDC_TOKEN_FILE: "/var/run/secrets/oidc-token",
        },
        providerRegistered: true,
        pathExists: () => false,
      }),
    ).toEqual({ configured: true, credentialSource: "oidc" });
    expect(
      inspectEsaRuntimeConfiguration({
        env: {
          ...base,
          FRONTMIND_ESA_INSTANCE_ID: "replace-with-managed-instance",
          ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
          ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
        },
        providerRegistered: true,
        pathExists: () => false,
      }),
    ).toMatchObject({
      configured: false,
      code: "ESA_INSTANCE_NOT_CONFIGURED",
    });
  });
});
