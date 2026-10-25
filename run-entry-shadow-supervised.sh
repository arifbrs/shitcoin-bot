#!/bin/bash
# Shadow entry judge — HANYA menilai, tidak pernah memutuskan. Di luar codeFingerprint.
cd "$(dirname "$0")" || exit 1
mkdir -p logs
while true; do
  node legacy/probes/entry-shadow-probe.mjs >> logs/entry-shadow.log 2>&1
  echo "[$(date -Iseconds)] exit $? — restart 20s" >> logs/entry-shadow-supervisor.log
  sleep 20
done
