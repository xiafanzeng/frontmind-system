#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required}"
: "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

node .github/scripts/verify-promotion-main-push.mjs \
  --repository "$GITHUB_REPOSITORY" \
  --source-sha "$GITHUB_SHA" \
  --workflow-name "Dashboard CI and release" \
  --workflow-path ".github/workflows/dashboard-ci.yml" \
  --activation-job-name "Build, sign and deploy immutable image" \
  --prior-activation-events "push,workflow_dispatch,repository_dispatch" \
  --event-name "$GITHUB_EVENT_NAME" \
  --event-path "$GITHUB_EVENT_PATH"
