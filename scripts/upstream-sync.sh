#!/usr/bin/env bash
# Merge upstream Nexus into vendor/nexus (git subtree, squashed).
#
#   scripts/upstream-sync.sh [--remote <name or url>] [--ref <ref>]   defaults: upstream main
#   scripts/upstream-sync.sh [remote] [branch]                        the same, positionally
#
# Exit 0: merged cleanly, or nothing new upstream. After a merge the last line
#         is MERGE_SHA=<sha>; the caller then runs every suite on that commit
#         before opening a PR. With nothing new, no MERGE_SHA line is printed.
# Exit 2: the merge conflicts. It is aborted, and the conflicted files and the
#         vendor/nexus/PATCHES.md rows that touch them are printed, for an issue.
# Exit 3: refused before pulling: the tree or index is dirty, or a merge,
#         rebase, cherry-pick or revert is already in progress. Nothing is touched.
# Exit 1: anything else (fetch failure).
set -uo pipefail

remote="upstream"
branch="main"
positional=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote | --ref)
      [ "$#" -ge 2 ] || { echo "upstream-sync: $1 needs a value." >&2; exit 1; }
      if [ "$1" = --remote ]; then remote="$2"; else branch="$2"; fi
      shift 2
      ;;
    -*) echo "upstream-sync: unknown option $1." >&2; exit 1 ;;
    *) positional+=("$1"); shift ;;
  esac
done
[ "${#positional[@]}" -le 2 ] || { echo "upstream-sync: at most a remote and a branch." >&2; exit 1; }
[ "${#positional[@]}" -ge 1 ] && remote="${positional[0]}"
[ "${#positional[@]}" -ge 2 ] && branch="${positional[1]}"
prefix="vendor/nexus"

cd "$(git rev-parse --show-toplevel)" || exit 1

# Refuse to run on top of other work: a failed pull would otherwise be
# indistinguishable from the operation already in progress.
for state in MERGE_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD; do
  if [ -e "$(git rev-parse --git-path "$state")" ]; then
    echo "upstream-sync: refusing to run: a merge, rebase, cherry-pick or revert is in progress ($state)." >&2
    echo "Finish or abort it, then run this again." >&2
    exit 3
  fi
done
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "upstream-sync: refusing to run: the working tree or index has uncommitted changes." >&2
  echo "Commit or stash them, then run this again." >&2
  exit 3
fi

# Read the recorded patches before the merge can touch the tree.
patches="$(git show "HEAD:$prefix/PATCHES.md" 2>/dev/null || true)"

before="$(git rev-parse HEAD)"
if git subtree pull --prefix="$prefix" "$remote" "$branch" --squash \
  -m "Merge upstream Nexus $branch into $prefix"; then
  after="$(git rev-parse HEAD)"
  if [ "$after" != "$before" ]; then echo "MERGE_SHA=$after"; fi
  exit 0
fi

# No MERGE_HEAD existed before the pull (checked above); abort only a merge
# this invocation started.
started_merge=""
[ -e "$(git rev-parse --git-path MERGE_HEAD)" ] && started_merge=yes

conflicted="$(git diff --name-only --diff-filter=U)"
if [ -z "$conflicted" ]; then
  [ -n "$started_merge" ] && git merge --abort 2>/dev/null
  echo "upstream-sync: git subtree pull failed without a merge conflict." >&2
  exit 1
fi
if [ -n "$started_merge" ]; then
  git merge --abort
else
  echo "upstream-sync: git subtree pull failed with conflicts but started no merge; leaving the tree as is." >&2
  exit 1
fi

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
