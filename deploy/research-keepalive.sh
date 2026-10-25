#!/usr/bin/env bash
# RESEARCH KEEPALIVE (disiapkan FINAL, TIDAK dijalankan otomatis — keputusan operator).
# Mencegah MAC SLEEP selama sesi riset (akar outage 29,86 jam: Maintenance Sleep, bukan crash).
# Pemakaian: ./deploy/research-keepalive.sh            → tahan sleep selama terminal terbuka
#            ./deploy/research-keepalive.sh &          → latar belakang; matikan dengan `pkill caffeinate`
# caffeinate = asersi per-proses: TIDAK mengubah pengaturan sistem; matikan = hilang pengaruhnya.
# Untuk 24/7 sejati: opsi VPS (deploy/micincloud-bot.service) — keputusan operator terpisah.
set -u
echo "[keepalive] caffeinate -ism dimulai (pid $$) — Mac tidak akan tidur selama ini berjalan."
echo "[keepalive] hentikan: pkill caffeinate (asetril hilang otomatis bila proses mati)."
exec caffeinate -ism
