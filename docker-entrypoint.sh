#!/bin/sh
# Runs Filtarr as PUID:PGID (default 1000:1000; Unraid uses 99:100) and makes sure that user owns /config.
set -e
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p /config
  # Only fix ownership when it is wrong, so large or remote config folders aren't rewritten on every start.
  if [ -n "$(find /config \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit)" ]; then
    echo "Setting owner of /config to $PUID:$PGID"
    chown -R "$PUID:$PGID" /config
  fi
  umask "${UMASK:-022}"
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi
exec "$@"
