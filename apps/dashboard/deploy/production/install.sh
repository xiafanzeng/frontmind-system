#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly DEPLOY_ROOT="/opt/frontmind-deploy"
readonly CONFIG_ROOT="/etc/frontmind-deploy"
readonly RUNTIME_CONFIG_ROOT="/etc/frontmind"
readonly DEPLOY_USER="frontmind-deploy"

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

# shellcheck source=deploy/production/install-config-no-clobber.sh
source "$SCRIPT_DIR/install-config-no-clobber.sh"
# shellcheck source=deploy/production/install-key-policy.sh
source "$SCRIPT_DIR/install-key-policy.sh"

[[ $EUID -eq 0 ]] || die "INSTALL_REQUIRES_ROOT"
[[ $# -eq 2 ]] || die "usage: sudo ./install.sh /root/dashboard-deploy.pub /root/website-deploy.pub"
dashboard_public_key_file="$1"
website_public_key_file="$2"
for public_key_file in "$dashboard_public_key_file" "$website_public_key_file"; do
  [[ -f $public_key_file && ! -L $public_key_file ]] || die "PUBLIC_KEY_FILE_INVALID:${public_key_file}"
done

for command in cosign curl docker flock getent gzip gunzip jq mysql mysqldump sha256sum sudo timeout useradd usermod visudo; do
  command -v "$command" >/dev/null 2>&1 || die "REQUIRED_COMMAND_MISSING:${command}"
done
docker compose version >/dev/null || die "DOCKER_COMPOSE_V2_REQUIRED"

dashboard_public_key="$(read_deploy_public_key "$dashboard_public_key_file")" \
  || die "DEPLOY_PUBLIC_KEY_REJECTED:${dashboard_public_key_file}"
website_public_key="$(read_deploy_public_key "$website_public_key_file")" \
  || die "DEPLOY_PUBLIC_KEY_REJECTED:${website_public_key_file}"
deploy_public_keys_are_independent "$dashboard_public_key" "$website_public_key" \
  || die "DEPLOY_KEYS_MUST_BE_INDEPENDENT"

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/${DEPLOY_USER}" \
    --shell /bin/bash "$DEPLOY_USER"
else
  usermod --shell /bin/bash "$DEPLOY_USER"
fi
[[ $(getent passwd "$DEPLOY_USER" | cut -d: -f7) == "/bin/bash" ]] \
  || die "DEPLOY_USER_SHELL_INVALID"

install -d -o root -g root -m 0755 "$DEPLOY_ROOT"
install -d -o root -g root -m 0755 \
  "$DEPLOY_ROOT/dashboard" "$DEPLOY_ROOT/website"
install -d -o root -g root -m 0700 \
  "$CONFIG_ROOT" "$CONFIG_ROOT/services" "$RUNTIME_CONFIG_ROOT" \
  /var/lib/frontmind-deploy/dashboard /var/lib/frontmind-deploy/website \
  /var/backups/frontmind-dashboard
install -d -o 10001 -g 10001 -m 0700 \
  /var/lib/frontmind/prepared-files \
  /var/lib/frontmind/dashboard-assets
install -d -o 10002 -g 10002 -m 0700 \
  /var/lib/frontmind-website \
  /var/lib/frontmind-website/custom-question-validations
chown -R 10002:10002 /var/lib/frontmind-website
[[ $(stat -c '%u:%g' /var/lib/frontmind/dashboard-assets) == "10001:10001" ]] \
  || die "DASHBOARD_PERSISTENCE_OWNER_INVALID"
[[ $(stat -c '%u:%g' /var/lib/frontmind-website) == "10002:10002" ]] \
  || die "WEBSITE_PERSISTENCE_OWNER_INVALID"

install -o root -g root -m 0644 \
  "$SCRIPT_DIR/dashboard/compose.yaml" "$DEPLOY_ROOT/dashboard/compose.yaml"
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/website/compose.yaml" "$DEPLOY_ROOT/website/compose.yaml"
install -o root -g root -m 0755 \
  "$SCRIPT_DIR/controller/frontmind-deploy-controller" \
  /usr/local/sbin/frontmind-deploy-controller
install -o root -g root -m 0755 \
  "$SCRIPT_DIR/controller/frontmind-deploy-forced-command" \
  /usr/local/sbin/frontmind-deploy-forced-command
install -o root -g root -m 0700 \
  "$SCRIPT_DIR/controller/frontmind-contract-maintenance" \
  /usr/local/sbin/frontmind-contract-maintenance
install -o root -g root -m 0700 \
  "$SCRIPT_DIR/controller/frontmind-bootstrap-state" \
  /usr/local/sbin/frontmind-bootstrap-state

install_config_from_example_no_clobber \
  "$SCRIPT_DIR/controller/dashboard-compose.env.example" \
  "$CONFIG_ROOT/dashboard-compose.env.example" \
  "$CONFIG_ROOT/dashboard-compose.env"
install_config_from_example_no_clobber \
  "$SCRIPT_DIR/controller/website-compose.env.example" \
  "$CONFIG_ROOT/website-compose.env.example" \
  "$CONFIG_ROOT/website-compose.env"

install -o root -g root -m 0600 \
  "$SCRIPT_DIR/controller/services/dashboard.env.example" \
  "$CONFIG_ROOT/services/dashboard.env.example"
install -o root -g root -m 0600 \
  "$SCRIPT_DIR/controller/services/website.env.example" \
  "$CONFIG_ROOT/services/website.env.example"
install -o root -g root -m 0600 \
  "$SCRIPT_DIR/controller/dashboard-backup.cnf.example" \
  "$CONFIG_ROOT/dashboard-backup.cnf.example"
install -o root -g root -m 0600 \
  "$SCRIPT_DIR/controller/dashboard-restore.cnf.example" \
  "$CONFIG_ROOT/dashboard-restore.cnf.example"
install -o root -g root -m 0600 \
  "$SCRIPT_DIR/dashboard/runtime.env.example" \
  "$RUNTIME_CONFIG_ROOT/dashboard.env.example"
install -o root -g root -m 0600 \
  "$SCRIPT_DIR/dashboard/migrator.env.example" \
  "$RUNTIME_CONFIG_ROOT/dashboard-migrator.env.example"
install -o root -g root -m 0600 \
  "$SCRIPT_DIR/dashboard/readiness.env.example" \
  "$RUNTIME_CONFIG_ROOT/dashboard-readiness.env.example"
install -o root -g root -m 0600 \
  "$SCRIPT_DIR/website/runtime.env.example" \
  "$RUNTIME_CONFIG_ROOT/website.env.example"

ssh_dir="/var/lib/${DEPLOY_USER}/.ssh"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$ssh_dir"
authorized_keys="${ssh_dir}/authorized_keys"
{
  printf 'restrict,command="/usr/local/sbin/frontmind-deploy-forced-command dashboard" %s\n' \
    "$dashboard_public_key"
  printf 'restrict,command="/usr/local/sbin/frontmind-deploy-forced-command website" %s\n' \
    "$website_public_key"
} >"$authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$authorized_keys"
chmod 0600 "$authorized_keys"

sudoers_file="/etc/sudoers.d/frontmind-deploy"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/frontmind-deploy-controller *\n' \
  "$DEPLOY_USER" >"$sudoers_file"
chmod 0440 "$sudoers_file"
visudo -cf "$sudoers_file" >/dev/null

docker network inspect frontmind-applications >/dev/null 2>&1 \
  || docker network create frontmind-applications >/dev/null

cat <<'MESSAGE'
INSTALL_FILES_OK

Before the first deployment:
1. Edit the already seeded dashboard-compose.env and website-compose.env.
   For every other required *.example under /etc/frontmind*, create the live
   name only when it does not already exist; fill real values and keep owner
   root and mode 0600.
2. Confirm the Dashboard database network name in dashboard-compose.env.
3. For the one-time root-only bootstrap, use a temporary GHCR login and run
   docker logout ghcr.io immediately after frontmind-bootstrap-state succeeds.
   Normal forced-command deployments receive the job-scoped GITHUB_TOKEN over
   SSH stdin and never depend on a persistent root Docker login.
4. Configure the GitHub repository variables/secrets listed in
   docs/operations/RELEASE.md.
5. Add the generated frontmind-deploy user's SSH public endpoint to GitHub.

The installer never imports production data, runs migrations, changes the
1Panel reverse proxy, or starts either application. Re-running it refreshes
the two compose *.example files but preserves existing live compose env files;
never copy a refreshed example over a live file.
MESSAGE
