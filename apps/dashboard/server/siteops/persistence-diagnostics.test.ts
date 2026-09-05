import { describe, expect, it } from "vitest";

import {
  isSiteOpsPersistenceDatabaseError,
  safeSiteOpsPersistenceDiagnostics,
  siteOpsPersistenceTransactionOutcome,
} from "./persistence-diagnostics";

describe("SiteOps persistence diagnostics", () => {
  it("extracts only allowlisted diagnostics from a nested database failure", () => {
    const driverError = Object.assign(
      new Error(
        "Data too long for column 'workflow_upstream_version' at row 1",
      ),
      {
        code: "ER_DATA_TOO_LONG",
        errno: 1406,
        sqlState: "22001",
      },
    );
    const error = Object.assign(new Error("parameterized query failed"), {
      query: "insert into site_builds values (?)",
      params: ["customer-secret"],
      cause: driverError,
    });

    expect(safeSiteOpsPersistenceDiagnostics(error)).toEqual({
      driverCode: "ER_DATA_TOO_LONG",
      errno: 1406,
      sqlState: "22001",
      column: "workflow_upstream_version",
    });
    expect(isSiteOpsPersistenceDatabaseError(error)).toBe(true);
    expect(siteOpsPersistenceTransactionOutcome(error)).toBe("rolled_back");
  });

  it("does not classify an unknown programming failure as a database error", () => {
    const error = new Error("unexpected selection bug");

    expect(isSiteOpsPersistenceDatabaseError(error)).toBe(false);
    expect(safeSiteOpsPersistenceDiagnostics(error)).toEqual({});
  });

  it("does not treat a bare application error code as a database driver code", () => {
    const error = Object.assign(new Error("provider failed"), {
      code: "SOME_APP_ERROR",
    });

    expect(isSiteOpsPersistenceDatabaseError(error)).toBe(false);
    expect(safeSiteOpsPersistenceDiagnostics(error)).toEqual({});
  });

  it("requires coherent MySQL evidence and leaves transport rollback unknown", () => {
    for (const error of [
      Object.assign(new Error("application errno"), { errno: -2 }),
      Object.assign(new Error("application code"), { code: "ER_APP_BUG" }),
      Object.assign(new Error("application state"), { sqlState: "ABCDE" }),
    ]) {
      expect(isSiteOpsPersistenceDatabaseError(error)).toBe(false);
      expect(safeSiteOpsPersistenceDiagnostics(error)).toEqual({});
      expect(siteOpsPersistenceTransactionOutcome(error)).toBe("unknown");
    }

    const transport = Object.assign(new Error("connection reset"), {
      code: "ECONNRESET",
    });
    expect(isSiteOpsPersistenceDatabaseError(transport)).toBe(true);
    expect(safeSiteOpsPersistenceDiagnostics(transport)).toEqual({
      driverCode: "ECONNRESET",
    });
    expect(siteOpsPersistenceTransactionOutcome(transport)).toBe("unknown");
  });

  it("omits raw messages, SQL, parameters and unknown identifiers", () => {
    const secret = "customer-private-template-choice";
    const driverError = Object.assign(
      new Error(
        `Data too long for column '${secret}' under constraint '${secret}'`,
      ),
      {
        code: "ER_DATA_TOO_LONG",
        errno: 1406,
        sqlState: "22001",
        column: secret,
        constraint: secret,
      },
    );
    const error = Object.assign(new Error(`query failed: ${secret}`), {
      query: `insert into site_builds values ('${secret}')`,
      params: [secret],
      cause: driverError,
    });

    const diagnostics = safeSiteOpsPersistenceDiagnostics(error);
    expect(diagnostics).toEqual({
      driverCode: "ER_DATA_TOO_LONG",
      errno: 1406,
      sqlState: "22001",
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it("recognizes an allowlisted constraint without exposing duplicate data", () => {
    const secret = "customer-request-id";
    const error = Object.assign(
      new Error(
        `Duplicate entry '${secret}' for key 'site_operations_project_request_uq'`,
      ),
      {
        code: "ER_DUP_ENTRY",
        errno: 1062,
        sqlState: "23000",
      },
    );

    const diagnostics = safeSiteOpsPersistenceDiagnostics(error);
    expect(diagnostics).toEqual({
      driverCode: "ER_DUP_ENTRY",
      errno: 1062,
      sqlState: "23000",
      constraint: "site_operations_project_request_uq",
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });
});
