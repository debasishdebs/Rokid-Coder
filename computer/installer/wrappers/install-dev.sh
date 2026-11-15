#!/bin/sh
# Developer wrappers, for a repo checkout without the installer. Writes
# ~/.rokid-coder/bin/{rokid-node,agentd,rk,rokid-setup}, the same names the
# installer writes and the plugin hooks call, pointing at this repo's build and
# at the absolute node found on PATH now. Run it again after moving the repo or
# switching node. Build first: (cd computer && npm run build).
set -eu

case $0 in */*) here=${0%/*};; *) here=.;; esac
computer=$(CDPATH= cd -- "$here/../.." && pwd -P)

node=$(command -v node || true)
case $node in
  /*) ;;
  *) echo "install-dev.sh: no node on PATH" >&2; exit 1;;
esac
node=$(CDPATH= cd -- "$(dirname -- "$node")" && pwd -P)/$(basename -- "$node")

if [ ! -f "$computer/dist/cli.js" ]; then
  echo "install-dev.sh: $computer/dist is not built; run (cd computer && npm run build)" >&2
  exit 1
fi

quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

state="$HOME/.rokid-coder"
bin="$state/bin"
if [ ! -d "$state" ]; then
  mkdir -p "$state"
  chmod 0700 "$state"
fi
mkdir -p "$bin"

write() {
  name=$1
  shift
  temp="$bin/.$name.$$.tmp"
  {
    printf '#!/bin/sh\n'
    if [ "$name" = agentd ]; then
      printf 'if [ -f "$HOME/.rokid-coder/env" ]; then . "$HOME/.rokid-coder/env"; fi\n'
    fi
    printf 'exec %s "$@"\n' "$*"
  } > "$temp"
  chmod 0755 "$temp"
  mv -f "$temp" "$bin/$name"
}

write rokid-node "$(quote "$node")"
write agentd "$(quote "$node") $(quote "$computer/dist/cli.js")"
write rk "$(quote "$node") $(quote "$computer/dist/rk.js")"
write rokid-setup "$(quote "$node") $(quote "$computer/dist/setup/main.js")"
echo "Wrote $bin/{rokid-node,agentd,rk,rokid-setup} -> $node, $computer/dist"
