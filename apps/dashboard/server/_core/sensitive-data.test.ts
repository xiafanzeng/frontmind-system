import { inspect } from "node:util";

import axios from "axios";
import { describe, expect, it } from "vitest";

import {
  isSensitiveDataKey,
  redactSensitivePayload,
  safeErrorForLog,
} from "./sensitive-data";

const SENTINEL = "sentinel-current-credential-do-not-expose";

describe("sensitive data boundary", () => {
  it.each([
    "API_KEY",
    "apiKey",
    "Api-Key",
    "x-api-key",
    "AUTHORIZATION",
    "set-cookie",
    "accessToken",
    "refresh_token",
    "clientSecret",
    "databasePassword",
    "upstreamCredential",
  ])("classifies %s as sensitive", (key) => {
    expect(isSensitiveDataKey(key)).toBe(true);
  });

  it("removes auth fields and exact credentials from nested objects and arrays", () => {
    const payload = {
      id: "task-safe",
      API_KEY: SENTINEL,
      nested: [
        {
          Authorization: `Bearer ${SENTINEL}`,
          safe: `prefix ${SENTINEL} suffix`,
        },
        {
          headers: {
            Cookie: `session=${SENTINEL}`,
            "X-Request-ID": "request-safe",
          },
          output: "Bearer another-upstream-token",
        },
      ],
      token: "unknown-token",
    };

    const redacted = redactSensitivePayload(payload, {
      secrets: [SENTINEL],
    });
    const serialized = JSON.stringify(redacted);

    expect(redacted).toMatchObject({
      id: "task-safe",
      nested: [
        { safe: "prefix [REDACTED] suffix" },
        {
          headers: { "X-Request-ID": "request-safe" },
          output: "Bearer [REDACTED]",
        },
      ],
    });
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("api_key");
  });

  it("reduces Axios errors to an allowlisted credential-free log DTO", () => {
    const error = new axios.AxiosError(
      `upstream failed with ${SENTINEL}`,
      "ERR_SENTINEL_NETWORK",
      {
        headers: {
          API_KEY: SENTINEL,
          Authorization: `Bearer ${SENTINEL}`,
          Cookie: `session=${SENTINEL}`,
        },
      },
      { socket: { secret: SENTINEL } },
      {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "x-request-id": "request-safe", "set-cookie": SENTINEL },
        config: {
          headers: {
            API_KEY: SENTINEL,
            Authorization: `Bearer ${SENTINEL}`,
          },
        },
        data: { apiKey: SENTINEL },
      },
    );

    expect(inspect(error)).toContain(SENTINEL);
    const safe = safeErrorForLog(error, { secrets: [SENTINEL] });
    const serialized = JSON.stringify(safe);

    expect(safe).toEqual({
      name: "AxiosError",
      message: "upstream failed with [REDACTED]",
      code: "ERR_SENTINEL_NETWORK",
      status: 502,
      requestId: "request-safe",
    });
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("config");
    expect(serialized).not.toContain('"request":');
    expect(serialized).not.toContain("response");
    expect(serialized).not.toContain("headers");
  });
});
