#!/bin/sh
# uninstall.sh [--purge [--yes]] [--system [--force]]
#
# As yourself: removes Rokid Coder for you (rokid-setup uninstall). Your
# pairings and settings are kept unless --purge.
# --system also removes the package itself (/Library/Application
# Support/RokidCoder and its receipt), re-running under sudo for that part. It
# refuses while any other user still has Rokid Coder set up, unless --force.

if [ "${ROKID_INSTALLER_TEST:-}" != 1 ]; then unset ID SUDO DSCL PLUTIL PKGUTIL ROKID_INSTALL_ROOT; fi
ID=${ID:-/usr/bin/id}
SUDO=${SUDO:-/usr/bin/sudo}
DSCL=${DSCL:-/usr/bin/dscl}
PLUTIL=${PLUTIL:-/usr/bin/plutil}
PKGUTIL=${PKGUTIL:-/usr/sbin/pkgutil}
ROOT=${ROKID_INSTALL_ROOT:-/Library/Application Support/RokidCoder}
PACKAGE_ID=io.github.debasishdebs.rokidcoder.computer

purge= yes= system= force=
for arg in "$@"; do
  case $arg in
    --purge) purge=--purge ;;
    --yes) yes=--yes ;;
    --system) system=1 ;;
    --force) force=1 ;;
    *) echo "usage: uninstall.sh [--purge [--yes]] [--system [--force]]" >&2; exit 64 ;;
  esac
done

self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")
here=${self%/*}
. "$here/lib/references.sh" # build-pkg.sh inlines this file here

if [ "$("$ID" -u)" != 0 ]; then
  setup=
  for candidate in "$here/bin/rokid-setup" "$HOME/.rokid-coder/bin/rokid-setup"; do
    if [ -x "$candidate" ]; then setup=$candidate; break; fi
  done
  if [ -z "$setup" ]; then
    version=$(sed -n '/<key>version<\/key>/{n;s:.*<string>\(.*\)</string>.*:\1:p;}' "$ROOT/installed-version" 2>/dev/null)
    [ -n "$version" ] && [ -x "$ROOT/$version/bin/rokid-setup" ] && setup="$ROOT/$version/bin/rokid-setup"
  fi
  if [ -n "$setup" ]; then
    "$setup" uninstall $purge $yes || exit $?
  else
    echo "Rokid Coder is not set up for you; nothing to remove from your account."
  fi
  [ -n "$system" ] || exit 0
  exec "$SUDO" /bin/sh "$self" --system ${force:+--force}
fi

if [ -z "$system" ]; then
  echo "Run uninstall.sh as yourself; only --system needs root." >&2
  exit 64
fi

# Everyone's references but the invoker's own pending handoff: their own setup was just removed,
# and anything else of theirs still counts.
invoker=${SUDO_USER:-}
others=$(rokid_references "$ROOT" | awk -F '\t' -v me="$invoker" '!($1 == me && $3 == "pending setup")')
if [ -n "$others" ] && [ -z "$force" ]; then
  echo "Rokid Coder is still set up for other users:" >&2
  printf '%s\n' "$others" | awk -F '\t' '{ print "  " $1 " (" $3 ": " $2 ")" }' | sort -u >&2
  echo "Run uninstall.sh as each of them first, or pass --force to remove it anyway." >&2
  exit 1
fi
rm -rf -- "$ROOT" || exit 1
rokid_forget_receipts ""
echo "Removed $ROOT and the package receipts."
