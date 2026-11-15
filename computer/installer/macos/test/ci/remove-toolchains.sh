#!/bin/bash
# The clean-runtime job's starting point [FR 12]: every node, npm, npx and
# node-gyp under the places a Mac keeps them, Xcode and the Command Line Tools
# are moved aside, then it proves that nothing is left: no node on PATH, and
# the /usr/bin/cc and /usr/bin/python3 shims have nothing behind them.
set -euo pipefail
aside=/private/var/rokid-toolchains-removed
sudo mkdir -p "$aside"
for root in /usr/local /opt/homebrew /Users/runner/hostedtoolcache /Library/Frameworks; do
  [ -d "$root" ] || continue
  while IFS= read -r -d '' file; do
    sudo mv "$file" "$file.rokid-removed"
    echo "moved aside: $file"
  done < <(sudo find "$root" \( -name node -o -name npm -o -name npx -o -name node-gyp \) \( -type f -o -type l \) -print0 2>/dev/null)
done
for app in /Applications/Xcode*.app; do
  if [ -e "$app" ]; then
    sudo mv "$app" "$aside/"
    echo "moved aside: $app"
  fi
done
if [ -e /Library/Developer/CommandLineTools ]; then
  sudo mv /Library/Developer/CommandLineTools "$aside/"
  echo "moved aside: /Library/Developer/CommandLineTools"
fi

hash -r
if command -v node; then
  echo "node is still on PATH"
  exit 1
fi
for shim in /usr/bin/cc /usr/bin/python3; do
  if "$shim" --version < /dev/null > /dev/null 2>&1; then
    echo "$shim still runs a toolchain"
    exit 1
  fi
done
echo "No Node, no compiler and no Python toolchain is left."
