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

SUPERVISORS=(sniper research dashboard watchdog kol-copy kol-leaderboard entry-shadow)
PROCS=("tsx src/index.ts:sniper S1" "strategy2-scout:scout S2" "strategy2-papertrader:paper S2" \
       "strategy2-outcome:outcome S2" "tsx src/server.ts:dashboard" "watchdog.mjs:watchdog" \
       "kol-copy-probe:probe salin KOL" \
       "kol-leaderboard-refresh:penyegar leaderboard" \
       "entry-shadow-probe:shadow entry")

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
# Umur proses sniper. Setelah bot baru dinyalakan, "terakhir menulis" masih membawa jejak
# sebelum shutdown — menandainya DIAM adalah alarm palsu, dan alarm palsu yang berulang
# melatih orang mengabaikan detektornya. Ambang tidak pernah lebih besar dari umur proses.
def sniper_uptime_min():
    try:
        pid = subprocess.run(["pgrep","-f","tsx src/index.ts"], capture_output=True, text=True).stdout.split()[0]
        et = subprocess.run(["ps","-o","etime=","-p",pid], capture_output=True, text=True).stdout.strip()
        secs = 0
        for part in et.replace("-", ":").split(":"): secs = secs*60 + int(part)
        return secs/60
    except Exception:
        return 1e9
UP = sniper_uptime_min()
# (label, pola berkas, ambang menit) — ambang = beberapa kali irama normalnya
checks = [
    ("sniper: keputusan",   "logs/decisions-*.jsonl",       5),
    # trade ditutup hanya kalau ada posisi; sepi bukan berarti rusak
    ("sniper: trade",       "logs/paper-trades-*.jsonl",   180),
    # S2 dimatikan 2026-08-18; event masih ditulis proses lain, jadi diganti label
    ("S2: event",           "logs/events-*.jsonl",           5),
    ("probe salin KOL",     "logs/kol-copy-probe.log",      15),
    ("penyegar leaderboard","logs/kol-leaderboard-*.jsonl", 45),
    # menulis hanya saat ada entry BARU dinilai; laju buy ~2/jam, jadi jeda panjang wajar
    ("shadow entry",        "logs/entry-shadow.log",        90),
]
for label, pat, limit in checks:
    fs = sorted(glob.glob(pat))
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
  lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1 && ok "4317 dashboard" || bad "4317 kosong"
  echo "── POSISI TERBUKA ──"
  python3 - <<'PY' 2>/dev/null || info "state belum bisa dibaca"
import json,os
for p,l in (('logs/positions.json','S1'),('logs/strategy2-paper-state.json','S2')):
    if not os.path.exists(p): print(f"  {l}: state belum ada"); continue
    d=json.load(open(p)); ps=d.get('positions')
    n=len(ps) if isinstance(ps,(list,dict)) else 0
    print(f"  {l}: {n} posisi terbuka")
PY
  return $(( ${#PROCS[@]} - live ))
}

start(){
  if running "tsx src/index.ts" || running "tsx src/server.ts"; then
    printf "${Y}Bot sudah jalan.${N} Pakai ./bot.sh status untuk melihat, atau ./bot.sh stop dulu.\n"
    status; return 1
  fi
  echo "Menyalakan bot…"
  info "cohort: $(grep -E '^export ENTRY_MC_FLOOR_SOL' run-sniper-supervised.sh | cut -d= -f2)–$(grep -E '^export ENTRY_MC_CEIL_SOL' run-sniper-supervised.sh | cut -d= -f2) ◎ · ukuran $(grep -E '^export PAPER_TRADE_SIZE_SOL' run-sniper-supervised.sh | cut -d= -f2) SOL"
  nohup ./run-sniper-supervised.sh    > logs/sniper-supervisor.out    2>&1 &
  nohup ./run-research-supervised.sh  > logs/research-supervisor.out  2>&1 &
  nohup ./run-dashboard-supervised.sh > logs/dashboard-supervisor.out 2>&1 &
  info "menunggu mesin naik (30 detik)…"; sleep 30
  # Watchdog TERAKHIR — lihat catatan di kepala berkas.
  info "menyalakan watchdog…"
  nohup ./run-watchdog-supervised.sh  > logs/watchdog-supervisor.out  2>&1 &
  # Probe KOL: pengamat murni, nol modal, di luar codeFingerprint — ikut hidup/mati bersama bot.
  nohup ./run-kol-copy-supervised.sh  > /dev/null                     2>&1 &
  nohup ./run-kol-leaderboard-supervised.sh > /dev/null               2>&1 &
  nohup ./run-entry-shadow-supervised.sh    > /dev/null               2>&1 &
  sleep 12
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
  for s in sniper research dashboard bxswaps; do pkill -f "run-$s-supervised" 2>/dev/null; done
  pkill -f "tsx src/index.ts" 2>/dev/null
  pkill -f "strategy2-scout" 2>/dev/null; pkill -f "strategy2-papertrader" 2>/dev/null
  pkill -f "strategy2-outcome" 2>/dev/null; pkill -f "gmgn" 2>/dev/null
  pkill -f "bx-swaps" 2>/dev/null; pkill -f "tsx src/server.ts" 2>/dev/null
  sleep 6
  local left; left=$(ps aux | grep -E "tsx src/|strategy2-|watchdog.mjs|kol-edge-probe|kol-copy-probe|kol-leaderboard-refresh|entry-shadow-probe|run-.*-supervised" | grep -v grep | wc -l | tr -d ' ')
  if [ "$left" = "0" ]; then ok "semua proses berhenti"; else bad "$left proses masih hidup"; fi
  lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1 && bad "port 4317 masih dipakai" || ok "port 4317 kosong"
  # Data aman? state harus JSON utuh, dan baris log terakhir tidak boleh terpotong.
  python3 - <<'PY'
import json,os,glob,datetime
bad=0
for p in ('logs/positions.json','logs/strategy2-paper-state.json'):
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
