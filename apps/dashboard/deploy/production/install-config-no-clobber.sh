#!/usr/bin/env bash

# Source this file after defining die(). The caller must already be root.
install_config_from_example_no_clobber() {
  [[ $# -eq 3 ]] || die "INSTALL_CONFIG_ARGUMENTS_INVALID"
  local source_file="$1"
  local example_target="$2"
  local live_target="$3"

  [[ -f $source_file && ! -L $source_file ]] \
    || die "INSTALL_CONFIG_SOURCE_INVALID:${source_file}"
  [[ ! -L $example_target ]] \
    || die "INSTALL_CONFIG_EXAMPLE_SYMLINK_REJECTED:${example_target}"
  [[ ! -e $example_target || -f $example_target ]] \
    || die "INSTALL_CONFIG_EXAMPLE_NOT_FILE:${example_target}"
  [[ ! -L $live_target ]] \
    || die "INSTALL_CONFIG_LIVE_SYMLINK_REJECTED:${live_target}"
  [[ ! -e $live_target || -f $live_target ]] \
    || die "INSTALL_CONFIG_LIVE_NOT_FILE:${live_target}"

  # The example is repository-owned documentation and may safely advance on
  # every installer run. The live file contains production settings/secrets;
  # seed it once, then preserve its bytes forever on installer reruns.
  install -o root -g root -m 0600 "$source_file" "$example_target"
  if [[ -e $live_target ]]; then
    chown root:root "$live_target"
    chmod 0600 "$live_target"
    printf 'INSTALL_CONFIG_PRESERVED:%s\n' "$live_target"
    return 0
  fi

  install -o root -g root -m 0600 "$source_file" "$live_target"
  printf 'INSTALL_CONFIG_SEEDED:%s\n' "$live_target"
}
