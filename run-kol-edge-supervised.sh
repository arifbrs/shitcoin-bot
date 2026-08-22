#!/bin/bash
# KOL EDGE PROBE — pengamat murni. Nol modal, nol keputusan trading, di luar codeFingerprint.
# Menjawab satu pertanyaan: kalau KOL beli, berapa lama edge-nya bertahan?
cd "$(dirname "$0")" || exit 1
mkdir -p logs
while true; do
  echo "[$(date -Iseconds)] start kol-edge-probe" >> logs/kol-edge-supervisor.log
  node src/kol-edge-probe.mjs >> logs/kol-edge-probe.log 2>&1
  echo "[$(date -Iseconds)] exit code $? — restart 15s" >> logs/kol-edge-supervisor.log
  sleep 15
done
