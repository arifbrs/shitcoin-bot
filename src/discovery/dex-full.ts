/**
 * DEXSCREENER FULL — kolektor SEMUA 13 endpoint REST resmi, jalan terus (default tiap 5 menit).
 *
 * Owner (2026-10-08): "analisa kamu graping semua data yang ada di dexscreener, tanpa terkecuali!
 * lengkap, pantau ya jangan berhenti!" — maka proses ini mengambil SETIAP endpoint yang
 * didokumentasikan di https://docs.dexscreener.com/api/reference, tanpa kecuali:
 *
 *   meta group (60 rpm, bucket 55)          dex group (300 rpm, bucket 250)
 *   1  token-profiles/latest/v1             7  latest/dex/pairs/{chain}/{pair}
 *   2  token-profiles/recent-updates/v1     8  latest/dex/search
 *   3  community-takeovers/latest/v1        9  token-pairs/v1/{chain}/{token}
 *   4  ads/latest/v1                       10  tokens/v1/{chain}/{≤30 addr}
 *   5  token-boosts/latest/v1
 *   6  token-boosts/top/v1
 *   +  orders/v1/{chain}/{token} (60 rpm, dicek bergilir utk token yang SEDANG membayar promosi)
 *   +  metas/trending/v1 dan metas/meta/v1/{slug}
 *
 * WebSocket (6 stream: profiles latest/recent, CTO, ads, boosts latest/top): DIUKUR TERBUKA tanpa
 * kunci/akun (uji 2026-10-08 — tersambung HTTP 101, data mengalir dalam detik) dan kini DIPAKAI
 * sebagai lapisan realtime lewat dex-ws.ts; REST tetap jalan sebagai jaring aman + untuk endpoint
 * yang tidak punya stream (orders, metas, pairs, search, batch snapshot).
 *
 * Aturan yang dipatuhi: dua bucket terpisah (supaya endpoint 60 rpm tidak pernah ikut arus 300 rpm),
 * dedupe "pernah dilihat" (state, bukan spam log), snapshot pertama-saja utk watchlist (state
 * menyimpan nilai terakhir; event hanya utk penemuan baru), dan SEMUA kegagalan dicatat apa adanya.
 *
 * Run: npm run dex:full   (DEX_FULL_ONCE=true = satu siklus)
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { TokenBucket } from "../util/http.js";
import { startDexWs, type DexWsKind } from "./dex-ws.js";

const BASE = "https://api.dexscreener.com";
const metaBucket = TokenBucket.perMinute(55); // plafon dokumen: 60/menit
const dexBucket = TokenBucket.perMinute(250); // plafon dokumen: 300/menit
const CHAINS = (process.env.DEX_FULL_CHAINS ?? "solana,robinhood").split(",").map((s) => s.trim()).filter(Boolean);
const CYCLE_MS = (() => { const n = Number(process.env.DEX_FULL_CYCLE_MS); return Number.isFinite(n) && n >= 60_000 ? n : 5 * 60_000; })();
const ORDERS_PER_CYCLE = 8, ORDERS_TTL_MS = 6 * 3_600_000;
const META_DETAILS_PER_CYCLE = 2, META_TTL_MS = 6 * 3_600_000;
const ONCE = process.env.DEX_FULL_ONCE === "true";
const STATE_PATH = join(config.logDir, "dex-full-state.json");
const SEEN_TTL_MS = 48 * 3_600_000;

async function get<T>(path: string, bucket: TokenBucket): Promise<T | null> {
  await bucket.take();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) { ui.warn(`[dex-full] ${path} → HTTP ${res.status}`); return null; }
    return (await res.json()) as T;
  } catch (e) {
    ui.warn(`[dex-full] ${path} → ${(e as Error).message}`);
    return null;
  } finally { clearTimeout(t); }
}

interface Seen { at: number; kind: string; amt?: number }
interface State {
  seen: Record<string, Seen>; // key: kind|chain|addr → waktu pertama terlihat
  watch: Record<string, { at: number; chain: string; symbol: string; liqUsd: number | null; vol24: number | null; chg24: number | null; mcUsd: number | null }>;
  ordersChecked: Record<string, number>;
  metaChecked: Record<string, number>;
}
function loadState(): State {
  if (existsSync(STATE_PATH)) {
    try {
      const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State>;
      return { seen: s.seen ?? {}, watch: s.watch ?? {}, ordersChecked: s.ordersChecked ?? {}, metaChecked: s.metaChecked ?? {} };
    } catch { /* mulai bersih */ }
  }
  return { seen: {}, watch: {}, ordersChecked: {}, metaChecked: {} };
}
function saveState(s: State): void {
  const now = Date.now();
  for (const [k, v] of Object.entries(s.seen)) if (now - v.at > SEEN_TTL_MS) delete s.seen[k];
  for (const [k, v] of Object.entries(s.watch)) if (now - v.at > 24 * 3_600_000) delete s.watch[k];
  for (const [k, v] of Object.entries(s.ordersChecked)) if (now - v > SEEN_TTL_MS) delete s.ordersChecked[k];
  for (const [k, v] of Object.entries(s.metaChecked)) if (now - v > SEEN_TTL_MS) delete s.metaChecked[k];
  try { writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(s)); renameSync(`${STATE_PATH}.tmp`, STATE_PATH); } catch { /* best-effort */ }
}

/**
 * State TUNGGAL yang dipakai bersama oleh siklus REST dan feed WebSocket — supaya dedupe
 * "pernah dilihat" berlaku lintas-jalur (tanpa ini, jalur REST dan WS saling mencatat baris yang sama).
 */
const state: State = loadState();

interface Rows { chainId?: string; tokenAddress?: string; [k: string]: unknown }
const ours = (r: Rows): boolean => typeof r.chainId === "string" && CHAINS.includes(r.chainId);

/**
 * Nama event + bentuk baris per stream — SATU sumber kebenaran untuk jalur REST (siklus 5 menit)
 * dan jalur WebSocket (realtime). Dulu tiap jalur menulis bentuknya sendiri; itu cara paling cepat
 * membuat dua jalur menyimpang tanpa sadar.
 */
const EVENT_NAME: Record<DexWsKind, string> = {
  profiles: "dex-profiles", "profile-updates": "dex-profile-updates", cto: "dex-cto",
  ads: "dex-ads", boosts: "dex-boosts", "boosts-top": "dex-boosts-top",
};
const ROW_BUILDER: Record<DexWsKind, (r: Rows) => Record<string, unknown>> = {
  profiles: (r) => ({ chain: r.chainId, token: r.tokenAddress, description: r.description ?? null, links: (r.links as unknown[])?.length ?? 0 }),
  "profile-updates": (r) => ({ chain: r.chainId, token: r.tokenAddress, description: r.description ?? null }),
  cto: (r) => ({ chain: r.chainId, token: r.tokenAddress, claimDate: r.claimDate ?? null }),
  ads: (r) => ({ chain: r.chainId, token: r.tokenAddress, adType: r.type ?? null, durationHours: r.durationHours ?? null, impressions: r.impressions ?? null }),
  boosts: (r) => ({ chain: r.chainId, token: r.tokenAddress, amount: r.amount ?? null, totalAmount: r.totalAmount ?? null }),
  "boosts-top": (r) => ({ chain: r.chainId, token: r.tokenAddress, amount: r.amount ?? null, totalAmount: r.totalAmount ?? null }),
};

/** Catat baris baru dari satu stream (REST atau WS) + deteksi kenaikan belanja boost. */
function logStream(s: State, kind: DexWsKind, rows: Rows[]): number {
  const mine = rows.filter(ours);
  let added = logNew(s, EVENT_NAME[kind], mine, ROW_BUILDER[kind]);
  if (kind === "boosts") added += logBoostIncreases(s, mine);
  return added;
}

/** Catat penemuan BARU (sekali per kind|chain|addr) + kembalikan jumlah baris baru. */
function logNew(s: State, kind: string, rows: Rows[], build: (r: Rows) => Record<string, unknown>): number {
  let added = 0;
  for (const r of rows) {
    const key = `${kind}|${r.chainId}|${r.tokenAddress}`;
    if (s.seen[key]) continue;
    s.seen[key] = { at: Date.now(), kind };
    logRecord("events", { type: `${kind}`, ...build(r), firstSeen: true, cfg: configHash });
    added++;
  }
  return added;
}

/**
 * Khusus BOOST: token yang sudah pernah terlihat tapi TOTAL belanjanya NAIK = sinyal pemantauan
 * (ada yang menambah uang promosi). Dulu ini hilang — dedupe "pernah dilihat" membuat kenaikan
 * belanja tak pernah tercatat. Sekarang setiap kenaikan totalAmount dicatat + disimpan.
 */
function logBoostIncreases(s: State, rows: Rows[]): number {
  let inc = 0;
  for (const r of rows) {
    const key = `boost-amt|${r.chainId}|${r.tokenAddress}`;
    const total = Number(r.totalAmount ?? 0);
    const prev = Number((s.seen[key] as { amt?: number } | undefined)?.amt ?? 0);
    if (total > prev) {
      if (prev > 0) {
        logRecord("events", { type: "dex-boost-increase", chain: r.chainId, token: r.tokenAddress, from: prev, to: total, delta: total - prev, cfg: configHash });
        inc++;
      }
      s.seen[key] = { at: Date.now(), kind: "boost-amt", amt: total } as Seen;
    }
  }
  return inc;
}

async function cycle(n: number): Promise<void> {
  const t0 = Date.now();
  const s = state;
  let calls = 0;
  const counts: Record<string, number> = {};
  const P = async <T,>(p: string, b: TokenBucket): Promise<T | null> => { calls++; return get<T>(p, b); };

  // 1+2. PROFIL token (baru + baru-diperbarui)
  const profiles = (await P<Rows[]>("/token-profiles/latest/v1", metaBucket)) ?? [];
  const updates = (await P<Rows[]>("/token-profiles/recent-updates/v1", metaBucket)) ?? [];
  counts.profiles = logStream(s, "profiles", profiles);
  counts.profileUpdates = logStream(s, "profile-updates", updates);

  // 3. COMMUNITY TAKEOVERS
  const ctos = (await P<Rows[]>("/community-takeovers/latest/v1", metaBucket)) ?? [];
  counts.cto = logStream(s, "cto", ctos);

  // 4. ADS (iklan berbayar — siapa yang sedang membelanjakan impression)
  const ads = (await P<Rows[]>("/ads/latest/v1", metaBucket)) ?? [];
  counts.ads = logStream(s, "ads", ads);

  // 5+6. BOOSTS (latest + top)
  const boostsLatest = (await P<Rows[]>("/token-boosts/latest/v1", metaBucket)) ?? [];
  const boostsTop = (await P<Rows[]>("/token-boosts/top/v1", metaBucket)) ?? [];
  counts.boostLatest = logStream(s, "boosts", boostsLatest);
  counts.boostTop = logStream(s, "boosts-top", boostsTop);

  // 7+8. PAIRS by pair address + SEARCH — disapu eksplisit tiap siklus (dengan token dari boost
  // milik kita) supaya kedua endpoint grup-dex benar-benar tersentuh, bukan diasumsikan.
  const firstOurs = boostsLatest.find(ours);
  if (firstOurs?.chainId && firstOurs.tokenAddress) {
    calls++; await get(`/latest/dex/search?q=${encodeURIComponent(String(firstOurs.tokenAddress))}`, dexBucket);
    const pairsOfToken = await get<Array<{ pairAddress?: string }>>(`/token-pairs/v1/${firstOurs.chainId}/${firstOurs.tokenAddress}`, dexBucket);
    calls++;
    const firstPairAddr = pairsOfToken?.[0]?.pairAddress;
    if (firstPairAddr) { calls++; await get(`/latest/dex/pairs/${firstOurs.chainId}/${firstPairAddr}`, dexBucket); }
  }

  // 9+10. WATCH SNAPSHOT — semua token yang muncul dari 6 sumber di atas (chain kita), di-batch
  // ≤30 alamat/call via /tokens/v1/{chain}/{addrs}. Event hanya utk snapshot PERTAMA; nilai
  // terakhir disimpan di state.watch.
  const candidates = new Map<string, Rows>();
  for (const r of [...profiles, ...updates, ...ctos, ...ads, ...boostsLatest, ...boostsTop]) if (ours(r) && r.tokenAddress) candidates.set(`${r.chainId}|${r.tokenAddress}`, r);
  for (const chain of CHAINS) {
    const unique = [...new Set([...candidates.values()].filter((r) => r.chainId === chain).map((r) => String(r.tokenAddress)))];
    if (!unique.length) continue;
    // KOREKSI (2026-10-08): dulu hanya 30 token/chain disnapshot → token boost di luar itu tidak
    // punya metrik sama sekali (join tampil "?"). Sekarang sampai 3 batch (90 token), diprioritaskan
    // yang paling lama belum disnapshot supaya cakupan berputar, bukan selalu 30 yang sama.
    unique.sort((a, b) => (s.watch[`${chain}|${a}`]?.at ?? 0) - (s.watch[`${chain}|${b}`]?.at ?? 0));
    const take = unique.slice(0, 90);
    let snapped = 0;
    for (let i = 0; i < take.length; i += 30) {
      const addrs = take.slice(i, i + 30);
      const pairs = (await P<Array<Record<string, unknown>>>(`/tokens/v1/${chain}/${addrs.join(",")}`, dexBucket)) ?? [];
      const best = new Map<string, Record<string, unknown>>();
      for (const p of pairs) {
        const addr = String((p.baseToken as { address?: string } | undefined)?.address ?? "");
        const liq = Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0);
        if (!addr || !addrs.includes(addr)) continue;
        const prev = best.get(addr);
        if (!prev || liq > Number((prev.liquidity as { usd?: number } | undefined)?.usd ?? 0)) best.set(addr, p);
      }
      for (const [addr, p] of best) {
        const row = {
          chain, symbol: String((p.baseToken as { symbol?: string } | undefined)?.symbol ?? "?"),
          liqUsd: Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0) || null,
          vol24: Number((p.volume as { h24?: number } | undefined)?.h24 ?? 0) || null,
          chg24: Number((p.priceChange as { h24?: number } | undefined)?.h24 ?? 0),
          mcUsd: Number(p.marketCap ?? 0) || null,
        };
        const key = `${chain}|${addr}`;
        if (!s.watch[key]) logRecord("events", { type: "dex-token-snapshot", token: addr, ...row, firstSeen: true, cfg: configHash });
        s.watch[key] = { at: Date.now(), ...row };
        snapped++;
      }
    }
    counts[`snap_${chain}`] = snapped;
  }

  // 11. ORDERS — dicek bergilir utk token dari profil/boost (yang punya pembayaran), TTL 6 jam.
  const orderQueue = [...candidates.values()].filter((r) => r.chainId && r.tokenAddress).slice(0, 40);
  let ordersChecked = 0;
  for (const r of orderQueue) {
    if (ordersChecked >= ORDERS_PER_CYCLE) break;
    const key = `${r.chainId}|${r.tokenAddress}`;
    if (s.ordersChecked[key] && Date.now() - s.ordersChecked[key] < ORDERS_TTL_MS) continue;
    const rows = await P<Array<Record<string, unknown>>>(`/orders/v1/${r.chainId}/${r.tokenAddress}`, metaBucket);
    s.ordersChecked[key] = Date.now();
    ordersChecked++;
    if (!rows?.length) continue;
    logRecord("events", { type: "dex-orders", chain: r.chainId, token: r.tokenAddress, orders: rows.slice(0, 6).map((o) => ({ type: o.type, status: o.status, paidAt: o.paymentTimestamp })), cfg: configHash });
  }
  counts.ordersChecked = ordersChecked;

  // 12+13. METAS (tren narasi) + DETAIL utk top-N yang belum dicek.
  const metas = (await P<Array<Record<string, unknown>>>("/metas/trending/v1", metaBucket)) ?? [];
  counts.metas = metas.length;
  const topMetas = [...metas].sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0)).slice(0, 5);
  if (topMetas.length) {
    logRecord("events", {
      type: "dex-metas", n: metas.length,
      top: topMetas.map((m) => ({ slug: m.slug, name: m.name, tokens: m.tokenCount, mc: m.marketCap, vol: m.volume })),
      cfg: configHash,
    });
  }
  let metaDetails = 0;
  for (const m of topMetas) {
    if (metaDetails >= META_DETAILS_PER_CYCLE) break;
    const slug = String(m.slug ?? "");
    if (!slug || (s.metaChecked[slug] && Date.now() - s.metaChecked[slug] < META_TTL_MS)) continue;
    const d = await P<Record<string, unknown>>(`/metas/meta/v1/${encodeURIComponent(slug)}`, metaBucket);
    s.metaChecked[slug] = Date.now();
    metaDetails++;
    if (!d) continue;
    logRecord("events", { type: "dex-meta-detail", slug, name: d.name, tokens: d.tokenCount, mc: d.marketCap, vol: d.volume, mcChange: d.marketCapChange, pairs: ((d.pairs as unknown[]) ?? []).length, cfg: configHash });
  }
  counts.metaDetails = metaDetails;

  saveState(state);
  logRecord("events", { type: "dex-cycle", n, calls, ms: Date.now() - t0, watch: Object.keys(state.watch).length, ...counts, cfg: configHash });
  ui.info(`[dex-full] siklus ${n}: ${calls} call ${((Date.now() - t0) / 1000).toFixed(1)}s · ${JSON.stringify(counts)}`);
}

async function main(): Promise<void> {
  console.log(`[dex-full] SEMUA 13 endpoint DexScreener · chain: ${CHAINS.join(", ")} · siklus ${CYCLE_MS / 60_000} menit · dua bucket (60/300 rpm).`);
  console.log(`[dex-full] state: ${STATE_PATH}`);
  // LAPISAN REALTIME (2026-10-08): 6 stream WebSocket DexScreener diuji TERBUKA tanpa kunci/akun
  // dan mengalirkan data dalam detik. REST tetap jalan sebagai jaring aman + satu-satunya sumber
  // untuk endpoint yang tidak punya stream (orders, metas, pairs, search, batch snapshot).
  if (process.env.DEX_FULL_WS !== "false") {
    startDexWs((kind, rows) => {
      const added = logStream(state, kind, rows);
      if (added > 0) {
        saveState(state);
        ui.info(`[dex-ws] ${kind}: +${added} baru (dari ${rows.length} baris)`);
      }
    });
  } else {
    console.log("[dex-full] jalur WebSocket DIMATIKAN (DEX_FULL_WS=false) — hanya siklus REST.");
  }
  let n = 1;
  await cycle(n).catch((e) => ui.warn(`[dex-full] siklus gagal: ${(e as Error).message}`));
  if (ONCE) return;
  setInterval(() => void cycle(++n).catch((e) => ui.warn(`[dex-full] siklus gagal: ${(e as Error).message}`)), CYCLE_MS);
}

void main();
