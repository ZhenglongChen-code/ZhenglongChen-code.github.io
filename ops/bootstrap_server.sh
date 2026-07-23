#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
caddyfile_argument="${1:-$script_dir/Caddyfile.ip}"
caddy_transaction_active=0
caddy_transaction_target=""
caddy_transaction_original_exists=0
caddy_transaction_rollback_snapshot=""
caddy_transaction_temporary=""
caddy_transaction_file_may_have_changed=0
caddy_transaction_previous_active=0
caddy_transaction_service_may_have_changed=0
caddy_transaction_previous_enabled=0

# Print a bootstrap error and exit without continuing.
fail() {
  local message="$1"
  printf 'bootstrap: %s\n' "$message" >&2
  exit 1
}

# Return one systemd service's active state without propagating an inactive exit code.
get_service_state() {
  local service_name="$1"
  local service_state
  service_state="$(systemctl is-active "$service_name" 2>/dev/null || true)"
  printf '%s\n' "${service_state:-unknown}"
}

# Return whether one systemd service is enabled, treating absent units as disabled.
get_service_enablement() {
  local service_name="$1"
  local enablement_state
  enablement_state="$(systemctl is-enabled "$service_name" 2>/dev/null || true)"
  if [[ "$enablement_state" == "enabled" ]]; then
    printf 'enabled\n'
  else
    printf 'disabled\n'
  fi
}

# Reject any port 80 listener that is not owned by Caddy.
assert_port_80_listener_safe() {
  local listener_snapshot="$1"
  local check_phase="$2"
  local port_80_listeners
  local non_caddy_port_80

  port_80_listeners="$(printf '%s\n' "$listener_snapshot" | awk '$4 ~ /:80$/')"
  non_caddy_port_80="$(printf '%s\n' "$port_80_listeners" | grep -Ev 'users:\(\("caddy",' || true)"
  if [[ -n "$non_caddy_port_80" ]]; then
    fail "port 80 has a non-Caddy listener during $check_phase; identify and stop it manually before rerunning"
  fi
}

# Reject test-mode paths that escape the canonical isolated root through a symlink.
assert_safe_system_path() {
  local requested_path="$1"
  local relative_path
  local current_path
  local component
  local component_index=0
  local last_index
  local -a path_components

  if [[ "${bootstrap_test_mode:-0}" != "1" ]]; then
    return 0
  fi
  case "$requested_path" in
    "$system_root" | "$system_root"/*) ;;
    *) fail "test-mode path escapes the canonical root: $requested_path" ;;
  esac

  relative_path="${requested_path#"$system_root"/}"
  IFS='/' read -r -a path_components <<<"$relative_path"
  last_index=$((${#path_components[@]} - 1))
  current_path="$system_root"
  for component in "${path_components[@]}"; do
    case "$component" in
      "" | . | ..) fail "test-mode path is not canonical: $requested_path" ;;
    esac
    current_path="$current_path/$component"
    if [[ -L "$current_path" ]]; then
      fail "test-mode path contains a symbolic link: $current_path"
    fi
    if [[ "$component_index" -lt "$last_index" && -e "$current_path" && ! -d "$current_path" ]]; then
      fail "test-mode path parent is not a directory: $current_path"
    fi
    component_index=$((component_index + 1))
  done
}

# Create and secure the deployment root before inspecting its admin-owned children.
prepare_site_directories() {
  local site_parent
  local child_path
  local child_mode

  site_parent="$(dirname -- "$site_root")"
  assert_safe_system_path "$site_parent"
  assert_safe_system_path "$site_root"

  if [[ -L "$site_parent" || ( -e "$site_parent" && ! -d "$site_parent" ) ]]; then
    fail "$site_parent must be a non-symlink directory"
  fi
  mkdir -p "$site_parent"

  if [[ -L "$site_root" || ( -e "$site_root" && ! -d "$site_root" ) ]]; then
    fail "$site_root must be a non-symlink directory"
  fi
  if [[ ! -d "$site_root" ]]; then
    mkdir "$site_root"
  fi
  chown -h root:root "$site_root"
  chmod 0755 "$site_root"

  if [[ -L "$site_root" || ! -d "$site_root" ]]; then
    fail "$site_root changed during ownership hardening"
  fi

  assert_safe_system_path "$runtime_root"
  if [[ -L "$runtime_root" || ( -e "$runtime_root" && ! -d "$runtime_root" ) ]]; then
    fail "$runtime_root must be a non-symlink directory"
  fi
  if [[ ! -d "$runtime_root" ]]; then
    mkdir "$runtime_root"
  fi
  chown -h root:root "$runtime_root"
  chmod 0755 "$runtime_root"
  if [[ -L "$runtime_root" || ! -d "$runtime_root" ]]; then
    fail "$runtime_root changed during ownership hardening"
  fi

  assert_safe_system_path "$releases_root"
  assert_safe_system_path "$staging_root"
  assert_safe_system_path "$state_root"
  for child_path in "$releases_root" "$staging_root" "$state_root"; do
    if [[ -L "$child_path" || ( -e "$child_path" && ! -d "$child_path" ) ]]; then
      fail "$child_path must be a non-symlink directory"
    fi
    if [[ ! -d "$child_path" ]]; then
      mkdir "$child_path"
    fi
    child_mode=0755
    if [[ "$child_path" == "$state_root" ]]; then
      child_mode=0700
    fi
    chown -h admin:admin "$child_path"
    chmod "$child_mode" "$child_path"
  done
  chown -h admin:admin "$runtime_root"
  chmod 0755 "$runtime_root"
}

# Restore the pre-bootstrap Caddyfile after any transactional failure.
restore_caddyfile() {
  local target_path="$1"
  local original_exists="$2"
  local backup_path="$3"

  if [[ "$original_exists" == "1" ]]; then
    if cp -p "$backup_path" "$target_path"; then
      printf 'bootstrap: restored original Caddyfile from %s\n' "$backup_path" >&2
      return 0
    fi
    printf 'bootstrap: failed to restore original Caddyfile from %s\n' "$backup_path" >&2
    return 1
  else
    if rm -f -- "$target_path"; then
      printf 'bootstrap: removed unvalidated new Caddyfile\n' >&2
      return 0
    fi
    printf 'bootstrap: failed to remove unvalidated new Caddyfile %s\n' "$target_path" >&2
    return 1
  fi
}

# Snapshot the pre-bootstrap Caddyfile and service state before package installation can mutate them.
begin_caddyfile_transaction() {
  local target_path="$1"
  local previous_service_state="$2"
  local previous_enablement_state="$3"
  local target_dir
  local rollback_snapshot=""

  target_dir="$(dirname -- "$target_path")"
  mkdir -p "$target_dir"

  if [[ -L "$target_path" ]]; then
    fail "$target_path must not be a symbolic link"
  fi
  if [[ -e "$target_path" && ! -f "$target_path" ]]; then
    fail "$target_path must be a regular file"
  fi

  caddy_transaction_target="$target_path"
  caddy_transaction_original_exists=0
  caddy_transaction_rollback_snapshot=""
  caddy_transaction_temporary=""
  caddy_transaction_file_may_have_changed=0
  caddy_transaction_previous_active=0
  caddy_transaction_service_may_have_changed=0
  caddy_transaction_previous_enabled=0
  if [[ "$previous_service_state" == "active" ]]; then
    caddy_transaction_previous_active=1
  fi
  if [[ "$previous_enablement_state" == "enabled" ]]; then
    caddy_transaction_previous_enabled=1
  fi
  trap 'cleanup_caddyfile_transaction "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  caddy_transaction_active=1

  if [[ -f "$target_path" ]]; then
    rollback_snapshot="$(mktemp "$target_dir/.Caddyfile.rollback.XXXXXX")"
    caddy_transaction_rollback_snapshot="$rollback_snapshot"
    cp -p "$target_path" "$rollback_snapshot"
    caddy_transaction_original_exists=1
  fi
}

# Roll back an interrupted Caddyfile transaction and preserve its exit status.
cleanup_caddyfile_transaction() {
  local exit_status="$1"
  local recovery_config_available=0

  trap - EXIT INT TERM HUP
  if [[ "$caddy_transaction_active" == "1" ]]; then
    if [[ -n "$caddy_transaction_temporary" ]] && ! rm -f -- "$caddy_transaction_temporary"; then
      printf 'bootstrap: failed to remove temporary Caddyfile %s\n' "$caddy_transaction_temporary" >&2
    fi
    if [[ "$caddy_transaction_file_may_have_changed" == "1" ]]; then
      if restore_caddyfile \
        "$caddy_transaction_target" \
        "$caddy_transaction_original_exists" \
        "$caddy_transaction_rollback_snapshot"; then
        if [[ "$caddy_transaction_original_exists" == "1" ]]; then
          recovery_config_available=1
        fi
      else
        printf 'bootstrap: manual Caddyfile recovery is required\n' >&2
      fi
    elif [[ -f "$caddy_transaction_target" && ! -L "$caddy_transaction_target" ]]; then
      recovery_config_available=1
    fi
    if [[ "$caddy_transaction_previous_active" == "1" ]]; then
      if [[ "$recovery_config_available" == "1" ]] && \
        caddy validate --config "$caddy_transaction_target" && \
        systemctl reload caddy; then
        printf 'bootstrap: restored the previously active Caddy service\n' >&2
      else
        printf 'bootstrap: could not restore the previously active Caddy service; manual recovery is required\n' >&2
      fi
    elif [[ "$caddy_transaction_service_may_have_changed" == "1" ]]; then
      if systemctl stop caddy; then
        printf 'bootstrap: restored the prior inactive Caddy service state\n' >&2
      else
        printf 'bootstrap: could not restore the prior inactive Caddy service state; manual recovery is required\n' >&2
      fi
    fi
    if [[ -n "$caddy_transaction_rollback_snapshot" ]] && \
      ! rm -f -- "$caddy_transaction_rollback_snapshot"; then
      printf 'bootstrap: failed to remove rollback snapshot %s\n' "$caddy_transaction_rollback_snapshot" >&2
    fi
    if [[ "$caddy_transaction_service_may_have_changed" == "1" ]]; then
      if [[ "$caddy_transaction_previous_enabled" == "1" ]]; then
        if ! systemctl enable caddy; then
          printf 'bootstrap: could not restore enabled Caddy state; manual recovery is required\n' >&2
        fi
      elif ! systemctl disable caddy; then
        printf 'bootstrap: could not restore disabled Caddy state; manual recovery is required\n' >&2
      fi
    fi
  fi
  exit "$exit_status"
}

# Commit a validated and active Caddyfile transaction.
commit_caddyfile_transaction() {
  caddy_transaction_active=0
  trap - EXIT INT TERM HUP
  if [[ -n "$caddy_transaction_rollback_snapshot" ]] && \
    ! rm -f -- "$caddy_transaction_rollback_snapshot"; then
    printf 'bootstrap: failed to remove committed rollback snapshot %s\n' "$caddy_transaction_rollback_snapshot" >&2
  fi
}

# Install and validate the requested Caddyfile, preserving a changed original.
install_caddyfile() {
  local source_path="$1"
  local target_path="$2"
  local target_dir
  local backup_path=""
  local timestamp
  local temporary_path

  [[ "$caddy_transaction_active" == "1" && "$target_path" == "$caddy_transaction_target" ]] || \
    fail "Caddyfile installation requires an active matching transaction"
  target_dir="$(dirname -- "$target_path")"

  if [[ "$caddy_transaction_original_exists" == "1" ]] && \
    ! cmp -s "$source_path" "$caddy_transaction_rollback_snapshot"; then
    timestamp="$(date '+%Y%m%d%H%M%S')"
    backup_path="$target_path.backup.$timestamp"
    [[ ! -e "$backup_path" && ! -L "$backup_path" ]] || fail "backup already exists: $backup_path; retry after the timestamp changes"
    cp -p "$caddy_transaction_rollback_snapshot" "$backup_path"
    printf 'bootstrap: backed up existing Caddyfile to %s\n' "$backup_path"
  fi

  if [[ -f "$target_path" ]] && cmp -s "$source_path" "$target_path"; then
    printf 'bootstrap: Caddyfile is already current; no replacement needed\n'
    if ! caddy validate --config "$target_path"; then
      printf 'bootstrap: unchanged Caddyfile failed validation and was preserved\n' >&2
      fail "Caddyfile validation failed; Caddy was not enabled or reloaded"
    fi
    return 0
  fi

  temporary_path="$(mktemp "$target_dir/.Caddyfile.XXXXXX")"
  caddy_transaction_temporary="$temporary_path"
  install -m 0644 "$source_path" "$temporary_path"
  caddy_transaction_file_may_have_changed=1
  mv -f -- "$temporary_path" "$target_path"
  caddy_transaction_temporary=""

  if ! caddy validate --config "$target_path"; then
    fail "Caddyfile validation failed; Caddy was not enabled or reloaded"
  fi
}

if [[ "$#" -gt 1 ]]; then
  fail "usage: sudo $0 [path-to-Caddyfile]"
fi

if [[ ! -f "$caddyfile_argument" || ! -r "$caddyfile_argument" ]]; then
  fail "Caddyfile source must be a readable regular file: $caddyfile_argument"
fi

caddyfile_source_dir="$(cd -- "$(dirname -- "$caddyfile_argument")" && pwd -P)"
caddyfile_source="$caddyfile_source_dir/$(basename -- "$caddyfile_argument")"

if [[ "${bootstrap_test_mode:-0}" == "1" ]]; then
  requested_system_root="${bootstrap_system_root:-}"
  [[ "$requested_system_root" == /* && "$requested_system_root" != "/" ]] || fail "bootstrap_system_root must be an absolute non-root path in test mode"
  [[ -d "$requested_system_root" && ! -L "$requested_system_root" ]] || fail "bootstrap_system_root must be an existing canonical directory"
  canonical_system_root="$(cd -- "$requested_system_root" && pwd -P)"
  [[ "$requested_system_root" == "$canonical_system_root" ]] || fail "bootstrap_system_root must be canonical and contain no symbolic-link components"
  system_root="$canonical_system_root"
else
  [[ "${bootstrap_test_mode:-0}" == "0" ]] || fail "bootstrap_test_mode must be 0 or 1"
  [[ -z "${bootstrap_system_root:-}" ]] || fail "bootstrap_system_root is allowed only when bootstrap_test_mode=1"
  [[ "$EUID" -eq 0 ]] || fail "run this script as root, for example: sudo $0 $caddyfile_source"
  system_root=""
fi

os_release_path="$system_root/etc/os-release"
caddy_target="$system_root/etc/caddy/Caddyfile"
site_root="$system_root/var/www/personal_site"
runtime_root="$site_root/runtime"
releases_root="$runtime_root/releases"
staging_root="$runtime_root/staging"
state_root="$runtime_root/state"

assert_safe_system_path "$os_release_path"
[[ -r "$os_release_path" ]] || fail "cannot read $os_release_path"
distro_id="$(sed -n 's/^ID=//p' "$os_release_path" | head -n 1 | tr -d '"')"
version_id="$(sed -n 's/^VERSION_ID=//p' "$os_release_path" | head -n 1 | tr -d '"')"
architecture="$(uname -m)"

case "$distro_id" in
  ubuntu | debian) ;;
  *) fail "unsupported distribution '$distro_id'; use Ubuntu or Debian" ;;
esac

[[ -n "$version_id" ]] || fail "VERSION_ID is missing from $os_release_path"
printf 'bootstrap: detected ID=%s VERSION_ID=%s ARCH=%s\n' "$distro_id" "$version_id" "$architecture"

listener_output="$(ss -ltnp)"
printf 'bootstrap: listeners on ports 22, 80, and 443:\n'
port_listener_output="$(printf '%s\n' "$listener_output" | awk '$4 ~ /:22$/ || $4 ~ /:80$/ || $4 ~ /:443$/')"
if [[ -n "$port_listener_output" ]]; then
  printf '%s\n' "$port_listener_output"
else
  printf 'none\n'
fi

caddy_state="$(get_service_state caddy)"
caddy_enablement="$(get_service_enablement caddy)"
nginx_state="$(get_service_state nginx)"
apache2_state="$(get_service_state apache2)"
printf 'bootstrap: service states: caddy=%s caddy_enablement=%s nginx=%s apache2=%s\n' "$caddy_state" "$caddy_enablement" "$nginx_state" "$apache2_state"

assert_port_80_listener_safe "$listener_output" "initial inspection"

id -u admin >/dev/null 2>&1 || fail "required user 'admin' does not exist"

assert_safe_system_path "$caddy_target"
begin_caddyfile_transaction "$caddy_target" "$caddy_state" "$caddy_enablement"

if ! command -v caddy >/dev/null 2>&1; then
  printf 'bootstrap: Caddy is absent; installing the distro package\n'
  apt-get update
  if ! apt-cache show caddy >/dev/null 2>&1; then
    fail "the caddy package is unavailable for $distro_id $version_id; configure a trusted package repository explicitly, then rerun"
  fi
  caddy_transaction_file_may_have_changed=1
  caddy_transaction_service_may_have_changed=1
  apt-get install --yes caddy
fi

prepare_site_directories

install_caddyfile "$caddyfile_source" "$caddy_target"

activation_listener_output="$(ss -ltnp)"
assert_port_80_listener_safe "$activation_listener_output" "pre-activation recheck"

caddy_transaction_service_may_have_changed=1
systemctl enable caddy
if [[ "$caddy_state" == "active" ]]; then
  systemctl reload caddy
else
  systemctl restart caddy
fi

systemctl is-active caddy
commit_caddyfile_transaction
printf 'bootstrap: site URL http://106.14.173.234\n'
