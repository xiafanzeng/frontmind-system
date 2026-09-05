const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TRAILER_KEYS = [
  "FrontMind-Dev-Source",
  "FrontMind-Product-Tree",
  "FrontMind-Projection-Policy",
];
export const MERGE_PROOF_KIND = "frontmind.production-pr-merge-proof";
export const MERGE_PROOF_FILE = "promotion-merge-proof.json";
export const MERGE_PROOF_ARTIFACT_PREFIX =
  "frontmind-production-merge-proof-attempt-";
const MAX_MERGE_PROOF_ARTIFACT_BYTES = 1_000_000;

export class PromotionGateError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "PromotionGateError";
    this.code = code;
    this.details = details;
  }
}

function reject(code, details) {
  throw new PromotionGateError(code, details);
}

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function objectWithExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    sameValues(Object.keys(value).sort(), [...keys].sort())
  );
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function mergeProofArtifactName(runAttempt) {
  if (!positiveInteger(runAttempt)) {
    reject("PROMOTION_GATE_RUN_ATTEMPT_INVALID", { runAttempt });
  }
  return `${MERGE_PROOF_ARTIFACT_PREFIX}${runAttempt}`;
}

export function parseCanonicalMergeProof(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 64_000) {
    reject("PROMOTION_GATE_MERGE_PROOF_JSON_INVALID");
  }
  let proof;
  try {
    proof = JSON.parse(raw);
  } catch {
    reject("PROMOTION_GATE_MERGE_PROOF_JSON_INVALID");
  }
  if (`${JSON.stringify(proof)}\n` !== raw) {
    reject("PROMOTION_GATE_MERGE_PROOF_NOT_CANONICAL");
  }
  return proof;
}

export function validateMergeProof(config, proof, expected = {}) {
  if (
    !objectWithExactKeys(proof, [
      "schemaVersion",
      "kind",
      "repository",
      "workflow",
      "run",
      "pullRequest",
      "checkout",
    ]) ||
    !objectWithExactKeys(proof?.workflow, ["name", "path"]) ||
    !objectWithExactKeys(proof?.run, ["id", "attempt", "event"]) ||
    !objectWithExactKeys(proof?.pullRequest, ["number", "base", "head"]) ||
    !objectWithExactKeys(proof?.pullRequest?.base, ["ref", "sha"]) ||
    !objectWithExactKeys(proof?.pullRequest?.head, [
      "ref",
      "sha",
      "repository",
    ]) ||
    !objectWithExactKeys(proof?.checkout, ["sha", "parents", "tree"])
  ) {
    reject("PROMOTION_GATE_MERGE_PROOF_SCHEMA_INVALID");
  }
  if (
    proof.schemaVersion !== 1 ||
    proof.kind !== MERGE_PROOF_KIND ||
    proof.repository !== config.repository ||
    proof.workflow.name !== config.workflowName ||
    proof.workflow.path !== config.workflowPath ||
    !positiveInteger(proof.run.id) ||
    !positiveInteger(proof.run.attempt) ||
    proof.run.event !== "pull_request" ||
    !positiveInteger(proof.pullRequest.number) ||
    proof.pullRequest.base.ref !== "main" ||
    !SHA_PATTERN.test(proof.pullRequest.base.sha ?? "") ||
    typeof proof.pullRequest.head.ref !== "string" ||
    !proof.pullRequest.head.ref ||
    !SHA_PATTERN.test(proof.pullRequest.head.sha ?? "") ||
    proof.pullRequest.head.repository !== config.repository ||
    !SHA_PATTERN.test(proof.checkout.sha ?? "") ||
    !Array.isArray(proof.checkout.parents) ||
    proof.checkout.parents.length !== 2 ||
    !proof.checkout.parents.every((value) => SHA_PATTERN.test(value ?? "")) ||
    !SHA_PATTERN.test(proof.checkout.tree ?? "") ||
    !sameValues(proof.checkout.parents, [
      proof.pullRequest.base.sha,
      proof.pullRequest.head.sha,
    ])
  ) {
    reject("PROMOTION_GATE_MERGE_PROOF_IDENTITY_INVALID", { proof });
  }

  const bindings = [
    ["runId", proof.run.id],
    ["runAttempt", proof.run.attempt],
    ["pullNumber", proof.pullRequest.number],
    ["baseSha", proof.pullRequest.base.sha],
    ["headRef", proof.pullRequest.head.ref],
    ["headSha", proof.pullRequest.head.sha],
    ["headRepository", proof.pullRequest.head.repository],
    ["testMergeSha", proof.checkout.sha],
    ["sourceParents", proof.checkout.parents],
    ["sourceTree", proof.checkout.tree],
  ];
  for (const [key, actual] of bindings) {
    if (expected[key] !== undefined && !sameValues(expected[key], actual)) {
      reject("PROMOTION_GATE_MERGE_PROOF_BINDING_MISMATCH", {
        key,
        expected: expected[key],
        actual,
      });
    }
  }
  return proof;
}

export function selectMergeProofArtifact(run, document) {
  if (
    !Number.isSafeInteger(document?.total_count) ||
    document.total_count < 0 ||
    document.total_count > 100 ||
    !Array.isArray(document?.artifacts) ||
    document.artifacts.length !== document.total_count
  ) {
    reject("PROMOTION_GATE_ARTIFACT_LIST_INVALID");
  }
  const expectedName = mergeProofArtifactName(run?.run_attempt);
  const matches = document.artifacts.filter(
    (artifact) => artifact?.name === expectedName,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    reject("PROMOTION_GATE_MERGE_PROOF_ARTIFACT_AMBIGUOUS", {
      count: matches.length,
    });
  }
  const artifact = matches[0];
  if (
    !positiveInteger(artifact?.id) ||
    artifact.expired !== false ||
    !positiveInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes > MAX_MERGE_PROOF_ARTIFACT_BYTES ||
    !DIGEST_PATTERN.test(artifact.digest ?? "") ||
    typeof artifact.archive_download_url !== "string" ||
    !artifact.archive_download_url ||
    artifact.workflow_run?.id !== run.id ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    artifact.workflow_run?.head_branch !== run.head_branch
  ) {
    reject("PROMOTION_GATE_MERGE_PROOF_ARTIFACT_INVALID", { artifact });
  }
  return artifact;
}

function artifactFingerprint(artifact) {
  return {
    id: artifact?.id,
    name: artifact?.name,
    size_in_bytes: artifact?.size_in_bytes,
    digest: artifact?.digest,
    expired: artifact?.expired,
    archive_download_url: artifact?.archive_download_url,
    workflow_run: artifact?.workflow_run
      ? {
          id: artifact.workflow_run.id,
          head_sha: artifact.workflow_run.head_sha,
          head_branch: artifact.workflow_run.head_branch,
        }
      : null,
  };
}

function pullFingerprint(pull) {
  return {
    number: pull?.number,
    state: pull?.state,
    draft: pull?.draft,
    merged: pull?.merged,
    merged_at: pull?.merged_at,
    merge_commit_sha: pull?.merge_commit_sha,
    base_ref: pull?.base?.ref,
    base_sha: pull?.base?.sha,
    head_ref: pull?.head?.ref,
    head_sha: pull?.head?.sha,
    head_repository: pull?.head?.repo?.full_name,
  };
}

function runFingerprint(run) {
  return {
    id: run?.id,
    run_attempt: run?.run_attempt,
    status: run?.status,
    conclusion: run?.conclusion,
    event: run?.event,
    name: run?.name,
    path: run?.path,
    head_sha: run?.head_sha,
    head_branch: run?.head_branch,
    workflow_id: run?.workflow_id,
  };
}

function activationJobFingerprint(job) {
  return {
    id: job?.id,
    run_id: job?.run_id,
    run_attempt: job?.run_attempt,
    workflow_name: job?.workflow_name,
    head_sha: job?.head_sha,
    head_branch: job?.head_branch,
    name: job?.name,
    status: job?.status,
    conclusion: job?.conclusion,
  };
}

function normalizedWorkflowPath(path) {
  return typeof path === "string" ? path.split("@", 1)[0] : null;
}

function commitFingerprint(commit) {
  return {
    sha: commit?.sha,
    tree: commit?.tree,
    parents: commit?.parents,
  };
}

export function selectPriorActivationJob(config, run, document) {
  if (
    !Number.isSafeInteger(document?.total_count) ||
    document.total_count < 0 ||
    document.total_count > 100 ||
    !Array.isArray(document?.jobs) ||
    document.jobs.length !== document.total_count
  ) {
    reject("PROMOTION_GATE_ACTIVATION_JOBS_INVALID");
  }
  const matches = document.jobs.filter(
    (job) => job?.name === config.activationJobName,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    reject("PROMOTION_GATE_ACTIVATION_JOB_AMBIGUOUS", {
      count: matches.length,
    });
  }
  const job = matches[0];
  if (
    !positiveInteger(job?.id) ||
    job.run_id !== run?.id ||
    job.run_attempt !== run?.run_attempt ||
    job.workflow_name !== run?.name ||
    job.head_sha !== run?.head_sha ||
    job.head_branch !== run?.head_branch
  ) {
    reject("PROMOTION_GATE_ACTIVATION_JOB_IDENTITY_INVALID", { job });
  }
  return job;
}

export function parsePromotionTrailers(message) {
  const collected = new Map(TRAILER_KEYS.map((key) => [key, []]));
  for (const line of String(message ?? "").split(/\r?\n/u)) {
    for (const key of TRAILER_KEYS) {
      if (line.startsWith(`${key}:`)) {
        collected.get(key).push(line.slice(key.length + 1).trim());
      }
    }
  }
  return Object.fromEntries(collected);
}

function validateEvent(eventName, eventPayload, sourceSha) {
  if (
    !["push", "workflow_dispatch", "repository_dispatch"].includes(eventName)
  ) {
    reject("PROMOTION_GATE_EVENT_REJECTED", { eventName });
  }
  if (eventName === "push") {
    if (
      eventPayload?.ref !== "refs/heads/main" ||
      eventPayload?.after !== sourceSha
    ) {
      reject("PROMOTION_GATE_PUSH_IDENTITY_MISMATCH", {
        ref: eventPayload?.ref,
        after: eventPayload?.after,
        sourceSha,
      });
    }
  }
}

function validateTrailers(headRef, message) {
  const trailers = parsePromotionTrailers(message);
  const presentCount = TRAILER_KEYS.reduce(
    (total, key) => total + trailers[key].length,
    0,
  );
  const promotion = String(headRef ?? "").startsWith("codex/promote-");
  if (!promotion && presentCount > 0) {
    reject("PROMOTION_TRAILER_ON_ORDINARY_PULL_REQUEST", { trailers });
  }
  if (!promotion) return { promotion: false, trailers };

  for (const key of TRAILER_KEYS) {
    if (trailers[key].length !== 1) {
      reject("PROMOTION_TRAILER_COUNT_INVALID", {
        key,
        values: trailers[key],
      });
    }
  }
  if (!SHA_PATTERN.test(trailers["FrontMind-Dev-Source"][0])) {
    reject("PROMOTION_DEV_SOURCE_TRAILER_INVALID");
  }
  for (const key of ["FrontMind-Product-Tree", "FrontMind-Projection-Policy"]) {
    if (!DIGEST_PATTERN.test(trailers[key][0])) {
      reject("PROMOTION_DIGEST_TRAILER_INVALID", { key });
    }
  }
  return { promotion: true, trailers };
}

export function identityRunsForEvidence(config, evidence) {
  const source = evidence?.sourceCommit;
  const pull = evidence?.pull;
  const head = evidence?.headCommit;
  return (evidence?.workflowRuns ?? []).filter((run) => {
    if (
      run?.name !== config.workflowName ||
      normalizedWorkflowPath(run?.path) !== config.workflowPath ||
      run?.event !== "pull_request" ||
      run?.head_sha !== head?.sha ||
      run?.head_branch !== pull?.head?.ref ||
      !run?.mergeProof ||
      !run?.mergeArtifact
    ) {
      return false;
    }
    try {
      validateMergeProof(config, run.mergeProof, {
        runId: run.id,
        runAttempt: run.run_attempt,
        pullNumber: pull.number,
        baseSha: source.parents[0],
        headRef: pull.head.ref,
        headSha: head.sha,
        headRepository: config.repository,
        sourceParents: source.parents,
        sourceTree: head.tree,
      });
      return (
        run.mergeArtifact.name === mergeProofArtifactName(run.run_attempt) &&
        run.mergeArtifact.workflow_run?.id === run.id &&
        run.mergeArtifact.workflow_run?.head_sha === run.head_sha &&
        run.mergeArtifact.workflow_run?.head_branch === run.head_branch
      );
    } catch {
      return false;
    }
  });
}

function identityPriorActivationRuns(config, evidence) {
  return (evidence?.priorActivationRuns ?? []).filter(
    (run) =>
      run?.name === config.workflowName &&
      normalizedWorkflowPath(run?.path) === config.workflowPath &&
      Array.isArray(config.priorActivationEvents) &&
      config.priorActivationEvents.includes(run?.event) &&
      run?.head_sha === evidence?.sourceSha &&
      run?.head_branch === "main" &&
      positiveInteger(run?.id) &&
      positiveInteger(run?.run_attempt) &&
      positiveInteger(run?.workflow_id),
  );
}

function verifyPriorActivationEvidence(config, evidence) {
  const source = evidence?.sourceCommit;
  if (
    source?.sha !== evidence.sourceSha ||
    !SHA_PATTERN.test(source?.tree ?? "")
  ) {
    reject("PROMOTION_GATE_PRIOR_ACTIVATION_SOURCE_INVALID", {
      source: commitFingerprint(source),
    });
  }
  const runs = identityPriorActivationRuns(config, evidence);
  if (runs.length !== 1) {
    reject("PROMOTION_GATE_PRIOR_ACTIVATION_MISSING_OR_AMBIGUOUS", {
      count: runs.length,
      runIds: runs.map((run) => run.id),
    });
  }
  const run = runs[0];
  if (run.status !== "completed" || run.conclusion !== "success") {
    reject("PROMOTION_GATE_PRIOR_ACTIVATION_NOT_SUCCESSFUL", {
      id: run.id,
      attempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
    });
  }
  const workflow = evidence.workflows?.[String(run.workflow_id)];
  if (
    workflow?.id !== run.workflow_id ||
    workflow?.name !== config.workflowName ||
    workflow?.path !== config.workflowPath ||
    workflow?.state !== "active"
  ) {
    reject("PROMOTION_GATE_WORKFLOW_IDENTITY_INVALID", { workflow });
  }
  const job = evidence.priorActivationJob;
  if (
    !positiveInteger(job?.id) ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.workflow_name !== run.name ||
    job.head_sha !== run.head_sha ||
    job.head_branch !== run.head_branch ||
    job.name !== config.activationJobName ||
    job.status !== "completed" ||
    job.conclusion !== "success"
  ) {
    reject("PROMOTION_GATE_PRIOR_ACTIVATION_JOB_NOT_SUCCESSFUL", {
      job: activationJobFingerprint(job),
    });
  }
  if (
    !sameValues(
      runFingerprint(evidence.final?.priorActivationRun),
      runFingerprint(run),
    ) ||
    !sameValues(
      activationJobFingerprint(evidence.final?.priorActivationJob),
      activationJobFingerprint(job),
    )
  ) {
    reject("PROMOTION_GATE_EVIDENCE_MOVED_DURING_VERIFICATION");
  }
  return {
    sourceSha: evidence.sourceSha,
    priorActivation: true,
    workflowRunId: run.id,
    workflowRunAttempt: run.run_attempt,
    activationJobId: job.id,
  };
}

export function verifyPromotionGateEvidence(config, evidence) {
  const { repository, workflowName, workflowPath } = config;
  const sourceSha = evidence?.sourceSha;
  if (!SHA_PATTERN.test(sourceSha ?? "")) {
    reject("PROMOTION_GATE_SOURCE_SHA_INVALID", { sourceSha });
  }
  validateEvent(evidence.eventName, evidence.eventPayload, sourceSha);
  if (evidence.mainSha !== sourceSha || evidence.final?.mainSha !== sourceSha) {
    reject("PROMOTION_GATE_MAIN_MOVED", {
      sourceSha,
      initialMainSha: evidence.mainSha,
      finalMainSha: evidence.final?.mainSha,
    });
  }

  if (
    evidence.eventName !== "push" &&
    Array.isArray(evidence.priorActivationRuns) &&
    evidence.priorActivationRuns.length > 0
  ) {
    return verifyPriorActivationEvidence(config, evidence);
  }

  const source = evidence.sourceCommit;
  if (
    source?.sha !== sourceSha ||
    !Array.isArray(source?.parents) ||
    source.parents.length !== 2 ||
    !SHA_PATTERN.test(source?.tree ?? "")
  ) {
    reject("PROMOTION_GATE_DIRECT_PUSH_OR_TOPOLOGY_INVALID", {
      source: commitFingerprint(source),
    });
  }

  const pulls = evidence.associatedPulls;
  if (!Array.isArray(pulls) || pulls.length !== 1) {
    reject("PROMOTION_GATE_PULL_REQUEST_MISSING_OR_AMBIGUOUS", {
      count: Array.isArray(pulls) ? pulls.length : null,
    });
  }
  const pull = evidence.pull;
  const summary = pulls[0];
  if (
    pull?.number !== summary?.number ||
    pull?.state !== "closed" ||
    pull?.draft !== false ||
    pull?.merged !== true ||
    !pull?.merged_at ||
    pull?.base?.ref !== "main" ||
    pull?.base?.sha !== source.parents[0] ||
    pull?.head?.repo?.full_name !== repository ||
    pull?.merge_commit_sha !== sourceSha ||
    pull?.head?.sha !== source.parents[1]
  ) {
    reject("PROMOTION_GATE_PULL_REQUEST_IDENTITY_INVALID", {
      pull: pullFingerprint(pull),
      sourceParents: source.parents,
    });
  }

  const head = evidence.headCommit;
  if (
    head?.sha !== pull.head.sha ||
    head?.tree !== source.tree ||
    !sameValues(source.parents, [source.parents[0], head.sha])
  ) {
    reject("PROMOTION_GATE_MERGE_TREE_MISMATCH", {
      source: commitFingerprint(source),
      head: commitFingerprint(head),
    });
  }
  const trailerEvidence = validateTrailers(pull.head.ref, head.message);

  const identityRuns = identityRunsForEvidence(config, evidence);
  if (identityRuns.length !== 1) {
    reject("PROMOTION_GATE_WORKFLOW_RUN_MISSING_OR_AMBIGUOUS", {
      count: identityRuns.length,
      runIds: identityRuns.map((run) => run.id),
    });
  }
  const run = identityRuns[0];
  if (
    !Number.isInteger(run.id) ||
    !Number.isInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    reject("PROMOTION_GATE_WORKFLOW_NOT_SUCCESSFUL", {
      id: run.id,
      attempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
    });
  }
  const workflow = evidence.workflows?.[String(run.workflow_id)];
  if (
    workflow?.id !== run.workflow_id ||
    workflow?.name !== workflowName ||
    workflow?.path !== workflowPath ||
    workflow?.state !== "active"
  ) {
    reject("PROMOTION_GATE_WORKFLOW_IDENTITY_INVALID", { workflow });
  }

  if (
    !sameValues(pullFingerprint(evidence.final?.pull), pullFingerprint(pull)) ||
    !sameValues(runFingerprint(evidence.final?.run), runFingerprint(run)) ||
    !sameValues(
      commitFingerprint(evidence.final?.headCommit),
      commitFingerprint(head),
    ) ||
    !sameValues(
      artifactFingerprint(evidence.final?.mergeArtifact),
      artifactFingerprint(run.mergeArtifact),
    ) ||
    !sameValues(evidence.final?.mergeProof, run.mergeProof)
  ) {
    reject("PROMOTION_GATE_EVIDENCE_MOVED_DURING_VERIFICATION");
  }

  return {
    sourceSha,
    pullNumber: pull.number,
    pullHeadSha: head.sha,
    pullBaseSha: source.parents[0],
    testMergeSha: run.mergeProof.checkout.sha,
    workflowRunId: run.id,
    workflowRunAttempt: run.run_attempt,
    promotion: trailerEvidence.promotion,
    trailers: trailerEvidence.trailers,
  };
}
