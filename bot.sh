#!/bin/bash
# ── PENGENDALI BOT: start / stop / status ────────────────────────────────────
# Dibuat supaya owner bisa menjalankan sendiri tanpa perlu menyalin urutan
# perintah. Urutannya BUKAN selera — tiap langkah lahir dari kesalahan nyata:
#
#   * watchdog dinyalakan TERAKHIR (jeda 45s). Kalau bersamaan, ia membaca
#     proses yang masih booting sebagai macet lalu langsung membunuhnya.
#   * watchdog dimatikan PERTAMA. Kalau tidak, ia menghidupkan ulang sniper
#     yang baru saja diminta berhenti.
#   * verifikasi lewat PORT dan NAMA SKRIP supervisor, bukan sekadar nama
#     proses — pernah dilaporkan "0 proses" padahal 4 supervisor masih hidup.
cd "$(dirname "$0")" || exit 1

G='\033[32m'; R='\033[31m'; Y='\033[33m'; D='\033[2m'; N='\033[0m'
ok(){ printf "  ${G}✓${N} %s\n" "$1"; }
bad(){ printf "  ${R}✗${N} %s\n" "$1"; }
info(){ printf "  ${D}%s${N}\n" "$1"; }

# MULTI-LANE (2026-10-07): dashboard + GMGN + Robinhood. Lane Solana dimatikan oleh owner.
# DASHBOARD DIMATIKAN (2026-10-13): operator mematikannya → ia tidak dihitung sebagai lane yang
# seharusnya jalan (kalau tidak, status akan selalu tampak "silang" padahal itu keputusan sadar).
# SAKLAR DARI .env (2026-10-13): skrip bash tidak memuat .env, sehingga DASHBOARD_DISABLED di sana
# TIDAK terlihat — akibatnya status tetap menghitung dashboard sebagai silang padahal sengaja mati.
# Dibaca di sini (tanpa menyentuh rahasia lain) supaya keputusan operator benar-benar berlaku.
if [ -f .env ]; then DASHBOARD_DISABLED=$(grep -E '^DASHBOARD_DISABLED=' .env | tail -1 | cut -d= -f2- | tr -d ' \r'); fi

SUPERVISORS=(gmgn robinhood analisa dexscreener)
[ "${DASHBOARD_DISABLED:-0}" != "1" ] && SUPERVISORS=(dashboard "${SUPERVISORS[@]}")
# DASHBOARD DIMATIKAN (2026-10-13): entri prosesnya ikut dilepas supaya status tidak menghitungnya
# sebagai lane yang gagal. Kembalikan dua baris ini bila dashboard dinyalakan lagi.
PROCS=()
[ "${DASHBOARD_DISABLED:-0}" != "1" ] && PROCS+=("tsx src/server.ts:dashboard")
PROCS+=(
       "gmgn-proxy:proxy GMGN" \
       "gmgn-full-watch:watch GMGN" \
       "gmgn-report:report GMGN" \
       "robinhood/paper:paper RH (43 varian — 10+10+8+6+9 kohort-5)" \
       "robinhood/review:review RH jam-8" \
       "src/analisa.ts:analisa (loop 12m)" \
       "discovery/dex-full:dex-full (13 endpoint)" \
       "src/okx-lane.ts:okx-lane (observasi)" \
       "src/okx-strict-paper.ts:okx strict-paper (uang kertas)")

running(){ pgrep -f "$1" >/dev/null 2>&1; }

status(){
  echo "── PROSES ──"
  local live=0
  for e in "${PROCS[@]}"; do
    local pat="${e%%:*}" lbl="${e##*:}"
    if running "$pat"; then ok "$lbl"; live=$((live+1)); else bad "$lbl"; fi
  done
  echo "── SUPERVISOR ──"
  for s in "${SUPERVISORS[@]}"; do
    running "run-$s-supervised" && ok "run-$s" || bad "run-$s"
  done
  # ── KELUARAN, bukan sekadar keberadaan proses ──
  # kol-copy pernah MATI DIAM 38 jam sementara status melaporkannya sehat: supervisor menjaga
  # proses tetap hidup, dan proses yang terjebak loop 429 tetap "ada". Memeriksa pgrep saja
  # tidak pernah bisa menangkap itu. Yang diperiksa di sini: kapan tiap komponen terakhir
  # MENULIS sesuatu. Ambangnya per-komponen karena iramanya memang berbeda.
  echo "── KELUARAN (diam = tidak menghasilkan, walau proses hidup) ──"
  python3 - <<'PYCHK'
import glob, os, time, subprocess
now = time.time()
# Umur supervisor = masa tenggang: setelah baru dinyalakan, berkas terakhir masih membawa jejak
# sebelum shutdown — menandainya DIAM adalah alarm palsu.
def sup_uptime_min(pattern):
    try:
        pid = subprocess.run(["pgrep","-f",pattern], capture_output=True, text=True).stdout.split()[0]
        et = subprocess.run(["ps","-o","etime=","-p",pid], capture_output=True, text=True).stdout.strip()
        secs = 0
        for part in et.replace("-", ":").split(":"): secs = secs*60 + int(part)
        return secs/60
    except Exception:
        return 1e9
# MULTI-LANE (2026-10-07): lane Solana dimatikan, detektor diarahkan ke lane yang BENAR-BENAR
# berjalan (GMGN + Robinhood) supaya "DIAM" hanya menyala kalau ada yang sungguh rusak.
checks = [
    ("RH paper (siklus 3m)",   "logs/rh-events-*.jsonl",     "run-robinhood-supervised", 12),
    ("RH review (harian 8)",   "logs/robinhood-review-*.md", "run-robinhood-supervised", 1560),
    ("GMGN watch (siklus15m)", "logs/events-*.jsonl",        "run-gmgn-supervised",      25),
    ("GMGN proxy/supervisor",  "logs/gmgn-supervisor.out",   "run-gmgn-supervised",      25),
    ("GMGN report (harian)",   "logs/gmgn-report-*.md",      "run-gmgn-supervised",      1800),  # 30 jam: laporan harian + kelonggaran (dulu 26 jam -> alarm palsu DIAM)
]
for label, pat, sup, limit in checks:
    fs = sorted(glob.glob(pat))
    UP = sup_uptime_min(sup)
    if not fs:
        print(f"  \033[31m?\033[0m {label}: belum ada berkas")
        continue
    age = (now - os.path.getmtime(fs[-1])) / 60
    if UP < limit and age > UP:          # baru nyala: belum sempat menulis, bukan macet
        print(f"  \033[2m·\033[0m {label}: menunggu (proses baru {UP:.0f}m)")
        continue
    if age <= limit:
        print(f"  \033[32m✓\033[0m {label}: tulis {age:.0f}m lalu")
    else:
        print(f"  \033[31m✗ DIAM\033[0m {label}: tulis {age:.0f}m lalu (batas {limit}m)")
PYCHK
  echo "── PORT ──"
  if [ "${DASHBOARD_DISABLED:-0}" = "1" ]; then
    info "4317 dashboard — DIMATIKAN (sengaja, lihat PLAN_PROGRESS.md)"
  else
    lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1 && ok "4317 dashboard" || bad "4317 kosong"
  fi
  echo "── POSISI TERBUKA ──"
  python3 - <<'PY' 2>/dev/null || info "state belum bisa dibaca"
import json,os
p='logs/rh-paper-state.json'
if not os.path.exists(p):
    print("  RH: state belum ada")
else:
    try:
        d=json.load(open(p)); vs=d.get('variants',{})
        tot=sum(len(v.get('positions',[])) for v in vs.values())
        syms=[q.get('symbol') for v in vs.values() for q in v.get('positions',[])]
        print(f"  RH: {tot} posisi terbuka" + (f" · {', '.join(str(s) for s in syms[:8])}" if syms else " (menunggu kandidat)"))
    except Exception as e:
        print(f"  RH: state RUSAK — {e}")
print("  Solana S1/S2: dihentikan 2026-10-07 (lane mati, data lama tetap di logs/) — DINILAI GAGAL oleh operator 2026-10-11: pernah dicoba live, hasilnya nihil; jangan dihidupkan kembali tanpa rencana baru")
PY
  return $(( ${#PROCS[@]} - live ))
}

start(){
  if running "tsx src/server.ts"; then
    printf "${Y}Bot sudah jalan.${N} Pakai ./bot.sh status untuk melihat, atau ./bot.sh stop dulu.\n"
    status; return 1
  fi
  echo "Menyalakan bot…"
  # MULTI-LANE (2026-10-07, keputusan owner): lane Solana (sniper S1 + Strategy-2) DIMATIKAN —
  # tidak ada lagi proses yang memakan RPC/quota Solana. Yang jalan: dashboard + GMGN + Robinhood.
  # Rollback mudah: script run-sniper/run-research/run-watchdog/run-kol-* masih ada, jalankan manual.
  info "lane aktif : dashboard · GMGN (proxy+watch+report) · Robinhood (10 varian + review 08:00)"
  info "lane mati  : sniper S1 · Strategy-2 · watchdog Solana · probe KOL · okx · okx-paper (2026-10-13 fokus Robinhood)"
  # DASHBOARD DIMATIKAN (2026-10-13): operator mematikannya. Hidupkan lagi dengan menghapus
  # DASHBOARD_DISABLED=1 di .env. Baris asli: nohup ./run-dashboard-supervised.sh > logs/dashboard-supervisor.out 2>&1 &
  if [ "${DASHBOARD_DISABLED:-0}" != "1" ]; then nohup ./run-dashboard-supervised.sh > logs/dashboard-supervisor.out 2>&1 & fi
  nohup ./run-gmgn-supervised.sh      > logs/gmgn-supervisor.out 2>&1 &
  nohup ./run-robinhood-supervised.sh > logs/robinhood-supervisor.out 2>&1 &
  # LOOP ANALISA (2026-10-08): digest interpretasi tiap 12 menit — "jangan berhenti".
  nohup ./run-analisa-supervised.sh   > logs/analisa-supervisor.out   2>&1 &
  # DEXSCREENER FULL (2026-10-08): semua 13 endpoint, siklus 5 menit, tanpa key.
  nohup ./run-dexscreener-supervised.sh > logs/dex-supervisor.out     2>&1 &
  # OKX LANE (2026-10-08): blokir DNS ISP hilang — lane observasi read-only dinyalakan lagi.
  # DIMATIKAN 2026-10-13 (fokus Robinhood; skrip ada di legacy/solana-lanes/): nohup ./run-okx-supervised.sh       > logs/okx-supervisor.out       2>&1 &
  # OKX STRICT-PAPER (2026-10-08): uang kertas. Tanpa signer/broadcast — hanya tx unsigned + simulasi.
  # DIMATIKAN 2026-10-13 (fokus Robinhood; skrip ada di legacy/solana-lanes/): nohup ./run-okx-paper-supervised.sh > logs/okx-paper-supervisor.out 2>&1 &
  # PENJAGA LANE (2026-10-07): supervisor bisa mati diam sementara anaknya jadi orphan — tanpa ini
  # lane berhenti tanpa suara. Guard memeriksa tiap 2 menit dan menghidupkan ulang yang hilang.
  nohup ./tools/lane-guard.sh         > logs/lane-guard.out 2>&1 &
  info "menunggu mesin naik (12 detik)…"; sleep 12
  echo; status; local rc=$?
  echo
  if [ $rc -eq 0 ]; then
    printf "${G}Bot jalan.${N} Dashboard: http://localhost:4317/app\n"
  else
    printf "${R}Sebagian proses belum naik.${N} Coba ./bot.sh status lagi dalam 30 detik.\n"
  fi
  return $rc
}

stop(){
  echo "Mematikan bot…"
  # Watchdog dulu, kalau tidak ia menghidupkan ulang sniper yang baru dimatikan.
  pkill -f "run-watchdog-supervised" 2>/dev/null; pkill -f "watchdog.mjs" 2>/dev/null; sleep 2
  pkill -f "run-kol-edge-supervised" 2>/dev/null; pkill -f "kol-edge-probe" 2>/dev/null
  pkill -f "run-kol-copy-supervised" 2>/dev/null; pkill -f "kol-copy-probe" 2>/dev/null
  pkill -f "run-kol-leaderboard-supervised" 2>/dev/null; pkill -f "kol-leaderboard-refresh" 2>/dev/null
  pkill -f "run-entry-shadow-supervised" 2>/dev/null; pkill -f "entry-shadow-probe" 2>/dev/null
  for s in sniper research dashboard bxswaps robinhood gmgn; do pkill -f "run-$s-supervised" 2>/dev/null; done
  pkill -f "tsx src/index.ts" 2>/dev/null
  pkill -f "strategy2-scout" 2>/dev/null; pkill -f "strategy2-papertrader" 2>/dev/null
  pkill -f "strategy2-outcome" 2>/dev/null; pkill -f "gmgn" 2>/dev/null
  pkill -f "robinhood/paper" 2>/dev/null; pkill -f "robinhood/review" 2>/dev/null
  pkill -f "lane-guard" 2>/dev/null; pkill -f "run-analisa-supervised" 2>/dev/null; pkill -f "src/analisa.ts" 2>/dev/null
  pkill -f "run-dexscreener-supervised" 2>/dev/null; pkill -f "discovery/dex-full" 2>/dev/null
  pkill -f "run-okx-supervised" 2>/dev/null; pkill -f "src/okx-lane.ts" 2>/dev/null
  pkill -f "run-okx-paper-supervised" 2>/dev/null; pkill -f "src/okx-strict-paper.ts" 2>/dev/null
  pkill -f "bx-swaps" 2>/dev/null; pkill -f "tsx src/server.ts" 2>/dev/null
  sleep 6
  local left; left=$(ps aux | grep -E "tsx src/|strategy2-|watchdog.mjs|kol-edge-probe|kol-copy-probe|kol-leaderboard-refresh|entry-shadow-probe|run-.*-supervised" | grep -v grep | wc -l | tr -d ' ')
  if [ "$left" = "0" ]; then ok "semua proses berhenti"; else bad "$left proses masih hidup"; fi
  lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1 && bad "port 4317 masih dipakai" || ok "port 4317 kosong"
  # Data aman? state harus JSON utuh, dan baris log terakhir tidak boleh terpotong.
  python3 - <<'PY'
import json,os,glob,datetime
bad=0
for p in ('logs/positions.json','logs/strategy2-paper-state.json','logs/rh-paper-state.json'):
    if not os.path.exists(p): continue
    try:
        d=json.load(open(p)); ps=d.get('positions')
        print(f"  \033[32m✓\033[0m {p.split('/')[-1]}: JSON utuh · {len(ps) if isinstance(ps,(list,dict)) else 0} posisi terbuka")
    except Exception as e:
        bad+=1; print(f"  \033[31m✗\033[0m {p}: RUSAK — {e}")
today=datetime.date.today().isoformat(); cut=0
for f in glob.glob(f'logs/*-{today}.jsonl'):
    try:
        lines=open(f,errors='ignore').readlines()
        if lines: json.loads(lines[-1])
    except Exception: cut+=1
print(f"  \033[32m✓\033[0m log hari ini utuh" if cut==0 else f"  \033[31m✗\033[0m {cut} log baris terakhir terpotong")
PY
  echo; printf "${G}Aman untuk shutdown laptop.${N}\n"
}

case "${1:-status}" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  restart) stop; echo; start ;;
  *) echo "pakai: ./bot.sh {start|stop|status|restart}"; exit 2 ;;
esac
