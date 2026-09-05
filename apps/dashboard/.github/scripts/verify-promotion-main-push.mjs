import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MERGE_PROOF_FILE,
  PromotionGateError,
  identityRunsForEvidence,
  parseCanonicalMergeProof,
  selectMergeProofArtifact,
  selectPriorActivationJob,
  validateMergeProof,
  verifyPromotionGateEvidence,
} from "./promotion-gate-core.mjs";

const MAX_ARTIFACT_BYTES = 1_000_000;

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) {
    throw new PromotionGateError("PROMOTION_GATE_ARGUMENT_MISSING", { name });
  }
  return argv[index + 1];
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function localCommit(sha, gitCommand = git) {
  return {
    sha,
    parents: gitCommand("show", "-s", "--format=%P", sha)
      .split(/\s+/u)
      .filter(Boolean),
    tree: gitCommand("rev-parse", `${sha}^{tree}`),
    message: gitCommand("show", "-s", "--format=%B", sha),
  };
}

function parsePriorActivationEvents(value) {
  if (value === "none") return [];
  const events = value.split(",").filter(Boolean);
  const allowed = new Set(["push", "workflow_dispatch", "repository_dispatch"]);
  if (
    events.length === 0 ||
    new Set(events).size !== events.length ||
    events.some((event) => !allowed.has(event))
  ) {
    throw new PromotionGateError(
      "PROMOTION_GATE_PRIOR_ACTIVATION_EVENTS_INVALID",
      { value },
    );
  }
  return events;
}

export async function runPromotionGate({
  argv = process.argv,
  env = process.env,
  fetchImpl = globalThis.fetch,
  gitCommand = git,
  readFileImpl = readFile,
} = {}) {
  const repository = argument(argv, "--repository");
  const sourceSha = argument(argv, "--source-sha");
  const workflowName = argument(argv, "--workflow-name");
  const workflowPath = argument(argv, "--workflow-path");
  const activationJobName = argument(argv, "--activation-job-name");
  const priorActivationEvents = parsePriorActivationEvents(
    argument(argv, "--prior-activation-events"),
  );
  const eventName = argument(argv, "--event-name");
  const eventPath = argument(argv, "--event-path");
  const config = {
    repository,
    workflowName,
    workflowPath,
    activationJobName,
    priorActivationEvents,
  };
  const token = env.GITHUB_TOKEN;
  if (!token) throw new PromotionGateError("PROMOTION_GATE_TOKEN_MISSING");
  if (gitCommand("rev-parse", "HEAD") !== sourceSha) {
    throw new PromotionGateError("PROMOTION_GATE_CHECKOUT_MISMATCH");
  }
  if (gitCommand("status", "--porcelain=v1", "--untracked-files=all")) {
    throw new PromotionGateError("PROMOTION_GATE_CHECKOUT_DIRTY");
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function api(path, { rejectPagination = false } = {}) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers,
    });
    if (!response.ok) {
      throw new PromotionGateError("PROMOTION_GATE_GITHUB_API_FAILED", {
        path,
        status: response.status,
      });
    }
    if (
      rejectPagination &&
      /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*,|$)/u.test(
        response.headers.get("link") ?? "",
      )
    ) {
      throw new PromotionGateError("PROMOTION_GATE_GITHUB_RESULT_TRUNCATED", {
        path,
      });
    }
    return response.json();
  }
  async function downloadMergeProof(artifact) {
    const expectedUrl =
      `https://api.github.com/repos/${repository}/actions/artifacts/` +
      `${artifact.id}/zip`;
    if (artifact.archive_download_url !== expectedUrl) {
      throw new PromotionGateError(
        "PROMOTION_GATE_ARTIFACT_DOWNLOAD_URL_INVALID",
      );
    }
    const response = await fetchImpl(expectedUrl, {
      headers,
      redirect: "follow",
    });
    if (!response.ok || !response.body) {
      throw new PromotionGateError("PROMOTION_GATE_ARTIFACT_DOWNLOAD_FAILED", {
        status: response.status,
      });
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_ARTIFACT_BYTES) {
        throw new PromotionGateError("PROMOTION_GATE_ARTIFACT_TOO_LARGE");
      }
      chunks.push(Buffer.from(chunk));
    }
    const archive = Buffer.concat(chunks);
    if (archive.byteLength !== artifact.size_in_bytes) {
      throw new PromotionGateError("PROMOTION_GATE_ARTIFACT_SIZE_MISMATCH", {
        expected: artifact.size_in_bytes,
        actual: archive.byteLength,
      });
    }
    const digest =
      `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    if (digest !== artifact.digest) {
      throw new PromotionGateError("PROMOTION_GATE_ARTIFACT_DIGEST_MISMATCH");
    }

    const temporary = await mkdtemp(
      join(tmpdir(), "frontmind-promotion-merge-proof-"),
    );
    try {
      const archivePath = join(temporary, "artifact.zip");
      await writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
      const listing = execFileSync("unzip", ["-Z1", archivePath], {
        encoding: "utf8",
        maxBuffer: 64_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (listing !== `${MERGE_PROOF_FILE}\n`) {
        throw new PromotionGateError("PROMOTION_GATE_ARTIFACT_CONTENTS_INVALID");
      }
      const proofBytes = execFileSync(
        "unzip",
        ["-p", archivePath, MERGE_PROOF_FILE],
        {
          encoding: null,
          maxBuffer: 128_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let raw;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(proofBytes);
      } catch {
        throw new PromotionGateError("PROMOTION_GATE_MERGE_PROOF_UTF8_INVALID");
      }
      return parseCanonicalMergeProof(raw);
    } finally {
      await rm(temporary, { recursive: true, force: false });
    }
  }
  async function mergeProofForRun(run) {
    const document = await api(
      `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    const artifact = selectMergeProofArtifact(run, document);
    if (!artifact) return null;
    const proof = await downloadMergeProof(artifact);
    validateMergeProof(
      config,
      proof,
      {
        runId: run.id,
        runAttempt: run.run_attempt,
        headRef: run.head_branch,
        headSha: run.head_sha,
        headRepository: repository,
      },
    );
    return { artifact, proof };
  }
  async function mainSha() {
    const ref = await api(`/repos/${repository}/git/ref/heads/main`);
    return ref?.object?.sha;
  }
  async function apiCommit(sha) {
    const commit = await api(`/repos/${repository}/git/commits/${sha}`);
    return {
      sha: commit.sha,
      parents: (commit.parents ?? []).map((parent) => parent.sha),
      tree: commit.tree?.sha,
      message: commit.message,
    };
  }
  async function latestExactPullRun(pull) {
    if (!pull?.head?.sha || !pull?.head?.ref) return null;
    const document = await api(
      `/repos/${repository}/actions/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`,
    );
    if (
      !Number.isSafeInteger(document?.total_count) ||
      document.total_count < 0 ||
      document.total_count > 100 ||
      !Array.isArray(document.workflow_runs) ||
      document.workflow_runs.length !== document.total_count
    ) {
      throw new PromotionGateError("PROMOTION_GATE_WORKFLOW_RUNS_TRUNCATED");
    }
    return (
      document.workflow_runs
        .filter(
          (run) =>
            run?.name === workflowName &&
            String(run?.path ?? "").split("@", 1)[0] === workflowPath &&
            run?.event === "pull_request" &&
            run?.head_sha === pull.head.sha &&
            run?.head_branch === pull.head.ref &&
            Number.isSafeInteger(run?.id) &&
            run.id > 0 &&
            Number.isSafeInteger(run?.run_attempt) &&
            run.run_attempt > 0 &&
            Number.isSafeInteger(run?.workflow_id) &&
            run.workflow_id > 0,
        )
        .sort((left, right) => right.id - left.id)[0] ?? null
    );
  }

  const eventPayload = JSON.parse(await readFileImpl(eventPath, "utf8"));
  const initialMainSha = await mainSha();
  const sourceCommit = localCommit(sourceSha, gitCommand);
  if (eventName !== "push" && priorActivationEvents.length > 0) {
    const priorRunsDocument = await api(
      `/repos/${repository}/actions/runs?head_sha=${sourceSha}&per_page=100`,
    );
    if (
      !Number.isSafeInteger(priorRunsDocument?.total_count) ||
      priorRunsDocument.total_count < 0 ||
      priorRunsDocument.total_count > 100 ||
      !Array.isArray(priorRunsDocument.workflow_runs) ||
      priorRunsDocument.workflow_runs.length !== priorRunsDocument.total_count
    ) {
      throw new PromotionGateError(
        "PROMOTION_GATE_PRIOR_ACTIVATION_RUNS_INVALID",
      );
    }
    const candidates = priorRunsDocument.workflow_runs
      .filter(
        (run) =>
          run?.name === workflowName &&
          String(run?.path ?? "").split("@", 1)[0] === workflowPath &&
          priorActivationEvents.includes(run?.event) &&
          run?.head_sha === sourceSha &&
          run?.head_branch === "main" &&
          Number.isSafeInteger(run?.id) &&
          run.id > 0 &&
          Number.isSafeInteger(run?.run_attempt) &&
          run.run_attempt > 0 &&
          Number.isSafeInteger(run?.workflow_id) &&
          run.workflow_id > 0,
      )
      .sort((left, right) => right.id - left.id);
    const workflows = {};
    let priorRun = null;
    let priorActivationJob = null;
    for (const candidate of candidates) {
      if (
        candidate.status !== "completed" ||
        candidate.conclusion !== "success"
      ) {
        continue;
      }
      const workflow =
        workflows[String(candidate.workflow_id)] ??
        (await api(
          `/repos/${repository}/actions/workflows/${candidate.workflow_id}`,
        ));
      workflows[String(candidate.workflow_id)] = workflow;
      if (
        workflow?.id !== candidate.workflow_id ||
        workflow?.name !== workflowName ||
        workflow?.path !== workflowPath ||
        workflow?.state !== "active"
      ) {
        continue;
      }
      const jobs = await api(
        `/repos/${repository}/actions/runs/${candidate.id}/attempts/` +
          `${candidate.run_attempt}/jobs?per_page=100`,
      );
      let job;
      try {
        job = selectPriorActivationJob(config, candidate, jobs);
      } catch (error) {
        if (error instanceof PromotionGateError) continue;
        throw error;
      }
      if (job?.status === "completed" && job?.conclusion === "success") {
        priorRun = candidate;
        priorActivationJob = job;
        break;
      }
    }
    if (priorRun && priorActivationJob) {
      const finalRun = await api(
        `/repos/${repository}/actions/runs/${priorRun.id}`,
      );
      const finalJobs = await api(
        `/repos/${repository}/actions/runs/${finalRun.id}/attempts/` +
          `${finalRun.run_attempt}/jobs?per_page=100`,
      );
      const finalActivationJob = selectPriorActivationJob(
        config,
        finalRun,
        finalJobs,
      );
      return verifyPromotionGateEvidence(config, {
        sourceSha,
        eventName,
        eventPayload,
        mainSha: initialMainSha,
        sourceCommit,
        priorActivationRuns: [priorRun],
        priorActivationJob,
        workflows,
        final: {
          mainSha: await mainSha(),
          priorActivationRun: finalRun,
          priorActivationJob: finalActivationJob,
        },
      });
    }
  }
  const associatedPulls = await api(
    `/repos/${repository}/commits/${sourceSha}/pulls?per_page=100`,
    { rejectPagination: true },
  );
  if (!Array.isArray(associatedPulls)) {
    throw new PromotionGateError("PROMOTION_GATE_PULL_REQUEST_LIST_INVALID");
  }
  const exactPulls = associatedPulls.filter(
    (pull) =>
      pull?.merge_commit_sha === sourceSha &&
      pull?.base?.ref === "main" &&
      pull?.head?.repo?.full_name === repository,
  );
  const pullNumber = exactPulls.length === 1 ? exactPulls[0].number : 0;
  const pull = pullNumber
    ? await api(`/repos/${repository}/pulls/${pullNumber}`)
    : null;
  const headCommit = pull?.head?.sha ? await apiCommit(pull.head.sha) : null;
  const latestRun = await latestExactPullRun(pull);
  const workflowRuns = [];
  const workflows = {};
  if (latestRun) {
    const mergeProof = await mergeProofForRun(latestRun);
    if (mergeProof) {
      workflowRuns.push({
        ...latestRun,
        mergeArtifact: mergeProof.artifact,
        mergeProof: mergeProof.proof,
      });
    }
    if (!workflows[String(latestRun.workflow_id)]) {
      workflows[String(latestRun.workflow_id)] = await api(
        `/repos/${repository}/actions/workflows/${latestRun.workflow_id}`,
      );
    }
  }
  const identityRuns = identityRunsForEvidence(
    config,
    { sourceCommit, pull, headCommit, workflowRuns },
  );
  const identityRun = identityRuns.length === 1 ? identityRuns[0] : null;
  const finalPull = pullNumber
    ? await api(`/repos/${repository}/pulls/${pullNumber}`)
    : null;
  const finalRun = identityRun ? await latestExactPullRun(finalPull) : null;
  const finalHeadCommit = finalPull?.head?.sha
    ? await apiCommit(finalPull.head.sha)
    : null;
  const finalMergeProof = finalRun ? await mergeProofForRun(finalRun) : null;

  return verifyPromotionGateEvidence(
    config,
    {
      sourceSha,
      eventName,
      eventPayload,
      mainSha: initialMainSha,
      sourceCommit,
      associatedPulls: exactPulls,
      pull,
      headCommit,
      workflowRuns,
      workflows,
      final: {
        mainSha: await mainSha(),
        pull: finalPull,
        run: finalRun,
        headCommit: finalHeadCommit,
        mergeArtifact: finalMergeProof?.artifact ?? null,
        mergeProof: finalMergeProof?.proof ?? null,
      },
    },
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runPromotionGate()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      const code =
        error instanceof PromotionGateError
          ? error.code
          : "PROMOTION_GATE_UNEXPECTED_FAILURE";
      const details = error instanceof PromotionGateError ? error.details : {};
      process.stderr.write(`${code} ${JSON.stringify(details)}\n`);
      process.exitCode = 1;
    });
}
