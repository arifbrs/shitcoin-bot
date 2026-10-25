#!/usr/bin/env bash
# LANE OBSERVER PUMP-CALLER (riset prospektif H2) — kontinu, bebas-kunci, nol modal.
# Feed PumpPortal (admission token baru) + tick observe: tape on-chain tervalidasi →
# candle selesai → keputusan bayangan → outcome PENDING→OBSERVED. Tanpa Developer API,
# tanpa signing. Mati = restart via deploy/start-lanes-detached.mjs (idempoten).
set -u
cd "$(dirname "$0")"
export PUMP_OBSERVE_TICK_MS="${PUMP_OBSERVE_TICK_MS:-35000}"
while true; do
  npx tsx src/research/pump-caller/watch.ts 2>&1 | sed 's/^/[pump:watch] /'
  sleep 60
done
