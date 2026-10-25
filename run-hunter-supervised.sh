#!/bin/bash
# HUNTER SUPERVISOR (2026-10-24) — kolektor Lowcap Hunter jadwal permanen.
# Alur tiap HUNTER_INTERVAL_SEC detik (default 3600): kolektor GMGN dua chain (read-only,
# lewat proxy lokal 10s/call) → filter/tiering offline → keluaran logs/hunter/*.json.
# Nol modal, tidak pernah menandatangani apa pun. Supervisor berhenti bila TERM ke pid ini.
set -u
cd "$(dirname "$0")" || exit 1

INTERVAL="${HUNTER_INTERVAL_SEC:-3600}"
mkdir -p logs
lock=logs/hunter-supervisor.lock
if ! ( set -C; printf '%s\n' "$$" > "$lock" ) 2>/dev/null; then
  owner=$(cat "$lock" 2>/dev/null)
  case "$owner" in ''|*[!0-9]*) echo "[hunter-supervisor] lock tidak sah; dipertahankan"; exit 1;; esac
  if kill -0 "$owner" 2>/dev/null; then echo "[hunter-supervisor] sudah jalan (pid $owner)"; exit 1; fi
  rm "$lock"
  ( set -C; printf '%s\n' "$$" > "$lock" ) 2>/dev/null || exit 1
fi
trap 'rm -f "$lock"; exit 0' INT TERM EXIT

while true; do
  echo "[hunter-supervisor] $(date '+%H:%M:%S') siklus koleksi dimulai"
  for chain in robinhood sol; do
    npx tsx src/hunter/collect.ts "$chain" 20 2>&1 | sed "s/^/[hunter-$chain] /"
    sleep 5
  done
  npx tsx src/hunter/run.ts 2>&1 | sed 's/^/[hunter-filter] /'
  echo "[hunter-supervisor] siklus selesai — tidur ${INTERVAL}s"
  sleep "$INTERVAL"
done
