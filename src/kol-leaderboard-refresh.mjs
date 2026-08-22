/**
 * PENYEGAR LEADERBOARD pump.fun — menjaga config/kol-watchlist.json tetap mutakhir.
 *
 * Endpoint (ditemukan dengan membongkar bundel JS pump.fun, 2026-08-11):
 *   GET https://frontend-api-v3.pump.fun/pnl-leaderboard
 *       ?period=daily|weekly|monthly &sort=realized|unrealized|combined &limit=N
 *   periodLabel "24h" = jendela BERGULIR, di-refresh ~5 menit. Bukan reset per jam.
 *   Butuh cookie sesi login. Tanpa itu: 401 Unauthorized.
 *
 * Cookie diambil dari .env (PUMPFUN_COOKIE) — .env sudah gitignored. Nilainya TIDAK PERNAH
 * dicetak ke log; yang dilaporkan hanya panjang dan 4 karakter terakhir.
 *
 * Selain menulis watchlist, tiap tarikan disimpan utuh ke logs/kol-leaderboard-*.jsonl.
 * Itu bukan arsip iseng: riwayat peringkat adalah satu-satunya cara menguji hipotesis
 * "inti stabil lawan bintang sesaat" — apakah nama yang bertahan lintas jam berbeda
 * hasilnya dari nama yang melejit sekali lalu hilang.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const URL_BASE = "https://frontend-api-v3.pump.fun/pnl-leaderboard";
const PERIOD = process.env.KOL_LB_PERIOD ?? "daily";
const LIMIT  = Number(process.env.KOL_LB_LIMIT ?? 50);
const EVERY_MS = Number(process.env.KOL_LB_EVERY_MS ?? 30 * 60_000);

const env = Object.fromEntries(readFileSync(".env","utf8").split("\n")
  .filter(l => l.includes("=") && !l.startsWith("#"))
  .map(l => [l.slice(0,l.indexOf("=")).trim(), l.slice(l.indexOf("=")+1).trim()]));
const COOKIE = env.PUMPFUN_COOKIE ?? "";

const say = m => console.log(`[kol-lb] ${new Date().toISOString()} ${m}`);
const mask = c => c ? `${c.length} char, …${c.slice(-4)}` : "(kosong)";

async function refresh() {
  if (!COOKIE) { say("PUMPFUN_COOKIE belum diisi di .env — watchlist dibiarkan apa adanya"); return; }
  const url = `${URL_BASE}?period=${PERIOD}&limit=${LIMIT}`;
  let res;
  try {
    res = await fetch(url, { headers: {
      cookie: COOKIE, accept: "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      origin: "https://pump.fun", referer: "https://pump.fun/",
    }});
  } catch (e) { say(`gagal menghubungi: ${e.message}`); return; }

  if (res.status === 401) {
    // Kegagalan yang PALING mungkin terjadi dan paling mudah salah didiagnosis nanti.
    say(`401 — cookie sesi kedaluwarsa atau salah (${mask(COOKIE)}). Watchlist LAMA tetap dipakai.`);
    say(`      perbarui PUMPFUN_COOKIE di .env, lalu proses ini akan pulih sendiri.`);
    return;
  }
  if (!res.ok) { say(`HTTP ${res.status} — watchlist lama tetap dipakai`); return; }

  const j = await res.json();
  const rows = j?.entries ?? [];
  if (!rows.length) { say("balasan kosong — watchlist lama tetap dipakai"); return; }

  mkdirSync("logs", { recursive: true });
  appendFileSync(join("logs", `kol-leaderboard-${new Date().toISOString().slice(0,10)}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), period: PERIOD, periodLabel: j.periodLabel,
      windowStartSec: j.windowStartSec,
      entries: rows.map(e => ({ rank: e.rank, username: e.username, wallet: e.walletAddress,
        pnlUsd: e.pnlUsd, pnlPercent: e.pnlPercent, buySpendSol: e.buySpendSol,
        realizedPnlUsd: e.realizedPnlUsd, unrealizedPnlUsd: e.unrealizedPnlUsd })) }) + "\n");

  let prev = [];
  try { prev = JSON.parse(readFileSync("config/kol-watchlist.json","utf8")).entries ?? []; } catch {}
  const prevSet = new Set(prev.map(e => e.wallet));

  writeFileSync("config/kol-watchlist.json", JSON.stringify({
    _source: `${URL_BASE}?period=${PERIOD}&limit=${LIMIT}`,
    _periodLabel: j.periodLabel, _windowStartSec: j.windowStartSec,
    _refreshedAt: new Date().toISOString(),
    entries: rows.map(e => ({ rank: e.rank, username: e.username, wallet: e.walletAddress,
      pnlUsd: +(e.pnlUsd ?? 0).toFixed(2), pnlPercent: +(e.pnlPercent ?? 0).toFixed(2),
      buySpendSol: +(e.buySpendSol ?? 0).toFixed(2) })),
  }, null, 1) + "\n");

  const fresh = rows.filter(e => !prevSet.has(e.walletAddress)).length;
  say(`${rows.length} wallet · ${fresh} nama baru · ${rows.length - fresh} bertahan · puncak ${rows[0]?.username}`);
}

say(`mulai · period=${PERIOD} limit=${LIMIT} tiap ${EVERY_MS/60000} menit · cookie ${mask(COOKIE)}`);
void refresh();
setInterval(() => void refresh(), EVERY_MS);
