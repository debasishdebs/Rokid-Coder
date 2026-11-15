# Which version dirs under the install root are still in use, by any user the
# directory service knows (homes outside /Users count). Sourced by postinstall,
# which prunes what nothing references [6b-R6], and by uninstall.sh --system,
# which refuses while anyone else still references one [6b-R19], so the two
# always agree. It runs as root over files the users own, so it only reads
# regular files, never through a symlink, and only through plutil.
#
# Needs DSCL and PLUTIL set.

# rokid_json <file> <key path>: the value at the key path, or nothing.
rokid_json() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  rokid_json_value=$("$PLUTIL" -extract "$2" raw -o - "$1" 2>/dev/null) || return 1
  printf '%s\n' "$rokid_json_value"
}

# rokid_dscl_lookup <attribute> name|value <wanted>: from `dscl . -list /Users <attribute>`, the
# attribute of the user named <wanted>, or the name of the user whose attribute is <wanted>.
rokid_dscl_lookup() {
  "$DSCL" . -list /Users "$1" 2>/dev/null | while read -r rokid_name rokid_value; do
    if [ "$2" = name ] && [ "$rokid_name" = "$3" ]; then printf '%s\n' "$rokid_value"; break; fi
    if [ "$2" = value ] && [ "$rokid_value" = "$3" ]; then printf '%s\n' "$rokid_name"; break; fi
  done
}

# rokid_references <root>: one line per reference, "<user><TAB><bundle dir><TAB><kind>", where kind
# is installed, previous, "setup in progress" (an open journal) or "pending setup" (a handoff the
# user has not committed yet).
rokid_references() {
  rokid_root=$1
  "$DSCL" . -list /Users NFSHomeDirectory 2>/dev/null | while read -r rokid_user rokid_home; do
    [ -n "$rokid_home" ] && [ -d "$rokid_home/.rokid-coder" ] || continue
    rokid_manifest="$rokid_home/.rokid-coder/install.json"
    rokid_journal="$rokid_home/.rokid-coder/setup-journal.json"
    if rokid_dir=$(rokid_json "$rokid_manifest" bundleDir); then printf '%s\t%s\tinstalled\n' "$rokid_user" "$rokid_dir"; fi
    if rokid_dir=$(rokid_json "$rokid_manifest" previous.bundleDir); then printf '%s\t%s\tprevious\n' "$rokid_user" "$rokid_dir"; fi
    case $(rokid_json "$rokid_journal" open) in
      true | 1)
        for rokid_key in newManifest.bundleDir previousManifest.bundleDir; do
          if rokid_dir=$(rokid_json "$rokid_journal" "$rokid_key"); then printf '%s\t%s\tsetup in progress\n' "$rokid_user" "$rokid_dir"; fi
        done
        ;;
    esac
  done
  for rokid_handoff in "$rokid_root"/handoff/*.json; do
    [ -f "$rokid_handoff" ] || continue
    rokid_uid=$(rokid_json "$rokid_handoff" uid) || continue
    rokid_dir=$(rokid_json "$rokid_handoff" bundleDir) || continue
    rokid_user=$(rokid_dscl_lookup UniqueID value "$rokid_uid")
    if [ -n "$rokid_user" ]; then
      rokid_home=$(rokid_dscl_lookup NFSHomeDirectory name "$rokid_user")
      # Committed: that user's install.json now names the handed-off bundle.
      if [ -n "$rokid_home" ] && [ "$(rokid_json "$rokid_home/.rokid-coder/install.json" bundleDir)" = "$rokid_dir" ]; then continue; fi
    else
      rokid_user="uid $rokid_uid"
    fi
    printf '%s\t%s\tpending setup\n' "$rokid_user" "$rokid_dir"
  done
}

# rokid_is_referenced <dir> <references>: the volume is case-insensitive, so the comparison is too.
rokid_is_referenced() {
  rokid_wanted=$(printf '%s\n' "${1%/}" | tr '[:upper:]' '[:lower:]')
  printf '%s\n' "$2" | cut -f2 | sed 's:/*$::' | tr '[:upper:]' '[:lower:]' | grep -Fqx -- "$rokid_wanted"
}

# rokid_prune <root> <version being installed>: deletes each version dir nothing references. It
# runs before the new setup, so it only removes versions that were already unused; one this run's
# upgrades free up goes with the NEXT package install.
rokid_prune() {
  rokid_refs=$(rokid_references "$1")
  for rokid_candidate in "$1"/*; do
    [ -d "$rokid_candidate" ] && [ ! -L "$rokid_candidate" ] || continue
    [ "${rokid_candidate##*/}" = "$2" ] && continue
    # Only what the package laid out: a bundle.
    [ -f "$rokid_candidate/bundle.json" ] || continue
    rokid_is_referenced "$rokid_candidate" "$rokid_refs" && continue
    rm -rf -- "$rokid_candidate" && printf 'removed %s, which no user references any more\n' "${rokid_candidate##*/}"
  done
}
