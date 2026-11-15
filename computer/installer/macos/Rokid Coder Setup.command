#!/bin/sh
# Rokid Coder Setup: sets Rokid Coder up for whoever opens it. The installer
# opens it in Terminal for the logged-in user; the disk image carries a copy
# for any other user, and for a `sudo installer` run. It never switches user.

if [ "${ROKID_INSTALLER_TEST:-}" != 1 ]; then unset ID DSCL PLUTIL ROKID_INSTALL_ROOT; fi
ID=${ID:-/usr/bin/id}
DSCL=${DSCL:-/usr/bin/dscl}
PLUTIL=${PLUTIL:-/usr/bin/plutil}
ROOT=${ROKID_INSTALL_ROOT:-/Library/Application Support/RokidCoder}

uid=$("$ID" -u)
if [ "$uid" = 0 ]; then
  echo "Run Rokid Coder setup as yourself, not as root" >&2
  exit 1
fi
user=$("$ID" -un)

# HOME and SHELL from the directory service, not from whatever started this.
record=$("$DSCL" . -read "/Users/$user" NFSHomeDirectory UserShell 2>/dev/null)
value() {
  printf '%s\n' "$record" | awk -v key="$1:" '
    found { sub(/^ /, ""); print; exit }
    $0 == key { found = 1; next }
    index($0, key " ") == 1 { print substr($0, length(key) + 2); exit }'
}
home=$(value NFSHomeDirectory)
shell=$(value UserShell)
if [ -z "$home" ] || [ ! -d "$home" ]; then
  echo "Rokid Coder setup could not find your home folder (${home:-not in the directory service})." >&2
  exit 1
fi
[ -n "$shell" ] || shell=/bin/zsh

# Inside a version dir, that version; from the disk image, the installed one.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if [ -x "$here/bin/rokid-setup" ]; then
  bundle=$here
else
  version=$(sed -n '/<key>version<\/key>/{n;s:.*<string>\(.*\)</string>.*:\1:p;}' "$ROOT/installed-version" 2>/dev/null)
  bundle="$ROOT/$version"
  if [ -z "$version" ] || [ ! -x "$bundle/bin/rokid-setup" ]; then
    echo "Rokid Coder is not installed yet: open the Rokid Coder package first, then run this again." >&2
    exit 1
  fi
fi

latest=$(ls -t "$ROOT"/handoff/*.json 2>/dev/null | head -n 1)
if [ -n "$latest" ]; then
  handed=$("$PLUTIL" -extract uid raw -o - "$latest" 2>/dev/null) || handed=
  if [ -n "$handed" ] && [ "$handed" != "$uid" ]; then
    echo "The installer started this setup for another user (uid $handed). Setting Rokid Coder up for $user instead."
  fi
fi

log="$home/.rokid-coder/logs/setup.log"
before=0
[ -f "$log" ] && before=$(wc -c < "$log" | tr -d ' ')
HOME=$home SHELL=$shell USER=$user LOGNAME=$user "$bundle/bin/rokid-setup" install --platform darwin --bundle "$bundle" "$@"
status=$?

# The pairing step is the reachability check: when it did not finish, macOS may be keeping the
# phone's traffic from agentd (install-launchagent.sh:166-172).
if tail -c +"$((before + 1))" "$log" 2>/dev/null | grep -q "Not paired yet"; then
  cat <<EOF

If the phone never reaches this computer, macOS may be withholding local
network access from agentd. Enable "node" under
System Settings > Privacy & Security > Local Network,
then pair again with: ~/.rokid-coder/bin/agentd pair
EOF
fi
exit $status
