#!/bin/bash
# Restarts the read-only web dashboard (src/server.ts) whenever it exits, for ANY reason.
# Runs standalone (NOT via `npm start`/start.ts) so it survives independently of the sniper
# (src/index.ts) being stopped — the two are only bundled together in start.ts for convenience,
# server.ts itself only reads from disk state (positions.json, logs, wallet) and does not require
# the sniper process to be alive. Kill THIS script's PID to stop the dashboard for good.
cd "$(dirname "$0")"
while true; do
  npx tsx src/server.ts
  echo "[dashboard-supervisor] server exited (code $?) — restarting in 3s..."
  sleep 3
done
