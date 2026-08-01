#!/bin/bash
# Restarts `npm start` (bot+dashboard) whenever it exits, for ANY reason — including the bot's
# own watchdog `process.exit(1)` on a silent feed, which start.ts deliberately does NOT survive
# on its own ("If either child dies, bring down the other so the stack fails loudly, not half-up").
# This completes that design: the watchdog's own comment says "non-zero -> supervisor restarts
# us" — this IS that supervisor. To stop the stack for good, kill THIS script's PID, not just
# index.ts/server.ts (killing only those gets relaunched immediately by the loop below).
cd "$(dirname "$0")"
# BUG FIXED 2026-07-27: `until npm start; do ...; done` restarts only while npm start FAILS
# (non-zero exit) and stops for good the moment it exits 0 — which start.ts's shutdown() always
# does, even when a child was killed by the watchdog or by us. That inverted the whole point:
# the supervisor itself died on the very first "clean-looking" exit. `while true` restarts on
# EVERY exit, zero or not — the only correct behaviour for "keep this running no matter what".
while true; do
  npm start
  echo "[supervisor] stack exited (code $?) — restarting in 3s..."
  sleep 3
done
