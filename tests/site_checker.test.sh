#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_success() {
  local description="$1"
  shift
  "$@" || fail "$description"
}

assert_failure() {
  local description="$1"
  shift
  if "$@"; then
    fail "$description"
  fi
}

make_fixture() {
  local fixture_root="$1"

  mkdir -p "$fixture_root/dist/research" "$fixture_root/dist/projects" "$fixture_root/dist/articles" "$fixture_root/dist/about" \
    "$fixture_root/social_exports/welcome"
  printf '<!doctype html><html lang="zh-CN"><head><link rel="canonical" href="http://106.14.173.234/"></head><body>Zhenglong Chen</body></html>\n' >"$fixture_root/dist/index.html"
  printf '<html>Zhenglong Chen</html>\n' >"$fixture_root/dist/research/index.html"
  printf '<html>Zhenglong Chen</html>\n' >"$fixture_root/dist/projects/index.html"
  printf '<html>Zhenglong Chen</html>\n' >"$fixture_root/dist/articles/index.html"
  printf '<html>Zhenglong Chen</html>\n' >"$fixture_root/dist/about/index.html"
  printf '<rss>Zhenglong Chen</rss>\n' >"$fixture_root/dist/rss.xml"
  printf '<html>Zhenglong Chen</html>\n' >"$fixture_root/dist/404.html"
  printf 'Zhenglong Chen\n' >"$fixture_root/social_exports/welcome/zhihu.md"
}

run_checker() {
  local fixture_root="$1"
  (
    cd "$fixture_root"
    node "$repo_root/scripts/check_site.mjs"
  )
}

valid_fixture="$test_root/valid"
make_fixture "$valid_fixture"
assert_success 'a valid generated artifact set must pass' run_checker "$valid_fixture"

legacy_work_fixture="$test_root/legacy_work"
make_fixture "$legacy_work_fixture"
mkdir -p "$legacy_work_fixture/dist/work"
printf '<html>Zhenglong Chen</html>\n' >"$legacy_work_fixture/dist/work/index.html"
assert_failure 'legacy work output must be rejected' run_checker "$legacy_work_fixture"

legacy_writing_fixture="$test_root/legacy_writing"
make_fixture "$legacy_writing_fixture"
mkdir -p "$legacy_writing_fixture/dist/writing"
printf '<html>Zhenglong Chen</html>\n' >"$legacy_writing_fixture/dist/writing/index.html"
assert_failure 'legacy writing output must be rejected' run_checker "$legacy_writing_fixture"

legacy_english_writing_fixture="$test_root/legacy_english_writing"
make_fixture "$legacy_english_writing_fixture"
mkdir -p "$legacy_english_writing_fixture/dist/en/writing"
printf '<html>Zhenglong Chen</html>\n' >"$legacy_english_writing_fixture/dist/en/writing/index.html"
assert_failure 'legacy English writing output must be rejected' run_checker "$legacy_english_writing_fixture"

chinese_leak_fixture="$test_root/chinese_leak"
make_fixture "$chinese_leak_fixture"
printf '<html>陈正龙</html>\n' >"$chinese_leak_fixture/dist/articles/leak.html"
assert_failure 'generated HTML containing the former Chinese public name must fail' \
  run_checker "$chinese_leak_fixture"

english_leak_fixture="$test_root/english_leak"
make_fixture "$english_leak_fixture"
printf 'ChenZL\n' >"$english_leak_fixture/social_exports/welcome/zhihu.md"
assert_failure 'social-export text containing the former public name must fail' \
  run_checker "$english_leak_fixture"

missing_identity_fixture="$test_root/missing_identity"
make_fixture "$missing_identity_fixture"
printf '<!doctype html><html lang="zh-CN"><head><link rel="canonical" href="http://106.14.173.234/"></head><body>public homepage</body></html>\n' >"$missing_identity_fixture/dist/index.html"
assert_failure 'a homepage without Zhenglong Chen must fail' run_checker "$missing_identity_fixture"

missing_social_exports_fixture="$test_root/missing_social_exports"
make_fixture "$missing_social_exports_fixture"
rm -rf -- "$missing_social_exports_fixture/social_exports"
assert_failure 'missing generated social exports must fail' run_checker "$missing_social_exports_fixture"

empty_social_exports_fixture="$test_root/empty_social_exports"
make_fixture "$empty_social_exports_fixture"
rm -rf -- "$empty_social_exports_fixture/social_exports/welcome"
assert_failure 'social exports without generated text files must fail' run_checker "$empty_social_exports_fixture"

source_only_fixture="$test_root/source_only"
make_fixture "$source_only_fixture"
mkdir -p "$source_only_fixture/src"
printf '陈正龙\nChenZL\n' >"$source_only_fixture/src/notes.md"
assert_success 'source documents are outside the generated artifact scan' run_checker "$source_only_fixture"

studio_markup_fixture="$test_root/studio_markup"
make_fixture "$studio_markup_fixture"
printf '<html>Local Markdown Studio</html>\n' >"$studio_markup_fixture/dist/articles/leak.html"
assert_failure 'public Studio markup must be rejected' run_checker "$studio_markup_fixture"

studio_api_fixture="$test_root/studio_api"
make_fixture "$studio_api_fixture"
printf '<script>fetch("/api/publish")</script>\n' >"$studio_api_fixture/dist/articles/leak.html"
assert_failure 'public Studio API routes must be rejected' run_checker "$studio_api_fixture"

studio_secret_fixture="$test_root/studio_secret"
make_fixture "$studio_secret_fixture"
printf 'session_token .env.studio.local .studio/transactions transaction journal\n' >"$studio_secret_fixture/dist/articles/leak.html"
assert_failure 'public Studio tokens and transaction data must be rejected' run_checker "$studio_secret_fixture"

source_map_fixture="$test_root/source_map"
make_fixture "$source_map_fixture"
printf '{"sources":["studio/src/main.ts"]}\n' >"$source_map_fixture/dist/app.js.map"
assert_failure 'public source maps must be rejected' run_checker "$source_map_fixture"

printf 'site_checker tests passed\n'
