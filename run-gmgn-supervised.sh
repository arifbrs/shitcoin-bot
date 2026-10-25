#!/bin/bash
# GMGN LANE — proxy + watch + prospective outcomes + offline report. Read-only, zero capital.
#
# Dipisah dari run-research-supervised.sh (2026-10-07, keputusan owner: "fokus penuh ke
# Robinhood + GMGN", seluruh lane Solana dimatikan). Proses scout/outcome/paper Solana TIDAK
# dijalankan lagi; GMGN tetap hidup karena sinyal + kualitas wallet-nya jadi bahan riset lane
# Robinhood. Tracker baru hanya mengukur sinyal; TIDAK menjalankan scout/paper/trading Solana.
set -u
cd "$(dirname "$0")" || exit 1

# Observation lane cannot inherit signed swap capability from the trader's .env.
export GMGN_READ_ONLY=true

# Scoped supervisor; duplicate launches are refused. Stop with TERM to this supervisor PID.
mkdir -p logs/gmgn-observations
lock=logs/gmgn-observations/supervisor.lock
if ! ( set -C; printf '%s\n' "$$" > "$lock" ) 2>/dev/null; then
  owner=$(cat "$lock")
  case "$owner" in ''|*[!0-9]*) echo "[gmgn-supervisor] invalid lock owner; preserved"; exit 1;; esac
  if kill -0 "$owner" 2>/dev/null; then echo "[gmgn-supervisor] already running (pid $owner)"; exit 1; fi
  rm "$lock"
  ( set -C; printf '%s\n' "$$" > "$lock" ) 2>/dev/null || exit 1
fi

cleanup() {
  trap - EXIT INT TERM
  # Only descendants created by this supervisor, never broad process-name matches.
  stop_tree() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null); do stop_tree "$child"; done
    kill -TERM "$pid" 2>/dev/null || true
  }
  local child
  for child in $(jobs -pr); do stop_tree "$child"; done
  wait 2>/dev/null || true
  if [ "$(cat "$lock" 2>/dev/null)" = "$$" ]; then rm "$lock"; fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

supervise() {
  local name="$1"; shift
  while true; do
    "$@"
    echo "[gmgn-supervisor] $name exited (code $?) — restarting in 30s..."
    sleep 30
  done
}

supervise "gmgn-proxy" npm run gmgn:proxy &
sleep 3
supervise "gmgn-full-watch" npm run gmgn:full-watch &
supervise "gmgn-outcomes" npm run gmgn:outcomes &
supervise "gmgn-report" npm run gmgn:report -- --loop &
wait
