#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root_candidate="$(mktemp -d)"
test_root="$(cd "$test_root_candidate" && pwd -P)"
mock_bin="$test_root/bin"
mock_state="$test_root/mock_state"
command_log="$test_root/commands.log"
test_fs="$test_root/fs"
test_caddyfile="$test_root/Caddyfile.ip"
captured_output="$test_root/captured.log"

trap 'rm -rf -- "$test_root"' EXIT

# Stop the test suite with a readable assertion message.
fail() {
  local message="$1"
  printf 'FAIL: %s\n' "$message" >&2
  exit 1
}

# Assert that a command succeeds.
assert_success() {
  local description="$1"
  shift
  "$@" || fail "$description"
}

# Assert that a command fails.
assert_failure() {
  local description="$1"
  shift
  if "$@"; then
    fail "$description"
  fi
}

# Assert that a command exits with an exact status.
assert_status() {
  local expected_status="$1"
  local description="$2"
  shift 2
  local actual_status

  set +e
  "$@"
  actual_status=$?
  set -e
  assert_equal "$expected_status" "$actual_status" "$description"
}

# Assert that two string values are equal.
assert_equal() {
  local expected="$1"
  local actual="$2"
  local description="$3"
  [[ "$actual" == "$expected" ]] || fail "$description: expected '$expected', got '$actual'"
}

# Assert that a fixed string occurs in a file.
assert_contains() {
  local expected="$1"
  local file_path="$2"
  grep -F -- "$expected" "$file_path" >/dev/null || fail "missing '$expected' in $file_path"
}

# Assert that a fixed string does not occur in a file.
assert_not_contains() {
  local unexpected="$1"
  local file_path="$2"
  if grep -F -- "$unexpected" "$file_path" >/dev/null; then
    fail "unexpected '$unexpected' in $file_path"
  fi
}

# Assert that a fixed string occurs an exact number of times in a file.
assert_count() {
  local expected_count="$1"
  local expected="$2"
  local file_path="$3"
  local actual_count
  actual_count="$(grep -Fc -- "$expected" "$file_path" || true)"
  assert_equal "$expected_count" "$actual_count" "count of '$expected' in $file_path"
}

# Return a directory mode portably on macOS and Linux.
file_mode() {
  local file_path="$1"
  if stat -f '%Lp' "$file_path" >/dev/null 2>&1; then
    stat -f '%Lp' "$file_path"
  else
    stat -c '%a' "$file_path"
  fi
}

# Reset the isolated filesystem and mock behavior for one scenario.
reset_case() {
  rm -rf -- "$test_fs" "$mock_state"
  mkdir -p "$test_fs/etc" "$mock_state"
  : >"$command_log"
  : >"$mock_state/ss_output"
  : >"$mock_state/ss_output_second"
  printf '0\n' >"$mock_state/ss_call_count"
  printf 'inactive\n' >"$mock_state/caddy_state"
  printf 'disabled\n' >"$mock_state/caddy_enabled_state"
  printf 'inactive\n' >"$mock_state/nginx_state"
  printf 'inactive\n' >"$mock_state/apache2_state"
  printf '0\n' >"$mock_state/caddy_validate_failure"
  printf '0\n' >"$mock_state/package_install_changes_caddy"
  printf 'none\n' >"$mock_state/caddy_signal"
  printf 'none\n' >"$mock_state/systemctl_failure_action"
  printf 'none\n' >"$mock_state/systemctl_signal_action"
  printf '0\n' >"$mock_state/caddy_is_active_count"
  printf '1\n' >"$mock_state/admin_exists"
  printf 'ID=ubuntu\nVERSION_ID=24.04\n' >"$test_fs/etc/os-release"
  printf 'http://106.14.173.234 {\n    root * /var/www/personal_site/runtime/current\n}\n' >"$test_caddyfile"
}

# Run the bootstrap against the isolated filesystem.
run_bootstrap() {
  run_bootstrap_with_root "$test_fs"
}

# Run the bootstrap with one explicit isolated root.
run_bootstrap_with_root() {
  local bootstrap_root="$1"
  bootstrap_test_mode=1 \
    bootstrap_system_root="$bootstrap_root" \
    mock_state="$mock_state" \
    command_log="$command_log" \
    repo_root="$repo_root" \
    test_fs="$test_fs" \
    mock_bin="$mock_bin" \
    package_caddy_mock="$test_root/caddy.package.mock" \
    PATH="$mock_bin:$PATH" \
    "$repo_root/ops/bootstrap_server.sh" "$test_caddyfile"
}

mkdir -p "$mock_bin"

cat >"$mock_bin/ss" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'ss <%s>\n' "$*" >>"$command_log"
ss_call_count="$(cat "$mock_state/ss_call_count")"
ss_call_count=$((ss_call_count + 1))
printf '%s\n' "$ss_call_count" >"$mock_state/ss_call_count"
if [[ "$ss_call_count" -gt 1 && -s "$mock_state/ss_output_second" ]]; then
  cat "$mock_state/ss_output_second"
else
  cat "$mock_state/ss_output"
fi
MOCK

cat >"$mock_bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl <%s>\n' "$*" >>"$command_log"
systemctl_action="${1:-}"
if [[ "$systemctl_action" == "is-enabled" ]]; then
  enabled_state_file="$mock_state/${2}_enabled_state"
  enabled_state="$(cat "$enabled_state_file")"
  printf '%s\n' "$enabled_state"
  [[ "$enabled_state" == "enabled" ]]
fi
if [[ "$systemctl_action" == "is-active" ]]; then
  if [[ "${2:-}" == "caddy" ]]; then
    caddy_is_active_count="$(cat "$mock_state/caddy_is_active_count")"
    caddy_is_active_count=$((caddy_is_active_count + 1))
    printf '%s\n' "$caddy_is_active_count" >"$mock_state/caddy_is_active_count"
    if [[ "$(cat "$mock_state/systemctl_failure_action")" == "final-is-active" && "$caddy_is_active_count" -gt 1 ]]; then
      printf 'none\n' >"$mock_state/systemctl_failure_action"
      exit 1
    fi
  fi
  state_file="$mock_state/${2}_state"
  service_state="$(cat "$state_file")"
  printf '%s\n' "$service_state"
  [[ "$service_state" == "active" ]]
fi
if [[ "$(cat "$mock_state/systemctl_signal_action")" == "$systemctl_action" ]]; then
  printf 'none\n' >"$mock_state/systemctl_signal_action"
  kill -TERM "$PPID"
  exit 143
fi
if [[ "$(cat "$mock_state/systemctl_failure_action")" == "$systemctl_action" ]]; then
  printf 'none\n' >"$mock_state/systemctl_failure_action"
  if [[ "$systemctl_action" == "restart" ]]; then
    printf 'inactive\n' >"$mock_state/caddy_state"
  fi
  exit 1
fi
if [[ "$systemctl_action" == "restart" || "$systemctl_action" == "reload" ]]; then
  printf 'active\n' >"$mock_state/${2}_state"
fi
if [[ "$systemctl_action" == "stop" ]]; then
  printf 'inactive\n' >"$mock_state/${2}_state"
fi
if [[ "$systemctl_action" == "enable" ]]; then
  printf 'enabled\n' >"$mock_state/${2}_enabled_state"
fi
if [[ "$systemctl_action" == "disable" ]]; then
  printf 'disabled\n' >"$mock_state/${2}_enabled_state"
fi
MOCK

cat >"$mock_bin/caddy" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'caddy <%s>\n' "$*" >>"$command_log"
if [[ "${1:-}" == "validate" && "${2:-}" == "--config" && "${3:-}" == "$repo_root/ops/Caddyfile.ip" ]]; then
  grep -Fx 'http://106.14.173.234 {' "$3" >/dev/null
  grep -Fx '    root * /var/www/personal_site/runtime/current' "$3" >/dev/null
  grep -Fx '    encode zstd gzip' "$3" >/dev/null
  grep -Fx '    file_server' "$3" >/dev/null
  grep -Fx '        X-Content-Type-Options nosniff' "$3" >/dev/null
  grep -Fx '        Referrer-Policy strict-origin-when-cross-origin' "$3" >/dev/null
  grep -Fx '        X-Frame-Options DENY' "$3" >/dev/null
  grep -Fx '        -Server' "$3" >/dev/null
  if grep -E 'https://|(^|[[:space:]])tls([[:space:]]|$)' "$3" >/dev/null; then
    exit 1
  fi
fi
if [[ "$(cat "$mock_state/caddy_signal")" == "TERM" ]]; then
  printf 'none\n' >"$mock_state/caddy_signal"
  kill -TERM "$PPID"
  exit 143
fi
if [[ "$(cat "$mock_state/caddy_validate_failure")" == "1" ]]; then
  exit 1
fi
MOCK

cat >"$mock_bin/id" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'id <%s>\n' "$*" >>"$command_log"
if [[ "${1:-}" == "-u" && "${2:-}" == "admin" ]]; then
  if [[ "$(cat "$mock_state/admin_exists")" == "1" ]]; then
    printf '1000\n'
    exit 0
  fi
fi
exit 1
MOCK

cat >"$mock_bin/chown" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'chown <%s>\n' "$*" >>"$command_log"
MOCK

cat >"$mock_bin/apt-get" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'apt-get <%s>\n' "$*" >>"$command_log"
if [[ "${1:-}" == "install" && "$(cat "$mock_state/package_install_changes_caddy")" == "1" ]]; then
  mkdir -p "$test_fs/etc/caddy"
  printf 'package configuration\n' >"$test_fs/etc/caddy/Caddyfile"
  printf 'active\n' >"$mock_state/caddy_state"
  printf 'enabled\n' >"$mock_state/caddy_enabled_state"
  cp "$package_caddy_mock" "$mock_bin/caddy"
  chmod +x "$mock_bin/caddy"
fi
MOCK

cat >"$mock_bin/apt-cache" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'apt-cache <%s>\n' "$*" >>"$command_log"
printf 'Package: caddy\n'
MOCK

chmod +x "$mock_bin/ss" "$mock_bin/systemctl" "$mock_bin/caddy" \
  "$mock_bin/id" "$mock_bin/chown" "$mock_bin/apt-get" "$mock_bin/apt-cache"

expected_ssh_config="$(cat <<'EXPECTED'
Host personal_server
    HostName 106.14.173.234
    User admin
    Port 22
    IdentityFile ~/.ssh/id_rsa
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
EXPECTED
)"
actual_ssh_config="$(cat "$repo_root/ops/ssh/personal_server.conf" 2>/dev/null || true)"
assert_equal "$expected_ssh_config" "$actual_ssh_config" "SSH fragment must match the approved alias"

assert_contains 'http://106.14.173.234 {' "$repo_root/ops/Caddyfile.ip"
assert_contains 'root * /var/www/personal_site/runtime/current' "$repo_root/ops/Caddyfile.ip"
assert_contains 'encode zstd gzip' "$repo_root/ops/Caddyfile.ip"
assert_contains 'file_server' "$repo_root/ops/Caddyfile.ip"
assert_contains 'X-Content-Type-Options nosniff' "$repo_root/ops/Caddyfile.ip"
assert_contains 'Referrer-Policy strict-origin-when-cross-origin' "$repo_root/ops/Caddyfile.ip"
assert_contains 'X-Frame-Options DENY' "$repo_root/ops/Caddyfile.ip"
assert_contains '-Server' "$repo_root/ops/Caddyfile.ip"
assert_not_contains 'https://' "$repo_root/ops/Caddyfile.ip"
reset_case
assert_success "the checked-in IP Caddyfile must pass Caddy validation semantics" \
  env mock_state="$mock_state" command_log="$command_log" repo_root="$repo_root" \
  "$mock_bin/caddy" validate --config "$repo_root/ops/Caddyfile.ip"

reset_case
printf 'ID=fedora\nVERSION_ID=42\n' >"$test_fs/etc/os-release"
assert_failure "unsupported distributions must fail" run_bootstrap
assert_not_contains 'apt-get' "$command_log"
[[ ! -e "$test_fs/var/www/personal_site" ]] || fail "unsupported OS changed the site filesystem"

reset_case
printf 'active\n' >"$mock_state/nginx_state"
assert_success "active nginx without a port 80 listener must not block bootstrap" run_bootstrap

reset_case
printf 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("python",pid=12,fd=3))\n' >"$mock_state/ss_output"
assert_failure "a non-Caddy port 80 listener must stop bootstrap" run_bootstrap
assert_not_contains 'apt-get' "$command_log"
[[ ! -e "$test_fs/var/www/personal_site" ]] || fail "port conflict changed the site filesystem"

reset_case
printf 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("python",pid=13,fd=3))\n' >"$mock_state/ss_output_second"
assert_failure "a port 80 listener appearing before activation must stop bootstrap" run_bootstrap
[[ ! -e "$test_fs/etc/caddy/Caddyfile" ]] || fail "listener race retained a newly installed Caddyfile"
assert_not_contains 'systemctl <enable caddy>' "$command_log"
assert_count '2' 'ss <-ltnp>' "$command_log"

reset_case
printf 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("caddy",pid=14,fd=3))\n' >"$mock_state/ss_output"
assert_success "an existing Caddy port 80 listener must be allowed" run_bootstrap

reset_case
printf '0\n' >"$mock_state/admin_exists"
mv "$mock_bin/caddy" "$test_root/caddy.mock"
assert_failure "a missing admin user must stop before package installation" run_bootstrap
mv "$test_root/caddy.mock" "$mock_bin/caddy"
assert_not_contains 'apt-get' "$command_log"
[[ ! -e "$test_fs/var/www/personal_site" ]] || fail "missing admin user changed the site filesystem"

reset_case
mkdir -p "$test_fs/var/www"
parent_escape_target="$test_root/parent_escape_target"
mkdir -m 0711 "$parent_escape_target"
ln -s "$parent_escape_target" "$test_fs/var/www/personal_site"
assert_failure "a symlinked site root must be rejected" run_bootstrap
[[ ! -e "$parent_escape_target/releases" ]] || fail "site-root symlink created host-target children"
assert_equal '711' "$(file_mode "$parent_escape_target")" "site-root symlink changed host-target mode"
assert_not_contains "chown <admin:admin $test_fs/var/www/personal_site" "$command_log"

reset_case
mkdir -p "$test_fs/var/www/personal_site"
runtime_escape_target="$test_root/runtime_escape_target"
mkdir -m 0711 "$runtime_escape_target"
ln -s "$runtime_escape_target" "$test_fs/var/www/personal_site/runtime"
assert_failure "a symlinked runtime directory must be rejected" run_bootstrap
[[ ! -e "$runtime_escape_target/releases" ]] || fail "runtime symlink created host-target children"
assert_equal '711' "$(file_mode "$runtime_escape_target")" "runtime symlink changed host-target mode"
assert_not_contains "chown <-h admin:admin $test_fs/var/www/personal_site/runtime>" "$command_log"

reset_case
mkdir -p "$test_fs/var/www/personal_site/runtime/releases" "$test_fs/var/www/personal_site/runtime/staging"
state_escape_target="$test_root/state_escape_target"
mkdir -m 0711 "$state_escape_target"
ln -s "$state_escape_target" "$test_fs/var/www/personal_site/runtime/state"
assert_failure "a symlinked state directory must be rejected" run_bootstrap
assert_equal '711' "$(file_mode "$state_escape_target")" "state symlink changed host-target mode"
assert_not_contains "chown <admin:admin $test_fs/var/www/personal_site/runtime/state" "$command_log"

reset_case
mkdir -p "$test_fs/var/www/personal_site/runtime/releases" "$test_fs/var/www/personal_site/runtime/staging"
printf 'not a directory\n' >"$test_fs/var/www/personal_site/runtime/state"
assert_failure "a non-directory state path must be rejected" run_bootstrap
assert_not_contains "chown <admin:admin $test_fs/var/www/personal_site/runtime/state" "$command_log"

reset_case
assert_failure "a lexical parent traversal in the test root must be rejected" run_bootstrap_with_root "$test_fs/../fs"
assert_not_contains 'chown' "$command_log"

reset_case
root_link="$test_root/root_link"
ln -s / "$root_link"
if run_bootstrap_with_root "$root_link" >"$captured_output" 2>&1; then
  fail "a test root symlinked to / was accepted"
fi
assert_contains 'canonical' "$captured_output"
assert_not_contains 'chown' "$command_log"

reset_case
nested_escape_target="$test_root/nested_escape_target"
mkdir "$nested_escape_target"
mkdir -p "$test_fs"
ln -s "$nested_escape_target" "$test_fs/var"
assert_failure "a nested test-root symlink must be rejected" run_bootstrap
[[ ! -e "$nested_escape_target/www" ]] || fail "nested symlink escape mutated its target"
assert_not_contains "$nested_escape_target" "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
cp "$test_caddyfile" "$test_fs/etc/caddy/Caddyfile"
assert_success "an identical configuration should be idempotent" run_bootstrap
backup_count="$(find "$test_fs/etc/caddy" -maxdepth 1 -type f -name 'Caddyfile.backup.*' | wc -l | tr -d ' ')"
assert_equal '0' "$backup_count" "identical configuration must not create a backup"
assert_equal '755' "$(file_mode "$test_fs/var/www/personal_site")" "site root mode"
assert_equal '755' "$(file_mode "$test_fs/var/www/personal_site/runtime")" "runtime root mode"
assert_equal '755' "$(file_mode "$test_fs/var/www/personal_site/runtime/releases")" "releases mode"
assert_equal '755' "$(file_mode "$test_fs/var/www/personal_site/runtime/staging")" "staging mode"
assert_equal '700' "$(file_mode "$test_fs/var/www/personal_site/runtime/state")" "state mode"
assert_contains "chown <-h root:root $test_fs/var/www/personal_site>" "$command_log"
assert_contains "chown <-h admin:admin $test_fs/var/www/personal_site/runtime>" "$command_log"
assert_contains "chown <-h admin:admin $test_fs/var/www/personal_site/runtime/releases>" "$command_log"
assert_contains "chown <-h admin:admin $test_fs/var/www/personal_site/runtime/staging>" "$command_log"
assert_contains "chown <-h admin:admin $test_fs/var/www/personal_site/runtime/state>" "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
cp "$test_caddyfile" "$test_fs/etc/caddy/Caddyfile"
printf '1\n' >"$mock_state/caddy_validate_failure"
assert_failure "an invalid unchanged configuration must stop bootstrap" run_bootstrap
[[ -f "$test_fs/etc/caddy/Caddyfile" ]] || fail "validation removed an unchanged Caddyfile"
assert_equal "$(cat "$test_caddyfile")" "$(cat "$test_fs/etc/caddy/Caddyfile")" "unchanged invalid configuration must be preserved"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'old configuration\n' >"$test_fs/etc/caddy/Caddyfile"
printf 'new configuration\n' >"$test_caddyfile"
printf '1\n' >"$mock_state/caddy_validate_failure"
assert_status '1' "validation failure must preserve its exit status" run_bootstrap
assert_equal 'old configuration' "$(cat "$test_fs/etc/caddy/Caddyfile")" "validation failure must restore the original"
backup_count="$(find "$test_fs/etc/caddy" -maxdepth 1 -type f -name 'Caddyfile.backup.*' | wc -l | tr -d ' ')"
assert_equal '1' "$backup_count" "changed configuration must create one backup"
assert_not_contains 'systemctl <enable caddy>' "$command_log"
assert_not_contains 'systemctl <reload caddy>' "$command_log"
assert_not_contains 'systemctl <restart caddy>' "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'old configuration\n' >"$test_fs/etc/caddy/Caddyfile"
printf 'new configuration\n' >"$test_caddyfile"
printf 'active\n' >"$mock_state/caddy_state"
printf 'enable\n' >"$mock_state/systemctl_failure_action"
assert_status '1' "enable failure must preserve its exit status" run_bootstrap
assert_equal 'old configuration' "$(cat "$test_fs/etc/caddy/Caddyfile")" "enable failure must restore the original Caddyfile"
assert_equal 'active' "$(cat "$mock_state/caddy_state")" "enable failure must preserve an active Caddy service"
assert_equal 'disabled' "$(cat "$mock_state/caddy_enabled_state")" "enable failure must preserve disabled enablement"
assert_count '1' 'systemctl <disable caddy>' "$command_log"
assert_count '1' 'systemctl <reload caddy>' "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'new configuration\n' >"$test_caddyfile"
printf 'enable\n' >"$mock_state/systemctl_signal_action"
assert_status '143' "TERM during enable must preserve its exit status" run_bootstrap
[[ ! -e "$test_fs/etc/caddy/Caddyfile" ]] || fail "TERM during enable retained a newly installed Caddyfile"
assert_equal 'inactive' "$(cat "$mock_state/caddy_state")" "TERM during enable changed an inactive Caddy service"
assert_equal 'disabled' "$(cat "$mock_state/caddy_enabled_state")" "TERM during enable must restore disabled enablement"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'old configuration\n' >"$test_fs/etc/caddy/Caddyfile"
printf 'new configuration\n' >"$test_caddyfile"
printf 'active\n' >"$mock_state/caddy_state"
printf 'reload\n' >"$mock_state/systemctl_failure_action"
assert_status '1' "reload failure must preserve its exit status" run_bootstrap
assert_equal 'old configuration' "$(cat "$test_fs/etc/caddy/Caddyfile")" "reload failure must restore the original Caddyfile"
assert_equal 'active' "$(cat "$mock_state/caddy_state")" "reload failure must recover the active Caddy service"
assert_equal 'disabled' "$(cat "$mock_state/caddy_enabled_state")" "reload failure must restore active-but-disabled enablement"
assert_count '1' 'systemctl <disable caddy>' "$command_log"
assert_count '2' 'systemctl <reload caddy>' "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'old configuration\n' >"$test_fs/etc/caddy/Caddyfile"
printf 'new configuration\n' >"$test_caddyfile"
printf 'active\n' >"$mock_state/caddy_state"
printf 'enabled\n' >"$mock_state/caddy_enabled_state"
printf 'reload\n' >"$mock_state/systemctl_failure_action"
assert_status '1' "enabled-service reload failure must preserve its exit status" run_bootstrap
assert_equal 'old configuration' "$(cat "$test_fs/etc/caddy/Caddyfile")" "enabled-service reload failure must restore the original Caddyfile"
assert_equal 'active' "$(cat "$mock_state/caddy_state")" "enabled-service reload failure must recover active state"
assert_equal 'enabled' "$(cat "$mock_state/caddy_enabled_state")" "enabled-service reload failure must preserve enablement"
assert_count '2' 'systemctl <enable caddy>' "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'old configuration\n' >"$test_fs/etc/caddy/Caddyfile"
printf 'new configuration\n' >"$test_caddyfile"
printf 'active\n' >"$mock_state/caddy_state"
printf 'reload\n' >"$mock_state/systemctl_signal_action"
assert_status '143' "TERM during reload must preserve its exit status" run_bootstrap
assert_equal 'old configuration' "$(cat "$test_fs/etc/caddy/Caddyfile")" "TERM during reload must restore the original Caddyfile"
assert_equal 'active' "$(cat "$mock_state/caddy_state")" "TERM during reload must recover the active Caddy service"
assert_count '2' 'systemctl <reload caddy>' "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'new configuration\n' >"$test_caddyfile"
printf 'restart\n' >"$mock_state/systemctl_failure_action"
assert_status '1' "restart failure must preserve its exit status" run_bootstrap
[[ ! -e "$test_fs/etc/caddy/Caddyfile" ]] || fail "restart failure retained a newly installed Caddyfile"
assert_equal 'inactive' "$(cat "$mock_state/caddy_state")" "restart failure must leave the prior inactive service state"
assert_equal 'disabled' "$(cat "$mock_state/caddy_enabled_state")" "restart failure must restore inactive-disabled enablement"
assert_count '1' 'systemctl <disable caddy>' "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'new configuration\n' >"$test_caddyfile"
printf 'restart\n' >"$mock_state/systemctl_signal_action"
assert_status '143' "TERM during restart must preserve its exit status" run_bootstrap
[[ ! -e "$test_fs/etc/caddy/Caddyfile" ]] || fail "TERM during restart retained a newly installed Caddyfile"
assert_equal 'inactive' "$(cat "$mock_state/caddy_state")" "TERM during restart must leave the prior inactive service state"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'old configuration\n' >"$test_fs/etc/caddy/Caddyfile"
printf 'new configuration\n' >"$test_caddyfile"
printf 'final-is-active\n' >"$mock_state/systemctl_failure_action"
assert_status '1' "final active-state failure must preserve its exit status" run_bootstrap
assert_equal 'old configuration' "$(cat "$test_fs/etc/caddy/Caddyfile")" "final active-state failure must restore the original Caddyfile"
assert_equal 'inactive' "$(cat "$mock_state/caddy_state")" "final active-state failure must restore the prior inactive service state"
assert_equal 'disabled' "$(cat "$mock_state/caddy_enabled_state")" "final active-state failure must restore disabled enablement"
assert_count '1' 'systemctl <stop caddy>' "$command_log"
assert_count '1' 'systemctl <disable caddy>' "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'new configuration\n' >"$test_caddyfile"
printf '1\n' >"$mock_state/caddy_validate_failure"
assert_status '1' "validation failure without an original must preserve its exit status" run_bootstrap
[[ ! -e "$test_fs/etc/caddy/Caddyfile" ]] || fail "validation failure retained a newly installed Caddyfile"
temporary_count="$(find "$test_fs/etc/caddy" -maxdepth 1 -type f -name '.Caddyfile.*' | wc -l | tr -d ' ')"
assert_equal '0' "$temporary_count" "validation failure must remove staged files"
assert_not_contains 'systemctl <enable caddy>' "$command_log"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'old configuration\n' >"$test_fs/etc/caddy/Caddyfile"
printf 'new configuration\n' >"$test_caddyfile"
printf 'TERM\n' >"$mock_state/caddy_signal"
assert_status '143' "TERM must preserve the signal exit status" run_bootstrap
assert_equal 'old configuration' "$(cat "$test_fs/etc/caddy/Caddyfile")" "TERM must restore the original Caddyfile"
temporary_count="$(find "$test_fs/etc/caddy" -maxdepth 1 -type f -name '.Caddyfile.*' | wc -l | tr -d ' ')"
assert_equal '0' "$temporary_count" "TERM with an original must remove staged files"
assert_not_contains 'systemctl <enable caddy>' "$command_log"
assert_not_contains 'systemctl <reload caddy>' "$command_log"
assert_not_contains 'systemctl <restart caddy>' "$command_log"

reset_case
mv "$mock_bin/caddy" "$test_root/caddy.package.mock"
printf '1\n' >"$mock_state/package_install_changes_caddy"
printf '1\n' >"$mock_state/caddy_validate_failure"
assert_status '1' "validation failure after package installation must preserve its exit status" run_bootstrap
[[ ! -e "$test_fs/etc/caddy/Caddyfile" ]] || fail "package-induced Caddyfile survived validation rollback"
assert_equal 'inactive' "$(cat "$mock_state/caddy_state")" "package-induced active state must be rolled back"
assert_equal 'disabled' "$(cat "$mock_state/caddy_enabled_state")" "package-induced enablement must be rolled back"
assert_count '1' 'systemctl <stop caddy>' "$command_log"
assert_count '1' 'systemctl <disable caddy>' "$command_log"
rm -f -- "$test_root/caddy.package.mock"

reset_case
mv "$mock_bin/caddy" "$test_root/caddy.package.mock"
printf '1\n' >"$mock_state/package_install_changes_caddy"
printf 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("python",pid=15,fd=3))\n' >"$mock_state/ss_output_second"
assert_status '1' "pre-activation failure after package installation must preserve its exit status" run_bootstrap
[[ ! -e "$test_fs/etc/caddy/Caddyfile" ]] || fail "package-induced Caddyfile survived pre-activation rollback"
assert_equal 'inactive' "$(cat "$mock_state/caddy_state")" "pre-activation rollback must stop package-started Caddy"
assert_equal 'disabled' "$(cat "$mock_state/caddy_enabled_state")" "pre-activation rollback must disable package-enabled Caddy"
assert_count '1' 'systemctl <stop caddy>' "$command_log"
assert_count '1' 'systemctl <disable caddy>' "$command_log"
rm -f -- "$test_root/caddy.package.mock"

reset_case
mkdir -p "$test_fs/etc/caddy"
printf 'new configuration\n' >"$test_caddyfile"
printf 'TERM\n' >"$mock_state/caddy_signal"
assert_status '143' "TERM without an original must preserve the signal exit status" run_bootstrap
[[ ! -e "$test_fs/etc/caddy/Caddyfile" ]] || fail "TERM retained a newly installed Caddyfile"
temporary_count="$(find "$test_fs/etc/caddy" -maxdepth 1 -type f -name '.Caddyfile.*' | wc -l | tr -d ' ')"
assert_equal '0' "$temporary_count" "TERM without an original must remove staged files"
assert_not_contains 'systemctl <enable caddy>' "$command_log"
assert_not_contains 'systemctl <reload caddy>' "$command_log"
assert_not_contains 'systemctl <restart caddy>' "$command_log"

printf 'bootstrap server tests passed\n'
