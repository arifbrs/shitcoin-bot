#!/bin/bash
# ANALISA SUPERVISOR — menjaga loop analisa berkelanjutan (digest tiap 12 menit) tetap hidup.
# Read-only, nol API (hanya 1 cek DoH), tidak menyentuh lane mana pun.
cd "$(dirname "$0")" || exit 1
while true; do
  npm run analisa -- --loop
  echo "[analisa-supervisor] exit $? — restart 3s"
  sleep 3
done
