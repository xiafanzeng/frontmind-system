import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MERGE_PROOF_FILE,
  PromotionGateError,
  mergeProofArtifactName,
} from "../.github/scripts/promotion-gate-core.mjs";
import { runPromotionGate } from "../.github/scripts/verify-promotion-main-push.mjs";

const sha = (character) => character.repeat(40);
const isWebsite = import.meta.url.includes("/frontmind-website/");
const service = isWebsite ? "website" : "dashboard";
const config = {
  repository: `xiafanzeng/frontmind-${service}`,
  workflowName: isWebsite
    ? "Website CI and release"
    : "Dashboard CI and release",
  workflowPath: isWebsite
    ? ".github/workflows/ci-release.yml"
    : ".github/workflows/dashboard-ci.yml",
  activationJobName: isWebsite
    ? "Deploy signed website digest"
    : "Build, sign and deploy immutable image",
  priorActivationEvents: isWebsite
    ? "none"
    : "push,workflow_dispatch,repository_dispatch",
};

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function proofArchive(proof) {
  const directory = await mkdtemp(join(tmpdir(), "promotion-runtime-proof-"));
  try {
    const proofPath = join(directory, MERGE_PROOF_FILE);
    const archivePath = join(directory, "proof.zip");
    await writeFile(proofPath, `${JSON.stringify(proof)}\n`, "utf8");
    execFileSync("zip", ["-q", "-X", archivePath, MERGE_PROOF_FILE], {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return await readFile(archivePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fullProofHarness({
  eventName = "push",
  priorRuns = null,
  olderRuns = [],
  finalRuns = null,
} = {}) {
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
      ref: `codex/promote-${service}-c`,
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
  };
  const proof = {
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
  const archive = await proofArchive(proof);
  const artifact = {
    id: 501,
    name: mergeProofArtifactName(run.run_attempt),
    size_in_bytes: archive.byteLength,
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    expired: false,
    archive_download_url:
      `https://api.github.com/repos/${config.repository}/actions/artifacts/501/zip`,
    workflow_run: {
      id: run.id,
      head_sha: run.head_sha,
      head_branch: run.head_branch,
    },
  };
  const initialRunList = [...olderRuns, run];
  const runLists = [
    initialRunList,
    finalRuns ?? initialRunList.map((value) => structuredClone(value)),
  ];
  const calls = [];
  let runListRead = 0;
  let pullRead = 0;
  let headCommitRead = 0;
  let mainRead = 0;
  let olderArtifactReads = 0;

  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    const route = `${url.pathname}${url.search}`;
    calls.push(route);
    if (
      route ===
      `/repos/${config.repository}/git/ref/heads/main`
    ) {
      mainRead += 1;
      return jsonResponse({ object: { sha: sourceSha } });
    }
    if (
      route ===
      `/repos/${config.repository}/actions/runs?head_sha=${sourceSha}&per_page=100`
    ) {
      return jsonResponse({
        total_count: priorRuns?.length ?? 0,
        workflow_runs: priorRuns ?? [],
      });
    }
    if (
      route ===
      `/repos/${config.repository}/commits/${sourceSha}/pulls?per_page=100`
    ) {
      return jsonResponse([pull]);
    }
    if (route === `/repos/${config.repository}/pulls/${pull.number}`) {
      pullRead += 1;
      return jsonResponse(structuredClone(pull));
    }
    if (
      route ===
      `/repos/${config.repository}/git/commits/${headSha}`
    ) {
      headCommitRead += 1;
      return jsonResponse({
        sha: headSha,
        parents: [{ sha: baseSha }],
        tree: { sha: tree },
        message: [
          "Promote exact Dev",
          "",
          `FrontMind-Dev-Source: ${sha("f")}`,
          `FrontMind-Product-Tree: sha256:${"1".repeat(64)}`,
          `FrontMind-Projection-Policy: sha256:${"2".repeat(64)}`,
        ].join("\n"),
      });
    }
    if (
      route ===
      `/repos/${config.repository}/actions/runs?event=pull_request&head_sha=${headSha}&per_page=100`
    ) {
      const workflowRuns =
        runLists[Math.min(runListRead, runLists.length - 1)];
      runListRead += 1;
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: structuredClone(workflowRuns),
      });
    }
    if (
      route ===
      `/repos/${config.repository}/actions/runs/${run.id}/artifacts?per_page=100`
    ) {
      return jsonResponse({
        total_count: 1,
        artifacts: [structuredClone(artifact)],
      });
    }
    for (const oldRun of olderRuns) {
      if (
        route ===
        `/repos/${config.repository}/actions/runs/${oldRun.id}/artifacts?per_page=100`
      ) {
        olderArtifactReads += 1;
        const expired = {
          ...structuredClone(artifact),
          id: 499,
          expired: true,
          workflow_run: {
            id: oldRun.id,
            head_sha: oldRun.head_sha,
            head_branch: oldRun.head_branch,
          },
        };
        return jsonResponse({
          total_count: 2,
          artifacts: [expired, structuredClone(expired)],
        });
      }
    }
    const latestFinal = finalRuns?.[0];
    if (
      latestFinal &&
      latestFinal.id !== run.id &&
      route ===
        `/repos/${config.repository}/actions/runs/${latestFinal.id}/artifacts?per_page=100`
    ) {
      return jsonResponse({ total_count: 0, artifacts: [] });
    }
    if (
      route ===
      `/repos/${config.repository}/actions/workflows/${run.workflow_id}`
    ) {
      return jsonResponse({
        id: run.workflow_id,
        name: config.workflowName,
        path: config.workflowPath,
        state: "active",
      });
    }
    if (
      route ===
      `/repos/${config.repository}/actions/artifacts/${artifact.id}/zip`
    ) {
      return new Response(archive, { status: 200 });
    }
    throw new Error(`unexpected API request: ${route}`);
  };

  const gitCommand = (...args) => {
    const command = args.join(" ");
    if (command === "rev-parse HEAD") return sourceSha;
    if (command === "status --porcelain=v1 --untracked-files=all") return "";
    if (command === `show -s --format=%P ${sourceSha}`) {
      return `${baseSha} ${headSha}`;
    }
    if (command === `rev-parse ${sourceSha}^{tree}`) return tree;
    if (command === `show -s --format=%B ${sourceSha}`) {
      return "PR merge";
    }
    throw new Error(`unexpected git command: ${command}`);
  };
  const argv = [
    "node",
    "gate",
    "--repository",
    config.repository,
    "--source-sha",
    sourceSha,
    "--workflow-name",
    config.workflowName,
    "--workflow-path",
    config.workflowPath,
    "--activation-job-name",
    config.activationJobName,
    "--prior-activation-events",
    config.priorActivationEvents,
    "--event-name",
    eventName,
    "--event-path",
    "/event.json",
  ];
  return {
    calls,
    counters: () => ({
      mainRead,
      pullRead,
      headCommitRead,
      runListRead,
      olderArtifactReads,
    }),
    invoke: () =>
      runPromotionGate({
        argv,
        env: { GITHUB_TOKEN: "test-token" },
        fetchImpl,
        gitCommand,
        readFileImpl: async () =>
          JSON.stringify(
            eventName === "push"
              ? { ref: "refs/heads/main", after: sourceSha }
              : {},
          ),
      }),
    pull,
    run,
    sourceSha,
  };
}

test("runtime selects only the latest exact PR run and ignores older expired or duplicate evidence", async () => {
  const older = {
    id: 90,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    name: config.workflowName,
    path: config.workflowPath,
    head_sha: sha("c"),
    head_branch: `codex/promote-${service}-c`,
    workflow_id: 44,
  };
  const harness = await fullProofHarness({ olderRuns: [older] });
  const result = await harness.invoke();
  assert.equal(result.workflowRunId, 91);
  assert.equal(
    harness.calls.some((route) => route.includes("/runs/90/artifacts")),
    false,
  );
  assert.equal(harness.counters().olderArtifactReads, 0);
  assert.equal(harness.counters().runListRead, 2);
});

test("runtime rejects when the latest exact PR run changes during final reread", async () => {
  const newer = {
    id: 92,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    event: "pull_request",
    name: config.workflowName,
    path: config.workflowPath,
    head_sha: sha("c"),
    head_branch: `codex/promote-${service}-c`,
    workflow_id: 44,
  };
  const harness = await fullProofHarness({ finalRuns: [newer] });
  await assert.rejects(
    harness.invoke(),
    (error) =>
      error instanceof PromotionGateError &&
      error.code === "PROMOTION_GATE_EVIDENCE_MOVED_DURING_VERIFICATION",
  );
});

test("runtime recognizes successful activation-capable dispatch runs", {
  skip: isWebsite,
}, async () => {
  for (const priorEvent of ["workflow_dispatch", "repository_dispatch"]) {
    const sourceSha = sha("a");
    const baseSha = sha("b");
    const tree = sha("e");
    const run = {
      id: priorEvent === "workflow_dispatch" ? 191 : 192,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      event: priorEvent,
      name: config.workflowName,
      path: config.workflowPath,
      head_sha: sourceSha,
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
    let mainReads = 0;
    let jobReads = 0;
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      const route = `${url.pathname}${url.search}`;
      if (route === `/repos/${config.repository}/git/ref/heads/main`) {
        mainReads += 1;
        return jsonResponse({ object: { sha: sourceSha } });
      }
      if (
        route ===
        `/repos/${config.repository}/actions/runs?head_sha=${sourceSha}&per_page=100`
      ) {
        return jsonResponse({ total_count: 1, workflow_runs: [run] });
      }
      if (
        route ===
        `/repos/${config.repository}/actions/workflows/${run.workflow_id}`
      ) {
        return jsonResponse({
          id: run.workflow_id,
          name: run.name,
          path: run.path,
          state: "active",
        });
      }
      if (
        route ===
        `/repos/${config.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
      ) {
        jobReads += 1;
        return jsonResponse({ total_count: 1, jobs: [job] });
      }
      if (route === `/repos/${config.repository}/actions/runs/${run.id}`) {
        return jsonResponse(run);
      }
      throw new Error(`unexpected API request: ${route}`);
    };
    const result = await runPromotionGate({
      argv: [
        "node",
        "gate",
        "--repository",
        config.repository,
        "--source-sha",
        sourceSha,
        "--workflow-name",
        config.workflowName,
        "--workflow-path",
        config.workflowPath,
        "--activation-job-name",
        config.activationJobName,
        "--prior-activation-events",
        config.priorActivationEvents,
        "--event-name",
        "workflow_dispatch",
        "--event-path",
        "/event.json",
      ],
      env: { GITHUB_TOKEN: "test-token" },
      fetchImpl,
      gitCommand: (...args) => {
        const command = args.join(" ");
        if (command === "rev-parse HEAD") return sourceSha;
        if (command === "status --porcelain=v1 --untracked-files=all") return "";
        if (command === `show -s --format=%P ${sourceSha}`) return baseSha;
        if (command === `rev-parse ${sourceSha}^{tree}`) return tree;
        if (command === `show -s --format=%B ${sourceSha}`) return "source";
        throw new Error(`unexpected git command: ${command}`);
      },
      readFileImpl: async () => "{}",
    });
    assert.equal(result.priorActivation, true);
    assert.equal(result.workflowRunId, run.id);
    assert.equal(mainReads, 2);
    assert.equal(jobReads, 2);
  }
});

test("failed activation attempt falls through to a complete exact-PR proof", {
  skip: isWebsite,
}, async () => {
  const failed = {
    id: 190,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    event: "push",
    name: config.workflowName,
    path: config.workflowPath,
    head_sha: sha("a"),
    head_branch: "main",
    workflow_id: 44,
  };
  const harness = await fullProofHarness({
    eventName: "repository_dispatch",
    priorRuns: [failed],
  });
  const result = await harness.invoke();
  assert.equal(result.workflowRunId, 91);
  assert.equal(result.priorActivation, undefined);
});

test("runtime disables non-push activation recovery when the adapter has no activation route", {
  skip: !isWebsite,
}, async () => {
  const ignored = {
    id: 190,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "push",
    name: config.workflowName,
    path: config.workflowPath,
    head_sha: sha("a"),
    head_branch: "main",
    workflow_id: 44,
  };
  const harness = await fullProofHarness({
    eventName: "workflow_dispatch",
    priorRuns: [ignored],
  });
  const result = await harness.invoke();
  assert.equal(result.workflowRunId, 91);
  assert.equal(
    harness.calls.some((route) =>
      route.includes(`actions/runs?head_sha=${harness.sourceSha}`),
    ),
    false,
  );
});
