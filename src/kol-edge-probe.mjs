/**
 * KOL EDGE PROBE — apakah wallet yang diikuti benar-benar punya edge, dan berapa lama ia bertahan.
 *
 * Pertanyaan yang dijawab: kalau seorang KOL membeli koin, berapa imbal hasil ke depan pada 10
 * detik, 30 detik, 2 menit, 10 menit? Itu yang menentukan apakah berlangganan feed sub-detik
 * (pumpportal berbayar / Geyser) masuk akal sama sekali:
 *   - edge bertahan >60s  → feed gratis sudah cukup, tidak perlu bayar
 *   - edge habis dalam 5s → berlangganan pun percuma, eksekusi kita tidak akan menyamai mereka
 *
 * KENAPA DIBANGUN TERPISAH, bukan memakai data yang sudah ada:
 * `gmgn-kol-watch` hanya mencatat trade pada mint yang SUDAH kita pegang atau lacak. Diukur pada
 * data itu, sinyalnya tampak +43,5 poin dengan t=+7,67 — lalu uji arah waktu menunjukkan
 * 222 dari 222 pembelian terjadi SESUDAH entry kita, median 73 detik. Murni kausalitas terbalik:
 * smart money muncul di koin yang sudah naik. Probe ini mencatat SETIAP pembelian mereka, tanpa
 * menyaring pada posisi kita, sehingga arah waktunya benar sejak awal.
 *
 * Nol modal, nol keputusan trading, di luar codeFingerprint → tidak mereset cohort.
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = process.env.LOG_DIR ?? "logs";
const PROXY = `http://127.0.0.1:${process.env.GMGN_PROXY_PORT ?? 4319}/call`;
// 3 menit, MENYAMAI gmgn-kol-watch — bukan angka selera. Pada 60 detik probe ini ikut memicu
// ban IP GMGN (RATE_LIMIT_BANNED, 2026-08-11), dan feed yang sama dipakai bot untuk keputusan
// trading. Pengamat tidak boleh memakan jatah pengambil keputusan.
const POLL_MS = Number(process.env.KOL_POLL_MS ?? 180_000);
// Horizon diukur dari WAKTU KITA MELIHAT trade, bukan dari waktu trade di chain — karena itulah
// yang bisa kita tiru. Lag feed sudah menjadi bagian dari jawabannya, bukan disembunyikan.
const HORIZONS = [10, 30, 120, 600];
const MAX_TRACK = 400;

const out = (name, row) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${name}-${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch { /* best effort */ }
};
const say = (m) => { console.log(`[kol-edge] ${new Date().toISOString()} ${m}`); };

async function gmgn(method, args) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(PROXY, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, args }), signal: ctl.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.data ?? j?.result ?? j ?? null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** Market cap dari pump.fun — mencakup koin yang MASIH di bonding curve (DexScreener tidak). */
async function mcOf(mint) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`,
      { headers: { accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.usd_market_cap === "number" ? j.usd_market_cap : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

const tracking = new Map();   // key -> { mint, maker, tags, seenAt, mc0, done:Set }
const seenTx = new Set();

async function pollFeed() {
  // Nama metode dan bentuk baris DIVERIFIKASI dari src/discovery/gmgn.ts, bukan ditebak:
  // proxy mengembalikan { list: [...] }, dan tiap baris memakai token_address / side /
  // amount_usd / maker_info.tags (bukan mint/maker/tags seperti dugaan pertama saya).
  const feeds = await Promise.all([gmgn("getKol", ["sol", 50]), gmgn("getSmartMoney", ["sol", 50])]);
  let added = 0;
  for (const [i, rows] of feeds.entries()) {
    const watchType = i === 0 ? "kol" : "smartmoney";
    const list = Array.isArray(rows?.list) ? rows.list : (Array.isArray(rows) ? rows : []);
    for (const r of list) {
      // Nama field DIVERIFIKASI dari respons proxy sungguhan (2026-08-11), bukan dari dokumentasi:
      // mint ada di `base_address` (BUKAN token_address), tx di `transaction_hash`,
      // dan `timestamp` dalam DETIK epoch.
      const mint = r?.base_address;
      const side = (r?.side ?? "").toString().toLowerCase();
      const tx = r?.transaction_hash ?? `${mint}:${r?.timestamp}`;
      // SELL ikut dicatat. Versi pertama menyaringnya keluar, dan itu membuat hipotesis
      // "keluar saat KOL keluar" mustahil diuji — yang dibutuhkan adalah imbal hasil dari
      // beli-KOL sampai jual-KOL, bukan sampai jam dinding yang kita tentukan sendiri.
      if (!mint || !side || seenTx.has(tx)) continue;
      seenTx.add(tx);
      if (seenTx.size > 5000) seenTx.clear();
      const mc0 = await mcOf(mint);
      if (mc0 == null) continue;            // bukan koin pump.fun / tidak bisa dihargai → lewati
      // Jejak mentah tiap trade (dua sisi) supaya pasangan beli→jual per (wallet,mint)
      // bisa direkonstruksi belakangan.
      out("kol-trade", { mint, symbol: r?.base_token?.symbol ?? null, maker: r?.maker ?? null,
        side, watchType, tags: r?.maker_info?.tags ?? null, amountUsd: r?.amount_usd ?? null,
        priceUsd: r?.price_usd ?? null, tradeTs: r?.timestamp ?? null, mcNow: mc0, tx });
      if (!side.includes("buy")) continue;  // horizon tetap hanya diukur dari sisi beli
      const key = `${tx}`;
      tracking.set(key, { mint, maker: r?.maker ?? null, watchType,
        symbol: r?.base_token?.symbol ?? null,
        tags: r?.maker_info?.tags ?? null, amountUsd: r?.amount_usd ?? null,
        priceUsd0: r?.price_usd ?? null, tradeTs: r?.timestamp ?? null,
        seenAt: Date.now(), mc0, done: new Set() });
      added++;
      if (tracking.size > MAX_TRACK) tracking.delete(tracking.keys().next().value);
    }
  }
  if (added) say(`+${added} pembelian dilacak · total ${tracking.size}`);
}

async function sampleHorizons() {
  const now = Date.now();
  for (const [key, t] of [...tracking]) {
    for (const h of HORIZONS) {
      if (t.done.has(h)) continue;
      const age = (now - t.seenAt) / 1000;
      if (age < h) continue;
      if (age > h * 3) { t.done.add(h); continue; }   // terlalu telat → jangan catat sampel palsu
      const mc = await mcOf(t.mint);
      t.done.add(h);
      if (mc == null) continue;
      out("kol-edge", { mint: t.mint, symbol: t.symbol, maker: t.maker, watchType: t.watchType, tags: t.tags,
        amountUsd: t.amountUsd, tradeTs: t.tradeTs,
        // Lag feed dicatat eksplisit: horizon diukur dari saat KITA melihat, jadi seberapa telat
        // kita melihatnya adalah bagian dari jawaban, bukan sesuatu yang disembunyikan.
        feedLagSec: t.tradeTs ? Math.round(t.seenAt / 1000 - t.tradeTs) : null,
        horizonSec: h, mc0: t.mc0, mc, retPct: (mc / t.mc0 - 1) * 100 });
    }
    if (t.done.size === HORIZONS.length) tracking.delete(key);
  }
}

if (!existsSync(LOG_DIR)) { say(`log dir ${LOG_DIR} tidak ada`); process.exit(1); }
say(`mulai · poll ${POLL_MS / 1000}s · horizon ${HORIZONS.join("/")}s · read-only, nol modal`);
void pollFeed();
setInterval(() => void pollFeed(), POLL_MS);
setInterval(() => void sampleHorizons(), 5_000);
