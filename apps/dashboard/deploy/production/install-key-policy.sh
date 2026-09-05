#!/usr/bin/env bash

# Parse deploy public keys once and compare only the cryptographic identity
# (algorithm + base64 blob). OpenSSH comments are descriptive metadata and must
# never make one key look independent from itself.
read_deploy_public_key() {
  local file="$1" value key_type key_blob comment
  IFS= read -r value <"$file"
  [[ $(wc -l <"$file") -eq 1 ]] || {
    printf 'DEPLOY_PUBLIC_KEY_MUST_BE_ONE_LINE:%s\n' "$file" >&2
    return 1
  }
  read -r key_type key_blob comment <<<"$value"
  [[ $key_type =~ ^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521))$ ]] || {
    printf 'DEPLOY_PUBLIC_KEY_REJECTED:%s\n' "$file" >&2
    return 1
  }
  [[ $key_blob =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || {
    printf 'DEPLOY_PUBLIC_KEY_REJECTED:%s\n' "$file" >&2
    return 1
  }
  printf '%s' "$value"
}

deploy_public_key_identity() {
  local value="$1" key_type key_blob comment
  read -r key_type key_blob comment <<<"$value"
  [[ $key_type =~ ^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521))$ ]] || return 1
  [[ $key_blob =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
  printf '%s %s' "$key_type" "$key_blob"
}

deploy_public_keys_are_independent() {
  local first_identity second_identity
  first_identity="$(deploy_public_key_identity "$1")" || return 1
  second_identity="$(deploy_public_key_identity "$2")" || return 1
  [[ $first_identity != "$second_identity" ]]
}
