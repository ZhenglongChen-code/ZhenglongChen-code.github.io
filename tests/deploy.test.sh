#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

mock_bin="$test_root/bin"
mock_state_dir="$test_root/state"
command_log="$test_root/commands.log"
valid_deploy_key_path="$test_root/deploy_key"
deploy_key_path="$valid_deploy_key_path"
mkdir -p "$mock_bin" "$mock_state_dir"
: >"$command_log"
: >"$deploy_key_path"
chmod 600 "$deploy_key_path"

cat >"$mock_bin/ssh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh' >>"$command_log"
printf ' <%s>' "$@" >>"$command_log"
printf '\n' >>"$command_log"

remote_command="${!#}"
release_dir="/var/www/personal_site/runtime/releases/$release_name"
staging_dir="/var/www/personal_site/runtime/staging/$release_name"
state_file="/var/www/personal_site/runtime/state/$release_name.previous"
current_link="/var/www/personal_site/runtime/current"

if [[ "$remote_command" == *"mkdir"*"$staging_dir"* ]]; then
  if [[ -e "$mock_state_dir/release_exists" || -e "$mock_state_dir/staging_exists" ]]; then
    exit 73
  fi
  : >"$mock_state_dir/staging_exists"
  printf 'create_staging\n' >>"$mock_state_dir/events"
  exit 0
fi

if [[ "$remote_command" == *"test -f $staging_dir/index.html"* ]]; then
  if [[ "${mock_verify_failure:-0}" == "1" ]]; then
    printf 'verify_failure\n' >>"$mock_state_dir/events"
    exit 74
  fi
  [[ -e "$mock_state_dir/uploaded" ]]
  printf 'verify_staging_index\n' >>"$mock_state_dir/events"
  exit 0
fi

if [[ "$remote_command" == *"rm -rf -- $staging_dir"* ]]; then
  rm -f -- "$mock_state_dir/staging_exists" "$mock_state_dir/uploaded"
  printf 'cleanup_staging\n' >>"$mock_state_dir/events"
  exit 0
fi

if [[ "$remote_command" == *"mv -- $staging_dir $release_dir"* && "$remote_command" == *"mv -Tf"*"$current_link"* ]]; then
  [[ -e "$mock_state_dir/staging_exists" && ! -e "$mock_state_dir/release_exists" ]]
  if [[ -n "${mock_target_before_switch:-}" ]]; then
    printf '%s\n' "$mock_target_before_switch" >"$mock_state_dir/current_target"
    printf 'concurrent_before_switch\n' >>"$mock_state_dir/events"
  fi
  current_target_kind="$(cat "$mock_state_dir/current_target_kind" 2>/dev/null || printf 'valid')"
  if [[ "$current_target_kind" != "valid" ]]; then
    if [[ "$remote_command" == *"$state_file"* && "$remote_command" == *"readlink -f"* && "$remote_command" == *"[ -L"* ]]; then
      printf 'reject_%s_target\n' "$current_target_kind" >>"$mock_state_dir/events"
      exit 77
    fi
  fi
  rm -f -- "$mock_state_dir/staging_exists"
  : >"$mock_state_dir/release_exists"
  printf 'promote_release\n' >>"$mock_state_dir/events"
  if [[ -s "$mock_state_dir/current_target" ]]; then
    cp "$mock_state_dir/current_target" "$mock_state_dir/previous_state"
  else
    : >"$mock_state_dir/previous_state"
  fi
  [[ "$remote_command" == *"$state_file"* ]] && printf 'write_previous_state\n' >>"$mock_state_dir/events"
  printf 'capture_current\n' >>"$mock_state_dir/events"
  printf '%s\n' "$release_dir" >"$mock_state_dir/current_target"
  printf 'switch_current\n' >>"$mock_state_dir/events"
  if [[ "${mock_interrupt_after_switch:-0}" == "1" ]]; then
    printf 'remote_interrupt_after_switch\n' >>"$mock_state_dir/events"
    if [[ "$remote_command" != *"current_target="* || "$remote_command" != *"!= $release_dir"* ]]; then
      rm -f -- "$mock_state_dir/release_exists"
      printf 'unsafe_trap_removed_active_release\n' >>"$mock_state_dir/events"
    else
      printf 'safe_trap_preserved_active_release\n' >>"$mock_state_dir/events"
    fi
    exit 143
  fi
  exit 0
fi

if [[ "$remote_command" == *".rollback."* && "$remote_command" == *"mv -Tf"*"$current_link"* ]]; then
  [[ "$remote_command" == *"$state_file"* ]] || exit 78
  current_target="$(cat "$mock_state_dir/current_target" 2>/dev/null || true)"
  if [[ "$current_target" != "$release_dir" ]]; then
    rm -f -- "$mock_state_dir/previous_state"
    printf 'rollback_superseded\n' >>"$mock_state_dir/events"
    exit 42
  fi
  if [[ -s "$mock_state_dir/previous_state" ]]; then
    cat "$mock_state_dir/previous_state" >"$mock_state_dir/current_target"
    printf 'rollback_current\n' >>"$mock_state_dir/events"
  else
    rm -f -- "$mock_state_dir/current_target"
    printf 'clear_current\n' >>"$mock_state_dir/events"
  fi
  if [[ "$remote_command" == *"rm -rf -- $release_dir"* ]]; then
    rm -f -- "$mock_state_dir/release_exists"
    printf 'remove_failed_release\n' >>"$mock_state_dir/events"
  fi
  cp "$mock_state_dir/previous_state" "$mock_state_dir/last_previous_state"
  rm -f -- "$mock_state_dir/previous_state"
  printf 'remove_previous_state\n' >>"$mock_state_dir/events"
  exit 0
fi

if [[ "$remote_command" == *"rm -f -- $current_link"* && "$remote_command" == *"rm -rf -- $release_dir"* ]]; then
  [[ "$remote_command" == *"$state_file"* ]] || exit 78
  current_target="$(cat "$mock_state_dir/current_target" 2>/dev/null || true)"
  if [[ "$current_target" != "$release_dir" ]]; then
    printf 'clear_superseded\n' >>"$mock_state_dir/events"
    exit 42
  fi
  rm -f -- "$mock_state_dir/current_target" "$mock_state_dir/release_exists"
  printf 'clear_current\nremove_failed_release\n' >>"$mock_state_dir/events"
  cp "$mock_state_dir/previous_state" "$mock_state_dir/last_previous_state"
  rm -f -- "$mock_state_dir/previous_state"
  printf 'remove_previous_state\n' >>"$mock_state_dir/events"
  exit 0
fi

if [[ "$remote_command" == *"find /var/www/personal_site/runtime/releases"* && "$remote_command" == *"current_target="* && "$remote_command" == *"flock -x 9"* ]]; then
  [[ "$remote_command" == *"$state_file"* ]] || exit 78
  current_target="$(cat "$mock_state_dir/current_target" 2>/dev/null || true)"
  if [[ "$current_target" != "$release_dir" ]]; then
    rm -f -- "$mock_state_dir/previous_state"
    printf 'health_superseded\n' >>"$mock_state_dir/events"
    exit 42
  fi
  printf 'health_owned\n' >>"$mock_state_dir/events"
  if [[ "$remote_command" == *"find /var/www/personal_site/runtime/releases"* ]]; then
    printf 'prune_releases\n' >>"$mock_state_dir/events"
  fi
  if [[ "$remote_command" == *"find /var/www/personal_site/runtime/staging"* && "$remote_command" == *"-mmin +1440"* && "$remote_command" == *'if [ "$resolved_stage_path" != "$old_stage_path" ]'* ]]; then
    if [[ -e "$mock_state_dir/stale_stage_safe" ]]; then
      rm -f -- "$mock_state_dir/stale_stage_safe"
      printf 'prune_stale_stage\n' >>"$mock_state_dir/events"
    fi
    if [[ "$remote_command" == *'find "$old_stage_owner" -maxdepth 0 -type f -mmin +1440'* && "$remote_command" == *'if [ "$resolved_stage_owner" != "$old_stage_owner" ]'* && "$remote_command" == *"find /var/www/personal_site/runtime/state"* && "$remote_command" == *"-name '*.active'"* ]]; then
      rm -f -- "$mock_state_dir/expired_active_stage" "$mock_state_dir/expired_active_marker"
      rm -f -- "$mock_state_dir/orphan_active_marker"
      printf 'expire_abandoned_stage_lease\ncleanup_orphan_active_marker\n' >>"$mock_state_dir/events"
    fi
    if [[ "$remote_command" == *'if [ "$old_stage_path" = /var/www/personal_site/runtime/staging/release-abc123 ]'* && "$remote_command" == *'if [ "$old_stage_name" = release-abc123 ]'* ]]; then
      printf 'preserve_current_invocation_stage\n' >>"$mock_state_dir/events"
    fi
    printf 'preserve_confined_stage_paths\n' >>"$mock_state_dir/events"
  fi
  rm -f -- "$mock_state_dir/previous_state"
  printf 'remove_previous_state\n' >>"$mock_state_dir/events"
  exit 0
fi

if [[ "$remote_command" == *"find /var/www/personal_site/runtime/releases"* ]]; then
  printf 'prune_releases\n' >>"$mock_state_dir/events"
fi
MOCK

cat >"$mock_bin/rsync" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'rsync' >>"$command_log"
printf ' <%s>' "$@" >>"$command_log"
printf '\n' >>"$command_log"
portable_chmod_argument='--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r'
if [[ " $* " != *" $portable_chmod_argument "* ]]; then
  printf 'invalid_rsync_permissions\n' >>"$mock_state_dir/events"
  exit 64
fi
printf 'rsync_permissions <directories=0755> <files=0644>\n' >>"$command_log"
staging_destination="admin@106.14.173.234:/var/www/personal_site/runtime/staging/$release_name/"
[[ " $* " == *" $staging_destination "* ]]
[[ -e "$mock_state_dir/staging_exists" ]]
if [[ "${mock_rsync_failure:-0}" == "1" ]]; then
  printf 'upload_failure\n' >>"$mock_state_dir/events"
  exit 23
fi
if [[ "${mock_rsync_interrupt:-0}" == "1" ]]; then
  printf 'local_upload_interrupt\n' >>"$mock_state_dir/events"
  kill -TERM "$PPID"
  sleep 0.1
  exit 143
fi
: >"$mock_state_dir/uploaded"
printf 'upload_dist\n' >>"$mock_state_dir/events"
MOCK

cat >"$mock_bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl' >>"$command_log"
printf ' <%s>' "$@" >>"$command_log"
printf '\n' >>"$command_log"
if [[ -n "${mock_concurrent_target:-}" ]]; then
  printf '%s\n' "$mock_concurrent_target" >"$mock_state_dir/current_target"
  printf 'concurrent_switch\n' >>"$mock_state_dir/events"
fi
if [[ "${mock_curl_failure:-0}" == "1" ]]; then
  printf 'health_failure\n' >>"$mock_state_dir/events"
  exit 22
fi
printf 'health_success\n' >>"$mock_state_dir/events"
MOCK

chmod +x "$mock_bin/ssh" "$mock_bin/rsync" "$mock_bin/curl"

export PATH="$mock_bin:$PATH"
export command_log
export mock_state_dir
export deploy_host="106.14.173.234"
export deploy_user="admin"
export deploy_key_path
export release_name="release-abc123"
export site_url="http://106.14.173.234"

# Fail with a readable assertion message.
fail() {
  local message="$1"
  printf 'FAIL: %s\n' "$message" >&2
  exit 1
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

# Return the first line number containing a fixed string.
line_number() {
  local expected="$1"
  local file_path="$2"
  grep -nF -- "$expected" "$file_path" | head -n 1 | cut -d: -f1 || true
}

# Assert that command-log markers occur in the requested order.
assert_ordered() {
  local file_path="$1"
  shift
  local previous_line=0
  local marker
  local current_line

  for marker in "$@"; do
    current_line="$(line_number "$marker" "$file_path")"
    [[ -n "$current_line" ]] || fail "missing ordered marker '$marker'"
    ((current_line > previous_line)) || fail "marker '$marker' was out of order"
    previous_line="$current_line"
  done
}

# Run the deployment script and capture output without aborting this test suite.
run_deploy() {
  local output_file="$1"
  set +e
  (
    cd "$deploy_fixture"
    bash "$repo_root/scripts/deploy.sh"
  ) >"$output_file" 2>&1
  local exit_status=$?
  set -e
  return "$exit_status"
}

# Keep deployment scenarios independent of ignored build output in the checkout.
deploy_fixture="$test_root/deploy_site"
mkdir -p "$deploy_fixture/dist"
printf '%s\n' '<!doctype html><html lang="zh-CN"><head><link rel="canonical" href="http://106.14.173.234/"></head><body>Zhenglong Chen</body></html>' >"$deploy_fixture/dist/index.html"

# Reset mocks and environment to a valid production-shaped baseline.
reset_case() {
  : >"$command_log"
  rm -f -- \
    "$mock_state_dir/current_target_kind" \
    "$mock_state_dir/current_target" \
    "$mock_state_dir/current_invocation_stage" \
    "$mock_state_dir/expired_active_marker" \
    "$mock_state_dir/expired_active_stage" \
    "$mock_state_dir/events" \
    "$mock_state_dir/fresh_active_stage" \
    "$mock_state_dir/last_previous_state" \
    "$mock_state_dir/orphan_active_marker" \
    "$mock_state_dir/release_exists" \
    "$mock_state_dir/previous_state" \
    "$mock_state_dir/recent_stage" \
    "$mock_state_dir/stale_stage_escaped" \
    "$mock_state_dir/stale_stage_safe" \
    "$mock_state_dir/staging_exists" \
    "$mock_state_dir/uploaded"
  unset deploy_root mock_concurrent_target mock_curl_failure mock_interrupt_after_switch mock_rsync_failure mock_rsync_interrupt mock_target_before_switch mock_verify_failure
  export deploy_host="106.14.173.234"
  export deploy_user="admin"
  export deploy_key_path="$valid_deploy_key_path"
  export release_name="release-abc123"
  export site_url="http://106.14.173.234"
}

# Set the mock server's current symlink target.
set_current_target() {
  local target_path="$1"
  printf '%s\n' "$target_path" >"$mock_state_dir/current_target"
  printf 'valid\n' >"$mock_state_dir/current_target_kind"
}

# Set an unsafe mock current target kind while retaining its visible path.
set_unsafe_current_target() {
  local target_path="$1"
  local target_kind="$2"
  printf '%s\n' "$target_path" >"$mock_state_dir/current_target"
  printf '%s\n' "$target_kind" >"$mock_state_dir/current_target_kind"
}

success_output="$test_root/success.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
run_deploy "$success_output" || fail "valid deployment should succeed"
assert_ordered "$mock_state_dir/events" \
  "create_staging" \
  "upload_dist" \
  "verify_staging_index" \
  "promote_release" \
  "write_previous_state" \
  "capture_current" \
  "switch_current" \
  "health_success" \
  "health_owned" \
  "prune_releases"
assert_contains "[ -e /var/www/personal_site/runtime/releases/release-abc123 ]" "$command_log"
assert_contains "[ -e /var/www/personal_site/runtime/staging/release-abc123 ]" "$command_log"
assert_contains "rsync <--archive> <--delete> <--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r>" "$command_log"
assert_contains "rsync_permissions <directories=0755> <files=0644>" "$command_log"
assert_contains "<dist/> <admin@106.14.173.234:/var/www/personal_site/runtime/staging/release-abc123/>" "$command_log"
assert_contains "<BatchMode=yes>" "$command_log"
assert_contains "<IdentitiesOnly=yes>" "$command_log"
assert_contains "<StrictHostKeyChecking=yes>" "$command_log"
assert_contains "<--fail> <--silent> <--show-error> <--max-time> <15> <http://106.14.173.234/>" "$command_log"
assert_contains "/var/www/personal_site/runtime/releases/release-abc123" "$mock_state_dir/current_target"
assert_contains "flock -x 9" "$command_log"
assert_contains "exec 9>/var/www/personal_site/runtime/deploy.lock" "$command_log"
assert_not_contains "/var/www/personal_site/deploy.lock" "$command_log"
assert_not_contains "/var/www/personal_site/current" "$command_log"
assert_contains "deploy_root: /var/www/personal_site/runtime" "$repo_root/.github/workflows/deploy.yml"
[[ ! -e "$mock_state_dir/staging_exists" ]] || fail "successful promotion must consume staging"
[[ -e "$mock_state_dir/release_exists" ]] || fail "successful promotion must create final release"
[[ ! -e "$mock_state_dir/previous_state" ]] || fail "successful finalization must remove previous-target state"

collision_output="$test_root/collision.out"
reset_case
: >"$mock_state_dir/release_exists"
if run_deploy "$collision_output"; then
  fail "an existing release directory should abort deployment"
fi
assert_not_contains "rsync" "$command_log"
[[ ! -e "$mock_state_dir/uploaded" ]] || fail "release collision must not upload dist"
assert_contains "release" "$collision_output"

staging_collision_output="$test_root/staging_collision.out"
reset_case
: >"$mock_state_dir/staging_exists"
if run_deploy "$staging_collision_output"; then
  fail "an existing staging directory should abort deployment"
fi
assert_not_contains "rsync" "$command_log"
[[ -e "$mock_state_dir/staging_exists" ]] || fail "staging collision must not overwrite the existing stage"

upload_failure_output="$test_root/upload_failure.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
export mock_rsync_failure=1
if run_deploy "$upload_failure_output"; then
  fail "upload failure should return nonzero"
fi
assert_contains "cleanup_staging" "$mock_state_dir/events"
[[ ! -e "$mock_state_dir/staging_exists" ]] || fail "upload failure must remove staging"
[[ ! -e "$mock_state_dir/release_exists" ]] || fail "upload failure must not create a completed release"
assert_contains "/var/www/personal_site/runtime/releases/previous-release" "$mock_state_dir/current_target"
assert_not_contains "prune_releases" "$mock_state_dir/events"

upload_interrupt_output="$test_root/upload_interrupt.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
export mock_rsync_interrupt=1
if run_deploy "$upload_interrupt_output"; then
  fail "interrupted upload should return nonzero"
fi
assert_contains "local_upload_interrupt" "$mock_state_dir/events"
assert_contains "cleanup_staging" "$mock_state_dir/events"
[[ ! -e "$mock_state_dir/staging_exists" ]] || fail "local signal trap must remove exact active staging directory"
[[ ! -e "$mock_state_dir/release_exists" ]] || fail "interrupted upload must not create a completed release"
assert_contains "/var/www/personal_site/runtime/releases/previous-release" "$mock_state_dir/current_target"

verify_failure_output="$test_root/verify_failure.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
export mock_verify_failure=1
if run_deploy "$verify_failure_output"; then
  fail "staging verification failure should return nonzero"
fi
assert_ordered "$mock_state_dir/events" "create_staging" "upload_dist" "verify_failure" "cleanup_staging"
[[ ! -e "$mock_state_dir/staging_exists" ]] || fail "verification failure must remove staging"
[[ ! -e "$mock_state_dir/release_exists" ]] || fail "verification failure must not create a completed release"
assert_contains "/var/www/personal_site/runtime/releases/previous-release" "$mock_state_dir/current_target"
assert_not_contains "prune_releases" "$mock_state_dir/events"

rollback_output="$test_root/rollback.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
export mock_curl_failure=1
if run_deploy "$rollback_output"; then
  fail "failed health check should return nonzero"
fi
assert_ordered "$mock_state_dir/events" \
  "switch_current" \
  "health_failure" \
  "rollback_current"
assert_not_contains "find /var/www/personal_site/runtime/releases" "$command_log"
assert_contains "rollback" "$rollback_output"
assert_contains "/var/www/personal_site/runtime/releases/previous-release" "$mock_state_dir/current_target"
assert_contains "flock -x 9" "$command_log"
[[ ! -e "$mock_state_dir/release_exists" ]] || fail "successful rollback must remove failed completed release"
[[ ! -e "$mock_state_dir/previous_state" ]] || fail "successful rollback must remove remote previous-target state"
assert_not_contains "ln -s -- /var/www/personal_site/runtime/releases/previous-release" "$command_log"
assert_contains "/var/www/personal_site/runtime/state/release-abc123.previous" "$command_log"

stale_capture_output="$test_root/stale_capture.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/P"
export mock_target_before_switch="/var/www/personal_site/runtime/releases/Q"
export mock_curl_failure=1
if run_deploy "$stale_capture_output"; then
  fail "failed deployment with a pre-switch concurrent change should return nonzero"
fi
assert_contains "/var/www/personal_site/runtime/releases/Q" "$mock_state_dir/last_previous_state"
assert_contains "/var/www/personal_site/runtime/releases/Q" "$mock_state_dir/current_target"
assert_ordered "$mock_state_dir/events" "concurrent_before_switch" "capture_current" "switch_current" "health_failure" "rollback_current"
[[ ! -e "$mock_state_dir/release_exists" ]] || fail "stale-capture rollback must remove its failed release"

interrupt_after_switch_output="$test_root/interrupt_after_switch.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
export mock_interrupt_after_switch=1
if run_deploy "$interrupt_after_switch_output"; then
  fail "remote interruption after switch should return nonzero"
fi
assert_contains "remote_interrupt_after_switch" "$mock_state_dir/events"
assert_contains "safe_trap_preserved_active_release" "$mock_state_dir/events"
assert_not_contains "unsafe_trap_removed_active_release" "$mock_state_dir/events"
[[ -e "$mock_state_dir/release_exists" ]] || fail "promotion trap must preserve the active release"
assert_contains "/var/www/personal_site/runtime/releases/release-abc123" "$mock_state_dir/current_target"
[[ -e "$mock_state_dir/previous_state" ]] || fail "interrupted active release must retain rollback state"
assert_not_contains "curl" "$command_log"

for unsafe_target_kind in missing symlink escaped; do
  unsafe_target_output="$test_root/unsafe_target_$unsafe_target_kind.out"
  reset_case
  set_unsafe_current_target "/var/www/personal_site/runtime/releases/unsafe-target" "$unsafe_target_kind"
  if run_deploy "$unsafe_target_output"; then
    fail "$unsafe_target_kind previous target should abort before switch"
  fi
  assert_contains "reject_${unsafe_target_kind}_target" "$mock_state_dir/events"
  assert_contains "/var/www/personal_site/runtime/releases/unsafe-target" "$mock_state_dir/current_target"
  [[ ! -e "$mock_state_dir/release_exists" ]] || fail "$unsafe_target_kind previous target must not create final release"
  [[ ! -e "$mock_state_dir/staging_exists" ]] || fail "$unsafe_target_kind previous target must clean staging"
  assert_not_contains "curl" "$command_log"
done

first_deploy_output="$test_root/first_deploy.out"
reset_case
export mock_curl_failure=1
if run_deploy "$first_deploy_output"; then
  fail "failed first deployment health check should return nonzero"
fi
[[ ! -e "$mock_state_dir/current_target" ]] || fail "failed first deployment should clear its current link"
assert_contains "clear_current" "$mock_state_dir/events"
assert_contains "remove_failed_release" "$mock_state_dir/events"
assert_not_contains "prune_releases" "$mock_state_dir/events"
assert_contains "flock -x 9" "$command_log"
[[ ! -e "$mock_state_dir/release_exists" ]] || fail "failed first deployment must remove its completed release"

superseded_first_output="$test_root/superseded_first.out"
reset_case
export mock_curl_failure=1
export mock_concurrent_target="/var/www/personal_site/runtime/releases/newer-release"
if run_deploy "$superseded_first_output"; then
  fail "superseded failed first deployment should return nonzero"
fi
assert_contains "/var/www/personal_site/runtime/releases/newer-release" "$mock_state_dir/current_target"
assert_contains "rollback_superseded" "$mock_state_dir/events"
assert_not_contains "clear_current" "$mock_state_dir/events"
assert_contains "superseded" "$superseded_first_output"
[[ -e "$mock_state_dir/release_exists" ]] || fail "superseded failed deployment must retain its completed release"

superseded_output="$test_root/superseded.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
export mock_curl_failure=1
export mock_concurrent_target="/var/www/personal_site/runtime/releases/newer-release"
if run_deploy "$superseded_output"; then
  fail "superseded failed deployment should return nonzero"
fi
assert_contains "/var/www/personal_site/runtime/releases/newer-release" "$mock_state_dir/current_target"
assert_contains "rollback_superseded" "$mock_state_dir/events"
assert_not_contains "rollback_current" "$mock_state_dir/events"
assert_not_contains "prune_releases" "$mock_state_dir/events"
assert_contains "superseded" "$superseded_output"
[[ -e "$mock_state_dir/release_exists" ]] || fail "superseded rollback must retain its completed release"
[[ ! -e "$mock_state_dir/previous_state" ]] || fail "superseded rollback must remove obsolete deployment state"

superseded_success_output="$test_root/superseded_success.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
export mock_concurrent_target="/var/www/personal_site/runtime/releases/newer-release"
if run_deploy "$superseded_success_output"; then
  fail "superseded successful health response should return nonzero"
fi
assert_contains "/var/www/personal_site/runtime/releases/newer-release" "$mock_state_dir/current_target"
assert_contains "health_superseded" "$mock_state_dir/events"
assert_not_contains "prune_releases" "$mock_state_dir/events"
assert_contains "superseded" "$superseded_success_output"
[[ -e "$mock_state_dir/release_exists" ]] || fail "superseded healthy deployment must retain its completed release"
[[ ! -e "$mock_state_dir/previous_state" ]] || fail "superseded finalization must remove obsolete deployment state"

stale_stage_output="$test_root/stale_stage.out"
reset_case
set_current_target "/var/www/personal_site/runtime/releases/previous-release"
: >"$mock_state_dir/stale_stage_safe"
: >"$mock_state_dir/stale_stage_escaped"
: >"$mock_state_dir/recent_stage"
: >"$mock_state_dir/fresh_active_stage"
: >"$mock_state_dir/expired_active_stage"
: >"$mock_state_dir/expired_active_marker"
: >"$mock_state_dir/current_invocation_stage"
: >"$mock_state_dir/orphan_active_marker"
run_deploy "$stale_stage_output" || fail "deployment with stale staging entries should succeed"
assert_contains "prune_stale_stage" "$mock_state_dir/events"
assert_contains "preserve_confined_stage_paths" "$mock_state_dir/events"
assert_contains "expire_abandoned_stage_lease" "$mock_state_dir/events"
assert_contains "cleanup_orphan_active_marker" "$mock_state_dir/events"
assert_contains "preserve_current_invocation_stage" "$mock_state_dir/events"
[[ ! -e "$mock_state_dir/stale_stage_safe" ]] || fail "confined staging directory older than 24h should be pruned"
[[ -e "$mock_state_dir/stale_stage_escaped" ]] || fail "escaped staging path must never be pruned"
[[ -e "$mock_state_dir/recent_stage" ]] || fail "recent staging directory must never be pruned"
[[ -e "$mock_state_dir/fresh_active_stage" ]] || fail "a fresh active staging lease must survive cleanup"
[[ ! -e "$mock_state_dir/expired_active_stage" ]] || fail "an abandoned active stage older than 24h should be pruned"
[[ ! -e "$mock_state_dir/expired_active_marker" ]] || fail "an abandoned active marker older than 24h should be pruned with its stage"
[[ -e "$mock_state_dir/current_invocation_stage" ]] || fail "the current invocation stage must survive even with manipulated timestamps"
[[ ! -e "$mock_state_dir/orphan_active_marker" ]] || fail "an orphan active marker should be pruned"
assert_contains "find /var/www/personal_site/runtime/staging" "$command_log"
assert_contains "find /var/www/personal_site/runtime/state" "$command_log"
assert_contains "-mmin +1440" "$command_log"
assert_contains "readlink -f" "$command_log"
assert_contains ".active" "$command_log"
assert_contains 'find "$old_stage_owner" -maxdepth 0 -type f -mmin +1440' "$command_log"
assert_contains "-name '*.active'" "$command_log"

missing_output="$test_root/missing.out"
reset_case
unset deploy_host
if run_deploy "$missing_output"; then
  fail "missing deploy_host should return nonzero"
fi
[[ ! -s "$command_log" ]] || fail "missing variables must fail before remote calls"
assert_contains "deploy_host" "$missing_output"

unsafe_output="$test_root/unsafe.out"
reset_case
export deploy_root='/var/www/personal_site'
if run_deploy "$unsafe_output"; then
  fail "the protected parent must not be accepted as the deploy runtime"
fi
[[ ! -s "$command_log" ]] || fail "unsafe deploy_root must fail before remote calls"
assert_contains "deploy_root" "$unsafe_output"

for unsafe_release_name in '../release' 'folder/release' 'release;touch-pwned' $'release\nnext'; do
  reset_case
  export release_name="$unsafe_release_name"
  if run_deploy "$unsafe_output"; then
    fail "unsafe release_name '$unsafe_release_name' should return nonzero"
  fi
  [[ ! -s "$command_log" ]] || fail "unsafe release_name must fail before remote calls"
done

reset_case
export deploy_host='106.14.173.234;touch-pwned'
if run_deploy "$unsafe_output"; then
  fail "unsafe deploy_host should return nonzero"
fi
[[ ! -s "$command_log" ]] || fail "unsafe deploy_host must fail before remote calls"

unsafe_key_path="$test_root/deploy;key"
: >"$unsafe_key_path"
chmod 600 "$unsafe_key_path"
reset_case
export deploy_key_path="$unsafe_key_path"
if run_deploy "$unsafe_output"; then
  fail "deploy_key_path with shell metacharacters should return nonzero"
fi
[[ ! -s "$command_log" ]] || fail "unsafe deploy_key_path must fail before remote calls"

for unsafe_site_url in 'http://example.com' 'http://106.14.173.234;touch-pwned' $'http://106.14.173.234\n'; do
  reset_case
  export site_url="$unsafe_site_url"
  if run_deploy "$unsafe_output"; then
    fail "unsafe site_url should return nonzero"
  fi
  [[ ! -s "$command_log" ]] || fail "unsafe site_url must fail before remote calls"
done

printf 'deploy tests passed\n'

# Run the site artifact checker from a supplied fixture directory.
run_site_check() {
  local fixture_root="$1"
  local output_file="$2"
  set +e
  (
    cd "$fixture_root"
    node "$repo_root/scripts/check_site.mjs"
  ) >"$output_file" 2>&1
  local exit_status=$?
  set -e
  return "$exit_status"
}

missing_fixture="$test_root/missing_site"
missing_site_output="$test_root/missing_site.out"
mkdir -p "$missing_fixture/dist"
if run_site_check "$missing_fixture" "$missing_site_output"; then
  fail "site checker should reject missing artifacts"
fi
for missing_path in \
  dist/index.html \
  dist/research/index.html \
  dist/projects/index.html \
  dist/articles/index.html \
  dist/about/index.html \
  dist/rss.xml \
  dist/404.html; do
  assert_contains "$missing_path" "$missing_site_output"
done

valid_fixture="$test_root/valid_site"
valid_site_output="$test_root/valid_site.out"
mkdir -p \
  "$valid_fixture/dist/research" \
  "$valid_fixture/dist/projects" \
  "$valid_fixture/dist/articles" \
  "$valid_fixture/dist/about" \
  "$valid_fixture/social_exports/welcome"
printf '%s\n' '<!doctype html><html lang="zh-CN"><head><link rel="canonical" href="http://106.14.173.234/"></head><body>Zhenglong Chen</body></html>' >"$valid_fixture/dist/index.html"
printf '%s\n' '<!doctype html>' >"$valid_fixture/dist/research/index.html"
printf '%s\n' '<!doctype html>' >"$valid_fixture/dist/projects/index.html"
printf '%s\n' '<!doctype html>' >"$valid_fixture/dist/articles/index.html"
printf '%s\n' '<!doctype html>' >"$valid_fixture/dist/about/index.html"
printf '%s\n' '<rss></rss>' >"$valid_fixture/dist/rss.xml"
printf '%s\n' '<!doctype html>' >"$valid_fixture/dist/404.html"
printf '%s\n' '# Zhenglong Chen' >"$valid_fixture/social_exports/welcome/zhihu.md"
run_site_check "$valid_fixture" "$valid_site_output" || fail "valid site artifacts should pass"
assert_contains "site artifacts verified" "$valid_site_output"

invalid_type_output="$test_root/invalid_type.out"
rm -f -- "$valid_fixture/dist/rss.xml"
mkdir "$valid_fixture/dist/rss.xml"
if run_site_check "$valid_fixture" "$invalid_type_output"; then
  fail "site checker should reject a required path that is a directory"
fi
assert_contains "dist/rss.xml" "$invalid_type_output"
assert_contains "regular file" "$invalid_type_output"
rmdir "$valid_fixture/dist/rss.xml"
printf '%s\n' '<rss></rss>' >"$valid_fixture/dist/rss.xml"

rm -f -- "$valid_fixture/dist/about/index.html"
ln -s ../index.html "$valid_fixture/dist/about/index.html"
if run_site_check "$valid_fixture" "$invalid_type_output"; then
  fail "site checker should reject a required path that is a symlink"
fi
assert_contains "dist/about/index.html" "$invalid_type_output"
assert_contains "regular file" "$invalid_type_output"
rm -f -- "$valid_fixture/dist/about/index.html"
printf '%s\n' '<!doctype html>' >"$valid_fixture/dist/about/index.html"

invalid_index_output="$test_root/invalid_index.out"
printf '%s\n' '<!doctype html><html><head><title>Astro Starter Kit: Basics</title></head></html>' >"$valid_fixture/dist/index.html"
if run_site_check "$valid_fixture" "$invalid_index_output"; then
  fail "site checker should reject starter content and missing metadata"
fi
assert_contains "starter/template text" "$invalid_index_output"
assert_contains 'lang="zh-CN"' "$invalid_index_output"
assert_contains "http://106.14.173.234/" "$invalid_index_output"

assert_contains 'release_name: ${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}' "$repo_root/.github/workflows/deploy.yml"
assert_contains 'printf '\''%s\n'\'' "$deploy_key_secret" > "$RUNNER_TEMP/personal_site_deploy_key"' "$repo_root/.github/workflows/deploy.yml"

printf 'site checker tests passed\n'
