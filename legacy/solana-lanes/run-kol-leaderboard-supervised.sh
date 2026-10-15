#!/bin/bash
# Penyegar leaderboard pump.fun. Read-only, nol modal, di luar codeFingerprint.
cd "$(dirname "$0")" || exit 1
mkdir -p logs
while true; do
  node legacy/probes/kol-leaderboard-refresh.mjs >> logs/kol-leaderboard.log 2>&1
  echo "[$(date -Iseconds)] exit $? — restart 30s" >> logs/kol-leaderboard-supervisor.log
  sleep 30
done
