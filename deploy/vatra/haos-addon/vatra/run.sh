#!/bin/sh
# Vatra HAOS add-on entry: the Supervisor mounts /data root-owned; hand it to node (uid 1000) and
# run the hub unprivileged. HA_URL / HA_TOKEN fall back to the Supervisor proxy (see
# src/lib/home/credentials.ts) unless set in Vatra's own settings.
set -eu
chown -R 1000:1000 /data
exec setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all --bounding-set=-all node /app/server.js
