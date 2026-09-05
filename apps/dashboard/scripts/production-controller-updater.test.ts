import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const updaterSource = path.resolve(
  "deploy/production/update-release-controllers.sh",
);
const controllerSource = path.resolve(
  "deploy/production/controller/frontmind-deploy-controller",
);
const forcedSource = path.resolve(
  "deploy/production/controller/frontmind-deploy-forced-command",
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness({
  failForcedInstall = false,
  failControllerInstall = false,
}: {
  failForcedInstall?: boolean;
  failControllerInstall?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "frontmind-prod-updater-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const templates = path.join(root, "deploy/production");
  const controllerDir = path.join(templates, "controller");
  const targets = path.join(root, "targets");
  const recoveryRoot = path.join(root, "controller-update-recovery");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(controllerDir, { recursive: true }),
    mkdir(targets, { recursive: true }),
  ]);
  const controllerTemplate = path.join(
    controllerDir,
    "frontmind-deploy-controller",
  );
  const forcedTemplate = path.join(
    controllerDir,
    "frontmind-deploy-forced-command",
  );
  await Promise.all([
    writeFile(controllerTemplate, await readFile(controllerSource), {
      mode: 0o755,
    }),
    writeFile(forcedTemplate, await readFile(forcedSource), { mode: 0o755 }),
  ]);
  const controllerTarget = path.join(targets, "frontmind-deploy-controller");
  const forcedTarget = path.join(targets, "frontmind-deploy-forced-command");
  await Promise.all([
    writeFile(controllerTarget, "old-controller\n", { mode: 0o755 }),
    writeFile(forcedTarget, "old-forced\n", { mode: 0o755 }),
  ]);

  let updater = await readFile(updaterSource, "utf8");
  updater = updater
    .replace(
      'readonly CONTROLLER_TARGET="/usr/local/sbin/frontmind-deploy-controller"',
      `readonly CONTROLLER_TARGET="${controllerTarget}"`,
    )
    .replace(
      'readonly FORCED_TARGET="/usr/local/sbin/frontmind-deploy-forced-command"',
      `readonly FORCED_TARGET="${forcedTarget}"`,
    )
    .replace(
      'readonly UPDATE_LOCK="/run/lock/frontmind-production-controller-update.lock"',
      `readonly UPDATE_LOCK="${path.join(root, "update.lock")}"`,
    )
    .replace(
      'readonly DASHBOARD_LOCK="/run/lock/frontmind-deploy-dashboard.lock"',
      `readonly DASHBOARD_LOCK="${path.join(root, "dashboard.lock")}"`,
    )
    .replace(
      'readonly WEBSITE_LOCK="/run/lock/frontmind-deploy-website.lock"',
      `readonly WEBSITE_LOCK="${path.join(root, "website.lock")}"`,
    )
    .replace(
      'readonly RECOVERY_ROOT="/var/lib/frontmind-deploy/controller-update"',
      `readonly RECOVERY_ROOT="${recoveryRoot}"`,
    )
    .replace(
      '[[ $EUID -eq 0 ]] || die "PRODUCTION_CONTROLLER_UPDATE_REQUIRES_ROOT" 77',
      ": # root check replaced in disposable updater contract",
    )
    .replace(
      '[[ -f $target && ! -L $target && $(stat -c \'%u:%g:%a\' "$target") == "0:0:755" ]]',
      '[[ -f $target && ! -L $target && $(stat -c \'%a\' "$target") == "755" ]]',
    )
    .replace(
      '[[ -d $RECOVERY_ROOT && ! -L $RECOVERY_ROOT \\\n  && $(stat -c \'%u:%g:%a\' "$RECOVERY_ROOT") == "0:0:700" ]]',
      "[[ -d $RECOVERY_ROOT && ! -L $RECOVERY_ROOT ]]",
    );
  const updaterFile = path.join(templates, "update-release-controllers.sh");
  await writeFile(updaterFile, updater, { mode: 0o755 });
  await writeFile(
    path.join(bin, "install"),
    `#!/usr/bin/env bash
set -e
args=("$@")
source="\${args[\${#args[@]}-2]}"
target="\${args[\${#args[@]}-1]}"
if [[ "${failForcedInstall ? "1" : "0"}" == 1 && "$target" == *frontmind-deploy-forced-command.tmp.* && ! -e "${path.join(root, "failed-once")}" ]]; then touch "${path.join(root, "failed-once")}"; exit 88; fi
if [[ "${failControllerInstall ? "1" : "0"}" == 1 && "$target" == *frontmind-deploy-controller.tmp.* && ! -e "${path.join(root, "failed-once")}" ]]; then touch "${path.join(root, "failed-once")}"; exit 88; fi
cp "$source" "$target"
chmod 0755 "$target"
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(bin, "stat"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == -c ]]; then printf '%s\\n' 755; exit 0; fi
exec /usr/bin/stat "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  const result = spawnSync("bash", [updaterFile, "--apply-version=7"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return {
    result,
    controllerTarget,
    forcedTarget,
    recoveryRoot,
    updaterFile,
    commandPath: `${bin}:${process.env.PATH}`,
  };
}

describe("production controller atomic updater", () => {
  it("installs the reviewed v7 split-runtime controller and exact 0065 boundary atomically", async () => {
    const test = await harness();
    expect(test.result.status, test.result.stderr).toBe(0);
    expect(test.result.stdout).toContain(
      "PRODUCTION_CONTROLLER_UPDATE_OK version=7",
    );
    const installedController = await readFile(test.controllerTarget, "utf8");
    expect(installedController).toContain(
      "frontmind-production-controller-version: 7",
    );
    expect(installedController).toContain("--coupled-stack");
    expect(installedController).toContain(
      "coupled-dashboard-runtime-rollback.env",
    );
    expect(installedController).toContain(
      "coupled-dashboard-runtime-rollback.retiring",
    );
    expect(installedController).toContain(
      "commit_coupled_stack_capsule_cleanup",
    );
    expect(installedController).toContain(
      "resolve_coupled_website_container_id",
    );
    expect(installedController).toContain(
      "mark_coupled_stack_external_fact_changed",
    );
    expect(installedController).toContain(
      "COUPLED_STACK_RECOVERY_MUST_FINISH_BEFORE_INCIDENT_ACKNOWLEDGEMENT",
    );
    expect(installedController).toContain(
      "/app/dist/private-workflows/socratic-kb-builder-v5.skill",
    );
    expect(installedController).toContain("/api/internal/presales/v2");
    expect(installedController).toContain("project-business-owner");
    expect(installedController).toContain(
      "siteops_alidns_oauth_contract_plan_matches",
    );
    expect(installedController).toContain("contract-0065-migration-started");
    expect(installedController).toContain(
      "dashboard_image_supports_split_runtime",
    );
    expect(installedController).toContain("dashboard_siteops_worker_matches");
    expect(installedController).toContain("start_application_runtime");
    expect(installedController).toContain("stop_application_runtime");
    expect(installedController).toContain("seed_static_template_catalog");
    expect(installedController).toContain(
      "/app/dist/seed-static-template-catalog.js",
    );
    expect(installedController).toContain(
      "STATIC_TEMPLATE_CATALOG_SEED_TIMEOUT_SECONDS=1800",
    );
    expect(installedController).toContain(
      "PRODUCTION_STATIC_TEMPLATE_CATALOG_SEED_FAILED",
    );
    expect(installedController).toContain(
      'SITEOPS_ALIDNS_OAUTH_MIGRATION_CONTROLLER="frontmind-production-controller-v6"',
    );
    expect(installedController).toContain(
      "e71230f0691ddd2a7d3d7b1a19d069775720ff999b445e86f60be902137a17db",
    );
    expect(installedController).toContain("restore_contract_0065_release");
    expect(installedController).toContain(
      "PRODUCTION_COUPLED_DASHBOARD_PRESALES_SURFACE_MISMATCH",
    );
    expect(installedController).not.toMatch(/--kb-manus-v2-rollout|canary|shadow/u);
    const installedForcedCommand = await readFile(test.forcedTarget, "utf8");
    expect(installedForcedCommand).toContain(
      '${words[0]} == "coupled-stack"',
    );
    expect(installedForcedCommand).toContain("--coupled-stack");
  });

  it("restores both old executables when the second install fails", async () => {
    const test = await harness({ failForcedInstall: true });
    expect(test.result.status, test.result.stderr).toBe(70);
    expect(test.result.stderr).toContain(
      "PRODUCTION_CONTROLLER_UPDATE_ROLLED_BACK",
    );
    expect(await readFile(test.controllerTarget, "utf8")).toBe(
      "old-controller\n",
    );
    expect(await readFile(test.forcedTarget, "utf8")).toBe("old-forced\n");
  });

  it("recovers both old executables from a persisted interrupted-update marker", async () => {
    const test = await harness();
    await mkdir(test.recoveryRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(test.recoveryRoot, "frontmind-deploy-controller.previous"),
        "recovered-controller\n",
        { mode: 0o600 },
      ),
      writeFile(
        path.join(
          test.recoveryRoot,
          "frontmind-deploy-forced-command.previous",
        ),
        "recovered-forced\n",
        { mode: 0o600 },
      ),
      writeFile(path.join(test.recoveryRoot, "pending"), "version=7\n", {
        mode: 0o600,
      }),
      writeFile(test.controllerTarget, "mixed-new-controller\n", {
        mode: 0o755,
      }),
      writeFile(test.forcedTarget, "mixed-old-forced\n", { mode: 0o755 }),
    ]);
    const result = spawnSync("bash", [test.updaterFile, "--apply-version=7"], {
      encoding: "utf8",
      env: { ...process.env, PATH: test.commandPath },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "PRODUCTION_CONTROLLER_UPDATE_RECOVERED_PREVIOUS",
    );
    expect(await readFile(test.controllerTarget, "utf8")).toContain(
      "frontmind-production-controller-version: 7",
    );
  });

  it("restores both old executables when the first replacement fails", async () => {
    const test = await harness({ failControllerInstall: true });
    expect(test.result.status, test.result.stderr).toBe(70);
    expect(await readFile(test.controllerTarget, "utf8")).toBe(
      "old-controller\n",
    );
    expect(await readFile(test.forcedTarget, "utf8")).toBe("old-forced\n");
  });

  it("rejects a SIGKILL-style leftover marker if either recovery backup is missing", async () => {
    const test = await harness();
    await mkdir(test.recoveryRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(test.recoveryRoot, "frontmind-deploy-controller.previous"),
        "recoverable-controller\n",
        { mode: 0o600 },
      ),
      writeFile(path.join(test.recoveryRoot, "pending"), "version=7\n", {
        mode: 0o600,
      }),
    ]);
    const result = spawnSync("bash", [test.updaterFile, "--apply-version=7"], {
      encoding: "utf8",
      env: { ...process.env, PATH: test.commandPath },
    });
    expect(result.status).toBe(73);
    expect(result.stderr).toContain(
      "PRODUCTION_CONTROLLER_UPDATE_RECOVERY_FAILED",
    );
  });

  it("rejects an existing controller target that is not the exact root-owned executable shape", async () => {
    const test = await harness();
    const unsafeController = path.join(test.recoveryRoot, "unsafe-controller");
    await mkdir(test.recoveryRoot, { recursive: true });
    await writeFile(unsafeController, "unsafe-controller\n", { mode: 0o755 });
    await rm(test.controllerTarget);
    await symlink(unsafeController, test.controllerTarget);
    const result = spawnSync("bash", [test.updaterFile, "--apply-version=7"], {
      encoding: "utf8",
      env: { ...process.env, PATH: test.commandPath },
    });
    expect(result.status).toBe(73);
    expect(result.stderr).toContain("PRODUCTION_CONTROLLER_TARGET_INVALID");
    expect(await readFile(unsafeController, "utf8")).toBe(
      "unsafe-controller\n",
    );
  });
});
