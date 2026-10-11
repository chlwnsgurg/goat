#!/usr/bin/env bash
# Scan GOAT against upstream T3 for a chase cycle (see devlog/_chase/020_cycle_runbook.md).
# Usage: devlog/_chase/scan.sh [--no-fetch] [--commits] [target-ref, default origin/dev]
# Read-only apart from fetching upstream main and origin.
set -euo pipefail

fetch=1
commits=0
target=origin/dev
for arg in "$@"; do
  case "$arg" in
    --no-fetch) fetch=0 ;;
    --commits) commits=1 ;;
    -h | --help) sed -n '2,4p' "$0"; exit 0 ;;
    *) target=$arg ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "missing remote 'upstream'. Run once:" >&2
  echo "  git remote add upstream https://github.com/pingdotgg/t3code.git" >&2
  echo "  git config remote.upstream.tagopt --no-tags" >&2
  exit 1
fi
if [ "$fetch" = 1 ]; then
  git fetch --quiet --no-tags upstream main
  git fetch --quiet origin
fi

up=upstream/main
base=$(git merge-base "$target" "$up")
t3_name='^\+(.*[^A-Za-z0-9_])?t3_[a-z]+_[a-z]'

echo "## baseline"
echo "target           $target $(git log -1 --format='%h %cs %s' "$target")"
echo "upstream         $(git log -1 --format='%h %cs %s' "$up")"
echo "reviewed-through $(git log -1 --format='%h %cs %s' "$base")"
echo "goat-only        $(git rev-list --count "$up..$target") commits"
echo "upstream-ahead   $(git rev-list --count "$target..$up") commits"

echo
echo "## trial merge conflicts"
conflicts=$(git merge-tree --write-tree --name-only "$target" "$up" | awk 'NR == 1 { next } /^$/ { exit } { print }' || true)
if [ -n "$conflicts" ]; then
  printf '%s\n' "$conflicts" | sed 's/^/  /'
  echo "  ($(printf '%s\n' "$conflicts" | wc -l | tr -d ' ') files)"
else
  echo "  none"
fi

echo
echo "## migrations added since reviewed-through"
migrations=apps/server/src/persistence/Migrations
added_migrations() {
  git diff --name-only --diff-filter=A "$base" "$1" -- "$migrations/" |
    sed -nE 's#^.*/([0-9]{3})_([A-Za-z0-9]+)\.ts$#\1 \2#p'
}
goat_migrations=$(added_migrations "$target")
upstream_migrations=$(added_migrations "$up")
echo "  goat:     $(printf '%s' "$goat_migrations" | paste -sd',' - | sed 's/,/, /g')"
echo "  upstream: $(printf '%s' "$upstream_migrations" | paste -sd',' - | sed 's/,/, /g')"
collisions=$(comm -12 \
  <(printf '%s\n' "$goat_migrations" | awk 'NF { print $1 }' | sort) \
  <(printf '%s\n' "$upstream_migrations" | awk 'NF { print $1 }' | sort))
if [ -n "$collisions" ]; then
  echo "  COLLISION on id(s): $(printf '%s' "$collisions" | paste -sd' ' -) -> needs a decision card before merging"
fi

echo
echo "## upstream workflow changes (disable on goat-si/goat before pushing)"
workflows=$(git diff --name-status "$base" "$up" -- .github/workflows/)
if [ -n "$workflows" ]; then printf '%s\n' "$workflows" | sed 's/^/  /'; else echo "  none"; fi

echo
echo "## upstream t3_* MCP tools without a goat_* name"
tool_files='apps/server/src/mcp/toolkits/*/tools.ts'
missing=$(comm -23 \
  <(git grep -ohE '"t3_[a-z_]+"' "$up" -- "$tool_files" | tr -d '"' | sort -u) \
  <(git grep -ohE '"goat_[a-z_]+"' "$target" -- "$tool_files" | tr -d '"' | sed 's/^goat_/t3_/' | sort -u))
if [ -n "$missing" ]; then printf '%s\n' "$missing" | sed 's/^/  /'; else echo "  none"; fi

echo
echo "## upstream lines adding t3_* names, by file"
leaks=$(git diff "$base" "$up" -- apps packages ':!*.md' |
  awk -v pattern="$t3_name" '/^\+\+\+ b\// { file = substr($0, 7); next } $0 ~ pattern { count[file]++ } END { for (f in count) printf "  %4d %s\n", count[f], f }' |
  sort -rn)
if [ -n "$leaks" ]; then printf '%s\n' "$leaks"; else echo "  none"; fi

if [ "$commits" = 1 ]; then
  echo
  echo "## upstream commits (shared = files GOAT also changed, t3 = added t3_* lines, conf = conflicting files)"
  goat_files=$(mktemp)
  conflict_files=$(mktemp)
  trap 'rm -f "$goat_files" "$conflict_files"' EXIT
  git diff --name-only "$base" "$target" >"$goat_files"
  if [ -n "$conflicts" ]; then printf '%s\n' "$conflicts" >"$conflict_files"; fi
  for commit in $(git rev-list --reverse "$target..$up"); do
    files=$(git diff-tree --no-commit-id --name-only -r "$commit")
    shared=$(printf '%s\n' "$files" | grep -cxFf "$goat_files" || true)
    conf=""
    if [ -s "$conflict_files" ]; then
      conf=$(printf '%s\n' "$files" | grep -xFf "$conflict_files" | xargs -n1 basename | paste -sd' ' - || true)
    fi
    names=$(git show --format= "$commit" -- apps packages ':!*.md' | grep -cE "$t3_name" || true)
    printf '%s shared=%s t3=%s conf=[%s] %s\n' "$(git rev-parse --short "$commit")" "$shared" "$names" "$conf" \
      "$(git log -1 --format=%s "$commit")"
  done
fi
