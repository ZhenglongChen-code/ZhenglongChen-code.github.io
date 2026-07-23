#!/usr/bin/env bash

set -euo pipefail

site_root="${deploy_root:-/var/www/personal_site/runtime}"
releases_root="$site_root/releases"
staging_root="$site_root/staging"
state_root="$site_root/state"
current_link="$site_root/current"
deployment_lock="$site_root/deploy.lock"

# Print an error and stop before deployment can continue.
fail() {
  local message="$1"
  printf 'deploy: %s\n' "$message" >&2
  exit 1
}

# Require a named environment variable to be set and nonempty.
require_variable() {
  local variable_name="$1"
  [[ -n "${!variable_name:-}" ]] || fail "$variable_name is required"
}

for variable_name in deploy_host deploy_user deploy_key_path release_name site_url; do
  require_variable "$variable_name"
done

[[ "$site_root" == "/var/www/personal_site/runtime" ]] || fail "deploy_root must be /var/www/personal_site/runtime"
[[ "$deploy_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail "deploy_host contains unsafe characters"
[[ "$deploy_host" != *..* ]] || fail "deploy_host is invalid"
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "deploy_user contains unsafe characters"
[[ "$release_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "release_name contains unsafe characters"
[[ "$release_name" != *..* ]] || fail "release_name cannot contain '..'"
[[ -f "$deploy_key_path" && -r "$deploy_key_path" ]] || fail "deploy_key_path must be a readable regular file"
[[ "$deploy_key_path" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "deploy_key_path contains unsafe characters"
[[ "/$deploy_key_path/" != *"/../"* ]] || fail "deploy_key_path cannot contain '..' path segments"

node - "$site_url" "$deploy_host" <<'NODE' || fail "site_url must be an http(s) origin for deploy_host"
const [site_url, deploy_host] = process.argv.slice(2);

try {
  if (/[\u0000-\u0020\u007f]/.test(site_url)) {
    process.exit(1);
  }

  const parsed_url = new URL(site_url);
  const valid_protocol = parsed_url.protocol === 'http:' || parsed_url.protocol === 'https:';
  const valid_authority = parsed_url.hostname === deploy_host
    && parsed_url.username === ''
    && parsed_url.password === ''
    && parsed_url.port === '';
  const valid_location = parsed_url.pathname === '/'
    && parsed_url.search === ''
    && parsed_url.hash === '';

  if (!valid_protocol || !valid_authority || !valid_location) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
NODE

[[ -f "dist/index.html" ]] || fail "dist/index.html is missing; run the build first"

release_dir="$releases_root/$release_name"
staging_dir="$staging_root/$release_name"
state_file="$state_root/$release_name.previous"
active_state_file="$state_root/$release_name.active"
remote_target="$deploy_user@$deploy_host"
ssh_options=(
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -i "$deploy_key_path"
)

# Execute one already-validated command on the deployment host.
run_remote() {
  local remote_command="$1"
  ssh "${ssh_options[@]}" "$remote_target" "$remote_command"
}

# Remove only this deployment's allowlisted staging directory.
cleanup_staging() {
  local cleanup_command="set -eu; rm -rf -- $staging_dir; rm -f -- $active_state_file"
  run_remote "$cleanup_command"
}

# Attempt exact staging cleanup whenever local orchestration exits early.
cleanup_local_stage() {
  local exit_status=$?
  trap - EXIT INT TERM HUP
  if [[ "${stage_cleanup_enabled:-0}" -eq 1 ]]; then
    if ! cleanup_staging; then
      printf 'deploy: staging cleanup failed for %s\n' "$staging_dir" >&2
    fi
  fi
  exit "$exit_status"
}

prepare_staging_command="set -eu; mkdir -p -- $staging_root $state_root; if [ -e $release_dir ] || [ -L $release_dir ] || [ -e $staging_dir ] || [ -L $staging_dir ] || [ -e $state_file ] || [ -L $state_file ] || [ -e $active_state_file ] || [ -L $active_state_file ]; then exit 73; fi; cleanup_prepare() { rm -rf -- $staging_dir; rm -f -- $active_state_file; }; trap cleanup_prepare EXIT; mkdir -- $staging_dir; umask 077; : > $active_state_file; trap - EXIT"
if ! run_remote "$prepare_staging_command"; then
  fail "release or staging directory already exists, or staging could not be created"
fi

stage_cleanup_enabled=1
trap cleanup_local_stage EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if ! rsync \
  --archive \
  --delete \
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  -e "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -i $deploy_key_path" \
  dist/ \
  "$remote_target:$staging_dir/"; then
  fail "upload failed; staging cleanup requested"
fi

if ! run_remote "test -f $staging_dir/index.html"; then
  fail "staging verification failed; staging cleanup requested"
fi

temporary_link="$current_link.tmp.$release_name"
state_temp="$state_file.tmp"
switch_command="set -eu; exec 9>$deployment_lock; flock -x 9; if [ ! -d $staging_dir ] || [ -L $staging_dir ] || [ ! -f $active_state_file ] || [ -L $active_state_file ] || [ -e $release_dir ] || [ -L $release_dir ] || [ -e $state_file ] || [ -L $state_file ] || [ -e $state_temp ] || [ -L $state_temp ]; then exit 75; fi; promotion_started=0; cleanup_promotion() { rm -f -- $temporary_link $state_temp $active_state_file; current_target=\$(readlink $current_link || true); if [ \"\$current_target\" != $release_dir ]; then if [ \"\$promotion_started\" = 1 ]; then rm -rf -- $release_dir; fi; rm -f -- $state_file; fi; }; trap cleanup_promotion EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP; previous_target=''; if [ -L $current_link ]; then previous_target=\$(readlink $current_link); elif [ -e $current_link ]; then exit 76; fi; if [ -n \"\$previous_target\" ]; then previous_name=\${previous_target#$releases_root/}; case \"\$previous_name\" in ''|*[!A-Za-z0-9._-]*|.|..|*..*) exit 77 ;; esac; if [ \"\$previous_target\" != $releases_root/\$previous_name ] || [ ! -d \"\$previous_target\" ] || [ -L \"\$previous_target\" ]; then exit 77; fi; previous_resolved=\$(readlink -f -- \"\$previous_target\") || exit 77; if [ \"\$previous_resolved\" != \"\$previous_target\" ]; then exit 77; fi; fi; umask 077; printf '%s\\n' \"\$previous_target\" > $state_temp; mv -Tf -- $state_temp $state_file; mv -- $staging_dir $release_dir; promotion_started=1; rm -f -- $temporary_link; ln -s -- $release_dir $temporary_link; mv -Tf -- $temporary_link $current_link; rm -f -- $active_state_file; trap - EXIT INT TERM HUP"
if ! run_remote "$switch_command"; then
  fail "locked release promotion and switch failed"
fi

stage_cleanup_enabled=0
trap - EXIT INT TERM HUP

health_url="${site_url%/}/"
read_state_command="if [ ! -f $state_file ] || [ -L $state_file ]; then exit 78; fi; previous_target=''; IFS= read -r previous_target < $state_file || exit 78; if [ -n \"\$previous_target\" ]; then previous_name=\${previous_target#$releases_root/}; case \"\$previous_name\" in ''|*[!A-Za-z0-9._-]*|.|..|*..*) exit 78 ;; esac; if [ \"\$previous_target\" != $releases_root/\$previous_name ] || [ ! -d \"\$previous_target\" ] || [ -L \"\$previous_target\" ]; then exit 78; fi; previous_resolved=\$(readlink -f -- \"\$previous_target\") || exit 78; if [ \"\$previous_resolved\" != \"\$previous_target\" ]; then exit 78; fi; fi"
if ! curl --fail --silent --show-error --max-time 15 "$health_url"; then
  rollback_link="$current_link.rollback.$release_name"
  rollback_command="set -eu; exec 9>$deployment_lock; flock -x 9; $read_state_command; current_target=\$(readlink $current_link || true); if [ \"\$current_target\" != $release_dir ]; then rm -f -- $state_file; exit 42; fi; if [ -n \"\$previous_target\" ]; then rm -f -- $rollback_link; trap 'rm -f -- $rollback_link' EXIT; ln -s -- \"\$previous_target\" $rollback_link; mv -Tf -- $rollback_link $current_link; trap - EXIT; else rm -f -- $current_link; fi; current_target=\$(readlink $current_link || true); if [ \"\$current_target\" = $release_dir ]; then exit 43; fi; rm -rf -- $release_dir; rm -f -- $state_file"
  if run_remote "$rollback_command"; then
    printf 'deploy: health check failed; remote rollback completed\n' >&2
  else
    rollback_status=$?
    if [[ "$rollback_status" -eq 42 ]]; then
      printf 'deploy: health check failed; deployment was superseded, current was not changed\n' >&2
    else
      printf 'deploy: health check failed and rollback failed\n' >&2
    fi
  fi
  exit 1
fi

finalize_command="set -eu; exec 9>$deployment_lock; flock -x 9; $read_state_command; current_target=\$(readlink $current_link || true); if [ \"\$current_target\" != $release_dir ]; then rm -f -- $state_file; exit 42; fi; find $releases_root -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\\n' | sort -nr | tail -n +6 | cut -d ' ' -f2- | while IFS= read -r old_release; do case \"\$old_release\" in ''|*[!A-Za-z0-9._-]*|.|..) exit 1 ;; esac; old_path=$releases_root/\$old_release; resolved_path=\$(readlink -f -- \"\$old_path\"); case \"\$resolved_path\" in $releases_root/*) ;; *) exit 1 ;; esac; current_target=\$(readlink -f -- $current_link); if [ \"\$resolved_path\" != \"\$current_target\" ]; then rm -rf -- \"\$resolved_path\"; fi; done; find $staging_root -mindepth 1 -maxdepth 1 -type d -mmin +1440 -printf '%f\\n' | while IFS= read -r old_stage_name; do case \"\$old_stage_name\" in ''|*[!A-Za-z0-9._-]*|.|..|*..*) exit 1 ;; esac; old_stage_path=$staging_root/\$old_stage_name; if [ \"\$old_stage_path\" = $staging_dir ]; then continue; fi; resolved_stage_path=\$(readlink -f -- \"\$old_stage_path\") || exit 1; if [ \"\$resolved_stage_path\" != \"\$old_stage_path\" ]; then exit 1; fi; old_stage_owner=$state_root/\$old_stage_name.active; if [ -e \"\$old_stage_owner\" ] || [ -L \"\$old_stage_owner\" ]; then if [ ! -f \"\$old_stage_owner\" ] || [ -L \"\$old_stage_owner\" ]; then continue; fi; resolved_stage_owner=\$(readlink -f -- \"\$old_stage_owner\") || exit 1; if [ \"\$resolved_stage_owner\" != \"\$old_stage_owner\" ]; then exit 1; fi; if [ -z \"\$(find \"\$old_stage_owner\" -maxdepth 0 -type f -mmin +1440 -print -quit)\" ]; then continue; fi; rm -f -- \"\$resolved_stage_owner\"; fi; rm -rf -- \"\$resolved_stage_path\"; done; find $state_root -mindepth 1 -maxdepth 1 -type f -name '*.active' -printf '%f\\n' | while IFS= read -r old_owner_name; do case \"\$old_owner_name\" in *.active) ;; *) exit 1 ;; esac; old_stage_name=\${old_owner_name%.active}; case \"\$old_stage_name\" in ''|*[!A-Za-z0-9._-]*|.|..|*..*) exit 1 ;; esac; if [ \"\$old_stage_name\" = $release_name ]; then continue; fi; old_owner_path=$state_root/\$old_owner_name; resolved_owner_path=\$(readlink -f -- \"\$old_owner_path\") || exit 1; if [ \"\$resolved_owner_path\" != \"\$old_owner_path\" ]; then exit 1; fi; old_stage_path=$staging_root/\$old_stage_name; if [ ! -e \"\$old_stage_path\" ] && [ ! -L \"\$old_stage_path\" ]; then rm -f -- \"\$resolved_owner_path\"; fi; done; rm -f -- $state_file"
if run_remote "$finalize_command"; then
  :
else
  finalize_status=$?
  if [[ "$finalize_status" -eq 42 ]]; then
    fail "deployment was superseded after health check; release retained and pruning skipped"
  fi
  fail "post-health ownership check or pruning failed"
fi

printf 'deploy: release %s is healthy and active\n' "$release_name"
