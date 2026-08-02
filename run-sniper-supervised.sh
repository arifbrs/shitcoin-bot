#!/bin/bash
# Runs JUST the sniper bot (src/index.ts, Strategy 1) under a restart-forever loop, WITHOUT its
# own bundled dashboard spawn (unlike `npm start`/start.ts, which pairs index.ts+server.ts and
# kills one if the other dies). The dashboard (server.ts) is already running standalone via
# run-dashboard-supervised.sh — spawning a second one here would fight it for port 4317. Dry-run
# only (config.dryRun is a hardcoded `true as const`, no live path exists in this codebase) —
# same paper-only safety posture as Strategy 2.
cd "$(dirname "$0")"

# ============================================================================
# COHORT TEST 2026-08-01 #2 — NAIKKAN BAND MC ENTRY (30-45 -> 55-100 SOL)
# ============================================================================
# Ini perubahan SELEKSI, bukan exit. Dasarnya: dari 957 trade tertutup, gross −5,23%/trade
# (biaya cuma 2,45%) — jadi kerugiannya BUKAN dari ongkos, tapi dari memilih coin yang salah.
# 72% trade tidak pernah menembus puncak +5% dan menghabiskan −11.809 poin; sisanya +6.112.
#
# Dari 11 sinyal saat entry hanya `curveMcSol` yang punya daya pisah (AUC 0,674) — rawScore,
# holders, devInitialBuySol, sniperPct, bundlerPct, washScore semuanya derau (0,47-0,55).
#
# Counterfactual di 20.468 jalur yang TIDAK pernah dibeli (logs/path-*.jsonl, obs:true; masuk
# saat MC pertama menembus band, MFE diukur DARI titik itu):
#     30-32 (lantai lama) : 21% bergerak >=5%,  2,6% lari >=100%
#     40-45 (plafon lama) : 40% bergerak,       7,0% lari
#     55-70               : 51% bergerak,      11,3% lari,  MFE median +5,7%
#     70-100              : 56% bergerak,      13,4% lari,  MFE median +10,3%
#     100-200             : datar/menurun
# Komentar lama di config ("don't buy the pump") terbantah: MC 55 tercapai median 3 DETIK setelah
# launch — belum ada pump untuk dikejar. curveMcSol sebenarnya mengukur modal awal dev + pembeli
# pertama. Volume berlimpah: >=55 SOL terjadi ~1.251 coin/hari (sekarang kita entry ~300/hari).
#
# PERINGATAN: MFE bukan P&L terealisasi. Ini arah dengan bukti terkuat yang kita punya, BUKAN
# janji profit. Kalau cohort baru tidak lebih baik dari 1qa0i0o, hapus dua baris export ini.
# ── UKURAN POSISI 0,03 -> 0,15 SOL (2026-08-02) ──
# Biaya TETAP menghancurkan posisi kecil. Tip validator (0,001 SOL/sisi, default aplikasi
# pump.fun) tidak pernah dimodelkan dan pada 0,03 SOL setara 6,67% round-trip — lebih besar
# dari SELURUH biaya lain digabung (2,39%). Diukur pada kurva nyata (vSol=70, tengah band):
#   0,03 SOL -> total 10,30%   EV live -2,63%
#   0,10 SOL -> total  5,80%   EV live +1,87%
#   0,15 SOL -> total  5,27%   EV live +2,40%   <- dipilih
#   0,25 SOL -> total  5,02%   EV live +2,65%   (optimum, tapi 12,5% float per posisi)
#   0,50 SOL -> total  5,33%   EV live +2,34%   (slippage mulai menang lagi)
# Slot bukan kendala: konkurensi terukur median 1, puncak 5; 0,15 SOL memberi 13 slot.
# 0,15 dipilih karena menangkap +2,40 dari +2,65 maksimum dengan separuh konsentrasi risiko.
export PAPER_TRADE_SIZE_SOL=0.15

export ENTRY_MC_FLOOR_SOL=55
export ENTRY_MC_CEIL_SOL=100

# --- DIBATALKAN: potong NO_DEVELOPMENT 45s -> 25s ---
# Diuji hidup sebagai cohort t5cofy dan HASILNYA LEBIH BURUK: EV −6,16% (167 trade) vs −5,91%
# (759 trade) di 45s. Bleed memang turun 22%->19% persis seperti prediksi simulasi, tapi EV tetap
# kalah. Simulasi memperkirakan +0,54%; kenyataannya −0,25%. Dikembalikan ke default 45s.
# Catatan lama disimpan di bawah sebagai pengingat seberapa jauh simulasi bisa meleset.
#
# --- COHORT TEST 2026-08-01: potong NO_DEVELOPMENT lebih awal, 45s -> 25s ---
# Diputuskan dari 546 trade hari ini yang punya jejak harga per-tick (logs/ticks-*.jsonl),
# dibandingkan setara (simulasi-45s vs simulasi-25s, dua-duanya pakai execPnlPct, supaya bias
# ~4 poin antara execPnlPct dan pnlPct-saat-tutup saling hapus):
#   potong 25s = +296 poin (+0.54%/trade), EV -10.95% -> -10.40%, monotonik (makin awal makin
#   baik sampai 10s). Untungnya dari 321 trade NO_DEVELOPMENT (+1.4% masing-masing) dan 64
#   DEV_DUMP (+0.5%); ongkosnya 1 TRAIL_LOCK yang seharusnya +84.8% ikut mati, plus 4 MAX_HOLD.
# Ini MENGURANGI PENDARAHAN, bukan menciptakan edge — EV tetap negatif. Kalau cohort baru tidak
# terbukti lebih baik dari cfg lama, hapus dua baris ini dan sniper balik ke 45s.
# config.risk masuk ke configHash, jadi cohort ini memisahkan dirinya sendiri lewat tag `cfg`.
# export NO_DEV_MS=25000   <- DIBATALKAN, lihat catatan di atas

while true; do
  npm run demo
  echo "[sniper-supervisor] bot exited (code $?) — restarting in 3s..."
  sleep 3
done
