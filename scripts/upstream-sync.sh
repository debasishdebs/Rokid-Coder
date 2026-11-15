#!/usr/bin/env bash
# Merge upstream Nexus into vendor/nexus (git subtree, squashed).
#
#   scripts/upstream-sync.sh [remote] [branch]     defaults: upstream main
#
# Exit 0: merged cleanly. The caller then runs every suite before opening a PR.
# Exit 2: the merge conflicts. It is aborted, and the conflicted files and the
#         vendor/nexus/PATCHES.md rows that touch them are printed, for an issue.
# Exit 1: anything else (dirty tree, fetch failure).
set -uo pipefail

remote="${1:-upstream}"
branch="${2:-main}"
prefix="vendor/nexus"

cd "$(git rev-parse --show-toplevel)" || exit 1

# Read the recorded patches before the merge can touch the tree.
patches="$(git show "HEAD:$prefix/PATCHES.md" 2>/dev/null || true)"

if git subtree pull --prefix="$prefix" "$remote" "$branch" --squash \
  -m "Merge upstream Nexus $branch into $prefix"; then
  exit 0
fi

conflicted="$(git diff --name-only --diff-filter=U)"
if [ -z "$conflicted" ]; then
  git merge --abort 2>/dev/null || true
  echo "upstream-sync: git subtree pull failed without a merge conflict." >&2
  exit 1
fi
git merge --abort

# Print the PATCHES.md rows whose Files entries (relative to $prefix,
# comma-separated, backticks optional) name a conflicted file, or name a
# directory (trailing /) that contains one.
matching_rows() {
  local row files path rel entry matched entries
  while IFS= read -r row; do
    case "$row" in
      "| SHA "*) continue ;;
      "|---"*) continue ;;
      "|"*) ;;
      *) continue ;;
    esac
    files="$(printf '%s' "$row" | awk -F'|' '{print $3}' | tr -d '`')"
    IFS=',' read -ra entries <<<"$files"
    [ "${#entries[@]}" -eq 0 ] && continue
    matched=""
    while IFS= read -r path; do
      rel="${path#"$prefix"/}"
      for entry in "${entries[@]}"; do
        entry="$(printf '%s' "$entry" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
        [ -z "$entry" ] && continue
        if [ "$rel" = "$entry" ] || { [ "${entry%/}" != "$entry" ] && [ "${rel#"$entry"}" != "$rel" ]; }; then
          matched=yes
        fi
      done
    done <<<"$conflicted"
    if [ -n "$matched" ]; then printf '%s\n' "$row"; fi
  done <<<"$patches"
}
rows="$(matching_rows)"

echo "upstream-sync: merging $remote $branch into $prefix conflicts with recorded patches."
echo "The merge was aborted; $prefix is unchanged."
echo "Conflicted files:"
printf '%s\n' "$conflicted" | sed 's/^/  /'
echo "PATCHES.md rows that touch them:"
if [ -n "$rows" ]; then
  printf '%s\n' "$rows" | sed 's/^/  /'
else
  echo "  (none)"
fi
exit 2
