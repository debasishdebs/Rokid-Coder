#!/bin/bash
# Moves any claude or codex the runner image ships out of reach, so setup in
# the macOS installer CI jobs can only ever meet the recorded fakes.
set -euo pipefail
for tool in claude codex; do
  for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.npm-global/bin"; do
    if [ -e "$dir/$tool" ] || [ -L "$dir/$tool" ]; then
      sudo mv "$dir/$tool" "$dir/$tool.rokid-removed"
      echo "moved aside: $dir/$tool"
    fi
  done
  while found=$(/bin/zsh -lc "command -v $tool" 2>/dev/null) && [ -n "$found" ]; do
    sudo mv "$found" "$found.rokid-removed"
    echo "moved aside: $found"
  done
done
