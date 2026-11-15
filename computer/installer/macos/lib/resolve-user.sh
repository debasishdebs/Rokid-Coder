#!/bin/sh
# Whose setup this is, and nothing else: it starts nothing [FR 11].
# Prints "<user><TAB><uid><TAB><home><TAB><shell>" and exits 0, or prints a
# reason code and exits 2:
#   deferred_cli_install  a `sudo installer` run (COMMAND_LINE_INSTALL), which never guesses whose machine it is
#   no_eligible_user      nobody setup could run as is at the console (loginwindow, root, a system account, no home)
# The detail of a no_eligible_user goes to stderr.

if [ "${ROKID_INSTALLER_TEST:-}" != 1 ]; then unset SCUTIL DSCL STAT; fi
SCUTIL=${SCUTIL:-/usr/sbin/scutil}
DSCL=${DSCL:-/usr/bin/dscl}
STAT=${STAT:-/usr/bin/stat}

reason() {
  printf '%s\n' "$1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" >&2
  exit 2
}

[ -n "${COMMAND_LINE_INSTALL:-}" ] && reason deferred_cli_install

# The top-level Name and UID of the console user's record (nested keys are indented deeper).
state=$(printf 'show State:/Users/ConsoleUser\n' | "$SCUTIL" 2>/dev/null)
name=$(printf '%s\n' "$state" | sed -n 's/^  Name : //p' | head -n 1)
uid=$(printf '%s\n' "$state" | sed -n 's/^  UID : //p' | head -n 1)

case $name in
  "" | root | loginwindow | _mbsetupuser) reason no_eligible_user "the console user is ${name:-nobody}" ;;
esac
console=$("$STAT" -f%Su /dev/console 2>/dev/null)
[ "$console" = "$name" ] || reason no_eligible_user "scutil says $name is at the console, /dev/console belongs to ${console:-nobody}"
case $uid in
  "" | *[!0-9]*) reason no_eligible_user "$name has no numeric uid" ;;
esac
[ "$uid" -ge 501 ] || reason no_eligible_user "$name (uid $uid) is a system account"

record=$("$DSCL" . -read "/Users/$name" NFSHomeDirectory UserShell 2>/dev/null) || reason no_eligible_user "the directory service has no record for $name"
# "Key: value", or, for a value with a space, "Key:" with the value on the next line.
value() {
  printf '%s\n' "$record" | awk -v key="$1:" '
    found { sub(/^ /, ""); print; exit }
    $0 == key { found = 1; next }
    index($0, key " ") == 1 { print substr($0, length(key) + 2); exit }'
}
home=$(value NFSHomeDirectory)
shell=$(value UserShell)
[ -n "$home" ] && [ -d "$home" ] || reason no_eligible_user "$name's home (${home:-none}) does not exist"
[ -n "$shell" ] || shell=/bin/zsh

printf '%s\t%s\t%s\t%s\n' "$name" "$uid" "$home" "$shell"
