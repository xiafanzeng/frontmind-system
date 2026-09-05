import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

const productionController = path.resolve(
  "deploy/production/controller/frontmind-deploy-controller",
);
const bootstrapEntry = path.resolve(
  "deploy/production/controller/frontmind-bootstrap-state",
);
const productionInstaller = path.resolve("deploy/production/install.sh");
const digest = `sha256:${"a".repeat(64)}`;
const baselineDigest = `sha256:${"7".repeat(64)}`;
const image = `ghcr.io/xiafanzeng/frontmind-dashboard@${digest}`;
const websiteImage = `ghcr.io/xiafanzeng/frontmind-website@${digest}`;
const sourceSha = "b".repeat(40);
const temporaryRoots: string[] = [];
const systemSha256sum = spawnSync("sh", ["-c", "command -v sha256sum"], {
  encoding: "utf8",
}).stdout.trim();
if (!path.isAbsolute(systemSha256sum)) {
  throw new Error("sha256sum is required for deploy controller tests");
}

type PlanStatus =
  | "exact"
  | "exact-schema-diverged"
  | "pending-expand"
  | "pending-expand-changed"
  | "contract"
  | "ahead"
  | "diverged"
  | "error";

type HarnessOptions = {
  service?: "dashboard" | "website";
  planStatus?: PlanStatus;
  planSequence?: PlanStatus[];
  readySourceSha?: string;
  readyImageDigest?: string;
  activeSourceSha?: string;
  activeReadyImageDigest?: string;
  activeImageReference?: string;
  cosignExit?: number;
  migrationMode?: "success" | "timeout" | "precondition-changed";
  backupMode?: "success" | "dump-fail";
  restoreMode?:
    | "success"
    | "checksum-fail"
    | "drop-create-fail"
    | "pipeline-fail"
    | "temporary-ledger-query-fail";
  localImageDigests?: string[];
  bootstrapped?: boolean;
};

async function executable(file: string, content: string) {
  await writeFile(file, content, { mode: 0o755 });
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

const mockLedgerRows = Array.from({ length: 49 }, (_, index) => ({
  hash: "e".repeat(64),
  createdAt: 1_700_000_000_000 + index,
}));
const mockAppliedJournalHash = sha256(`${JSON.stringify(mockLedgerRows)}\n`);
const mockLedgerOutput = `${mockLedgerRows
  .map(({ hash, createdAt }) => `${hash}\t${createdAt}`)
  .join("\n")}\n`;

async function writeVerifiedRecoveryBackup(backupDir: string) {
  const backupFile = path.join(
    backupDir,
    "frontmind-dashboard-interrupted.sql.gz",
  );
  const metadataFile = `${backupFile}.meta.json`;
  const archive = gzipSync(
    "CREATE TABLE restored_probe (id INT PRIMARY KEY);\n",
  );
  const metadata = JSON.stringify({
    schemaVersion: 1,
    database: "frontmind_acceptance",
    charset: "utf8mb4",
    collation: "utf8mb4_0900_ai_ci",
    tableCount: 58,
    migrationCount: 49,
    migrationJournalHash: mockAppliedJournalHash,
  });
  await Promise.all([
    writeFile(backupFile, archive),
    writeFile(metadataFile, metadata),
  ]);
  await writeFile(
    `${backupFile}.sha256`,
    `${sha256(archive)}  ${backupFile}\n${sha256(metadata)}  ${metadataFile}\n`,
  );
  return backupFile;
}

async function harness(options: HarnessOptions = {}) {
  const {
    service = "dashboard",
    planStatus = "exact",
    planSequence = [planStatus],
    readySourceSha = sourceSha,
    readyImageDigest = digest,
    activeSourceSha = sourceSha,
    activeReadyImageDigest = baselineDigest,
    activeImageReference = `frontmind-${service}:temp-${sourceSha.slice(0, 7)}`,
    cosignExit = 0,
    migrationMode = "success",
    backupMode = "success",
    restoreMode = "success",
    localImageDigests = [],
    bootstrapped = true,
  } = options;
  const repository = `ghcr.io/xiafanzeng/frontmind-${service}`;
  const candidateImage = `${repository}@${digest}`;
  const imageEnvKey =
    service === "dashboard"
      ? "FRONTMIND_DASHBOARD_IMAGE"
      : "FRONTMIND_WEBSITE_IMAGE";
  const root = await mkdtemp(path.join(tmpdir(), "frontmind-controller-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const configRoot = path.join(root, "config/services");
  const composeDir = path.join(root, "compose");
  const stateDir = path.join(root, "state");
  const registryAuthRoot = path.join(root, "registry-auth");
  const backupDir = path.join(root, "backups");
  const log = path.join(root, "commands.log");
  const planCounter = path.join(root, "plan-counter");
  const rolloutCounter = path.join(root, "rollout-counter");
  const backupCnf = path.join(root, "backup.cnf");
  const restoreCnf = path.join(root, "restore.cnf");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
    mkdir(composeDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(registryAuthRoot, { recursive: true }),
    mkdir(backupDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(backupCnf, "[client]\nuser=backup\n", { mode: 0o600 }),
    writeFile(restoreCnf, "[client]\nuser=restore\n", { mode: 0o600 }),
  ]);
  await writeFile(path.join(composeDir, "compose.yaml"), "services: {}\n");
  await writeFile(
    path.join(root, "compose.env"),
    service === "dashboard"
      ? "FRONTMIND_DASHBOARD_HOST_PORT=3001\n"
      : "FRONTMIND_WEBSITE_HOST_PORT=8888\n",
  );
  await writeFile(
    path.join(configRoot, `${service}.env`),
    [
      `IMAGE_REPOSITORY=${repository}`,
      service === "dashboard"
        ? "COSIGN_IDENTITY=https://github.com/xiafanzeng/frontmind-dashboard/.github/workflows/dashboard-ci.yml@refs/heads/main"
        : "COSIGN_IDENTITY=https://github.com/xiafanzeng/frontmind-website/.github/workflows/ci-release.yml@refs/heads/main",
      "COSIGN_ISSUER=https://token.actions.githubusercontent.com",
      `COMPOSE_DIR=${composeDir}`,
      `COMPOSE_FILE=${path.join(composeDir, "compose.yaml")}`,
      `COMPOSE_ENV_FILE=${path.join(root, "compose.env")}`,
      `IMAGE_ENV_FILE=${path.join(composeDir, ".env")}`,
      `COMPOSE_SERVICE=${service}`,
      `IMAGE_ENV_KEY=${imageEnvKey}`,
      service === "dashboard"
        ? "LOCAL_READY_URL=http://127.0.0.1:3001/readyz"
        : "LOCAL_READY_URL=http://127.0.0.1:8888/readyz",
      `PUBLIC_READY_URL=https://${service}.invalid/readyz`,
      `READY_SHA_SHAPE=${service}`,
      `STATE_DIR=${stateDir}`,
      `BACKUP_DIR=${backupDir}`,
      "BACKUP_DATABASE=frontmind_acceptance",
      `BACKUP_MYSQL_CNF=${backupCnf}`,
      `RESTORE_MYSQL_CNF=${restoreCnf}`,
    ].join("\n"),
  );

  let controller = await readFile(productionController, "utf8");
  controller = controller
    .replace(
      'readonly CONFIG_ROOT="/etc/frontmind-deploy/services"',
      `readonly CONFIG_ROOT="${configRoot}"`,
    )
    .replace(
      'readonly REGISTRY_AUTH_RUNTIME_ROOT="/run"',
      `readonly REGISTRY_AUTH_RUNTIME_ROOT="${registryAuthRoot}"`,
    )
    .replace(
      '[[ $EUID -eq 0 ]] || die "DEPLOY_CONTROLLER_REQUIRES_ROOT"',
      ": # root check replaced only in disposable test copy",
    )
    .replace(
      /config_is_root_only\(\) \{[\s\S]*?\n\}/u,
      "config_is_root_only() { return 0;\n}",
    )
    .replace(
      'lock_file="/run/lock/frontmind-deploy-${service}.lock"',
      `lock_file="${path.join(root, "deploy.lock")}"`,
    )
    .replace(
      "readonly DEPLOY_TIMEOUT_SECONDS=120",
      "readonly DEPLOY_TIMEOUT_SECONDS=5",
    )
    .replace(
      "readonly CANDIDATE_READY_BUDGET_SECONDS=90",
      "readonly CANDIDATE_READY_BUDGET_SECONDS=2",
    );
  const controllerFile = path.join(root, "controller");
  await executable(controllerFile, controller);

  await executable(
    path.join(bin, "cosign"),
    `#!/usr/bin/env bash
echo "cosign $*" >>"$TEST_LOG"
echo "cosign-config \${DOCKER_CONFIG:-unset}" >>"$TEST_LOG"
exit "\${TEST_COSIGN_EXIT:-0}"
`,
  );
  await executable(
    path.join(bin, "flock"),
    '#!/usr/bin/env bash\necho "flock $*" >>"$TEST_LOG"\n',
  );
  await executable(
    path.join(bin, "timeout"),
    `#!/usr/bin/env bash
set -e
echo "timeout $*" >>"$TEST_LOG"
if [[ " $* " == *" release-db-migrate migrate "* && "\${TEST_MIGRATION_MODE:-success}" == timeout ]]; then
  exit 124
fi
while [[ \${1:-} == --* ]]; do shift; done
shift
exec "$@"
`,
  );
  await executable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
rollout_count=0
[[ ! -f "$TEST_ROLLOUT_COUNTER" ]] || read -r rollout_count <"$TEST_ROLLOUT_COUNTER"
ready_source="$TEST_READY_SOURCE_SHA"
ready_digest="$TEST_READY_IMAGE_DIGEST"
if [[ "$TEST_FORCED_INITIAL_TAKEOVER" == 1 && ( $rollout_count -eq 0 || $rollout_count -ge 2 ) ]]; then
  ready_source="$TEST_ACTIVE_SOURCE_SHA"
  ready_digest="$TEST_ACTIVE_READY_IMAGE_DIGEST"
fi
if [[ "$TEST_SERVICE" == dashboard ]]; then
  printf '{"status":"ok","build":{"sha":"%s","imageDigest":"%s"},"migration":{"journalHash":"%s"}}\\n' \
    "$ready_source" "$ready_digest" "${"c".repeat(64)}"
else
  printf '{"status":"ok","buildSha":"%s","imageDigest":"%s","dependencies":{"status":"ok"}}\\n' \
    "$ready_source" "$ready_digest"
fi
`,
  );
  await executable(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -e
echo "docker $*" >>"$TEST_LOG"
args=" $* "
if [[ "\${1:-}" == login ]]; then
  password="$(cat)"
  [[ -n "$password" && -n "\${DOCKER_CONFIG:-}" ]]
  printf '%s\n' "registry-config $DOCKER_CONFIG" >>"$TEST_LOG"
  printf '%s\n' '{"auths":{"ghcr.io":{"auth":"redacted-test-value"}}}' >"$DOCKER_CONFIG/config.json"
  exit 0
fi
if [[ "$args" == *" image inspect "*"org.opencontainers.image.revision"* ]]; then echo "$TEST_SOURCE_SHA"; exit 0; fi
if [[ "$args" == *" inspect "*"org.opencontainers.image.revision"* ]]; then echo "$TEST_ACTIVE_SOURCE_SHA"; exit 0; fi
if [[ "$args" == *" image inspect "*"{{.Id}}"* ]]; then echo "sha256:${"9".repeat(64)}"; exit 0; fi
if [[ "$args" == *" inspect "*"{{.State.Running}}"* ]]; then echo "true"; exit 0; fi
if [[ "$args" == *" inspect "*"{{.Config.Image}}"* ]]; then echo "$TEST_ACTIVE_IMAGE_REFERENCE"; exit 0; fi
if [[ "$args" == *" inspect "*"{{.Image}}"* ]]; then echo "sha256:${"9".repeat(64)}"; exit 0; fi
if [[ "$args" == *" ps -q $TEST_SERVICE "* ]]; then echo "frontmind-running-$TEST_SERVICE"; exit 0; fi
if [[ "$args" == *" image ls "* ]]; then
  IFS=',' read -r -a local_digests <<<"$TEST_LOCAL_IMAGE_DIGESTS"
  for local_digest in "\${local_digests[@]}"; do
    [[ -n "$local_digest" ]] && printf '%s@%s\\n' "$TEST_REPOSITORY" "$local_digest"
  done
  exit 0
fi
if [[ "$args" == *" up -d "* ]]; then
  rollout_count=0
  [[ ! -f "$TEST_ROLLOUT_COUNTER" ]] || read -r rollout_count <"$TEST_ROLLOUT_COUNTER"
  printf '%s\\n' "$((rollout_count + 1))" >"$TEST_ROLLOUT_COUNTER"
fi
if [[ "$args" == *" release-db-plan plan --json "* ]]; then
  printf '%s\n' "plan-config \${DOCKER_CONFIG:-unset}" >>"$TEST_LOG"
  count=0
  [[ ! -f "$TEST_PLAN_COUNTER" ]] || read -r count <"$TEST_PLAN_COUNTER"
  count=$((count + 1))
  printf '%s\\n' "$count" >"$TEST_PLAN_COUNTER"
  IFS=',' read -r -a statuses <<<"$TEST_PLAN_SEQUENCE"
  index=$((count - 1))
  (( index < \${#statuses[@]} )) || index=$((\${#statuses[@]} - 1))
  status="\${statuses[$index]}"
  case "$status" in
    error)
      echo "simulated readonly plan failure" >&2
      exit 19
      ;;
    exact)
      printf '{"status":"exact","journalHash":"%s","applied":{"count":49,"journalHash":"%s"},"pending":[],"allPendingExpand":false,"schema":{"status":"exact"}}\\n' "${"c".repeat(64)}" "${mockAppliedJournalHash}"
      ;;
    exact-schema-diverged)
      printf '{"status":"exact","journalHash":"%s","applied":{"count":49,"journalHash":"%s"},"pending":[],"allPendingExpand":false,"schema":{"status":"diverged"}}\\n' "${"c".repeat(64)}" "${mockAppliedJournalHash}"
      ;;
    pending-expand)
      printf '{"status":"pending","journalHash":"%s","applied":{"count":49,"journalHash":"%s"},"pending":[{"idx":49,"tag":"0049_expand","classification":"expand"}],"allPendingExpand":true,"schema":{"status":"not_checked"}}\\n' "${"d".repeat(64)}" "${mockAppliedJournalHash}"
      ;;
    pending-expand-changed)
      printf '{"status":"pending","journalHash":"%s","applied":{"count":49,"journalHash":"%s"},"pending":[{"idx":49,"tag":"0049_expand","classification":"expand"}],"allPendingExpand":true,"schema":{"status":"not_checked"}}\\n' "${"d".repeat(64)}" "${"f".repeat(64)}"
      ;;
    contract)
      printf '{"status":"pending","journalHash":"%s","applied":{"count":49,"journalHash":"%s"},"pending":[{"idx":49,"tag":"0049_contract","classification":"contract"}],"allPendingExpand":false,"schema":{"status":"not_checked"}}\\n' "${"d".repeat(64)}" "${mockAppliedJournalHash}"
      ;;
    ahead)
      printf '{"status":"ahead","journalHash":"%s","applied":{"count":50,"journalHash":"%s"},"pending":[],"allPendingExpand":false}\\n' "${"d".repeat(64)}" "${mockAppliedJournalHash}"
      ;;
    diverged)
      printf '{"status":"diverged","journalHash":"%s","applied":{"count":49,"journalHash":"%s"},"pending":[],"allPendingExpand":false,"mismatchIndex":12}\\n' "${"d".repeat(64)}" "${mockAppliedJournalHash}"
      ;;
  esac
  exit 0
fi
if [[ "$args" == *" release-db-migrate migrate "* && "\${TEST_MIGRATION_MODE:-success}" == precondition-changed ]]; then
  printf '{"schemaVersion":1,"command":"migrate","status":"error","error":{"code":"MIGRATION_APPLIED_FACT_CHANGED"}}\\n'
  exit 78
fi
if [[ "$args" == *" release-db-plan postflight --json "* || "$args" == *" release-db-migrate migrate "* ]]; then
  printf '{"status":"exact","journalHash":"%s","applied":{"count":50,"journalHash":"%s"},"pending":[],"allPendingExpand":false,"schema":{"status":"exact"}}\\n' "${"c".repeat(64)}" "${"1".repeat(64)}"
  exit 0
fi
`,
  );
  await executable(
    path.join(bin, "mysqldump"),
    `#!/usr/bin/env bash
echo "mysqldump $*" >>"$TEST_LOG"
if [[ "\${TEST_BACKUP_MODE:-success}" == dump-fail ]]; then
  exit 43
fi
printf '%s\\n' 'CREATE TABLE restored_probe (id INT PRIMARY KEY);'
`,
  );
  await executable(
    path.join(bin, "sha256sum"),
    `#!/usr/bin/env bash
echo "sha256sum $*" >>"$TEST_LOG"
if [[ "\${TEST_RESTORE_MODE:-success}" == checksum-fail && "\${1:-}" == --check ]]; then
  exit 44
fi
exec ${JSON.stringify(systemSha256sum)} "$@"
`,
  );
  await executable(
    path.join(bin, "mysql"),
    `#!/usr/bin/env bash
set -e
echo "mysql $*" >>"$TEST_LOG"
args=" $* "
if [[ "\${TEST_RESTORE_MODE:-success}" == drop-create-fail && "$args" == *"DROP DATABASE IF EXISTS"* && "$args" == *"frontmind_acceptance"* && "$args" == *"CREATE DATABASE"* ]]; then
  exit 45
fi
if [[ "\${TEST_RESTORE_MODE:-success}" == pipeline-fail && "$args" == *"--database=frontmind_acceptance"* && "$args" != *"--execute="* ]]; then
  cat >/dev/null || true
  exit 46
fi
if [[ "\${TEST_RESTORE_MODE:-success}" == temporary-ledger-query-fail && "$args" == *"--database=frontmind_restore_"* && "$args" == *"SELECT hash, created_at FROM __drizzle_migrations"* ]]; then
  exit 47
fi
if [[ "$args" == *"default_character_set_name"* ]]; then
  printf '%s\\n' 'utf8mb4 utf8mb4_0900_ai_ci'
elif [[ "$args" == *"information_schema.tables"* ]]; then
  printf '%s\\n' '58'
elif [[ "$args" == *"SELECT hash, created_at FROM __drizzle_migrations"* ]]; then
  printf '%b' ${JSON.stringify(mockLedgerOutput)}
elif [[ "$args" == *"SELECT COUNT(*) FROM __drizzle_migrations"* ]]; then
  printf '%s\\n' '49'
else
  cat >/dev/null || true
fi
`,
  );

  if (bootstrapped) {
    await writeFile(
      path.join(stateDir, "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        currentDigest: baselineDigest,
        previousDigest: "",
        sourceSha,
        journalHash: "c".repeat(64),
        deployedAt: "2026-08-01T00:00:00Z",
        lastResult: { status: "success", message: "bootstrap-current" },
      }),
    );
  }

  const registryToken = `ghs_${"t".repeat(40)}`;
  const registryEnvelope = `xiafanzeng\n${registryToken}\n`;
  const runWithArgs = (
    args: string[],
    { forced = false, input }: { forced?: boolean; input?: string } = {},
  ) =>
    spawnSync("bash", [controllerFile, ...args], {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        SUDO_USER: forced ? "frontmind-deploy" : "",
        PATH: `${bin}:${process.env.PATH}`,
        TEST_LOG: log,
        TEST_SERVICE: service,
        TEST_REPOSITORY: repository,
        TEST_PLAN_SEQUENCE: planSequence.join(","),
        TEST_PLAN_COUNTER: planCounter,
        TEST_ROLLOUT_COUNTER: rolloutCounter,
        TEST_FORCED_INITIAL_TAKEOVER: forced && !bootstrapped ? "1" : "0",
        TEST_READY_SOURCE_SHA: readySourceSha,
        TEST_READY_IMAGE_DIGEST: readyImageDigest,
        TEST_ACTIVE_SOURCE_SHA: activeSourceSha,
        TEST_ACTIVE_READY_IMAGE_DIGEST: activeReadyImageDigest,
        TEST_ACTIVE_IMAGE_REFERENCE: activeImageReference,
        TEST_SOURCE_SHA: sourceSha,
        TEST_COSIGN_EXIT: String(cosignExit),
        TEST_MIGRATION_MODE: migrationMode,
        TEST_BACKUP_MODE: backupMode,
        TEST_RESTORE_MODE: restoreMode,
        TEST_LOCAL_IMAGE_DIGESTS: localImageDigests.join(","),
      },
    });
  const run = (candidate = candidateImage) =>
    runWithArgs([service, candidate, sourceSha]);
  const runForced = (candidate = candidateImage, input = registryEnvelope) =>
    runWithArgs([service, candidate, sourceSha], { forced: true, input });
  const bootstrap = (candidate = candidateImage) =>
    runWithArgs(["--bootstrap-state", service, candidate, sourceSha]);
  const acknowledge = (candidate = candidateImage) =>
    runWithArgs(["--acknowledge-incident", service, candidate, sourceSha]);
  return {
    root,
    backupDir,
    registryAuthRoot,
    log,
    state: path.join(stateDir, "state.json"),
    registryToken,
    image: candidateImage,
    run,
    runForced,
    bootstrap,
    acknowledge,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("deploy controller shell contract", () => {
  it("uses the forced deploy stdin token only in a temporary registry config", async () => {
    const test = await harness();
    const result = test.runForced();
    expect(result.status, result.stderr).toBe(0);

    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain(
      "docker login ghcr.io --username xiafanzeng --password-stdin",
    );
    expect(commands).toContain("cosign verify");
    expect(commands).toContain(`docker pull ${image}`);
    expect(commands).toContain("plan-config unset");
    expect(commands).not.toContain(test.registryToken);

    const registryConfig = commands.match(/^registry-config ([^\n]+)$/mu)?.[1];
    const cosignConfig = commands.match(/^cosign-config ([^\n]+)$/mu)?.[1];
    expect(registryConfig).toBeTruthy();
    expect(registryConfig).toMatch(
      new RegExp(`^${test.registryAuthRoot}/frontmind-ghcr-dashboard\\.`),
    );
    expect(cosignConfig).toBe(registryConfig);
    expect(spawnSync("test", ["!", "-e", registryConfig!]).status).toBe(0);
  });

  it.each([
    ["missing", ""],
    ["missing token", "xiafanzeng\n"],
    ["invalid username", `bad actor\nghs_${"t".repeat(40)}\n`],
    ["short token", "xiafanzeng\nshort\n"],
    ["extra line", `xiafanzeng\nghs_${"t".repeat(40)}\nextra\n`],
  ])(
    "rejects %s forced deploy registry auth before verification",
    async (_label, input) => {
      const test = await harness();
      const result = test.runForced(image, input);
      expect(result.status).toBe(77);
      const commands = await readFile(test.log, "utf8");
      expect(commands).not.toContain("cosign verify");
      expect(commands).not.toContain(`docker pull ${image}`);
    },
  );

  it("establishes the first Dashboard state from a signed same-source image without database writes", async () => {
    const test = await harness({ bootstrapped: false });
    const result = test.runForced();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("INITIAL_SIGNED_TAKEOVER_SUCCESS");

    expect(JSON.parse(await readFile(test.state, "utf8"))).toMatchObject({
      currentDigest: digest,
      previousDigest: "",
      sourceSha,
      journalHash: "c".repeat(64),
      lastResult: {
        status: "success",
        message: "initial-signed-takeover",
      },
    });
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain(
      "cosign verify --certificate-identity https://github.com/xiafanzeng/frontmind-dashboard/.github/workflows/dashboard-ci.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com",
    );
    expect(commands).toContain(`docker pull ${image}`);
    expect(commands).toContain("inspect --format {{.State.Running}}");
    expect(commands).toContain("release-db-plan plan --json");
    expect(commands).toContain("plan-config unset");
    expect((commands.match(/^docker .* up -d /gmu) || []).length).toBe(1);
    expect(commands).not.toContain("release-db-migrate migrate");
    expect(commands).not.toContain("mysqldump");
    expect(commands).not.toContain("DROP DATABASE");
  });

  it("establishes the first Website state without invoking any database service", async () => {
    const test = await harness({ service: "website", bootstrapped: false });
    const result = test.runForced();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("INITIAL_SIGNED_TAKEOVER_SUCCESS");
    expect(JSON.parse(await readFile(test.state, "utf8"))).toMatchObject({
      currentDigest: digest,
      previousDigest: "",
      sourceSha,
      journalHash: "not-applicable",
      lastResult: { message: "initial-signed-takeover" },
    });
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain(`docker pull ${websiteImage}`);
    expect(commands).not.toContain("release-db-");
    expect(commands).not.toContain("mysql");
    expect(commands).not.toContain("mysqldump");
  });

  it("takes over an internally consistent older source SHA without database writes", async () => {
    const olderSourceSha = "e".repeat(40);
    const test = await harness({
      bootstrapped: false,
      activeSourceSha: olderSourceSha,
    });
    const result = test.runForced();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("INITIAL_SIGNED_TAKEOVER_SUCCESS");
    expect(olderSourceSha).not.toBe(sourceSha);
    expect(JSON.parse(await readFile(test.state, "utf8"))).toMatchObject({
      currentDigest: digest,
      previousDigest: "",
      sourceSha,
      lastResult: { message: "initial-signed-takeover" },
    });
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("cosign verify");
    expect(commands).toContain("release-db-plan plan --json");
    expect((commands.match(/^docker .* up -d /gmu) || []).length).toBe(1);
    expect(commands).not.toContain("release-db-migrate migrate");
    expect(commands).not.toContain("mysqldump");
    expect(commands).not.toContain("DROP DATABASE");
  });

  it("rejects a malformed active source label before database or service changes", async () => {
    const test = await harness({
      bootstrapped: false,
      activeSourceSha: "not-a-source-sha",
    });
    const result = test.runForced();
    expect(result.status).toBe(73);
    expect(result.stderr).toContain(
      "INITIAL_TAKEOVER_ACTIVE_SOURCE_SHA_INVALID",
    );
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("cosign verify");
    expect(commands).not.toContain("release-db-");
    expect(commands).not.toContain(" up -d ");
    await expect(readFile(test.state, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks pending migrations during initial takeover before backup or mutation", async () => {
    const test = await harness({
      bootstrapped: false,
      planStatus: "pending-expand",
    });
    const result = test.runForced();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(
      "INITIAL_TAKEOVER_DATABASE_NOT_EXACT:pending",
    );
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("release-db-plan plan --json");
    expect(commands).not.toContain("release-db-migrate migrate");
    expect(commands).not.toContain("mysqldump");
    expect(commands).not.toContain(" up -d ");
    await expect(readFile(test.state, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks an exact ledger with schema drift during initial takeover", async () => {
    const test = await harness({
      bootstrapped: false,
      planStatus: "exact-schema-diverged",
    });
    const result = test.runForced();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(
      "INITIAL_TAKEOVER_DATABASE_SCHEMA_NOT_EXACT:diverged",
    );
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("release-db-plan plan --json");
    expect(commands).not.toContain("release-db-migrate migrate");
    expect(commands).not.toContain("mysqldump");
    expect(commands).not.toContain(" up -d ");
  });

  it("restores the captured pre-controller runtime when the first signed candidate is unready", async () => {
    const test = await harness({
      bootstrapped: false,
      readyImageDigest: `sha256:${"6".repeat(64)}`,
    });
    const result = test.runForced();
    expect(result.status).toBe(75);
    expect(result.stderr).toContain(
      "INITIAL_SIGNED_TAKEOVER_FAILED_PREVIOUS_RUNTIME_RESTORED",
    );
    const commands = await readFile(test.log, "utf8");
    expect((commands.match(/^docker .* up -d /gmu) || []).length).toBe(2);
    expect(commands).toContain(" stop dashboard");
    expect(commands).not.toContain("mysqldump");
    expect(commands).not.toContain("release-db-migrate migrate");
    await expect(readFile(test.state, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("deploys exact without backup and treats the same digest as an idempotent no-op", async () => {
    const test = await harness();
    const first = test.run();
    expect(first.status, first.stderr).toBe(0);
    const state = JSON.parse(await readFile(test.state, "utf8"));
    expect(state).toMatchObject({
      currentDigest: digest,
      previousDigest: baselineDigest,
      sourceSha,
    });
    const firstLog = await readFile(test.log, "utf8");
    expect(firstLog).not.toContain("mysqldump");
    expect((firstLog.match(/^docker .* up -d /gmu) || []).length).toBe(1);

    const second = test.run();
    expect(second.status, second.stderr).toBe(0);
    const secondState = JSON.parse(await readFile(test.state, "utf8"));
    expect(secondState.previousDigest).toBe(baselineDigest);
    const secondLog = await readFile(test.log, "utf8");
    expect((secondLog.match(/^docker .* up -d /gmu) || []).length).toBe(1);
    expect(second.stderr).toContain("DEPLOY_ALREADY_CURRENT");
  });

  it("bootstraps only the signed, active and ready current digest without database commands", async () => {
    const extraDigest = `sha256:${"8".repeat(64)}`;
    const test = await harness({
      bootstrapped: false,
      localImageDigests: [digest, extraDigest],
    });
    const unbootstrappedDeploy = test.run();
    expect(unbootstrappedDeploy.status).toBe(73);
    expect(unbootstrappedDeploy.stderr).toContain(
      "DEPLOY_STATE_NOT_BOOTSTRAPPED",
    );
    expect(await readFile(test.log, "utf8")).not.toContain("cosign verify");

    const first = test.bootstrap();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain("BOOTSTRAP_STATE_SUCCESS");
    const state = JSON.parse(await readFile(test.state, "utf8"));
    expect(state).toMatchObject({
      currentDigest: digest,
      previousDigest: "",
      sourceSha,
      journalHash: "c".repeat(64),
      lastResult: { status: "success", message: "bootstrap-current" },
    });
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("cosign verify");
    expect(commands).toContain(" ps -q dashboard");
    expect(commands).toContain(
      `image rm ghcr.io/xiafanzeng/frontmind-dashboard@${extraDigest}`,
    );
    expect(commands).not.toContain("release-db-");
    expect(commands).not.toContain("mysqldump");
    expect(commands).not.toContain(" up -d ");

    const second = test.bootstrap();
    expect(second.status).toBe(73);
    expect(second.stderr).toContain("BOOTSTRAP_STATE_ALREADY_EXISTS");
  });

  it("preserves an in-progress release when plan is unavailable, then restores pending without rerunning", async () => {
    const currentDigest = `sha256:${"e".repeat(64)}`;
    const previousDigest = `sha256:${"0".repeat(64)}`;
    const releaseId = `${sourceSha}-interrupted`;
    const test = await harness({
      planSequence: ["error", "pending-expand"],
      readySourceSha: sourceSha,
      readyImageDigest: currentDigest,
      localImageDigests: [digest, currentDigest, previousDigest],
    });
    const backupFile = await writeVerifiedRecoveryBackup(test.backupDir);
    const interruptedState = {
      schemaVersion: 1,
      currentDigest,
      previousDigest,
      sourceSha,
      journalHash: "c".repeat(64),
      deployedAt: "2026-08-02T00:00:00Z",
      lastResult: {
        status: "in_progress",
        message: "migration-started",
        attemptedDigest: digest,
        releaseId,
        backupFile,
        completedAt: "2026-08-02T00:01:00Z",
      },
    };
    await writeFile(test.state, JSON.stringify(interruptedState));

    const unavailable = test.run();
    expect(unavailable.status).toBe(75);
    expect(unavailable.stderr).toContain(
      "UNFINISHED_RELEASE_PLAN_UNAVAILABLE_STATE_PRESERVED",
    );
    expect(JSON.parse(await readFile(test.state, "utf8"))).toEqual(
      interruptedState,
    );
    let commands = await readFile(test.log, "utf8");
    expect(commands).not.toContain("release-db-migrate migrate");
    expect(commands).not.toContain(" up -d ");
    expect(commands).not.toContain(" image rm ");

    const pending = test.run();
    expect(pending.status, pending.stderr).toBe(75);
    expect(pending.stderr).toContain("UNFINISHED_RELEASE_RESTORED_NOT_RERUN");
    commands = await readFile(test.log, "utf8");
    expect((commands.match(/release-db-migrate migrate/gu) || []).length).toBe(
      0,
    );
    expect(
      (commands.match(/^docker .*release-db-plan plan --json/gmu) || []).length,
    ).toBe(2);
    expect(commands).toContain("DROP DATABASE IF EXISTS");
    expect(commands).not.toContain(
      `image rm ghcr.io/xiafanzeng/frontmind-dashboard@${digest}`,
    );
    const recovered = JSON.parse(await readFile(test.state, "utf8"));
    expect(recovered.currentDigest).toBe(currentDigest);
    expect(recovered.previousDigest).toBe(previousDigest);
    expect(recovered.lastResult.status).toBe("quarantined");
    expect(recovered.lastResult.message).toBe(
      "unfinished-migration-restored-from-backup",
    );
    expect(recovered.lastResult).toMatchObject({ releaseId, backupFile });

    const commandsBeforeQuarantineChecks = commands;
    const sameDigest = test.run();
    expect(sameDigest.status).toBe(75);
    expect(sameDigest.stderr).toContain(
      "DEPLOY_INCIDENT_QUARANTINED_REQUIRES_ROOT_ACKNOWLEDGEMENT",
    );
    const newDigest = `sha256:${"4".repeat(64)}`;
    const newerCandidate = test.run(
      `ghcr.io/xiafanzeng/frontmind-dashboard@${newDigest}`,
    );
    expect(newerCandidate.status).toBe(75);
    expect(newerCandidate.stderr).toContain(
      "DEPLOY_INCIDENT_QUARANTINED_REQUIRES_ROOT_ACKNOWLEDGEMENT",
    );
    const commandsAfterBlockedRetries = await readFile(test.log, "utf8");
    const blockedRetryCommands = commandsAfterBlockedRetries.slice(
      commandsBeforeQuarantineChecks.length,
    );
    expect(blockedRetryCommands).not.toContain("cosign");
    expect(blockedRetryCommands).not.toContain("docker pull");
    expect(blockedRetryCommands).not.toContain("release-db-");
    expect(blockedRetryCommands).not.toContain(" up -d ");
    expect(blockedRetryCommands).not.toContain("mysql");

    const commandsBeforeAcknowledgement = commandsAfterBlockedRetries;
    const acknowledged = test.acknowledge();
    expect(acknowledged.status, acknowledged.stderr).toBe(0);
    expect(acknowledged.stderr).toContain("DEPLOY_INCIDENT_ACKNOWLEDGED");
    const acknowledgementCommands = (await readFile(test.log, "utf8")).slice(
      commandsBeforeAcknowledgement.length,
    );
    expect(acknowledgementCommands).not.toContain("cosign");
    expect(acknowledgementCommands).not.toContain("docker pull");
    expect(acknowledgementCommands).not.toContain("release-db-");
    expect(acknowledgementCommands).not.toContain(" up -d ");
    expect(acknowledgementCommands).not.toContain("mysql");
    expect(
      JSON.parse(await readFile(test.state, "utf8")).lastResult,
    ).toMatchObject({
      status: "incident_acknowledged",
      message: "root-authorized-new-attempt",
      releaseId,
      backupFile,
    });
  });

  it("restores an interrupted exact-ledger schema divergence instead of treating it as a new migration", async () => {
    const currentDigest = `sha256:${"e".repeat(64)}`;
    const test = await harness({
      planStatus: "exact-schema-diverged",
      readySourceSha: sourceSha,
      readyImageDigest: currentDigest,
    });
    const backupFile = await writeVerifiedRecoveryBackup(test.backupDir);
    await writeFile(
      test.state,
      JSON.stringify({
        schemaVersion: 1,
        currentDigest,
        previousDigest: "",
        sourceSha,
        journalHash: "c".repeat(64),
        deployedAt: "2026-08-02T00:00:00Z",
        lastResult: {
          status: "in_progress",
          attemptedDigest: digest,
          releaseId: `${sourceSha}-schema-diverged`,
          backupFile,
        },
      }),
    );
    const result = test.run();
    expect(result.status, result.stderr).toBe(75);
    expect(result.stderr).toContain("UNFINISHED_RELEASE_RESTORED_NOT_RERUN");
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("release-db-plan plan --json");
    expect(commands).toContain("DROP DATABASE IF EXISTS");
    expect(commands).not.toContain("release-db-migrate migrate");
  });

  it("rejects wrong repositories, mutable tags and automatic contract migration", async () => {
    const exact = await harness();
    expect(exact.run(`ghcr.io/xiafanzeng/other@${digest}`).stderr).toContain(
      "DEPLOY_REPOSITORY_REJECTED",
    );
    expect(
      exact.run("ghcr.io/xiafanzeng/frontmind-dashboard:latest").stderr,
    ).toContain("DEPLOY_REPOSITORY_REJECTED");

    const contract = await harness({ planStatus: "contract" });
    const result = contract.run();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(
      "CONTRACT_MIGRATION_REQUIRES_MAINTENANCE_WINDOW",
    );
    const commands = await readFile(contract.log, "utf8");
    expect(commands).not.toContain("mysqldump");
    expect(commands).not.toContain(" up -d ");
  });

  it("quarantines a prefix change after the verified backup without migrating, restoring, or resuming writes", async () => {
    const test = await harness({
      planSequence: ["pending-expand", "pending-expand-changed"],
    });
    const result = test.run();
    expect(result.status, result.stderr).toBe(75);
    expect(result.stderr).toContain(
      "DATABASE_PREFIX_CHANGED_INCIDENT_QUARANTINED",
    );
    const commands = await readFile(test.log, "utf8");
    expect(
      (commands.match(/^docker .*release-db-plan plan --json/gmu) || []).length,
    ).toBe(2);
    expect(commands).toContain("mysqldump");
    expect(commands).not.toContain("release-db-migrate migrate");
    expect(commands).not.toContain(
      "DROP DATABASE IF EXISTS `frontmind_acceptance`; CREATE DATABASE",
    );
    expect(commands).not.toContain(" up -d ");
    expect(
      JSON.parse(await readFile(test.state, "utf8")).lastResult,
    ).toMatchObject({
      status: "quarantined",
      message: "pre-migration-prefix-changed-dashboard-remains-stopped",
      attemptedDigest: digest,
    });
  });

  it("quarantines an advisory-lock applied-fact change before DDL without overwriting external facts", async () => {
    const test = await harness({
      planStatus: "pending-expand",
      migrationMode: "precondition-changed",
    });
    const result = test.run();
    expect(result.status, result.stderr).toBe(75);
    expect(result.stderr).toContain(
      "MIGRATION_APPLIED_FACT_CHANGED_INCIDENT_QUARANTINED",
    );
    expect(result.stderr).not.toContain("MIGRATION_RESULT_UNKNOWN_RECONCILING");
    const commands = await readFile(test.log, "utf8");
    expect(
      (commands.match(/^docker .*release-db-plan plan --json/gmu) || []).length,
    ).toBe(2);
    expect(commands).toContain(
      `--expected-applied-count 49 --expected-applied-journal-hash ${mockAppliedJournalHash}`,
    );
    expect(commands).not.toContain(
      "DROP DATABASE IF EXISTS `frontmind_acceptance`; CREATE DATABASE",
    );
    expect(commands).not.toContain(" up -d ");
    expect(
      JSON.parse(await readFile(test.state, "utf8")).lastResult,
    ).toMatchObject({
      status: "quarantined",
      message:
        "migration-applied-fact-changed-before-ddl-dashboard-remains-stopped",
      attemptedDigest: digest,
    });
  });

  it("blocks a failed signature before pulling or rebuilding the service", async () => {
    const test = await harness({ cosignExit: 23 });
    const result = test.run();
    expect(result.status).toBe(23);
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("cosign verify");
    expect(commands).not.toContain("docker pull");
    expect(commands).not.toContain(" up -d ");
  });

  it.each(["ahead", "diverged"] as const)(
    "blocks a %s journal before rebuilding the service",
    async (planStatus) => {
      const test = await harness({ planStatus });
      const result = test.run();
      const commands = await readFile(test.log, "utf8");
      expect(result.status, `${result.stderr}\n${commands}`).toBe(78);
      expect(result.stderr).toContain(
        `DATABASE_JOURNAL_${planStatus.toUpperCase()}`,
      );
      expect(commands).toContain("release-db-plan plan --json");
      expect(commands).not.toContain("mysqldump");
      expect(commands).not.toContain(" up -d ");
    },
  );

  it("blocks exact-ledger schema divergence before rebuilding and removes the candidate", async () => {
    const test = await harness({
      planStatus: "exact-schema-diverged",
      localImageDigests: [digest],
    });
    const result = test.run();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("DATABASE_SCHEMA_NOT_EXACT");
    const commands = await readFile(test.log, "utf8");
    expect(commands).not.toContain(" up -d ");
    expect(commands).not.toContain("mysqldump");
    expect(commands).toContain(
      `image rm ghcr.io/xiafanzeng/frontmind-dashboard@${digest}`,
    );
  });

  it("times out an unknown migration, reconciles read-only and never reruns it", async () => {
    const currentDigest = `sha256:${"e".repeat(64)}`;
    const test = await harness({
      planSequence: ["pending-expand", "pending-expand"],
      migrationMode: "timeout",
      readySourceSha: sourceSha,
      readyImageDigest: currentDigest,
      localImageDigests: [digest, currentDigest],
    });
    await writeFile(
      test.state,
      JSON.stringify({
        schemaVersion: 1,
        currentDigest,
        previousDigest: "",
        sourceSha,
        journalHash: "c".repeat(64),
        deployedAt: "2026-08-02T00:00:00Z",
        lastResult: { status: "success" },
      }),
    );
    const result = test.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MIGRATION_RESULT_UNKNOWN_RECONCILING");
    expect(result.stderr).toContain("DATABASE_MIGRATION_UNKNOWN_NOT_RERUN");
    const commands = await readFile(test.log, "utf8");
    expect((commands.match(/release-db-migrate migrate/gu) || []).length).toBe(
      1,
    );
    expect(
      (commands.match(/^docker .*release-db-plan plan --json/gmu) || []).length,
    ).toBe(3);
    expect(commands).toContain(
      "timeout --foreground --signal=TERM --kill-after=10s 1800s",
    );
    expect(commands).toContain("mysqldump");
    expect(commands).toContain("DROP DATABASE IF EXISTS");
    expect((commands.match(/^docker .* up -d /gmu) || []).length).toBe(1);
    expect(commands).not.toContain(
      `image rm ghcr.io/xiafanzeng/frontmind-dashboard@${digest}`,
    );
    expect(
      JSON.parse(await readFile(test.state, "utf8")).lastResult,
    ).toMatchObject({
      status: "quarantined",
      message: "migration-result-unknown-database-restored",
      attemptedDigest: digest,
    });
  });

  it("fails closed before DROP when the verified-backup checksum cannot be proven", async () => {
    const test = await harness({
      planSequence: ["pending-expand", "pending-expand"],
      migrationMode: "timeout",
      restoreMode: "checksum-fail",
    });
    const result = test.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "DATABASE_RESTORE_FAILED_AFTER_MIGRATION_ERROR",
    );
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("sha256sum --check");
    expect(commands).not.toContain(
      "DROP DATABASE IF EXISTS `frontmind_acceptance`",
    );
    expect(
      JSON.parse(await readFile(test.state, "utf8")).lastResult.status,
    ).toBe("in_progress");
  });

  it("does not feed a backup into MySQL after DROP/CREATE itself fails", async () => {
    const test = await harness({
      planSequence: ["pending-expand", "pending-expand"],
      migrationMode: "timeout",
      restoreMode: "drop-create-fail",
    });
    const result = test.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "DATABASE_RESTORE_FAILED_AFTER_MIGRATION_ERROR",
    );
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain(
      "DROP DATABASE IF EXISTS `frontmind_acceptance`; CREATE DATABASE",
    );
    const productionRestorePipelines = commands
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("mysql ") &&
          line.includes("--database=frontmind_acceptance") &&
          !line.includes("--execute="),
      );
    expect(productionRestorePipelines).toEqual([]);
    expect(
      JSON.parse(await readFile(test.state, "utf8")).lastResult.status,
    ).toBe("in_progress");
  });

  it("propagates a failed production restore pipeline and never starts an application", async () => {
    const test = await harness({
      planSequence: ["pending-expand", "pending-expand"],
      migrationMode: "timeout",
      restoreMode: "pipeline-fail",
    });
    const result = test.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "DATABASE_RESTORE_FAILED_AFTER_MIGRATION_ERROR",
    );
    const commands = await readFile(test.log, "utf8");
    const productionRestorePipelines = commands
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("mysql ") &&
          line.includes("--database=frontmind_acceptance") &&
          !line.includes("--execute="),
      );
    expect(productionRestorePipelines).toHaveLength(1);
    expect(commands).not.toContain(" up -d ");
    expect(
      JSON.parse(await readFile(test.state, "utf8")).lastResult.status,
    ).toBe("in_progress");
  });

  it("propagates a failed dump before recording or running a migration", async () => {
    const test = await harness({
      planStatus: "pending-expand",
      backupMode: "dump-fail",
      readyImageDigest: baselineDigest,
    });
    const result = test.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_BACKUP_GATE_FAILED");
    const commands = await readFile(test.log, "utf8");
    expect(commands).toContain("mysqldump");
    expect(commands).not.toContain("release-db-migrate migrate");
    expect(
      JSON.parse(await readFile(test.state, "utf8")).lastResult,
    ).toMatchObject({
      status: "failed",
      message: "database-backup-or-restore-test-failed",
    });
  });

  it("best-effort drops the temporary restore database when ledger verification fails", async () => {
    const test = await harness({
      planStatus: "pending-expand",
      restoreMode: "temporary-ledger-query-fail",
      readyImageDigest: baselineDigest,
    });
    const result = test.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_BACKUP_GATE_FAILED");
    const commands = await readFile(test.log, "utf8");
    expect(commands).toMatch(/CREATE DATABASE `frontmind_restore_[^`]+`/u);
    expect(commands).toMatch(
      /DROP DATABASE IF EXISTS `frontmind_restore_[^`]+`/u,
    );
    expect(commands).not.toContain("release-db-migrate migrate");
  });

  it("keeps migration recovery facts and the candidate when restored previous is not ready", async () => {
    const currentDigest = `sha256:${"e".repeat(64)}`;
    const test = await harness({
      planStatus: "pending-expand",
      readySourceSha: sourceSha,
      readyImageDigest: `sha256:${"6".repeat(64)}`,
      localImageDigests: [digest, currentDigest],
    });
    await writeFile(
      test.state,
      JSON.stringify({
        schemaVersion: 1,
        currentDigest,
        previousDigest: "",
        sourceSha,
        journalHash: "c".repeat(64),
        deployedAt: "2026-08-02T00:00:00Z",
        lastResult: { status: "success" },
      }),
    );

    const result = test.run();
    expect(result.status).toBe(75);
    expect(result.stderr).toContain(
      "APPLICATION_ROLLBACK_FAILED_AFTER_CANDIDATE_ERROR_STATE_PRESERVED",
    );
    const incident = JSON.parse(await readFile(test.state, "utf8"));
    expect(incident.lastResult).toMatchObject({
      status: "in_progress",
      message: "migration-started",
      attemptedDigest: digest,
    });
    expect(incident.lastResult.releaseId).toContain(sourceSha);
    expect(incident.lastResult.backupFile).toContain("frontmind-dashboard-");
    const commands = await readFile(test.log, "utf8");
    expect((commands.match(/release-db-migrate migrate/gu) || []).length).toBe(
      2,
    );
    expect(commands).toContain("DROP DATABASE IF EXISTS");
    expect(commands).not.toContain(
      `image rm ghcr.io/xiafanzeng/frontmind-dashboard@${digest}`,
    );
  });

  it("rejects a same-SHA wrong digest and restores only the recorded current digest", async () => {
    const oldDigest = `sha256:${"e".repeat(64)}`;
    const oldSource = sourceSha;
    const previousDigest = `sha256:${"0".repeat(64)}`;
    const candidateDigest = `sha256:${"1".repeat(64)}`;
    const test = await harness({
      readySourceSha: oldSource,
      readyImageDigest: oldDigest,
      localImageDigests: [candidateDigest, oldDigest, previousDigest],
    });
    await writeFile(
      test.state,
      JSON.stringify({
        schemaVersion: 1,
        currentDigest: oldDigest,
        previousDigest,
        sourceSha: oldSource,
        journalHash: "c".repeat(64),
        deployedAt: "2026-08-02T00:00:00Z",
        lastResult: { status: "success" },
      }),
    );
    const result = test.run(
      `ghcr.io/xiafanzeng/frontmind-dashboard@${candidateDigest}`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("APPLICATION_READINESS_TIMEOUT");
    const state = JSON.parse(await readFile(test.state, "utf8"));
    expect(state.currentDigest).toBe(oldDigest);
    expect(state.previousDigest).toBe(previousDigest);
    expect(state.lastResult.message).toBe(
      "candidate-unready-previous-restored",
    );
    const commands = await readFile(test.log, "utf8");
    expect((commands.match(/^docker .* up -d /gmu) || []).length).toBe(2);
    expect(commands).toContain(" stop dashboard");
    expect(commands).toContain(
      `image rm ghcr.io/xiafanzeng/frontmind-dashboard@${candidateDigest}`,
    );
    expect(commands).not.toContain(
      `image rm ghcr.io/xiafanzeng/frontmind-dashboard@${oldDigest}`,
    );
  });

  it("contains fail-closed unknown-result and shared-deadline rollback ordering", async () => {
    const source = await readFile(productionController, "utf8");
    const bootstrap = await readFile(bootstrapEntry, "utf8");
    const installer = await readFile(productionInstaller, "utf8");
    const unknown = source.indexOf("MIGRATION_RESULT_UNKNOWN_RECONCILING");
    const readonlyPlan = source.indexOf(
      'run_release_db_json "$candidate_env" plan --json',
      unknown,
    );
    const noRerun = source.indexOf(
      "DATABASE_MIGRATION_UNKNOWN_NOT_RERUN",
      readonlyPlan,
    );
    expect(unknown).toBeGreaterThan(0);
    expect(readonlyPlan).toBeGreaterThan(unknown);
    expect(noRerun).toBeGreaterThan(readonlyPlan);
    expect(source).toContain(
      'restore_previous_application "$candidate_env" "$rollout_deadline"',
    );
    expect(source).toContain('next_previous_digest="$previous_digest"');
    expect(source).toContain("$((8#$mode & 0077)) -eq 0");
    expect(source).not.toContain("$((8#$mode & 0022)) -eq 0");
    expect(source).toContain(".build.imageDigest == $digest");
    expect(source).toContain(".imageDigest == $digest");
    expect(source.indexOf('if [[ $mode == "bootstrap-state" ]]')).toBeLessThan(
      source.indexOf('log "DATABASE_PLAN_START"'),
    );
    expect(bootstrap).toContain("BOOTSTRAP_STATE_REQUIRES_ROOT");
    expect(bootstrap).toContain('--bootstrap-state "$1" "$2" "$3"');
    expect(installer).toContain(
      '"$SCRIPT_DIR/controller/frontmind-bootstrap-state"',
    );
    expect(installer).toContain("/usr/local/sbin/frontmind-bootstrap-state");
  });
});
