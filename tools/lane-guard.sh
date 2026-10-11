#!/bin/bash
# LANE GUARD — penjaga supervisor (supervisor of supervisors).
#
# KENAPA ADA (bug produksi 2026-10-07 malam): supervisor Robinhood mati DIAM-DIAM sementara
# proses anaknya tetap jalan sebagai orphan. Begitu anaknya berhenti (mis. di-restart manual),
# tidak ada apa pun yang menghidupkannya lagi — lane mati tanpa suara, dashboard cuma "diam".
# Kelas kegagalan yang sama pernah menimpa probe KOL (mati diam 38 jam). bot.sh hanya menyalakan
# supervisor SAAT BOOT; ia tidak menjaga mereka tetap hidup setelahnya.
#
# Tugas guard ini sederhana dan sengaja bodoh: tiap LOOP detik, periksa apakah supervisor lane
# (run-robinhood-supervised, run-gmgn-supervised) masih ada. Kalau tidak → hidupkan ulang dengan
# pola yang sama seperti bot.sh (nohup, output ke logs/*-supervisor.out), dan catat kejadiannya.
# Tidak menyentuh lane yang memang dimatikan owner (Solana) — daftarnya eksplisit di bawah.
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
LOOP_SEC="${LANE_GUARD_LOOP_SEC:-120}"

echo "[lane-guard] mulai · cek tiap ${LOOP_SEC}s · menjaga: robinhood, gmgn"

guard() {
  local name="$1" script="$2" logs="$3" children="$4"
  if pgrep -f "$script" >/dev/null 2>&1; then return; fi
  echo "[$(date -Iseconds)] $name SUPERVISOR HILANG — bersihkan orphan lane ini, lalu hidupkan ulang" >> logs/lane-guard.log
  # ALARM (item 5, 2026-10-11): supervisor yang mati harus memberi tahu, bukan hanya dicatat.
  # node tools/notify.mjs senyap & keluar 0 bila alarm belum dipasang — jadi aman dipanggil selalu.
  ( node "$(dirname "$0")/../tools/notify.mjs" "$name SUPERVISOR HILANG — dihidupkan ulang oleh lane-guard" >/dev/null 2>&1 & )
  # PENTING: bunuh anak lane yang mungkin masih hidup sebagai orphan SEBELUM supervisor baru
  # dijalankan. Dua proses menulis state yang sama = duplikat/korupsi (persis bug 2026-10-07).
  if [ -n "$children" ]; then pkill -f "$children" 2>/dev/null; sleep 1; fi
  nohup "./$script" >> "$logs" 2>&1 &
}

while true; do
  guard "robinhood" "run-robinhood-supervised.sh" "logs/robinhood-supervisor.out" "robinhood/paper|robinhood/review"
  guard "gmgn"      "run-gmgn-supervised.sh"      "logs/gmgn-supervisor.out"      "gmgn-proxy|gmgn-full-watch|gmgn-report"
  guard "analisa"   "run-analisa-supervised.sh"   "logs/analisa-supervisor.out"   "src/analisa.ts"
  guard "dex"       "run-dexscreener-supervised.sh" "logs/dex-supervisor.out"     "src/discovery/dex-full.ts"
  guard "okx"       "run-okx-supervised.sh"        "logs/okx-supervisor.out"     "src/okx-lane.ts"
  guard "okx-paper" "run-okx-paper-supervised.sh"  "logs/okx-paper-supervisor.out" "src/okx-strict-paper.ts"
  # DASHBOARD (2026-10-11): supervisor dashboard TIDAK dijaga siapa pun sebelumnya — ia sempat mati
  # dan panel (alat pemantauan utama) hilang tanpa ada yang tahu. Sekarang dijaga seperti lane lain.
  guard "dashboard" "run-dashboard-supervised.sh" "logs/dashboard-supervisor.out" "src/server.ts"
  sleep "$LOOP_SEC"
done
