import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  comparePdfRuntimeTrees,
  verifyCurrentPdfRuntimeRevision,
} from "./assert-current-pdf-runtime-revision.mjs";

const dashboardWorkflow = path.resolve(".github/workflows/dashboard-ci.yml");
const productionKnownHosts = path.resolve(
  ".github/deploy/production_known_hosts",
);
const pdfWorkflow = path.resolve(".github/workflows/pdf-runtime.yml");
const pdfDockerfile = path.resolve("deploy/1panel-node-pdf/Dockerfile");
const dashboardDockerfile = path.resolve(
  "deploy/production/dashboard/Dockerfile",
);
const dashboardCompose = path.resolve(
  "deploy/production/dashboard/compose.yaml",
);
const productionBundleBuilder = path.resolve(
  "scripts/build-unsealed-artifact.mjs",
);
const productionArtifactIdentity = path.resolve(
  "scripts/build-artifact-identity.mjs",
);
const productionBundleAudit = path.resolve(
  "scripts/audit-production-bundle.mjs",
);
const productionController = path.resolve(
  "deploy/production/controller/frontmind-deploy-controller",
);
const presalesContractFixture = path.resolve(
  "shared/contracts/presales-v2-contract-hashes.fixture.json",
);
const productionReleaseManual = path.resolve("docs/operations/RELEASE.md");
const installer = path.resolve("deploy/production/install.sh");
const controllerUpdater = path.resolve(
  "deploy/production/update-release-controllers.sh",
);
const websiteRuntimeEnvExample = path.resolve(
  "deploy/production/website/runtime.env.example",
);
const noClobberLibrary = path.resolve(
  "deploy/production/install-config-no-clobber.sh",
);
const installKeyPolicy = path.resolve(
  "deploy/production/install-key-policy.sh",
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release workflow source-ordering contracts", () => {
  it("installs the pinned browser before required native Template tests run", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const browserInstall = workflow.indexOf(
      "pnpm exec playwright install --with-deps chromium",
    );
    const fullTest = workflow.indexOf("- run: pnpm test\n");

    expect(browserInstall).toBeGreaterThan(-1);
    expect(fullTest).toBeGreaterThan(-1);
    expect(browserInstall).toBeLessThan(fullTest);
  });

  it("pins independent external DNS and isolates the production Dashboard web and worker roles", async () => {
    const [compose, dockerfile] = await Promise.all([
      readFile(dashboardCompose, "utf8"),
      readFile(dashboardDockerfile, "utf8"),
    ]);

    expect(compose.match(/^    dns:\s*$/gmu)).toHaveLength(2);
    expect(compose.match(/^    dns_opt:\s*$/gmu)).toHaveLength(2);
    expect(compose).toContain("      - 1.1.1.1");
    expect(compose).toContain("      - 8.8.8.8");
    expect(compose).toContain("      - timeout:2");
    expect(compose).toContain("      - attempts:2");
    expect(compose).toContain("  siteops-worker:");
    expect(compose).toContain("FRONTMIND_RUNTIME_ROLE: web");
    expect(compose).toContain("FRONTMIND_RUNTIME_ROLE: siteops-worker");
    expect(compose).toContain("container_name: frontmind-dashboard-siteops-worker");
    const worker = compose.slice(
      compose.indexOf("  siteops-worker:"),
      compose.indexOf("  release-db-plan:"),
    );
    expect(worker).not.toContain("ports:");
    expect(worker).toContain('PORT: "3001"');
    expect(worker).toContain("      database: {}");
    expect(worker).not.toContain("      applications:");
    expect(dockerfile).toContain(
      'net.frontmind.runtime.roles="web,siteops-worker"',
    );
  });

  it("conditionally closes the production incident-repair CLI artifact chain", async () => {
    const [builder, artifactIdentity, audit, dockerfile] = await Promise.all([
      readFile(productionBundleBuilder, "utf8"),
      readFile(productionArtifactIdentity, "utf8"),
      readFile(productionBundleAudit, "utf8"),
      readFile(dashboardDockerfile, "utf8"),
    ]);
    const source = "server/knowledge-base-incident-repair-cli.ts";
    const output = "knowledge-base-incident-repair-cli.js";

    for (const contract of [builder, artifactIdentity, audit]) {
      expect(contract).toContain(source);
      expect(contract).toContain(output);
    }
    expect(builder).toContain("knowledgeBaseIncidentRepairCliRequired");
    expect(audit).toContain("knowledgeBaseIncidentRepairCliRequired");
    expect(dockerfile).toContain(`test -e ${source}`);
    expect(dockerfile).toContain(`test -s dist/${output}`);
    expect(dockerfile).toContain("/app/dist/artifact-manifest.json");
    expect(dockerfile).toContain(`/app/dist/${output}`);
  });

  it("packages the existing-task SiteOps reconciliation CLI into production", async () => {
    const [builder, dockerfile] = await Promise.all([
      readFile(productionBundleBuilder, "utf8"),
      readFile(dashboardDockerfile, "utf8"),
    ]);

    expect(builder).toContain('"scripts/reconcile-siteops-build.ts"');
    expect(builder).toContain('"reconcile-siteops-build.js"');
    expect(builder).toContain("BUILD_SITEOPS_RECONCILE_CLI_OUTPUT_MISSING");
    expect(dockerfile).toContain(
      "test -s dist/reconcile-siteops-build.js",
    );
    expect(dockerfile).toContain(
      "test -s /app/dist/reconcile-siteops-build.js",
    );
  });

  it("packages and preloads the immutable SiteOps Template catalog before production rollout", async () => {
    const [builder, dockerfile, controller, updater, installerSource] =
      await Promise.all([
        readFile(productionBundleBuilder, "utf8"),
        readFile(dashboardDockerfile, "utf8"),
        readFile(productionController, "utf8"),
        readFile(controllerUpdater, "utf8"),
        readFile(installer, "utf8"),
      ]);

    expect(builder).toContain(
      '"server/siteops/seed-static-template-catalog.ts"',
    );
    expect(dockerfile).toContain(
      "test -s dist/seed-static-template-catalog.js",
    );
    expect(dockerfile).toContain(
      "test -s /app/dist/seed-static-template-catalog.js",
    );
    expect(controller).toContain("seed_static_template_catalog");
    expect(controller).toContain(
      "STATIC_TEMPLATE_CATALOG_SEED_TIMEOUT_SECONDS=1800",
    );
    expect(controller).toContain("/app/dist/seed-static-template-catalog.js");
    const execution = controller.slice(
      controller.lastIndexOf('candidate_env="$(mktemp)"'),
    );
    expect(execution.indexOf("seed_static_template_catalog")).toBeGreaterThan(
      execution.indexOf('make_compose_env "$candidate_env" "$image"'),
    );
    expect(execution.indexOf("seed_static_template_catalog")).toBeLessThan(
      execution.indexOf("prepare_coupled_stack"),
    );
    expect(execution.indexOf("seed_static_template_catalog")).toBeLessThan(
      execution.indexOf('log "DATABASE_PLAN_START"'),
    );
    for (const contract of [updater, installerSource]) {
      expect(contract).toContain("seed_static_template_catalog");
      expect(contract).toContain("/app/dist/seed-static-template-catalog.js");
      expect(contract).toContain(
        "STATIC_TEMPLATE_CATALOG_SEED_TIMEOUT_SECONDS=1800",
      );
      expect(contract).toContain(
        "PRODUCTION_STATIC_TEMPLATE_CATALOG_SEED_FAILED",
      );
    }
  });

  it("binds the one ordinary production build directly to github.sha", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const buildJob = workflow.slice(
      workflow.indexOf("  build-sign:"),
      workflow.indexOf("  coupled-stack-deploy:"),
    );

    expect(workflow).not.toContain("  promotion-gate:");
    expect(workflow).not.toContain("  promotion-merge-proof:");
    expect(buildJob).toContain("      - quality");
    expect(buildJob).toContain("      - mysql-acceptance");
    expect(buildJob).toContain("needs.quality.result == 'success'");
    expect(buildJob).toContain("needs.mysql-acceptance.result == 'success'");
    expect(buildJob).toContain("source_sha: ${{ github.sha }}");
    expect(buildJob).toContain("FRONTMIND_RELEASE_SOURCE_SHA: ${{ github.sha }}");
    expect(buildJob).toContain("          ref: ${{ github.sha }}");
    expect(buildJob).not.toContain("needs.promotion-gate");
    expect(buildJob.match(/docker\/build-push-action@v6/gu)).toHaveLength(1);
    expect(buildJob.match(/cosign sign --yes/gu)).toHaveLength(1);
    expect(
      buildJob.match(/Deploy through fixed Dashboard capability/gu),
    ).toHaveLength(1);
  });

  it("wires one exact coupled production deployment without a rollout control plane", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const updater = await readFile(controllerUpdater, "utf8");
    const installerSource = await readFile(installer, "utf8");
    const releaseManual = await readFile(productionReleaseManual, "utf8");
    const coupledJob = workflow.slice(
      workflow.indexOf("  coupled-stack-deploy:"),
    );

    expect(workflow).toContain("          - reuse-coupled-stack");
    expect(coupledJob).toContain("inputs.release_mode == 'reuse-coupled-stack'");
    expect(coupledJob).toContain("Verify both existing signed production artifacts");
    expect(coupledJob).toContain("coupled-stack ghcr.io/xiafanzeng/frontmind-dashboard@");
    expect(coupledJob).not.toContain("docker/build-push-action");
    expect(coupledJob).not.toMatch(/canary|dual-read|shadow/iu);
    expect(workflow).not.toContain("--kb-manus-v2-rollout");
    expect(updater).toContain(
      'VERSION_ARGUMENT="--apply-version=${CONTROLLER_VERSION}"',
    );
    expect(updater).toContain('readonly CONTROLLER_VERSION="7"');
    expect(releaseManual).toContain("production-owned v7 controller");
    expect(releaseManual).toContain("--apply-version=7");
    expect(releaseManual).not.toMatch(/--apply-version=[0-6](?:\D|$)/u);
    expect(updater).toContain("dashboard_image_supports_split_runtime");
    expect(updater).toContain("dashboard_siteops_worker_matches");
    expect(updater).toContain("PRODUCTION_CONTROLLER_UPDATE_ROLLED_BACK");
    expect(updater).toContain("project-business-owner");
    expect(updater).toContain(
      "PRODUCTION_COUPLED_DASHBOARD_PRESALES_SURFACE_MISMATCH",
    );
    expect(updater).toContain("siteops_alidns_oauth_contract_plan_matches");
    expect(updater).toContain("contract-0065-migration-started");
    expect(releaseManual).toContain("forced command 不暴露 0065");
    expect(installerSource).not.toContain(
      "frontmind-update-release-controllers",
    );
    expect(installerSource).not.toContain("update-release-controllers.sh");
  });

  it("stops the consumer first and keeps one durable coupled failure recovery path", async () => {
    const controller = await readFile(productionController, "utf8");
    const execution = controller.slice(
      controller.lastIndexOf('candidate_env="$(mktemp)"'),
    );
    const prepare = controller.slice(
      controller.indexOf("prepare_coupled_stack()"),
      controller.indexOf("dashboard_health_and_changed_surface_once()"),
    );
    const success = controller.slice(
      controller.indexOf("deploy_coupled_website_and_finalize()"),
      controller.indexOf(
        'if [[ $operation == "deploy" && $mode == "acknowledge-incident" ]]',
      ),
    );
    const dashboardSmoke = controller.slice(
      controller.indexOf("dashboard_health_and_changed_surface_once()"),
      controller.indexOf("coupled_website_health_once()"),
    );
    const recovery = controller.slice(
      controller.indexOf("restore_coupled_stack()"),
      controller.indexOf("deploy_coupled_website_and_finalize()"),
    );
    const main = controller.slice(
      controller.indexOf(
        'if [[ $operation == "deploy" && $mode == "acknowledge-incident" ]]',
      ),
    );

    expect(controller).toContain(
      'COUPLED_STACK_CAPSULE_FILE="/var/lib/frontmind-deploy/dashboard/coupled-stack-pending.json"',
    );
    expect(controller).toContain(
      'COUPLED_DASHBOARD_RUNTIME_ROLLBACK_ENV="/var/lib/frontmind-deploy/dashboard/coupled-dashboard-runtime-rollback.env"',
    );
    expect(controller).toContain(
      'COUPLED_DASHBOARD_RUNTIME_RETIRING_ENV="/var/lib/frontmind-deploy/dashboard/coupled-dashboard-runtime-rollback.retiring"',
    );
    expect(controller).toContain(
      'COUPLED_WEBSITE_RUNTIME_ROLLBACK_ENV="/var/lib/frontmind-deploy/dashboard/coupled-website-runtime-rollback.env"',
    );
    expect(controller).toContain(
      'COUPLED_WEBSITE_RUNTIME_RETIRING_ENV="/var/lib/frontmind-deploy/dashboard/coupled-website-runtime-rollback.retiring"',
    );
    expect(controller).not.toMatch(/--kb-manus-v2-rollout|dual-read|canary|shadow/u);
    expect(prepare).toContain('stop website');
    expect(controller).toContain("resolve_coupled_website_container_id()");
    expect(controller).toContain(
      'coupled_website_compose "$environment_file" ps -q website',
    );
    expect(prepare).toContain(
      'resolve_coupled_website_container_id "$coupled_website_env"',
    );
    expect(prepare).not.toContain(
      "docker inspect --format '{{.Config.Image}}' frontmind-website",
    );
    expect(prepare).toContain("render_coupled_dashboard_runtime_v5");
    expect(prepare).toContain("render_coupled_website_runtime_v2");
    expect(controller).toContain("/^FRONTMIND_KB_V4_ROLLOUT_PERCENT=/ { next }");
    expect(controller).toContain("/^FRONTMIND_KB_MANUS_V2_WRITER=/ { next }");
    expect(prepare.indexOf('stop website')).toBeLessThan(
      prepare.indexOf("render_coupled_dashboard_runtime_v5"),
    );
    expect(execution.indexOf("prepare_coupled_stack")).toBeLessThan(
      execution.indexOf('log "DATABASE_PLAN_START"'),
    );
    expect(execution.indexOf('stop "$COMPOSE_SERVICE"')).toBeLessThan(
      execution.indexOf("backup_database"),
    );
    expect(success.match(/dashboard_health_and_changed_surface_once/g)).toHaveLength(1);
    expect(dashboardSmoke).toContain('"project-business-owner"');
    expect(dashboardSmoke).toContain(
      "($status.capabilities | sort) == ($requiredCapabilities | sort)",
    );
    expect(dashboardSmoke).toContain(
      "PRODUCTION_COUPLED_DASHBOARD_PRESALES_SURFACE_MISMATCH",
    );
    expect(dashboardSmoke).not.toContain(
      '.capabilities | type == "array" and length == 4',
    );
    expect(dashboardSmoke).not.toContain(
      '.contractHashes | type == "object" and length == 6',
    );
    expect(success.match(/wait_coupled_website_ready/g)).toHaveLength(1);
    expect(success.match(/coupled_website_health_once/g)).toHaveLength(1);
    expect(recovery).toContain('restore_production_database "$backup"');
    expect(recovery).toContain(
      '"$COUPLED_DASHBOARD_RUNTIME_ROLLBACK_ENV" "$COUPLED_DASHBOARD_RUNTIME_ENV_FILE"',
    );
    expect(recovery).toContain(
      '"$COUPLED_WEBSITE_RUNTIME_ROLLBACK_ENV" "$COUPLED_WEBSITE_RUNTIME_ENV_FILE"',
    );
    expect(recovery).toContain('wait_until_ready "$old_dashboard_source"');
    expect(recovery).toContain('wait_coupled_website_ready');
    expect(controller).toContain("mark_coupled_stack_external_fact_changed");
    expect(controller).toContain("commit_coupled_stack_capsule_cleanup");
    expect(controller).toContain(
      '.dashboard.databaseRestoreRequired = false |',
    );
    expect(controller).toContain("coupled_recovery_pending=1");
    expect(controller).toContain(
      "COUPLED_STACK_RECOVERY_MUST_FINISH_BEFORE_INCIDENT_ACKNOWLEDGEMENT",
    );
    expect(recovery).toContain(
      '$persisted_message == migration-applied-fact-changed-*',
    );
    expect(main.indexOf("restore_coupled_stack")).toBeLessThan(
      main.indexOf("read_ephemeral_registry_auth"),
    );
    expect(main.indexOf("restore_coupled_stack")).toBeLessThan(
      main.indexOf("verify_candidate"),
    );
  });

  it("binds the coupled smoke to the canonical Presales consumer contract", async () => {
    const controller = await readFile(productionController, "utf8");
    const dashboardSmoke = controller.slice(
      controller.indexOf("dashboard_health_and_changed_surface_once()"),
      controller.indexOf("coupled_website_health_once()"),
    );
    const filter = dashboardSmoke.match(
      /jq -e '\n([\s\S]*?)\n  ' <<<"\$status" >\/dev\/null/u,
    )?.[1];
    expect(filter).toBeTruthy();

    const fixture = JSON.parse(
      await readFile(presalesContractFixture, "utf8"),
    ) as {
      presalesContractVersion: number;
      capabilities: string[];
      contractHashes: Record<string, string>;
    };
    const status = {
      ok: true,
      ...fixture,
    };
    const run = (input: unknown) =>
      spawnSync("jq", ["-e", filter!], {
        encoding: "utf8",
        input: JSON.stringify(input),
      });

    expect(run(status).status).toBe(0);
    expect(
      run({ ...status, capabilities: [...status.capabilities].reverse() }).status,
    ).toBe(0);
    expect(
      run({
        ...status,
        capabilities: status.capabilities.filter(
          (capability) => capability !== "project-business-owner",
        ),
      }).status,
    ).toBe(1);
    expect(
      run({
        ...status,
        capabilities: [...status.capabilities, status.capabilities[0]],
      }).status,
    ).toBe(1);
    expect(
      run({
        ...status,
        capabilities: [...status.capabilities, "unknown-capability"],
      }).status,
    ).toBe(1);
    const incompleteHashes = { ...status.contractHashes };
    delete incompleteHashes["website.question-recommendation"];
    expect(run({ ...status, contractHashes: incompleteHashes }).status).toBe(1);
    expect(
      run({
        ...status,
        contractHashes: {
          ...status.contractHashes,
          "unknown.contract": "f".repeat(64),
        },
      }).status,
    ).toBe(1);
    expect(
      run({
        ...status,
        contractHashes: {
          ...status.contractHashes,
          "website.question-recommendation": "0".repeat(64),
        },
      }).status,
    ).toBe(1);
  });

  it("resolves exactly one compose-managed Website container id", async () => {
    const controller = await readFile(productionController, "utf8");
    const resolver = controller.slice(
      controller.indexOf("resolve_coupled_website_container_id()"),
      controller.indexOf("make_coupled_website_env()"),
    );
    const run = (composeOutput: string, composeStatus = 0) =>
      spawnSync(
        "bash",
        [
          "-c",
          `coupled_website_compose() {
  printf '%s' "$TEST_COMPOSE_OUTPUT"
  return "$TEST_COMPOSE_STATUS"
}
${resolver}
resolve_coupled_website_container_id fixture.env`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_COMPOSE_OUTPUT: composeOutput,
            TEST_COMPOSE_STATUS: String(composeStatus),
          },
        },
      );
    const containerId = "a".repeat(64);

    expect(run(`${containerId}\n`)).toMatchObject({
      status: 0,
      stdout: `${containerId}\n`,
    });
    expect(run("").status).toBe(1);
    expect(run(`${containerId}\n${"b".repeat(64)}\n`).status).toBe(1);
    expect(run(`${containerId}\n`, 23).status).toBe(1);
  });

  it("takes the pnpm version only from package.json", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    expect(workflow).not.toMatch(/pnpm\/action-setup@v4\s+with:\s+version:/gu);
  });

  it("runs one changed-surface MySQL acceptance without historical audit matrices", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const mysqlAcceptance = workflow.slice(
      workflow.indexOf("  mysql-acceptance:"),
      workflow.indexOf("  build-sign:"),
    );

    expect(mysqlAcceptance).toContain(
      "name: Changed-surface MySQL 8.4.10 acceptance",
    );
    expect(mysqlAcceptance).toContain(
      "node scripts/ci-verify-mysql-migration-upgrade.mjs",
    );
    expect(mysqlAcceptance).toContain(
      "name: Create isolated changed-surface acceptance databases",
    );
    expect(mysqlAcceptance).toContain("frontmind_release_acceptance_ci");
    expect(mysqlAcceptance).toContain("frontmind_auth_acceptance_ci");
    expect(mysqlAcceptance).toContain("pnpm test:release:mysql-acceptance");
    expect(mysqlAcceptance).toContain(
      "scripts/auth-mysql-transaction-acceptance.test.ts",
    );
    expect(mysqlAcceptance).not.toContain("matrix:");
    expect(mysqlAcceptance).not.toContain("migration-upgrade-historical");
    expect(mysqlAcceptance).not.toContain("pnpm test:kb:mysql-e2e-acceptance");
  });

  it("builds and signs once before the separately dispatched coupled deployment", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    expect(workflow).not.toContain("DASHBOARD_AUTO_DEPLOY_ENABLED");
    expect(workflow.indexOf("Build and push image")).toBeLessThan(
      workflow.indexOf("  coupled-stack-deploy:"),
    );
    expect(workflow.indexOf("Sign exact application digest")).toBeLessThan(
      workflow.indexOf("  coupled-stack-deploy:"),
    );
    expect(workflow).toContain(
      "install -m 0644 .github/deploy/production_known_hosts ~/.ssh/known_hosts",
    );
    expect(workflow).toContain("frontmind-deploy@149.88.85.148");
    expect(workflow).not.toContain("ssh-keyscan");

    const knownHosts = await readFile(productionKnownHosts, "utf8");
    expect(knownHosts).toMatch(
      /^149\.88\.85\.148 ssh-ed25519 [A-Za-z0-9+/=]+\n$/u,
    );
  });

  it("streams the job-scoped GHCR credential to the coupled deploy command", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const deployStep = workflow.slice(
      workflow.indexOf(
        "      - name: Run the ordinary coupled stop, migrate, and start command",
      ),
    );

    expect(deployStep).toContain("GHCR_USERNAME: ${{ github.actor }}");
    expect(deployStep).toContain("GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(deployStep).toContain(
      `printf '%s\\n%s\\n' "$GHCR_USERNAME" "$GHCR_TOKEN" |`,
    );
    expect(deployStep).toContain(
      '"coupled-stack ghcr.io/xiafanzeng/frontmind-dashboard@$DASHBOARD_IMAGE_DIGEST',
    );
    const remoteCommand = deployStep.match(/"coupled-stack [^\n]+"/u)?.[0];
    expect(remoteCommand).toBeTruthy();
    expect(remoteCommand).not.toContain('"--coupled-stack');
    expect(remoteCommand).not.toContain("GHCR_TOKEN");
  });

  it("checks the complete multi-commit push range for PDF base changes", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const producerWorkflow = await readFile(pdfWorkflow, "utf8");
    const changesJob = workflow.slice(
      workflow.indexOf("  changes:"),
      workflow.indexOf("  quality:"),
    );

    expect(changesJob).toContain("fetch-depth: 0");
    expect(changesJob).toContain("persist-credentials: false");
    expect(changesJob).toContain('git cat-file -e "${before}^{commit}"');
    expect(changesJob).toContain(
      'git diff --name-only "$before" "$GITHUB_SHA"',
    );
    expect(changesJob).not.toContain("fetch-depth: 2");
    for (const controlPath of [
      "scripts/assert-current-pdf-runtime-revision.mjs",
      "scripts/mark-ghcr-promoted.mjs",
    ]) {
      expect(changesJob).toContain(path.basename(controlPath, ".mjs"));
      expect(producerWorkflow).toContain(`- ${controlPath}`);
    }
  });

  it("upgrades MySQL from the complete multi-commit push base", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const upgradeStep = workflow.slice(
      workflow.indexOf(
        "      - name: Prove the current production base upgrades to this release",
      ),
      workflow.indexOf(
        "      - run: node scripts/verify-api-usage-migration-schema.mjs post",
      ),
    );

    expect(upgradeStep).toContain(
      "FRONTMIND_PUSH_BEFORE: ${{ github.event.before }}",
    );
    expect(upgradeStep).toContain(
      'FRONTMIND_UPGRADE_BASE_REF="$FRONTMIND_PUSH_BEFORE"',
    );
    expect(upgradeStep).toContain('FRONTMIND_UPGRADE_BASE_REF="$GITHUB_SHA^"');
    expect(upgradeStep).not.toContain("format('{0}^', github.sha)");
  });

  it("binds a dispatched PDF revision to the signed promoted digest and current tree", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const producer = await readFile(pdfDockerfile, "utf8");
    const pdfStep = workflow.slice(
      workflow.indexOf("      - id: pdf"),
      workflow.indexOf("      - id: build"),
    );

    expect(pdfStep).toContain(
      "DISPATCHED_REVISION: ${{ github.event.client_payload.pdf_runtime_revision }}",
    );
    expect(pdfStep).toContain(
      '[[ "${DISPATCHED_REVISION:-}" =~ ^[a-f0-9]{64}$ ]]',
    );
    expect(pdfStep).toContain('pdf_prefix="${pdf_repository}@"');
    expect(pdfStep).toContain('[[ "$pdf_image" == "$pdf_prefix"* ]]');
    expect(pdfStep).toContain('pdf_digest="${pdf_image#"$pdf_prefix"}"');
    expect(pdfStep).toContain('[[ "$pdf_digest" =~ ^sha256:[a-f0-9]{64}$ ]]');
    expect(pdfStep).not.toContain("=~ ^${pdf_repository}");
    expect(pdfStep).toContain("cosign verify");
    expect(pdfStep).toContain(
      'index .Image.Config.Labels "org.opencontainers.image.revision"',
    );
    expect(pdfStep).toContain('[[ "$image_revision" =~ ^[a-f0-9]{40}$ ]]');
    expect(pdfStep).toContain(
      "scripts/assert-current-pdf-runtime-revision.mjs",
    );
    expect(pdfStep).toContain(
      '--source-sha "$image_revision" --phase dashboard-base',
    );
    expect(pdfStep).toContain(
      '[[ "$computed_revision" == "$DISPATCHED_REVISION" ]]',
    );
    expect(pdfStep).toContain("$pdf_repository:released-current");
    expect(pdfStep).toContain("$pdf_repository:stable");
    expect(pdfStep).toContain("PDF_RUNTIME_DISPATCH_NOT_CURRENT_PROMOTION");
    expect(producer).toContain(
      'org.opencontainers.image.revision="${VCS_REF}"',
    );
    expect(await readFile(pdfWorkflow, "utf8")).toContain(
      "VCS_REF=${{ github.sha }}",
    );

    const signature = pdfStep.indexOf("cosign verify");
    const imageRevision = pdfStep.indexOf("org.opencontainers.image.revision");
    const treeRevision = pdfStep.indexOf(
      "assert-current-pdf-runtime-revision.mjs",
    );
    const payloadMatch = pdfStep.indexOf(
      '"$computed_revision" == "$DISPATCHED_REVISION"',
    );
    const dispatchOnly = pdfStep.indexOf('if [[ "$is_dispatch" == true ]]');
    const output = pdfStep.indexOf('echo "image=$pdf_image"');
    expect(imageRevision).toBeGreaterThan(signature);
    expect(treeRevision).toBeGreaterThan(imageRevision);
    expect(dispatchOnly).toBeGreaterThan(treeRevision);
    expect(payloadMatch).toBeGreaterThan(treeRevision);
    expect(output).toBeGreaterThan(payloadMatch);
  });

  it("prevents a superseded PDF runtime run from moving stable or dispatching", async () => {
    const workflow = await readFile(pdfWorkflow, "utf8");
    const revisionChecks = workflow.match(
      /node scripts\/assert-current-pdf-runtime-revision\.mjs --phase/gu,
    );

    expect(workflow).toContain("group: dashboard-pdf-runtime-main");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(revisionChecks).toHaveLength(2);
    expect(workflow).toContain("--phase promotion");
    expect(workflow).toContain("--phase dispatch");
    expect(workflow).toContain('--source-revision "$revision"');
    expect(workflow).toContain(
      "client_payload[pdf_runtime_revision]=$revision",
    );

    const signed = workflow.indexOf("Sign exact PDF runtime digest");
    const promotionGuard = workflow.indexOf("--phase promotion");
    const promotion = workflow.indexOf("node scripts/mark-ghcr-promoted.mjs");
    const dispatchGuard = workflow.indexOf("--phase dispatch");
    const dispatch = workflow.indexOf("repos/$GITHUB_REPOSITORY/dispatches");
    expect(signed).toBeGreaterThan(-1);
    expect(promotionGuard).toBeGreaterThan(signed);
    expect(promotion).toBeGreaterThan(promotionGuard);
    expect(dispatchGuard).toBeGreaterThan(promotion);
    expect(dispatch).toBeGreaterThan(dispatchGuard);
  });

  const sha = (character: string) => character.repeat(40);
  const tree = ({
    workflow = "a",
    dockerfile = "b",
    revisionHelper = "c",
    promotionHelper = "d",
    unrelated = "e",
  } = {}) => ({
    truncated: false,
    tree: [
      {
        path: ".github/workflows/pdf-runtime.yml",
        mode: "100644",
        type: "blob",
        sha: sha(workflow),
      },
      {
        path: "deploy/1panel-node-pdf/Dockerfile",
        mode: "100644",
        type: "blob",
        sha: sha(dockerfile),
      },
      {
        path: "scripts/assert-current-pdf-runtime-revision.mjs",
        mode: "100644",
        type: "blob",
        sha: sha(revisionHelper),
      },
      {
        path: "scripts/mark-ghcr-promoted.mjs",
        mode: "100644",
        type: "blob",
        sha: sha(promotionHelper),
      },
      {
        path: "server/unrelated.ts",
        mode: "100644",
        type: "blob",
        sha: sha(unrelated),
      },
    ],
  });

  it("allows an unrelated main commit with the same PDF revision", () => {
    const result = comparePdfRuntimeTrees({
      sourceTree: tree({ unrelated: "c" }),
      mainTree: tree({ unrelated: "d" }),
      phase: "promotion",
    });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.entryCount).toBe(4);
  });

  it("reads source and current main through the recursive Git Trees API", async () => {
    const sourceSha = sha("e");
    const mainSha = sha("f");
    const requests: string[] = [];
    const result = await verifyCurrentPdfRuntimeRevision({
      repository: "xiafanzeng/frontmind-dashboard",
      sourceSha,
      token: "test-token",
      phase: "promotion",
      request: async (endpoint: string) => {
        requests.push(endpoint);
        if (endpoint.endsWith("/git/ref/heads/main")) {
          return { object: { sha: mainSha } };
        }
        return tree();
      },
    });

    expect(result).toMatchObject({ sourceSha, mainSha, entryCount: 4 });
    expect(requests).toEqual([
      "/repos/xiafanzeng/frontmind-dashboard/git/ref/heads/main",
      `/repos/xiafanzeng/frontmind-dashboard/git/trees/${sourceSha}?recursive=1`,
      `/repos/xiafanzeng/frontmind-dashboard/git/trees/${mainSha}?recursive=1`,
    ]);
  });

  it.each([
    ["PDF file", tree({ dockerfile: "d" })],
    ["workflow", tree({ workflow: "d" })],
    ["revision helper", tree({ revisionHelper: "f" })],
    ["promotion helper", tree({ promotionHelper: "f" })],
  ])("rejects a superseded %s revision", (_label, mainTree) => {
    expect(() =>
      comparePdfRuntimeTrees({
        sourceTree: tree(),
        mainTree,
        phase: "dispatch",
      }),
    ).toThrow("PDF_RUNTIME_DISPATCH_SUPERSEDED");
  });

  it("fails closed when GitHub truncates either recursive tree", () => {
    expect(() =>
      comparePdfRuntimeTrees({
        sourceTree: tree(),
        mainTree: { ...tree(), truncated: true },
        phase: "promotion",
      }),
    ).toThrow("PDF_RUNTIME_TREE_TRUNCATED:main");
  });
});

const noClobberRunner = [
  "set -Eeuo pipefail",
  "die() {",
  "  printf '%s\\n' \"$1\" >&2",
  "  exit 1",
  "}",
  "install() {",
  "  local -a operands=()",
  "  while (($#)); do",
  '    case "$1" in',
  "      -o|-g|-m) shift 2 ;;",
  '      *) operands+=("$1"); shift ;;',
  "    esac",
  "  done",
  "  [[ ${#operands[@]} -eq 2 ]]",
  '  printf \'%s -> %s\\n\' "${operands[0]}" "${operands[1]}" >>"$TEST_INSTALL_LOG"',
  '  command cp -- "${operands[0]}" "${operands[1]}"',
  "}",
  "chown() { :; }",
  "chmod() { :; }",
  'source "$1"',
  'install_config_from_example_no_clobber "$2" "$3" "$4"',
  "",
].join("\n");

function runNoClobber(
  source: string,
  exampleTarget: string,
  liveTarget: string,
  log: string,
) {
  return spawnSync(
    "bash",
    [
      "-c",
      noClobberRunner,
      "frontmind-install-config-test",
      noClobberLibrary,
      source,
      exampleTarget,
      liveTarget,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TEST_INSTALL_LOG: log },
    },
  );
}

describe("production installer no-clobber policy", () => {
  it("refreshes examples while preserving an existing live compose env", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "frontmind-install-policy-"),
    );
    temporaryRoots.push(root);
    const source = path.join(root, "compose.env.source");
    const example = path.join(root, "compose.env.example");
    const live = path.join(root, "compose.env");
    const log = path.join(root, "install.log");
    await writeFile(source, "VALUE=initial\n");

    const first = runNoClobber(source, example, live, log);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`INSTALL_CONFIG_SEEDED:${live}`);
    expect(await readFile(live, "utf8")).toBe("VALUE=initial\n");

    await writeFile(source, "VALUE=updated-example\n");
    const second = runNoClobber(source, example, live, log);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(`INSTALL_CONFIG_PRESERVED:${live}`);
    expect(await readFile(example, "utf8")).toBe("VALUE=updated-example\n");
    expect(await readFile(live, "utf8")).toBe("VALUE=initial\n");

    const operations = await readFile(log, "utf8");
    expect(operations.match(new RegExp(` -> ${example}$`, "gmu"))).toHaveLength(
      2,
    );
    expect(operations.match(new RegExp(` -> ${live}$`, "gmu"))).toHaveLength(1);
  });

  it("fails closed instead of following a live-config symlink", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "frontmind-install-policy-"),
    );
    temporaryRoots.push(root);
    const source = path.join(root, "compose.env.source");
    const example = path.join(root, "compose.env.example");
    const live = path.join(root, "compose.env");
    const victim = path.join(root, "victim.env");
    const log = path.join(root, "install.log");
    await writeFile(source, "VALUE=source\n");
    await writeFile(victim, "DO_NOT_TOUCH=1\n");
    await symlink(victim, live);

    const result = runNoClobber(source, example, live, log);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("INSTALL_CONFIG_LIVE_SYMLINK_REJECTED");
    expect(await readFile(victim, "utf8")).toBe("DO_NOT_TOUCH=1\n");
  });

  it("wires both compose env files through the no-clobber helper", async () => {
    const script = await readFile(installer, "utf8");
    expect(script).toContain(
      'source "$SCRIPT_DIR/install-config-no-clobber.sh"',
    );
    expect(
      script.match(/install_config_from_example_no_clobber/gu),
    ).toHaveLength(2);
    expect(script).toContain('"$CONFIG_ROOT/dashboard-compose.env.example"');
    expect(script).toContain('"$CONFIG_ROOT/website-compose.env.example"');
  });

  it("requires a distinct production contract authorization code", async () => {
    const example = await readFile(websiteRuntimeEnvExample, "utf8");
    expect(example).toContain(
      "FRONTMIND_GEO_CONTRACT_AUTH_CODE=replace-with-independent-random-contract-code",
    );
    expect(example).not.toContain("frontmind666");
  });
});

describe("production installer deploy-key isolation", () => {
  function runKeyPolicy(dashboardKey: string, websiteKey: string) {
    return spawnSync(
      "bash",
      [
        "-c",
        [
          'source "$1"',
          'dashboard_key="$(read_deploy_public_key "$2")"',
          'website_key="$(read_deploy_public_key "$3")"',
          'deploy_public_keys_are_independent "$dashboard_key" "$website_key" || {',
          "  echo DEPLOY_KEYS_MUST_BE_INDEPENDENT >&2",
          "  exit 1",
          "}",
          'printf \'%s\\n%s\\n\' "$dashboard_key" "$website_key"',
        ].join("\n"),
        "frontmind-install-key-test",
        installKeyPolicy,
        dashboardKey,
        websiteKey,
      ],
      { encoding: "utf8" },
    );
  }

  it("rejects the same key blob even when comments differ", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-install-key-"));
    temporaryRoots.push(root);
    const dashboardKey = path.join(root, "dashboard.pub");
    const websiteKey = path.join(root, "website.pub");
    const sharedBlob =
      "AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyBlobForPolicyOnly1234567890=";
    await writeFile(dashboardKey, `ssh-ed25519 ${sharedBlob} dashboard\n`);
    await writeFile(websiteKey, `ssh-ed25519 ${sharedBlob} website\n`);

    const result = runKeyPolicy(dashboardKey, websiteKey);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DEPLOY_KEYS_MUST_BE_INDEPENDENT");
  });

  it("preserves full authorized_keys lines for distinct identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "frontmind-install-key-"));
    temporaryRoots.push(root);
    const dashboardKey = path.join(root, "dashboard.pub");
    const websiteKey = path.join(root, "website.pub");
    const dashboardLine =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDashboardKeyBlobForPolicy123456= dashboard";
    const websiteLine =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWebsiteKeyBlobForPolicy12345678= website";
    await writeFile(dashboardKey, `${dashboardLine}\n`);
    await writeFile(websiteKey, `${websiteLine}\n`);

    const result = runKeyPolicy(dashboardKey, websiteKey);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${dashboardLine}\n${websiteLine}\n`);
  });
});
