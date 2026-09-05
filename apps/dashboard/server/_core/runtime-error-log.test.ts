import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { runtimeErrorForLog, runtimeLogSecrets } from "./runtime-error-log";

describe("runtime error logging", () => {
  it("redacts configured and request credentials while dropping Axios internals", () => {
    const requestSecret = "request-secret-value-123456789";
    const monitorSecret = "monitor-secret-value-123456789";
    const databasePassword = "database-password-value-123456789";
    const env = {
      FRONTMIND_MONITOR_API_KEY: monitorSecret,
      DATABASE_URL: `mysql://user:${databasePassword}@db.example.test/app`,
    };
    const error = Object.assign(
      new Error(
        `upstream failed request=${requestSecret} monitor=${monitorSecret} db=${databasePassword}`,
      ),
      {
        name: "AxiosError",
        code: "ERR_BAD_RESPONSE",
        config: {
          headers: {
            Authorization: `Bearer ${requestSecret}`,
            API_KEY: requestSecret,
          },
          data: { prompt: requestSecret, monitorSecret },
        },
        request: { rawHeaders: ["Authorization", requestSecret] },
        response: {
          status: 502,
          headers: { "x-request-id": `trace-${requestSecret}` },
          data: { secret: monitorSecret },
        },
      },
    );

    const safe = runtimeErrorForLog(error, {
      additionalSecrets: [requestSecret],
      env,
    });
    const serialized = JSON.stringify(safe);

    expect(safe).toEqual({
      name: "AxiosError",
      message:
        "upstream failed request=[REDACTED] monitor=[REDACTED] db=[REDACTED]",
      code: "ERR_BAD_RESPONSE",
      status: 502,
      requestId: "trace-[REDACTED]",
    });
    expect(serialized).not.toContain(requestSecret);
    expect(serialized).not.toContain(monitorSecret);
    expect(serialized).not.toContain(databasePassword);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("config");
    expect(serialized).not.toContain("response");
    expect(runtimeLogSecrets([], env)).toContain(databasePassword);
  });

  it("drops Drizzle query parameters and nested database error details", () => {
    const sensitiveParameter = "credential-fingerprint-value";
    const error = new DrizzleQueryError(
      "insert into table values (?)",
      [sensitiveParameter],
      Object.assign(new Error(`Duplicate entry ${sensitiveParameter}`), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
      }),
    );

    const serialized = JSON.stringify(runtimeErrorForLog(error, { env: {} }));

    expect(serialized).toContain("Database query failed");
    expect(serialized).not.toContain(sensitiveParameter);
    expect(serialized).not.toContain("params");
    expect(serialized).not.toContain("cause");
  });
});
