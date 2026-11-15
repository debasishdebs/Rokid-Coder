#!/bin/sh
# Rokid-Coder bundle wrapper: shell builtins only, so it execs nothing but the bundled node.
case $0 in */*) d=${0%/*};; *) d=.;; esac
d=$(CDPATH= cd -- "$d" && pwd -P)
exec "$d/../node/bin/node" "$d/../app/dist/cli.js" "$@"
