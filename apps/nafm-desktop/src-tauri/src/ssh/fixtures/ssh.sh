#!/bin/sh
# Offline test double. No host connection or authentication is performed.
path=''
check=''
master=''
target=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -S) shift; path=$1 ;;
    -O) shift; check=$1 ;;
    -o) shift ;;
    -N) master=yes ;;
    -T) ;;
    *) target=$1 ;;
  esac
  shift
done
if [ "$check" = check ]; then
  if [ "$target" = external ]; then exit 0; fi
  test -n "$path" && test -f "$path"
  exit $?
fi
if [ "$master" = yes ]; then
  if [ "$target" = rejected ]; then
    echo 'Host key verification failed.' >&2
    exit 255
  fi
  if [ "$target" != stalled ]; then
    printf '%s' "$$" > "$path"
  fi
  exec sleep 60
fi
exit 0
