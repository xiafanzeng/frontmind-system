import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PromotionGateError,
  mergeProofArtifactName,
  parseCanonicalMergeProof,
  selectMergeProofArtifact,
  selectPriorActivationJob,
  validateMergeProof,
  verifyPromotionGateEvidence,
} from "../.github/scripts/promotion-gate-core.mjs";

const sha = (character) => character.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const config = {
  repository: "xiafanzeng/frontmind-dashboard",
  workflowName: "Dashboard CI and release",
  workflowPath: ".github/workflows/dashboard-ci.yml",
  activationJobName: "Build, sign and deploy immutable image",
  priorActivationEvents: ["push", "workflow_dispatch", "repository_dispatch"],
};

function fixture({ promotion = true } = {}) {
  const sourceSha = sha("a");
  const baseSha = sha("b");
  const headSha = sha("c");
  const testMergeSha = sha("d");
  const tree = sha("e");
  const pull = {
    number: 17,
    state: "closed",
    draft: false,
    merged: true,
    merged_at: "2026-08-06T01:00:00Z",
    merge_commit_sha: sourceSha,
    base: { ref: "main", sha: baseSha },
    head: {
      ref: promotion ? "codex/promote-dashboard-c" : "codex/release-docs",
      sha: headSha,
      repo: { full_name: config.repository },
    },
  };
  const run = {
    id: 91,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    name: config.workflowName,
    path: config.workflowPath,
    head_sha: headSha,
    head_branch: pull.head.ref,
    workflow_id: 44,
    pull_requests: [],
  };
  const mergeProof = {
    schemaVersion: 1,
    kind: "frontmind.production-pr-merge-proof",
    repository: config.repository,
    workflow: { name: config.workflowName, path: config.workflowPath },
    run: { id: run.id, attempt: run.run_attempt, event: "pull_request" },
    pullRequest: {
      number: pull.number,
      base: { ref: "main", sha: baseSha },
      head: {
        ref: pull.head.ref,
        sha: headSha,
        repository: config.repository,
      },
    },
    checkout: {
      sha: testMergeSha,
      parents: [baseSha, headSha],
      tree,
    },
  };
  const mergeArtifact = {
    id: 501,
    name: mergeProofArtifactName(run.run_attempt),
    size_in_bytes: 512,
    digest: digest("3"),
    expired: false,
    archive_download_url: `https://api.github.com/repos/${config.repository}/actions/artifacts/501/zip`,
    workflow_run: {
      id: run.id,
      head_sha: run.head_sha,
      head_branch: run.head_branch,
    },
  };
  run.mergeProof = mergeProof;
  run.mergeArtifact = mergeArtifact;
  const message = promotion
    ? [
        "Promote exact Dev",
        "",
        `FrontMind-Dev-Source: ${sha("f")}`,
        `FrontMind-Product-Tree: ${digest("1")}`,
        `FrontMind-Projection-Policy: ${digest("2")}`,
      ].join("\n")
    : "Ordinary production release";
  return {
    sourceSha,
    eventName: "push",
    eventPayload: { ref: "refs/heads/main", after: sourceSha },
    mainSha: sourceSha,
    sourceCommit: { sha: sourceSha, parents: [baseSha, headSha], tree },
    associatedPulls: [{ number: 17 }],
    pull,
    headCommit: { sha: headSha, parents: [baseSha], tree, message },
    workflowRuns: [run],
    workflows: {
      44: {
        id: 44,
        name: config.workflowName,
        path: config.workflowPath,
        state: "active",
      },
    },
    final: {
      mainSha: sourceSha,
      pull: structuredClone(pull),
      run: structuredClone(run),
      headCommit: { sha: headSha, parents: [baseSha], tree, message },
      mergeProof: structuredClone(mergeProof),
      mergeArtifact: structuredClone(mergeArtifact),
    },
  };
}

function expectCode(mutator, code) {
  const evidence = fixture();
  mutator(evidence);
  assert.throws(
    () => verifyPromotionGateEvidence(config, evidence),
    (error) => error instanceof PromotionGateError && error.code === code,
  );
}

function priorActivationFixture(eventName = "workflow_dispatch") {
  const evidence = fixture();
  const run = {
    id: 191,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    event: "push",
    name: config.workflowName,
    path: config.workflowPath,
    head_sha: evidence.sourceSha,
    head_branch: "main",
    workflow_id: 44,
  };
  const job = {
    id: 701,
    run_id: run.id,
    run_attempt: run.run_attempt,
    workflow_name: run.name,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    name: config.activationJobName,
    status: "completed",
    conclusion: "success",
  };
  return {
    sourceSha: evidence.sourceSha,
    eventName,
    eventPayload: {},
    mainSha: evidence.sourceSha,
    sourceCommit: {
      sha: evidence.sourceSha,
      parents: [sha("b")],
      tree: evidence.sourceCommit.tree,
    },
    priorActivationRuns: [run],
    priorActivationJob: job,
    workflows: structuredClone(evidence.workflows),
    final: {
      mainSha: evidence.sourceSha,
      priorActivationRun: structuredClone(run),
      priorActivationJob: structuredClone(job),
    },
  };
}

function expectPriorActivationCode(mutator, code) {
  const evidence = priorActivationFixture();
  mutator(evidence);
  assert.throws(
    () => verifyPromotionGateEvidence(config, evidence),
    (error) => error instanceof PromotionGateError && error.code === code,
  );
}

function git(repository, ...args) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("accepts exact promotion and ordinary PR merges", () => {
  assert.equal(verifyPromotionGateEvidence(config, fixture()).promotion, true);
  assert.equal(
    verifyPromotionGateEvidence(config, fixture({ promotion: false }))
      .promotion,
    false,
  );
});

test("blocks ordinary single-parent pushes and missing or duplicate trailers", () => {
  expectCode((value) => {
    value.sourceCommit.parents = [value.sourceCommit.parents[0]];
  }, "PROMOTION_GATE_DIRECT_PUSH_OR_TOPOLOGY_INVALID");
  expectCode((value) => {
    value.headCommit.message = value.headCommit.message.replace(
      /FrontMind-Product-Tree:.*\n/u,
      "",
    );
  }, "PROMOTION_TRAILER_COUNT_INVALID");
  expectCode((value) => {
    value.headCommit.message += `\nFrontMind-Dev-Source: ${sha("9")}`;
  }, "PROMOTION_TRAILER_COUNT_INVALID");
});

test("blocks moved heads, merge trees and main", () => {
  expectCode((value) => {
    value.pull.head.sha = sha("9");
    value.final.pull.head.sha = sha("9");
  }, "PROMOTION_GATE_PULL_REQUEST_IDENTITY_INVALID");
  expectCode((value) => {
    value.sourceCommit.tree = sha("9");
  }, "PROMOTION_GATE_MERGE_TREE_MISMATCH");
  expectCode((value) => {
    value.final.mainSha = sha("9");
  }, "PROMOTION_GATE_MAIN_MOVED");
});

test("blocks pending, failed, cancelled, wrong-path and ambiguous runs", () => {
  for (const [status, conclusion] of [
    ["in_progress", null],
    ["completed", "failure"],
    ["completed", "cancelled"],
  ]) {
    expectCode((value) => {
      value.workflowRuns[0].status = status;
      value.workflowRuns[0].conclusion = conclusion;
      value.final.run.status = status;
      value.final.run.conclusion = conclusion;
    }, "PROMOTION_GATE_WORKFLOW_NOT_SUCCESSFUL");
  }
  expectCode((value) => {
    value.workflowRuns[0].path = ".github/workflows/wrong.yml";
    value.final.run.path = ".github/workflows/wrong.yml";
  }, "PROMOTION_GATE_WORKFLOW_RUN_MISSING_OR_AMBIGUOUS");
  expectCode((value) => {
    const duplicate = structuredClone(value.workflowRuns[0]);
    duplicate.id = 92;
    duplicate.mergeProof.run.id = 92;
    duplicate.mergeArtifact.id = 502;
    duplicate.mergeArtifact.workflow_run.id = 92;
    value.workflowRuns.push(duplicate);
  }, "PROMOTION_GATE_WORKFLOW_RUN_MISSING_OR_AMBIGUOUS");
});

test("requires a canonical artifact proof bound to every exact identity", () => {
  const evidence = fixture();
  const run = evidence.workflowRuns[0];
  const raw = `${JSON.stringify(run.mergeProof)}\n`;
  assert.deepEqual(parseCanonicalMergeProof(raw), run.mergeProof);
  assert.throws(
    () =>
      parseCanonicalMergeProof(`${JSON.stringify(run.mergeProof, null, 2)}\n`),
    (error) =>
      error instanceof PromotionGateError &&
      error.code === "PROMOTION_GATE_MERGE_PROOF_NOT_CANONICAL",
  );
  validateMergeProof(config, run.mergeProof, {
    runId: run.id,
    runAttempt: run.run_attempt,
    pullNumber: evidence.pull.number,
    baseSha: evidence.sourceCommit.parents[0],
    headSha: evidence.pull.head.sha,
    testMergeSha: sha("d"),
    sourceParents: evidence.sourceCommit.parents,
    sourceTree: evidence.sourceCommit.tree,
  });
  for (const mutate of [
    (value) => {
      value.repository = "xiafanzeng/wrong";
    },
    (value) => {
      value.run.attempt += 1;
    },
    (value) => {
      value.pullRequest.number += 1;
    },
    (value) => {
      value.pullRequest.base.sha = sha("9");
    },
    (value) => {
      value.checkout.tree = sha("9");
    },
    (value) => {
      value.unexpected = true;
    },
  ]) {
    expectCode((value) => {
      mutate(value.workflowRuns[0].mergeProof);
      value.final.mergeProof = structuredClone(
        value.workflowRuns[0].mergeProof,
      );
    }, "PROMOTION_GATE_WORKFLOW_RUN_MISSING_OR_AMBIGUOUS");
  }
});

test("requires one unexpired digest-bound artifact for the run attempt", () => {
  const run = fixture().workflowRuns[0];
  const document = {
    total_count: 1,
    artifacts: [structuredClone(run.mergeArtifact)],
  };
  assert.equal(selectMergeProofArtifact(run, document).id, 501);
  assert.equal(
    selectMergeProofArtifact(run, { total_count: 0, artifacts: [] }),
    null,
  );
  assert.throws(
    () =>
      selectMergeProofArtifact(run, {
        total_count: 2,
        artifacts: [
          structuredClone(run.mergeArtifact),
          structuredClone(run.mergeArtifact),
        ],
      }),
    (error) =>
      error instanceof PromotionGateError &&
      error.code === "PROMOTION_GATE_MERGE_PROOF_ARTIFACT_AMBIGUOUS",
  );
  document.artifacts[0].digest = "not-a-digest";
  assert.throws(
    () => selectMergeProofArtifact(run, document),
    (error) =>
      error instanceof PromotionGateError &&
      error.code === "PROMOTION_GATE_MERGE_PROOF_ARTIFACT_INVALID",
  );
  document.artifacts[0] = structuredClone(run.mergeArtifact);
  document.artifacts[0].expired = true;
  assert.throws(
    () => selectMergeProofArtifact(run, document),
    (error) =>
      error instanceof PromotionGateError &&
      error.code === "PROMOTION_GATE_MERGE_PROOF_ARTIFACT_INVALID",
  );
});

test("selects only the activation job for the exact push run attempt", () => {
  const evidence = priorActivationFixture();
  const run = evidence.priorActivationRuns[0];
  const document = {
    total_count: 1,
    jobs: [structuredClone(evidence.priorActivationJob)],
  };
  assert.equal(selectPriorActivationJob(config, run, document).id, 701);
  assert.equal(
    selectPriorActivationJob(config, run, { total_count: 0, jobs: [] }),
    null,
  );
  assert.throws(
    () =>
      selectPriorActivationJob(config, run, {
        total_count: 2,
        jobs: [
          structuredClone(evidence.priorActivationJob),
          structuredClone(evidence.priorActivationJob),
        ],
      }),
    (error) =>
      error instanceof PromotionGateError &&
      error.code === "PROMOTION_GATE_ACTIVATION_JOB_AMBIGUOUS",
  );
  document.jobs[0].run_attempt += 1;
  assert.throws(
    () => selectPriorActivationJob(config, run, document),
    (error) =>
      error instanceof PromotionGateError &&
      error.code === "PROMOTION_GATE_ACTIVATION_JOB_IDENTITY_INVALID",
  );
});

test("proof writer records the actual clean PR test-merge checkout", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "frontmind-merge-proof-test-"),
  );
  const repository = join(temporary, "repository");
  const eventPath = join(temporary, "event.json");
  const outputPath = join(temporary, "proof.json");
  try {
    execFileSync("git", ["init", "-b", "main", repository], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    git(repository, "config", "user.name", "Promotion Gate Test");
    git(repository, "config", "user.email", "gate@example.invalid");
    await writeFile(join(repository, "fixture.txt"), "base\n", "utf8");
    git(repository, "add", "fixture.txt");
    git(repository, "commit", "-m", "base");
    const baseSha = git(repository, "rev-parse", "HEAD");
    git(repository, "checkout", "-b", "codex/promote-fixture");
    await writeFile(join(repository, "fixture.txt"), "candidate\n", "utf8");
    git(repository, "add", "fixture.txt");
    git(repository, "commit", "-m", "candidate");
    const headSha = git(repository, "rev-parse", "HEAD");
    const tree = git(repository, "rev-parse", `${headSha}^{tree}`);
    const mergeSha = execFileSync(
      "git",
      ["commit-tree", tree, "-p", baseSha, "-p", headSha],
      {
        cwd: repository,
        input: "synthetic pull request merge\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    git(repository, "checkout", "--detach", mergeSha);
    await writeFile(
      eventPath,
      `${JSON.stringify({
        pull_request: {
          number: 17,
          base: {
            ref: "main",
            sha: baseSha,
            repo: { full_name: config.repository },
          },
          head: {
            ref: "codex/promote-fixture",
            sha: headSha,
            repo: { full_name: config.repository },
          },
        },
      })}\n`,
      "utf8",
    );
    execFileSync(
      process.execPath,
      [
        new URL(
          "../.github/scripts/write-promotion-merge-proof.mjs",
          import.meta.url,
        ).pathname,
        "--repository",
        config.repository,
        "--workflow-name",
        config.workflowName,
        "--workflow-path",
        config.workflowPath,
        "--output",
        outputPath,
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: config.repository,
          GITHUB_SHA: mergeSha,
          GITHUB_WORKFLOW: config.workflowName,
          GITHUB_RUN_ID: "901",
          GITHUB_RUN_ATTEMPT: "2",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const proof = parseCanonicalMergeProof(await readFile(outputPath, "utf8"));
    validateMergeProof(config, proof, {
      runId: 901,
      runAttempt: 2,
      pullNumber: 17,
      baseSha,
      headRef: "codex/promote-fixture",
      headSha,
      testMergeSha: mergeSha,
      sourceParents: [baseSha, headSha],
      sourceTree: tree,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("allows non-push dispatch to reuse only the same successfully activated source", () => {
  for (const eventName of ["workflow_dispatch", "repository_dispatch"]) {
    const result = verifyPromotionGateEvidence(
      config,
      priorActivationFixture(eventName),
    );
    assert.equal(result.sourceSha, sha("a"));
    assert.equal(result.priorActivation, true);
  }
});

test("allows non-push dispatch to use full PR proof when no activation attempt exists", () => {
  const evidence = fixture();
  evidence.eventName = "workflow_dispatch";
  evidence.eventPayload = {};
  evidence.priorActivationRuns = [];
  const result = verifyPromotionGateEvidence(config, evidence);
  assert.equal(result.sourceSha, evidence.sourceSha);
  assert.equal(result.priorActivation, undefined);
});

test("fails closed on wrong, incomplete or moving prior activation evidence", () => {
  for (const [status, conclusion] of [
    ["in_progress", null],
    ["completed", "failure"],
    ["completed", "cancelled"],
  ]) {
    expectPriorActivationCode((value) => {
      value.priorActivationRuns[0].status = status;
      value.priorActivationRuns[0].conclusion = conclusion;
      value.final.priorActivationRun.status = status;
      value.final.priorActivationRun.conclusion = conclusion;
    }, "PROMOTION_GATE_PRIOR_ACTIVATION_NOT_SUCCESSFUL");
  }
  expectPriorActivationCode((value) => {
    value.priorActivationJob.conclusion = "failure";
    value.final.priorActivationJob.conclusion = "failure";
  }, "PROMOTION_GATE_PRIOR_ACTIVATION_JOB_NOT_SUCCESSFUL");
  expectPriorActivationCode((value) => {
    value.priorActivationRuns[0].head_sha = sha("9");
    value.final.priorActivationRun.head_sha = sha("9");
  }, "PROMOTION_GATE_PRIOR_ACTIVATION_MISSING_OR_AMBIGUOUS");
  expectPriorActivationCode((value) => {
    value.priorActivationRuns[0].path = ".github/workflows/wrong.yml";
    value.final.priorActivationRun.path = ".github/workflows/wrong.yml";
  }, "PROMOTION_GATE_PRIOR_ACTIVATION_MISSING_OR_AMBIGUOUS");
  expectPriorActivationCode((value) => {
    value.priorActivationRuns.push(
      structuredClone(value.priorActivationRuns[0]),
    );
  }, "PROMOTION_GATE_PRIOR_ACTIVATION_MISSING_OR_AMBIGUOUS");
  expectPriorActivationCode((value) => {
    value.final.priorActivationRun.run_attempt += 1;
  }, "PROMOTION_GATE_EVIDENCE_MOVED_DURING_VERIFICATION");
  expectPriorActivationCode((value) => {
    value.final.mainSha = sha("9");
  }, "PROMOTION_GATE_MAIN_MOVED");
});

test("push never uses prior activation as a direct-push bypass", () => {
  const evidence = priorActivationFixture();
  evidence.eventName = "push";
  evidence.eventPayload = {
    ref: "refs/heads/main",
    after: evidence.sourceSha,
  };
  assert.throws(
    () => verifyPromotionGateEvidence(config, evidence),
    (error) =>
      error instanceof PromotionGateError &&
      error.code === "PROMOTION_GATE_DIRECT_PUSH_OR_TOPOLOGY_INVALID",
  );
});

test("does not depend on branch settings or commit-status APIs", async () => {
  const runtime = await readFile(
    new URL(
      "../.github/scripts/verify-promotion-main-push.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  for (const forbidden of [
    "/branches/",
    "/rulesets",
    "/statuses/",
    "/check-runs",
  ]) {
    assert.equal(runtime.includes(forbidden), false, forbidden);
  }
  assert.ok(runtime.includes("head_sha=${pull.head.sha}"));
  assert.ok(runtime.includes("actions/runs?head_sha=${sourceSha}"));
  assert.ok(runtime.includes("/attempts/"));
  assert.ok(runtime.includes("priorActivationEvents.includes(run?.event)"));
  assert.ok(runtime.includes("latestExactPullRun(finalPull)"));
  assert.ok(runtime.includes("/artifacts?per_page=100"));
  assert.equal(runtime.includes("run.pull_requests.some"), false);
  const wrapper = await readFile(
    new URL(
      "../.github/scripts/verify-promotion-main-push.sh",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(
    wrapper.includes(`--activation-job-name "${config.activationJobName}"`),
  );
  assert.ok(
    wrapper.includes(
      '--prior-activation-events "push,workflow_dispatch,repository_dispatch"',
    ),
  );
});

test("workflow binds direct main activation to the exact source without duplicate CI blockers", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/dashboard-ci.yml", import.meta.url),
    "utf8",
  );
  const activation = workflow.slice(workflow.indexOf("  build-sign-deploy:"));
  assert.match(activation, /needs:\s*[\s\S]*- promotion-gate/u);
  assert.match(activation, /needs\.promotion-gate\.result == 'success'/u);
  assert.doesNotMatch(activation, /needs:\s*[\s\S]*- quality/u);
  assert.doesNotMatch(activation, /needs:\s*[\s\S]*- mysql-acceptance/u);
  for (const operation of [
    "docker/build-push-action",
    "cosign sign",
    "ssh -T",
    "mark-ghcr-promoted",
  ]) {
    assert.ok(activation.includes(operation), operation);
  }
  const proof = workflow.slice(
    workflow.indexOf("  promotion-merge-proof:"),
    workflow.indexOf("  build-sign-deploy:"),
  );
  assert.match(proof, /needs:\s*[\s\S]*- quality[\s\S]*- mysql-acceptance/u);
  assert.ok(proof.includes("write-promotion-merge-proof.mjs"));
  assert.ok(proof.includes("actions/upload-artifact@v4"));
  const source = workflow.slice(
    workflow.indexOf("  promotion-gate:"),
    workflow.indexOf("  changes:"),
  );
  assert.ok(source.includes('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'));
  assert.ok(!source.includes("verify-promotion-main-push.sh"));
});
