#!/bin/sh
# Builds the macOS package and its disk image from an extracted, verified
# darwin bundle (T7a's archive contract):
#
#   build-pkg.sh --bundle <dir> --arch arm64|x64 --out <dir> [--version-suffix <s>] [--min-os <v>]
#   build-pkg.sh --render-distribution --arch arm64|x64 --version <v> [--min-os <v>]
#
# It writes <out>/rokid-coder-<v>-macos-<arch>.pkg and .dmg (the pkg, "Rokid
# Coder Setup.command", uninstall.sh and a README). The version is the
# bundle's own (computer/package.json). --version-suffix makes a test build,
# <v>-<s>, whose bundle and plugins report that version; --min-os makes the
# refusal-screen build of the macOS gate (M3). Release builds pass neither.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PACKAGE_ID=io.github.debasishdebs.rokidcoder.computer
INSTALL_ROOT="/Library/Application Support/RokidCoder"

die() {
  echo "build-pkg.sh: $1" >&2
  exit 1
}

bundle= arch= out= suffix= min_os=13.0 render= version=
while [ $# -gt 0 ]; do
  case $1 in
    --bundle) bundle=${2:?}; shift 2 ;;
    --arch) arch=${2:?}; shift 2 ;;
    --out) out=${2:?}; shift 2 ;;
    --version-suffix) suffix=${2:?}; shift 2 ;;
    --min-os) min_os=${2:?}; shift 2 ;;
    --version) version=${2:?}; shift 2 ;;
    --render-distribution) render=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done
case $arch in arm64 | x64) ;; *) die "--arch must be arm64 or x64" ;; esac
case $min_os in "" | *[!0-9.]*) die "--min-os must be a version like 13.0" ;; esac

render_distribution() {
  case $1 in "" | *[!0-9A-Za-z.-]*) die "unusable version '$1'" ;; esac
  sed -e "s/ROKID_VERSION/$1/g" -e "s/ROKID_ARCH/$arch/g" -e "s/ROKID_MIN_OS/$min_os/g" "$here/Distribution.xml"
}

if [ -n "$render" ]; then
  render_distribution "$version"
  exit 0
fi

# uninstall.sh with lib/references.sh inlined, so the copy on the disk image works on its own.
render_uninstall() {
  awk -v lib="$here/lib/references.sh" '
    /^\. "\$here\/lib\/references\.sh"/ { while ((getline line < lib) > 0) print line; next }
    { print }' "$here/uninstall.sh"
}

[ -n "$bundle" ] && [ -f "$bundle/bundle.json" ] || die "--bundle must be an extracted darwin bundle"
[ -n "$out" ] || die "--out is required"
target=$(/usr/bin/plutil -extract target raw -o - "$bundle/bundle.json") || die "bundle.json has no target"
[ "$target" = "darwin-$arch" ] || die "the bundle is $target, not darwin-$arch"
version=$(/usr/bin/plutil -extract version raw -o - "$bundle/bundle.json") || die "bundle.json has no version"
[ -z "$suffix" ] || version="$version-$suffix"
name="rokid-coder-$version-macos-$arch"

stage=$(mktemp -d "${TMPDIR:-/tmp}/rokid-pkg.XXXXXX")
trap 'rm -rf "$stage"' EXIT
payload="$stage/root/$version"
mkdir -p "$stage/root" "$stage/scripts/lib" "$stage/dmg"

# The payload: the bundle, plus the two scripts a user runs from it. ditto keeps modes and symlinks.
/usr/bin/ditto "$bundle" "$payload"
cp "$here/Rokid Coder Setup.command" "$payload/"
render_uninstall > "$payload/uninstall.sh"
chmod 0755 "$payload/Rokid Coder Setup.command" "$payload/uninstall.sh"

if [ -n "$suffix" ]; then
  # A test build reports its own version everywhere setup and /health look, and carries its own
  # plugin content, so an upgrade and a rollback between two of them can be told apart [6b-R11].
  "$payload/node/bin/node" -e '
    const fs = require("fs"), path = require("path");
    const [root, version] = process.argv.slice(1);
    const stamp = (rel) => {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) return;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      value.version = version;
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    };
    for (const rel of ["bundle.json", "app/package.json", "plugins/claude-code/.claude-plugin/plugin.json", "plugins/codex/.codex-plugin/plugin.json"]) stamp(rel);
    for (const rel of ["plugins/claude-code/bin/hook-forward.js", "plugins/codex/bin/hook-forward.js"]) {
      const file = path.join(root, rel);
      if (fs.existsSync(file)) fs.appendFileSync(file, `\n// rokid-coder test build ${version}\n`);
    }
  ' "$payload" "$version"
fi
# Root-owned (pkgbuild --ownership recommended) and read-only for everyone else.
chmod -R go-w "$stage/root"

cp "$here/scripts/postinstall" "$stage/scripts/postinstall"
cp "$here/lib/resolve-user.sh" "$here/lib/launch-setup.sh" "$here/lib/references.sh" "$stage/scripts/lib/"
printf '%s\n' "$version" > "$stage/scripts/version"
chmod 0755 "$stage/scripts/postinstall" "$stage/scripts/lib/"*.sh

# Nothing in the payload may be relocated by Installer to wherever a same-id bundle sits.
/usr/bin/pkgbuild --analyze --root "$stage/root" "$stage/component.plist" > /dev/null
i=0
while /usr/bin/plutil -extract "$i" xml1 -o /dev/null "$stage/component.plist" > /dev/null 2>&1; do
  /usr/bin/plutil -replace "$i.BundleIsRelocatable" -bool NO "$stage/component.plist"
  i=$((i + 1))
done

/usr/bin/pkgbuild --root "$stage/root" --component-plist "$stage/component.plist" \
  --install-location "$INSTALL_ROOT" --scripts "$stage/scripts" \
  --identifier "$PACKAGE_ID" --version "$version" --ownership recommended \
  "$stage/rokid-coder-component.pkg"
render_distribution "$version" > "$stage/Distribution.xml"
mkdir -p "$out"
/usr/bin/productbuild --distribution "$stage/Distribution.xml" --package-path "$stage" "$out/$name.pkg"

cp "$out/$name.pkg" "$stage/dmg/"
cp "$here/Rokid Coder Setup.command" "$stage/dmg/"
render_uninstall > "$stage/dmg/uninstall.sh"
chmod 0755 "$stage/dmg/Rokid Coder Setup.command" "$stage/dmg/uninstall.sh"
cat > "$stage/dmg/README.txt" <<EOF
Rokid Coder $version for macOS ($arch)

1. Open $name.pkg and follow the installer. Setup then opens in Terminal.
2. If setup did not open (you installed from the command line, or you are not
   the user who was logged in), double-click "Rokid Coder Setup".
   If macOS says it can't be opened, right-click it (or Control-click), choose
   Open, then choose Open again.

To remove Rokid Coder for yourself, run uninstall.sh in Terminal. Add --purge
to delete your pairings and settings too, and --system to remove the package.
EOF
# hdiutil create fails now and then with "Resource busy" on a busy machine, and succeeds when retried.
tries=1
until /usr/bin/hdiutil create -volname "Rokid Coder $version" -srcfolder "$stage/dmg" -format UDZO -ov "$out/$name.dmg" > /dev/null; do
  [ "$tries" -lt 5 ] || { echo "build-pkg: hdiutil create failed $tries times" >&2; exit 1; }
  tries=$((tries + 1))
  sleep 10
done
echo "Built $out/$name.pkg and $out/$name.dmg"
