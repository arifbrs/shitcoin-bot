# Deploying Micincloud for 24/7

The bot is a long-running process, not a request handler. What makes it survive unattended is not
clever code — it is a supervisor that restarts it, a watchdog that notices when it is alive but
blind, retention that stops the disk filling, and an alert channel so you find out from your phone
instead of from a flat equity curve three days later.

This directory holds the pieces. The existing systemd instructions below target Ubuntu/Debian;
the current development Mac uses the LaunchAgents documented next.

## macOS paper services (manual start on current workstation)

The two checked-in plists run only the strict unsigned OKX paper engine and its local dashboard.
They deliberately stay inside the repository instead of `~/Library/LaunchAgents`, so logging in or
restarting the Mac does **not** start either job automatically.

Start them only when requested:

```bash
launchctl bootstrap "gui/$(id -u)" "$PWD/deploy/com.micincloud.okx-paper.plist"
launchctl bootstrap "gui/$(id -u)" "$PWD/deploy/com.micincloud.dashboard.plist"
```

Once manually loaded, both jobs use `KeepAlive`, so closing Terminal or a process crash does not end
the paper run. A logout, reboot, or explicit `bootout` unloads them and they remain off until the next
manual start. They do not make a sleeping or powered-off Mac execute; for uninterrupted samples keep
the Mac plugged in and prevent system sleep. The screen may still be locked or turned off.

Stop them explicitly before shutdown or whenever paper collection should end:

```bash
launchctl bootout "gui/$(id -u)/com.micincloud.okx-paper"
launchctl bootout "gui/$(id -u)/com.micincloud.dashboard"
```

Check them without relying on a Terminal session:

```bash
launchctl print "gui/$(id -u)/com.micincloud.okx-paper"
launchctl print "gui/$(id -u)/com.micincloud.dashboard"
curl -I http://127.0.0.1:4317/
tail -f logs/launchd-okx-paper.out.log
```

The plists contain absolute paths for this checkout. Update those paths if the repository or Node
installation is moved.

---

## 1. What the bot does on its own

| Concern | How it is handled | Where |
|---|---|---|
| Crash | Exits non-zero → systemd restarts | `index.ts` fatal-guard |
| Alive but feed dead | Watchdog exits after 5 min with no launch | `index.ts` watchdog |
| Unhandled rejection | Logged, process survives | `index.ts` fatal-guard |
| Disk fill | Old JSONL deleted (trades 90d, diagnostics 3–7d) | `util/log.ts` |
| Memory growth | Bounded maps + actor-memory pruning | `papertrader.ts`, `memory/actor-memory.ts` |
| Silent data corruption | Ledger reconciled every 60s, alerts on drift | `papertrader.ts` |
| Open positions on restart | Persisted to `logs/positions.json`, restored on boot | `papertrader.ts` |

## 2. Server setup

```bash
sudo adduser --system --group --home /opt/micincloud-bot micincloud
sudo mkdir -p /opt/micincloud-bot && sudo chown -R micincloud:micincloud /opt/micincloud-bot

# Node 20+ (tsx needs it)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Clone and install as the service user:

```bash
sudo -u micincloud git clone <your-repo> /opt/micincloud-bot
cd /opt/micincloud-bot && sudo -u micincloud npm ci
```

## 3. Secrets

`.env` is gitignored and must be created **on the server** — never committed.

```bash
sudo -u micincloud cp .env.example .env
sudo -u micincloud nano .env
sudo chmod 600 /opt/micincloud-bot/.env
```

Required for 24/7:

```ini
DASHBOARD_PASSWORD=<long random string>   # the console can withdraw SOL — treat as a real password
TELEGRAM_BOT_TOKEN=<from @BotFather>      # alerts; without these you will not know it died
TELEGRAM_CHAT_ID=<your chat id>
```

The wallet key lives in `.keys/bot-wallet.key` — also gitignored. Copy it over with `scp`, then
`chmod 600`. If it is not present the bot still runs (dry-run/simulate need no key).

## 4. Services

```bash
sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now micincloud-bot micincloud-web micincloud-okx-paper
```

Check:

```bash
systemctl status micincloud-bot
journalctl -u micincloud-okx-paper -f    # strict OKX paper: no signer/broadcast
journalctl -u micincloud-bot -f          # live log
journalctl -u micincloud-bot | grep -E "integrity|watchdog|fatal-guard"
```

## 5. Reaching the dashboard

The console can flatten positions and withdraw SOL, so it binds to **loopback only** by default,
and it will **refuse to start** on a public interface while the password is still the default.

**Recommended — Cloudflare Tunnel.** No inbound port on the VPS at all, and you can put Cloudflare
Access in front so the dashboard password is a second factor rather than the only one.

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
sudo dpkg -i cf.deb
cloudflared tunnel login
cloudflared tunnel create micincloud
# route bot.<your-domain> → http://127.0.0.1:4317
cloudflared tunnel route dns micincloud bot.<your-domain>
sudo cloudflared service install
```

**Simplest — SSH tunnel.** Nothing exposed, nothing to configure:

```bash
ssh -L 4317:127.0.0.1:4317 user@vps    # then open http://localhost:4317
```

Only set `DASHBOARD_HOST=0.0.0.0` if something else already terminates TLS and authenticates in
front of it. On its own it puts a money-moving console on the open internet.

## 6. Updating

```bash
cd /opt/micincloud-bot
sudo -u micincloud git pull && sudo -u micincloud npm ci
sudo systemctl restart micincloud-bot micincloud-web
```

Open positions survive the restart (`logs/positions.json`). **A code change alters `configHash`,
which is intentional — records self-isolate per strategy version, so analytics never pool two
different strategies.** Do not wipe logs to "clean up"; filter by hash instead.

## 7. What to watch in the first 48 hours

| Check | Healthy |
|---|---|
| `systemctl status micincloud-bot` | `active (running)`, low restart count |
| RSS (`ps -o rss= -C node`) | flat after a few hours — a steady climb is a leak |
| `du -sh logs/` | plateaus once retention kicks in |
| `journalctl -u micincloud-bot \| grep integrity` | empty |
| Telegram | one 🟢 startup, then silence |

Restarts are not automatically bad — a watchdog restart means it *worked*. Restarts every few
minutes mean something is genuinely wrong; read the journal before changing strategy.

## RESEARCH KEEPALIVE — atas temuan round-8 (mesin SLEEP, bukan crash) · 2026-10-24
Outage 29,86 jam = MacBook masuk Maintenance Sleep (pmset, baterai). Dua opsi, KEDUANYA butuh
keputusan operator (mengubah perilaku daya mesin):
1. Sesi riset aktif: `caffeinate -ism ./run-rhpaper-supervised.sh` (atau jalankan
   `caffeinate -ism` di terminal terpisah selama sesi riset — mencegah sleep idle+sistem).
2. 24/7 sejati: pindahkan lane zero-capital ke VPS (`micincloud-bot.service` sudah ada di
   deploy/) atau ubah pengaturan sleep macOS (System Settings →-lock screen/energy).
LaunchAgent KeepAlive (`com.shitcoin.lanes.plist`) hanya menghidupkan ulang PROSES mati —
tidak mencegah sleep; kombinasi keduanya diperlukan untuk coverage penuh.
