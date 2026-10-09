#!/bin/bash
# DEXSCREENER SUPERVISOR — menjaga kolektor "semua 13 endpoint" tetap hidup (siklus 5 menit).
# Read-only, tanpa API key, dua bucket (60 rpm meta/profil + 300 rpm dex) di dalam prosesnya.
cd "$(dirname "$0")" || exit 1
while true; do
  npm run dex:full
  echo "[dex-supervisor] exit $? — restart 3s"
  sleep 3
done
