#!/bin/bash
# KOL COPY PROBE — pengamat real-time wallet leaderboard pump.fun lewat Helius websocket.
# Nol modal, nol keputusan trading, di luar codeFingerprint.
cd "$(dirname "$0")" || exit 1
mkdir -p logs
while true; do
  echo "[$(date -Iseconds)] start kol-copy-probe" >> logs/kol-copy-supervisor.log
  node legacy/probes/kol-copy-probe.mjs >> logs/kol-copy-probe.log 2>&1
  echo "[$(date -Iseconds)] exit $? — restart 15s" >> logs/kol-copy-supervisor.log
  sleep 15
done
