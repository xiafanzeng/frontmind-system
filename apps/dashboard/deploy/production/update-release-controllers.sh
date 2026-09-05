#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CONTROLLER_VERSION="7"
readonly VERSION_ARGUMENT="--apply-version=${CONTROLLER_VERSION}"
readonly CONTROLLER_TEMPLATE="${SCRIPT_DIR}/controller/frontmind-deploy-controller"
readonly FORCED_TEMPLATE="${SCRIPT_DIR}/controller/frontmind-deploy-forced-command"
readonly CONTROLLER_TARGET="/usr/local/sbin/frontmind-deploy-controller"
readonly FORCED_TARGET="/usr/local/sbin/frontmind-deploy-forced-command"
readonly UPDATE_LOCK="/run/lock/frontmind-production-controller-update.lock"
readonly DASHBOARD_LOCK="/run/lock/frontmind-deploy-dashboard.lock"
readonly WEBSITE_LOCK="/run/lock/frontmind-deploy-website.lock"
readonly RECOVERY_ROOT="/var/lib/frontmind-deploy/controller-update"
readonly RECOVERY_MARKER="${RECOVERY_ROOT}/pending"
readonly CONTROLLER_BACKUP="${RECOVERY_ROOT}/frontmind-deploy-controller.previous"
readonly FORCED_BACKUP="${RECOVERY_ROOT}/frontmind-deploy-forced-command.previous"
update_committed=0

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

root_owned_executable() {
  local target="$1"
  [[ -f $target && ! -L $target && $(stat -c '%u:%g:%a' "$target") == "0:0:755" ]]
}

validate_controller() {
  local target="$1"
  bash -n "$target" \
    && [[ $(grep -Fxc -- "# frontmind-production-controller-version: ${CONTROLLER_VERSION}" "$target" || true) == 1 ]] \
    && grep -Fq -- '--coupled-stack' "$target" \
    && grep -Fq -- 'PRODUCTION_COUPLED_STACK_BOTH_PREVIOUS_RESTORED' "$target" \
    && grep -Fq -- 'PRODUCTION_COUPLED_STACK_SUCCESS' "$target" \
    && grep -Fq -- 'databaseRestoreRequired' "$target" \
    && grep -Fq -- 'coupled-dashboard-runtime-rollback.env' "$target" \
    && grep -Fq -- 'coupled-dashboard-runtime-rollback.retiring' "$target" \
    && grep -Fq -- 'coupled-website-runtime-rollback.env' "$target" \
    && grep -Fq -- 'coupled-website-runtime-rollback.retiring' "$target" \
    && grep -Fq -- 'mark_coupled_stack_external_fact_changed' "$target" \
    && grep -Fq -- 'commit_coupled_stack_capsule_cleanup' "$target" \
    && grep -Fq -- 'resolve_coupled_website_container_id' "$target" \
    && grep -Fq -- 'project-business-owner' "$target" \
    && grep -Fq -- 'PRODUCTION_COUPLED_DASHBOARD_PRESALES_SURFACE_MISMATCH' "$target" \
    && grep -Fq -- 'COUPLED_STACK_RECOVERY_MUST_FINISH_BEFORE_INCIDENT_ACKNOWLEDGEMENT' "$target" \
    && grep -Fq -- 'siteops_alidns_oauth_contract_plan_matches' "$target" \
    && grep -Fq -- 'contract-0065-migration-started' "$target" \
    && grep -Fq -- 'dashboard_image_supports_split_runtime' "$target" \
    && grep -Fq -- 'dashboard_siteops_worker_matches' "$target" \
    && grep -Fq -- 'start_application_runtime' "$target" \
    && grep -Fq -- 'stop_application_runtime' "$target" \
    && grep -Fq -- 'seed_static_template_catalog' "$target" \
    && grep -Fq -- '/app/dist/seed-static-template-catalog.js' "$target" \
    && grep -Fq -- 'STATIC_TEMPLATE_CATALOG_SEED_TIMEOUT_SECONDS=1800' "$target" \
    && grep -Fq -- 'PRODUCTION_STATIC_TEMPLATE_CATALOG_SEED_FAILED' "$target" \
    && grep -Fq -- '60b3ba7ba8fb92bbb2ecc2a62db1c13f549f26cc375d44eb2ee218459e50bc5f' "$target" \
    && grep -Fq -- '00c5395ab580f7dddef1ad743445561943b9fc28c0858a3c72eea5417cb7c52f' "$target" \
    && grep -Fq -- 'e71230f0691ddd2a7d3d7b1a19d069775720ff999b445e86f60be902137a17db' "$target" \
    && grep -Fq -- 'e4a5de422fac9b970a82a925a2de36a4e7f133a93ec35e026ea0c0494fe93c74' "$target" \
    && grep -Fq -- '47053769bdbf83b7b496da7ffc9f10042d746af4cb05baa7c91f1ec85a7a3a6d' "$target" \
    && grep -Fq -- 'restore_contract_0065_release' "$target" \
    && grep -Fq -- 'run_contract_0065_migration_json' "$target" \
    && grep -Fq -- 'contract_0065_migration_container_identity_is_exact' "$target" \
    && grep -Fq -- 'com.docker.compose.project' "$target" \
    && grep -Fq -- 'setsid --fork --wait' "$target" \
    && grep -Fq -- '/app/dist/private-workflows/socratic-kb-builder-v5.skill' "$target" \
    && grep -Fq -- '/api/internal/presales/v2' "$target" \
    && ! grep -Fq -- '--kb-manus-v2-rollout' "$target" \
    && ! grep -Eq -- 'dual-read|canary|shadow' "$target" \
    && ! grep -Eq -- 'frontmind-dashboard-dev|dashboard-dev\.frontmind\.net|/etc/frontmind-dev|/var/lib/frontmind-dev' "$target"
}

validate_forced_command() {
  local target="$1"
  bash -n "$target" \
    && grep -Fq -- '/usr/local/sbin/frontmind-deploy-controller' "$target" \
    && grep -Fq -- '${words[0]} == "coupled-stack"' "$target" \
    && grep -Fq -- '--coupled-stack' "$target" \
    && ! grep -Fq -- '--kb-manus-v2-rollout' "$target" \
    && grep -Fq -- 'expected_service="${1:-}"' "$target"
}

install_atomically() {
  local source="$1" target="$2" temporary
  temporary="$(mktemp "${target}.tmp.XXXXXX")" || return 1
  if ! install -o root -g root -m 0755 "$source" "$temporary" \
    || ! mv -f -- "$temporary" "$target"; then
    rm -f -- "$temporary" || true
    return 1
  fi
  root_owned_executable "$target"
}

recover_interrupted_update() {
  [[ -f $RECOVERY_MARKER && ! -L $RECOVERY_MARKER ]] || return 1
  [[ $(cat "$RECOVERY_MARKER") == "version=${CONTROLLER_VERSION}" ]] || return 1
  [[ -f $CONTROLLER_BACKUP && ! -L $CONTROLLER_BACKUP ]] || return 1
  [[ -f $FORCED_BACKUP && ! -L $FORCED_BACKUP ]] || return 1
  if ! install_atomically "$CONTROLLER_BACKUP" "$CONTROLLER_TARGET" \
    || ! install_atomically "$FORCED_BACKUP" "$FORCED_TARGET"; then
    return 1
  fi
  rm -f -- "$RECOVERY_MARKER" "$CONTROLLER_BACKUP" "$FORCED_BACKUP" || return 1
}

restore_controller_update() {
  if (( update_committed == 0 )) && [[ -f $RECOVERY_MARKER && ! -L $RECOVERY_MARKER ]]; then
    recover_interrupted_update \
      || printf '%s\n' "PRODUCTION_CONTROLLER_UPDATE_RECOVERY_PENDING" >&2
  fi
}

[[ $EUID -eq 0 ]] || die "PRODUCTION_CONTROLLER_UPDATE_REQUIRES_ROOT" 77
[[ $# -eq 1 && $1 == "$VERSION_ARGUMENT" ]] \
  || die "usage: sudo ./update-release-controllers.sh ${VERSION_ARGUMENT}" 64
for command in bash cat flock grep install mkdir mktemp mv rm stat; do
  command -v "$command" >/dev/null 2>&1 \
    || die "PRODUCTION_CONTROLLER_UPDATE_COMMAND_MISSING:${command}" 69
done
validate_controller "$CONTROLLER_TEMPLATE" \
  || die "PRODUCTION_CONTROLLER_TEMPLATE_REJECTED" 78
validate_forced_command "$FORCED_TEMPLATE" \
  || die "PRODUCTION_FORCED_COMMAND_TEMPLATE_REJECTED" 78

exec 8>"$UPDATE_LOCK"
flock -n 8 || die "PRODUCTION_CONTROLLER_UPDATE_ALREADY_RUNNING" 75
exec 9>"$DASHBOARD_LOCK"
flock -n 9 || die "PRODUCTION_DASHBOARD_RELEASE_ACTIVE" 75
exec 10>"$WEBSITE_LOCK"
flock -n 10 || die "PRODUCTION_WEBSITE_RELEASE_ACTIVE" 75

mkdir -p -m 0700 "$RECOVERY_ROOT"
[[ -d $RECOVERY_ROOT && ! -L $RECOVERY_ROOT \
  && $(stat -c '%u:%g:%a' "$RECOVERY_ROOT") == "0:0:700" ]] \
  || die "PRODUCTION_CONTROLLER_UPDATE_RECOVERY_ROOT_REJECTED" 73
if [[ -e $RECOVERY_MARKER || -L $RECOVERY_MARKER ]]; then
  recover_interrupted_update \
    || die "PRODUCTION_CONTROLLER_UPDATE_RECOVERY_FAILED" 73
  printf '%s\n' "PRODUCTION_CONTROLLER_UPDATE_RECOVERED_PREVIOUS"
fi
root_owned_executable "$CONTROLLER_TARGET" \
  || die "PRODUCTION_CONTROLLER_TARGET_INVALID" 73
root_owned_executable "$FORCED_TARGET" \
  || die "PRODUCTION_FORCED_COMMAND_TARGET_INVALID" 73
install -o root -g root -m 0600 "$CONTROLLER_TARGET" "$CONTROLLER_BACKUP" \
  || die "PRODUCTION_CONTROLLER_BACKUP_FAILED" 70
install -o root -g root -m 0600 "$FORCED_TARGET" "$FORCED_BACKUP" \
  || {
    rm -f -- "$CONTROLLER_BACKUP" "$FORCED_BACKUP" || true
    die "PRODUCTION_FORCED_COMMAND_BACKUP_FAILED" 70
  }
marker_temporary="$(mktemp "${RECOVERY_MARKER}.tmp.XXXXXX")" \
  || {
    rm -f -- "$CONTROLLER_BACKUP" "$FORCED_BACKUP" || true
    die "PRODUCTION_CONTROLLER_UPDATE_MARKER_FAILED" 70
  }
if ! printf '%s\n' "version=${CONTROLLER_VERSION}" >"$marker_temporary" \
  || ! chmod 0600 "$marker_temporary" \
  || ! mv -f -- "$marker_temporary" "$RECOVERY_MARKER"; then
  rm -f -- "$marker_temporary" "$CONTROLLER_BACKUP" "$FORCED_BACKUP" || true
  die "PRODUCTION_CONTROLLER_UPDATE_MARKER_FAILED" 70
fi

trap restore_controller_update EXIT
trap 'restore_controller_update; trap - TERM; exit 143' TERM
trap 'restore_controller_update; trap - INT; exit 130' INT

if ! install_atomically "$CONTROLLER_TEMPLATE" "$CONTROLLER_TARGET" \
  || ! install_atomically "$FORCED_TEMPLATE" "$FORCED_TARGET" \
  || ! validate_controller "$CONTROLLER_TARGET" \
  || ! validate_forced_command "$FORCED_TARGET"; then
  recover_interrupted_update || true
  die "PRODUCTION_CONTROLLER_UPDATE_ROLLED_BACK" 70
fi
rm -f -- "$RECOVERY_MARKER" \
  || die "PRODUCTION_CONTROLLER_UPDATE_COMMIT_FAILED" 70
update_committed=1
rm -f -- "$CONTROLLER_BACKUP" "$FORCED_BACKUP" \
  || printf '%s\n' "PRODUCTION_CONTROLLER_UPDATE_STALE_BACKUP_WARNING" >&2

printf '%s\n' "PRODUCTION_CONTROLLER_UPDATE_OK version=${CONTROLLER_VERSION}"
