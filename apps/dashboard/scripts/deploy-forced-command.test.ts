import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const wrapper = path.resolve(
  "deploy/production/controller/frontmind-deploy-forced-command",
);
const digest = `ghcr.io/xiafanzeng/frontmind-dashboard@sha256:${"a".repeat(64)}`;
const sourceSha = "b".repeat(40);
const websiteDigest = `ghcr.io/xiafanzeng/frontmind-website@sha256:${"c".repeat(64)}`;
const websiteSourceSha = "d".repeat(40);

describe("fixed-service deploy SSH command", () => {
  let binDir: string;
  let stdinLog: string;

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), "frontmind-deploy-command-"));
    stdinLog = path.join(binDir, "stdin.log");
    await writeFile(
      path.join(binDir, "sudo"),
      [
        "#!/usr/bin/env sh",
        "username=''",
        "token=''",
        "IFS= read -r username || true",
        "IFS= read -r token || true",
        'printf \'%s %s\\n\' "$username" "${#token}" >"$TEST_STDIN_LOG"',
        "printf '%s\\n' \"$*\"",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(async () => {
    await rm(binDir, { recursive: true, force: true });
  });

  function run(fixedService: string, command: string, input?: string) {
    return spawnSync("bash", [wrapper, fixedService], {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SSH_ORIGINAL_COMMAND: command,
        TEST_STDIN_LOG: stdinLog,
      },
    });
  }

  it("injects Dashboard from authorized_keys rather than accepting a service token", () => {
    const result = run("dashboard", `${digest} ${sourceSha}`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `-n /usr/local/sbin/frontmind-deploy-controller dashboard ${digest} ${sourceSha}`,
    );
  });

  it("allows one Dashboard-owned coupled stack command", () => {
    const result = run(
      "dashboard",
      `coupled-stack ${digest} ${sourceSha} ${websiteDigest} ${websiteSourceSha}`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      `-n /usr/local/sbin/frontmind-deploy-controller --coupled-stack ${digest} ${sourceSha} ${websiteDigest} ${websiteSourceSha}`,
    );
  });

  it("rejects legacy rollout, coordinate injection, and Website stack ownership", () => {
    for (const [service, command] of [
      ["dashboard", `--kb-manus-v2-rollout deploy ${digest} ${sourceSha}`],
      ["dashboard", `--kb-manus-v2-rollout canary;id ${digest} ${sourceSha}`],
      [
        "dashboard",
        `coupled-stack ${digest} ${sourceSha} ${websiteDigest};id ${websiteSourceSha}`,
      ],
      [
        "website",
        `coupled-stack ${digest} ${sourceSha} ${websiteDigest} ${websiteSourceSha}`,
      ],
    ] as const) {
      const result = run(service, command);
      expect(result.status).toBe(64);
    }
  });

  it("passes the registry auth envelope through sudo without logging the token", async () => {
    const token = `ghs_${"t".repeat(40)}`;
    const result = run(
      "dashboard",
      `${digest} ${sourceSha}`,
      `xiafanzeng\n${token}\n`,
    );
    expect(result.status).toBe(0);
    expect(await readFile(stdinLog, "utf8")).toBe(
      `xiafanzeng ${token.length}\n`,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  });

  it("rejects attempts to choose or add another service", () => {
    for (const command of [
      `website ${digest} ${sourceSha}`,
      `deploy dashboard ${digest} ${sourceSha}`,
      `${digest} ${sourceSha} extra`,
    ]) {
      const result = run("dashboard", command);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("DEPLOY_COMMAND_REJECTED");
    }
  });

  it("rejects mutable tags and malformed source identities", () => {
    expect(
      run("website", `ghcr.io/x/frontmind-website:latest ${sourceSha}`).status,
    ).toBe(64);
    expect(run("website", `${digest} not-a-sha`).status).toBe(64);
  });
});
