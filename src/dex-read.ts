/**
 * DEX READ — cara membaca SELURUH permukaan DexScreener (13 endpoint REST + 6 stream WebSocket),
 * dari dokumentasi resmi https://docs.dexscreener.com/api/reference (dibaca 2026-10-08).
 *
 *   npm run dex:read -- --guide                          → cheatsheet lengkap
 *   npm run dex:read -- --token <chain> <mint>           → baca satu token: semua pool + orders + boost
 *   npm run dex:read -- --meta <slug>                    → baca satu meta (narasi) + pair-nya
 *
 * Tanpa API key. Dua bucket: endpoint meta/profil (60 rpm) dan endpoint dex (300 rpm).
 */
import "dotenv/config";
import { TokenBucket } from "./util/http.js";

const BASE = "https://api.dexscreener.com";
const metaBucket = TokenBucket.perMinute(55);
const dexBucket = TokenBucket.perMinute(250);

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const GUIDE = argv.includes("--guide");

const usd = (v: number | null | undefined): string => v == null || !Number.isFinite(v) ? "—" : `$${Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(2)}`;
const pct = (v: number | null | undefined): string => v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

async function get<T>(path: string, bucket: TokenBucket): Promise<T | null> {
  await bucket.take();
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

function guide(): void {
  console.log(`═══ CARA BACA DEXSCREENER (13 endpoint REST + 6 stream WS, docs resmi 2026-10-08) ═══

── ENDPOINT "META/PROMOSI" (60 req/menit) ──────────────────────
1. token-profiles/latest/v1        : profil token terbaru yang MENDAFTAR — sinyal "ada yang mengurus" (ikon/deskripsi/link sosial). Terbaru ≠ terbaik.
2. token-profiles/recent-updates/v1: profil yang BARU DIPERBARUI — tim/komunitas sedang aktif menggarap. Perubahan mendadak = ada yang bergerak.
3. community-takeovers/latest/v1   : CTO resmi — tim lama pergi, komunitas mengambil alih (dengan claimDate). Lifecycle event; netral-positif, cek konteks.
4. ads/latest/v1                   : IKLAN berbayar (impressions, durationHours). Yang membeli impression sedang belanja promosi — sinyal marketing, bukan kualitas.
5. token-boosts/latest/v1          : boost aktif TERBARU (amount = yang baru dibayar, totalAmount = total terbayar per token).
6. token-boosts/top/v1             : boost PALING AKTIF — siapa yang paling banyak membayar promosi saat ini.
7. orders/v1/{chain}/{token}       : STATUS pesanan berbayar token (tokenProfile/communityTakeover/tokenAd/trendingBarAd × processing/approved/rejected/…). "approved" = memang membayar; "rejected" = ditolak (mis. gagal syarat). Ini bukti PEMBAYARAN, bukan kualitas.
8. metas/trending/v1               : tren NARASI (meta) — marketCap/liquidity/volume/tokenCount per meta + perubahan m5..h24. Untuk tahu "cerita" apa yang sedang diuangkan pasar.
9. metas/meta/v1/{slug}            : detail satu meta + pair di dalamnya.

── ENDPOINT "DEX/DATA" (300 req/menit) ────────────────────────
10. latest/dex/pairs/{chain}/{pairId} : satu/banyak pair per alamat PAIR (bukan token).
11. latest/dex/search?q=              : cari pair (nama/simbol/alamat). Paling berguna utk orientasi cepat.
12. token-pairs/v1/{chain}/{token}    : SEMUA pool sebuah token — pool mana yang dalam, quote apa (SOL/USDC/…), boost aktif.
13. tokens/v1/{chain}/{≤30 alamat}    : BATCH sampai 30 token sekaligus — cara paling hemat memantau watchlist.

── STREAM WEBSOCKET (6) — DIUKUR: TERBUKA & GRATIS (2026-10-08), sekarang DIPAKAI ──
wss://api.dexscreener.com/token-profiles/latest/v1 · /token-profiles/recent-updates/v1 ·
/community-takeovers/latest/v1 · /ads/latest/v1 · /token-boosts/latest/v1 · /token-boosts/top/v1
Format: {limit, data:[...]} · push, bukan polling. Uji langsung dari mesin ini: keenam stream
menerima koneksi HTTP 101 TANPA kunci/akun dan mengirim data dalam <10 detik (68KB/95KB/37KB/13KB/71KB/71KB).
Harga WS TIDAK dipublikasikan di docs; API Terms hanya menyebut ada versi gratis & berbayar dengan
limit "dilihat saat checkout". Status biaya: tidak dipublikasikan — kenyataan uji: gratis.
Kolektor (npm run dex:full) memakai keenamnya sebagai lapisan realtime (DEX_FULL_WS=false utk mematikan).

── FIELD PAIR (yang dipakai) ──────────────────────────────────
priceUsd/priceNative · txns.{m5..h24}.{buys,sells} · volume.{m5..h24} (USD) · priceChange.{m5..h24} (%)
liquidity.usd (INI yang menentukan bisa-keluar-tidak) · fdv vs marketCap (fdv pakai supply penuh — jangan tertukar)
pairCreatedAt (umur pool) · labels (mis. "v3", "v4") · info.socials/websites · boosts.active
CATATAN PENTING: priceUsd/marketCap selalu milik baseToken — token quote jangan dibaca dari field ini.

── CARA MEMBACANYA (7 aturan kerja) ───────────────────────────
a. Semua sinyal promosi (profil/boost/ads/orders) = UPAYA, bukan hasil. Cross-check ke data pool (liquidity, txns) sebelum percaya.
b. liquidity.usd adalah angka pertama yang dilihat; < $15k = slippage & exit risk tinggi (terukur di lane RH: 69% mati).
c. fdv ≫ marketCap = banyak supply belum beredar (risiko unlock).
d. txns buys/sells per jendela = arah tekanan; rasio >0.7 di token BARU bukan bullish — itu fase belum ada penjual (dan 65% mati di data kami).
e. pairCreatedAt: < 15 menit = jendela fat-tail, tapi 67% mati; ≥1 jam = 6–11% mati, tapi jarang moonshot.
f. Meta trending = rotasi narasi; token dari meta yang sedang naik volume dapat aliran; ini konteks, bukan alasan entry.
g. Batch /tokens/v1 = cara memantau banyak token tanpa membakar kuota (30/call, 300 rpm).

── ETIKET KUOTA ───────────────────────────────────────────────
meta/profil/orders/metas: 60 rpm · dex (pairs/search/token-pairs/tokens): 300 rpm.
Kolektor kita: \`npm run dex:full\` — dua bucket terpisah (55 & 250 rpm), siklus 5 menit, semua 13 endpoint disapu, dedupe "pernah dilihat", snapshot pertama masuk event.`);
}

interface Pair {
  chainId?: string; dexId?: string; pairAddress?: string; url?: string; labels?: string[] | null;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string | null; txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>; priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number } | null;
  fdv?: number | null; marketCap?: number | null; pairCreatedAt?: number | null;
  info?: { imageUrl?: string; websites?: Array<{ url?: string }>; socials?: Array<{ platform?: string; handle?: string }> };
  boosts?: { active?: number };
}

async function readToken(chain: string, mint: string): Promise<void> {
  console.log(`═══ BACA TOKEN ${chain} ${mint} ═══\n`);
  const pairs = (await get<Pair[]>(`/token-pairs/v1/${chain}/${mint}`, dexBucket)) ?? [];
  if (!pairs.length) { console.log("  tidak ada pool terindeks."); return; }
  const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const totalLiq = sorted.reduce((a, p) => a + (p.liquidity?.usd ?? 0), 0);
  const vol24 = sorted.reduce((a, p) => a + (p.volume?.h24 ?? 0), 0);
  const buys = sorted.reduce((a, p) => a + (p.txns?.h24?.buys ?? 0), 0);
  const sells = sorted.reduce((a, p) => a + (p.txns?.h24?.sells ?? 0), 0);
  const main = sorted[0];
  console.log(`  ${main?.baseToken?.symbol ?? "?"} · ${sorted.length} pool · liq total ${usd(totalLiq)} · vol24 ${usd(vol24)} · txns24 ${buys}B/${sells}S (rasio ${buys + sells ? (buys / (buys + sells)).toFixed(2) : "?"})`);
  if (main) console.log(`  harga ${main.priceUsd ? `$${Number(main.priceUsd).toPrecision(4)}` : "—"} · mc ${usd(main.marketCap)} · fdv ${usd(main.fdv)}${main.fdv && main.marketCap && main.fdv > main.marketCap * 1.5 ? "  ⚠️ fdv≫mc (supply belum beredar)" : ""} · pool tertua ${main.pairCreatedAt ? new Date(main.pairCreatedAt).toISOString().slice(0, 16) : "?"}`);
  console.log("\n  Pool (urut likuiditas):");
  for (const p of sorted.slice(0, 8)) {
    const ch = p.priceChange?.h24;
    console.log(`   ${String(p.dexId).padEnd(12)} ${String(p.quoteToken?.symbol ?? "?").padEnd(6)} liq ${usd(p.liquidity?.usd).padStart(9)} vol24 ${usd(p.volume?.h24).padStart(9)} h24 ${pct(ch).padStart(7)}${p.boosts?.active ? ` · BOOST ${p.boosts.active}` : ""} ${p.pairAddress ? `(${short(p.pairAddress)})` : ""}`);
  }
  const socials = main?.info?.socials ?? [];
  if (socials.length) console.log(`\n  Sosial: ${socials.map((s) => `${s.platform}:${s.handle}`).join(" ")}`);
  const orders = (await get<Array<Record<string, unknown>>>(`/orders/v1/${chain}/${mint}`, metaBucket)) ?? [];
  console.log(`\n  Orders berbayar: ${orders.length ? orders.map((o) => `${o.type}=${o.status}`).join(" ") : "tidak ada"}`);
  console.log(`\n  BACA CEPAT: liq ${usd(totalLiq)} ${(totalLiq) < 15_000 ? "🔴 <$15k — exit risk tinggi (69% mati di data RH)" : totalLiq < 40_000 ? "🟡 $15–40k" : "🟢 ≥$40k"}`);
}

async function readMeta(slug: string): Promise<void> {
  const d = await get<Record<string, unknown>>(`/metas/meta/v1/${encodeURIComponent(slug)}`, metaBucket);
  console.log(`═══ BACA META ${slug} ═══\n`);
  if (!d) { console.log("  tidak ditemukan."); return; }
  console.log(`  ${d.name} — ${d.description ?? ""}`);
  console.log(`  mc ${usd(Number(d.marketCap ?? 0))} · liq ${usd(Number(d.liquidity ?? 0))} · vol ${usd(Number(d.volume ?? 0))} · token ${d.tokenCount}`);
  const ch = d.marketCapChange as Record<string, number> | undefined;
  if (ch) console.log(`  perubahan mc: m5 ${pct(ch.m5)} h1 ${pct(ch.h1)} h6 ${pct(ch.h6)} h24 ${pct(ch.h24)}`);
  const pairs = (d.pairs as Pair[] | undefined) ?? [];
  console.log(`\n  ${pairs.length} pair di meta ini; teratas by liq:`);
  for (const p of [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, 8)) {
    console.log(`   ${String(p.baseToken?.symbol ?? "?").padEnd(12)} ${String(p.chainId).padEnd(10)} liq ${usd(p.liquidity?.usd).padStart(9)} vol24 ${usd(p.volume?.h24).padStart(9)} h24 ${pct(p.priceChange?.h24)}`);
  }
}

async function main(): Promise<void> {
  if (GUIDE) return guide();
  const token = flag("--token");
  if (token) {
    const chain = flag("--chain") ?? "solana";
    return readToken(chain, token);
  }
  const meta = flag("--meta");
  if (meta) return readMeta(meta);
  guide();
}

void main();
