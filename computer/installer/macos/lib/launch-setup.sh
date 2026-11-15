#!/bin/sh
# launch-setup.sh <uid> <user> <home> <shell> [-- <command> [args...]]
#
# Starts setup as that user, and nothing else: who the user is was decided by
# resolve-user.sh [FR 11]. Runs as root. It records the handoff, then opens
# "Rokid Coder Setup.command" in Terminal inside the user's own session, with
# an environment built from scratch rather than inherited from the installer.
# After `--`, it runs the given command there instead of Terminal (CI).
#
# ROKID_VERSION and ROKID_BUNDLE_DIR name the version being set up.

if [ "${ROKID_INSTALLER_TEST:-}" != 1 ]; then unset LAUNCHCTL SUDO ROKID_INSTALL_ROOT; fi
LAUNCHCTL=${LAUNCHCTL:-/bin/launchctl}
SUDO=${SUDO:-/usr/bin/sudo}
ROOT=${ROKID_INSTALL_ROOT:-/Library/Application Support/RokidCoder}

if [ $# -lt 4 ] || [ -z "${ROKID_VERSION:-}" ] || [ -z "${ROKID_BUNDLE_DIR:-}" ]; then
  echo "usage: ROKID_VERSION=<v> ROKID_BUNDLE_DIR=<dir> launch-setup.sh <uid> <user> <home> <shell> [-- <command...>]" >&2
  exit 64
fi
uid=$1 user=$2 home=$3 shell=$4
shift 4

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# handoff/<uid>.json: which bundle this user was handed, until their install.json names it.
mkdir -p "$ROOT/handoff" && chmod 0755 "$ROOT/handoff" || exit 1
tmp="$ROOT/handoff/.$uid.json.$$"
printf '{"uid":%s,"version":%s,"bundleDir":%s}\n' "$uid" "$(json_string "$ROKID_VERSION")" "$(json_string "$ROKID_BUNDLE_DIR")" > "$tmp" &&
  chmod 0644 "$tmp" && mv -f "$tmp" "$ROOT/handoff/$uid.json" || { rm -f "$tmp"; exit 1; }

# The user's own per-user temp dir (confstr DARWIN_USER_TEMP_DIR), as their login session has it.
tmpdir=$("$SUDO" -u "$user" /usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null)
[ -n "$tmpdir" ] || tmpdir=/tmp

if [ "${1:-}" = "--" ]; then
  shift
else
  set -- /usr/bin/open -a Terminal "$ROKID_BUNDLE_DIR/Rokid Coder Setup.command"
fi
exec "$LAUNCHCTL" asuser "$uid" "$SUDO" -u "$user" -H /usr/bin/env -i \
  HOME="$home" USER="$user" LOGNAME="$user" SHELL="$shell" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$tmpdir" \
  "$@"
