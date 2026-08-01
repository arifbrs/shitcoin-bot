#!/bin/bash
# Supervises the Strategy-2/GMGN research processes (review fix, 2026-07-27: these were running
# as orphans — nothing restarted them if one crashed or the machine rebooted). Zero capital, all
# read-only/paper — completely separate from the sniper's own run-supervised.sh.
#
# gmgn-proxy MUST be up before anything else that calls GMGN, since it's the only process that
# actually talks to GMGN now (see src/discovery/gmgn-proxy.ts) — every other script here just
# calls it over local HTTP. Started first, given a moment to bind its port, then everything else
# starts in parallel, each in its own restart-forever loop (same while-true pattern as the main
# supervisor — a script that exits 0 on shutdown must still come back, not just ones that crash).
cd "$(dirname "$0")"

supervise() {
  local name="$1"; shift
  while true; do
    "$@"
    echo "[research-supervisor] $name exited (code $?) — restarting in 3s..."
    sleep 3
  done
}

supervise "gmgn-proxy" npm run gmgn:proxy &
sleep 3  # let the proxy bind its port before anything tries to call it

supervise "strategy2-scout" npm run strategy2:scout &
supervise "strategy2-outcome" npm run strategy2:outcome &
supervise "strategy2-paper" npm run strategy2:paper &
supervise "gmgn-kol-watch" npm run gmgn:kol-watch &
supervise "gmgn-launchpads" npm run gmgn:launchpads &

wait
