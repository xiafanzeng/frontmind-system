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
const installer = path.resolve("deploy/production/install.sh");
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
  it("takes the pnpm version only from package.json", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    expect(workflow).not.toMatch(/pnpm\/action-setup@v4\s+with:\s+version:/gu);
  });

  it("builds and signs before every automatic main deployment", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    expect(workflow).not.toContain("DASHBOARD_AUTO_DEPLOY_ENABLED");
    expect(workflow.indexOf("Build and push image")).toBeLessThan(
      workflow.indexOf("Install restricted deploy key"),
    );
    expect(workflow.indexOf("Sign exact application digest")).toBeLessThan(
      workflow.indexOf("Install restricted deploy key"),
    );
    expect(workflow).toContain(
      "install -m 0644 .github/deploy/production_known_hosts ~/.ssh/known_hosts",
    );
    expect(workflow).toContain("DEPLOY_HOST: 149.88.85.148");
    expect(workflow).toContain("DEPLOY_USER: frontmind-deploy");
    expect(workflow).not.toContain("ssh-keyscan");

    const knownHosts = await readFile(productionKnownHosts, "utf8");
    expect(knownHosts).toMatch(
      /^149\.88\.85\.148 ssh-ed25519 [A-Za-z0-9+/=]+\n$/u,
    );
  });

  it("streams the job-scoped GHCR credential to the restricted deploy command", async () => {
    const workflow = await readFile(dashboardWorkflow, "utf8");
    const deployStep = workflow.slice(
      workflow.indexOf(
        "      - name: Deploy through fixed Dashboard capability",
      ),
      workflow.indexOf(
        "      - name: Record immutable successful-deployment marker",
      ),
    );

    expect(deployStep).toContain("GHCR_USERNAME: ${{ github.actor }}");
    expect(deployStep).toContain("GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(deployStep).toContain(
      `printf '%s\\n%s\\n' "$GHCR_USERNAME" "$GHCR_TOKEN" |`,
    );
    expect(deployStep).toContain(
      '"$IMAGE@$DIGEST $FRONTMIND_RELEASE_SOURCE_SHA"',
    );
    expect(deployStep).not.toContain(
      '"$IMAGE@$DIGEST $FRONTMIND_RELEASE_SOURCE_SHA $GHCR_TOKEN"',
    );
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
        "      - if: matrix.suite == 'migration-upgrade-base-ref'",
      ),
      workflow.indexOf(
        "      - if: matrix.suite == 'migration-upgrade-historical'",
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
