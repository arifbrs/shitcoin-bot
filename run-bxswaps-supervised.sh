#!/bin/bash
# Passive bloXroute pump.fun swap RECORDER (src/discovery/bloxroute-swap-recorder.ts).
#
# Measurement only — it touches no trading decision and is imported by nothing. Its whole job is
# to record per-swap bonding-curve reserves so we can finally measure what our 4-second polling
# tick misses (median 17.2% of price movement per tick step, measured over 109 armed exits).
#
# Safe to start/stop at any time: the file is NOT in config.ts's codeFingerprint() list, so
# running it cannot move the sniper's `cfg` hash or split the live cohort. Verified 2026-08-02.
#
# Free-tier reality (measured, the docs disagree): exactly ONE stream subscription at a time.
# A second concurrent subscribe is refused with "account is rate limited". Do not run two copies.
cd "$(dirname "$0")"
# NOTE: do NOT `source .env` — it contains a multi-line PEM (GMGN_PRIVATE_KEY) and the shell
# chokes on it ("line 205: PRIVATE: command not found"), silently dropping later variables.
# Export only the two keys this recorder needs, parsed literally.
export BLOXROUTE_AUTH_HEADER="$(grep -E '^BLOXROUTE_AUTH_HEADER=' .env | head -1 | cut -d= -f2-)"
export BLOXROUTE_WS_URL="$(grep -E '^BLOXROUTE_WS_URL=' .env | head -1 | cut -d= -f2-)"
while true; do
  npm run bx:swaps
  echo "[bx-swaps-supervisor] exited (code $?) — restarting in 10s..."
  sleep 10
done
