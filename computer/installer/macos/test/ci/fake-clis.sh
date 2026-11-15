#!/bin/sh
# fake-clis.sh <bin dir> <node>: puts claude and codex stand-ins into <bin dir>,
# the recorded fakes (plugin-cli/, staged beside this script) run by <node>.
# The macOS installer CI jobs use them so setup provisions the plugins without
# ever running a real claude or codex.
set -eu
dir=$1
node=$2
fakes=$(CDPATH= cd -- "$(dirname -- "$0")/plugin-cli" && pwd -P)
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
mkdir -p "$dir"
for pair in claude:claude-2.1.285 codex:codex-0.169.0; do
  tool=${pair%%:*}
  printf '#!/bin/sh\nexec %s %s %s "$@"\n' "$(q "$node")" "$(q "$fakes/fake-plugin-cli.js")" "$(q "$fakes/${pair#*:}")" > "$dir/$tool"
  chmod 0755 "$dir/$tool"
done
