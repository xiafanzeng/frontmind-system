import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import {
  MERGE_PROOF_KIND,
  PromotionGateError,
  validateMergeProof,
} from "./promotion-gate-core.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new PromotionGateError("PROMOTION_MERGE_PROOF_ARGUMENT_MISSING", {
      name,
    });
  }
  return process.argv[index + 1];
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new PromotionGateError("PROMOTION_MERGE_PROOF_ENVIRONMENT_MISSING", {
      name,
    });
  }
  return value;
}

function positiveInteger(value, name) {
  if (!/^\d+$/u.test(value)) {
    throw new PromotionGateError("PROMOTION_MERGE_PROOF_INTEGER_INVALID", {
      name,
      value,
    });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PromotionGateError("PROMOTION_MERGE_PROOF_INTEGER_INVALID", {
      name,
      value,
    });
  }
  return parsed;
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function main() {
  const config = {
    repository: argument("--repository"),
    workflowName: argument("--workflow-name"),
    workflowPath: argument("--workflow-path"),
  };
  const output = argument("--output");
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME");
  const eventPath = requiredEnvironment("GITHUB_EVENT_PATH");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const checkoutSha = requiredEnvironment("GITHUB_SHA");
  const workflowName = requiredEnvironment("GITHUB_WORKFLOW");
  const runId = positiveInteger(requiredEnvironment("GITHUB_RUN_ID"), "runId");
  const runAttempt = positiveInteger(
    requiredEnvironment("GITHUB_RUN_ATTEMPT"),
    "runAttempt",
  );
  if (
    eventName !== "pull_request" ||
    repository !== config.repository ||
    workflowName !== config.workflowName ||
    git("rev-parse", "HEAD") !== checkoutSha ||
    git("status", "--porcelain=v1", "--untracked-files=all")
  ) {
    throw new PromotionGateError("PROMOTION_MERGE_PROOF_CONTEXT_INVALID");
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const pull = event?.pull_request;
  if (
    pull?.base?.ref !== "main" ||
    pull?.base?.repo?.full_name !== config.repository ||
    pull?.head?.repo?.full_name !== config.repository
  ) {
    throw new PromotionGateError("PROMOTION_MERGE_PROOF_PULL_INVALID");
  }
  const parents = git("show", "-s", "--format=%P", checkoutSha)
    .split(/\s+/u)
    .filter(Boolean);
  const tree = git("rev-parse", `${checkoutSha}^{tree}`);
  const headTree = git("rev-parse", `${pull.head.sha}^{tree}`);
  if (tree !== headTree) {
    throw new PromotionGateError("PROMOTION_MERGE_PROOF_HEAD_TREE_MISMATCH", {
      checkoutTree: tree,
      headTree,
    });
  }

  const proof = {
    schemaVersion: 1,
    kind: MERGE_PROOF_KIND,
    repository: config.repository,
    workflow: {
      name: config.workflowName,
      path: config.workflowPath,
    },
    run: {
      id: runId,
      attempt: runAttempt,
      event: "pull_request",
    },
    pullRequest: {
      number: pull.number,
      base: {
        ref: pull.base.ref,
        sha: pull.base.sha,
      },
      head: {
        ref: pull.head.ref,
        sha: pull.head.sha,
        repository: pull.head.repo.full_name,
      },
    },
    checkout: {
      sha: checkoutSha,
      parents,
      tree,
    },
  };
  validateMergeProof(config, proof, {
    runId,
    runAttempt,
    pullNumber: pull.number,
    baseSha: pull.base.sha,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    headRepository: pull.head.repo.full_name,
    testMergeSha: checkoutSha,
    sourceParents: [pull.base.sha, pull.head.sha],
    sourceTree: headTree,
  });
  await writeFile(output, `${JSON.stringify(proof)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

main().catch((error) => {
  const code =
    error instanceof PromotionGateError
      ? error.code
      : "PROMOTION_MERGE_PROOF_UNEXPECTED_FAILURE";
  const details = error instanceof PromotionGateError ? error.details : {};
  process.stderr.write(`${code} ${JSON.stringify(details)}\n`);
  process.exitCode = 1;
});
