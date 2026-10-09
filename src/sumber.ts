/**
 * SUMBER — registry SEMUA sumber data repo ini: apa yang terpasang, apa yang wired, apa yang idle.
 *
 * Owner (2026-10-08): "apa lagi jangan sampai aku tau yang kamu belum tau ya!" — alat ini jawabannya:
 * satu tempat yang menyebut SEMUA sumber (yang dipakai maupun yang BELUM disentuh), status kuncinya,
 * dan keadaannya sekarang (hidup/dimatikan/diblokir). Tanpa ini, sumber yang tidak terpakai mudah
 * terlupakan — persis kelas kejutan yang tidak diinginkan.
 *
 * Read-only. `npm run sumber` — cek kunci dari .env (nama saja), portproxy lokal, 3 ping ringan,
 * dan perbandingan DNS untuk blokir ISP. Tidak mengirim kredensial ke mana pun.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promises as dns } from "node:dns";

const ENV = (() => {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1] as string] = (m[2] ?? "").trim();
    }
    return out;
  } catch { return {}; }
})();
const has = (k: string): boolean => Boolean(ENV[k] && ENV[k] !== "");

interface Source {
  name: string;
  gives: string;
  keys: string[];
  wired: string;
  status: string;
  unused?: string;
}

const SOURCES: Source[] = [
  { name: "GMGN OpenAPI", gives: "trenches, trending, signal t1-21, token info/security/holders/trader, KOL/smartmoney, wallet stats, kline, swap", keys: ["GMGN_API_KEY", "GMGN_PRIVATE_KEY"], wired: "proxy + full-watch + report + study + read (rh + sol)", status: "AKTIF (kuota ketat, pace 10s)", unused: "follow-wallet/follow-tokens/follow-groups, cooking-stats, user-info, gas-price (beberapa butuh signed auth)" },
  { name: "DexScreener REST", gives: "13 endpoint: profiles, cto, ads, boosts, orders, pairs, search, token-pairs, batch tokens, metas", keys: [], wired: "dex-full (siklus 5m) + dex-read + RH lane (markets/marks)", status: "AKTIF (dua bucket 55/250 rpm)", unused: "TIDAK ADA data LILIN/OHLCV — docs resminya berhenti di harga & volume agregat (halaman TradingView hanya soal library chart, bukan feed). Bar diambil dari GeckoTerminal/GMGN kline." },
  { name: "DexScreener WebSocket", gives: "6 stream realtime: profiles, profiles-updated, CTO, ads, boosts, boosts-top (push, bukan polling)", keys: [], wired: "dex-full lapisan realtime (dex-ws.ts) — DEX_FULL_WS=false utk mematikan", status: "AKTIF & GRATIS (diukur 2026-10-08: 6/6 tersambung HTTP 101 tanpa kunci, data <10s). Harga TIDAK dipublikasikan di docs; kenyataan uji: tidak berbayar", unused: "—" },
  { name: "GeckoTerminal", gives: "pool robinhood: top/new/trending, OHLCV (backtest + alat `npm run chart`), tokens/multi (mark batch), pool marks", keys: [], wired: "RH lane (discovery, mark, backtest) + chart lintas-chain (solana/robinhood)", status: "AKTIF — SATU-SATUNYA sumber lilin gratis tanpa kunci; diuji 2026-10-08: minute/5 → 120 lilin HTTP 200", unused: "limit per-IP KETAT (beberapa call cepat → 429, dibagi dengan lane RH) → chart dipakai on-demand, bukan polling" },
  { name: "Robinhood Chain RPC", gives: "eth_call/getLogs: ERC-20 transfers, supply, chain info", keys: ["ROBINHOOD_RPC_URL"], wired: "robinhood/intelligence (radar token)", status: "AKTIF" },
  { name: "OKX OnchainOS", gives: "74 endpoint: token/trenches/signal/leaderboard/portfolio/balance/dex/social (cluster, dev rug-count, aped wallet, bundle, news, sentiment)", keys: ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_API_PASSPHRASE", "OKX_PROJECT_ID"], wired: "okx-lane (observatory 60s/300s/900s/2700s + radar wallet + scout) + strict-paper", status: "AKTIF — blokir DNS ISP HILANG 2026-10-08; uji live 55/56 endpoint menjawab", unused: "WS 9 kanal (OKX_WS_ENABLED=false — butuh entitlement), OKX_TRACKED_WALLETS kosong, endpoint swap/tx belum diuji sampai broadcast" },
  { name: "Solana Tracker", gives: "/tokens/{mint}: meta+pools(liq/price/lpBurn/security)+RISK(snipers/insiders/bundlers/top10/score/risks)+events 1m..24h; /holders (top holder + % + USD); /wallet/{addr} (posisi); /tokens/trending", keys: ["SOLTRACKER_HOST", "SOLTRACKER_API_KEY", "SOLTRACKER_API_KEY_2", "SOLTRACKER_API_KEY_3", "SOLTRACKER_API_KEY_4"], wired: "lane Solana lama (idle) + alat baca BARU `npm run sol:read` (host sendiri = kredensial; kunci cadangan utk rotasi)", status: "AKTIF — diuji live 2026-10-08: token/holders/wallet/trending semua HTTP 200 (JANGAN kirim header kunci → 400)", unused: "/trades, /chart, /stats tidak tersedia di host ini (404)" },
  { name: "RugCheck", gives: "audit kontrak: lp lock, mint/freeze authority, risiko", keys: ["RUGCHECK_API_KEY", "RUGCHECK_ENABLED"], wired: "safety/ (gate sniper Solana)", status: "IDLE (lane Solana off)" },
  { name: "Jupiter", gives: "token intel (devBalancePct, netBuyers5m, organic score) + quote/eksekusi Solana", keys: ["JUPITER_API_KEY"], wired: "safety/jupiter-token + execution/jupiter + RH lane devSignal", status: "AKTIF sebagian (token intel dipakai lane RH)" },
  { name: "pump.fun frontend API", gives: "daftar coin baru (created_timestamp)", keys: [], wired: "scout lane new-launch (Solana, off) + panel dashboard", status: "IDLE" },
  { name: "pumpportal WS", gives: "feed peluncuran realtime (sniper)", keys: [], wired: "sniper Solana (off)", status: "IDLE" },
  { name: "Helius RPC", gives: "RPC Solana utama + websocket", keys: ["HELIUS_API_KEY"], wired: "execution/rpc pool", status: "IDLE (lane Solana off)" },
  { name: "Solscan Pro", gives: "token meta/holders/transfer, account txs, defi activities", keys: ["SOLSCAN_API_KEY"], wired: "hanya /chaininfo (status blok) di server", status: "BLOKIR KELAS KUNCI — pro-api v2 diuji live: 401 'Please upgrade your api key level'; public-api lama 404. Butuh naik tier di Solscan", unused: "seluruh API data (holder/transfer) — terkunci oleh paket kunci" },
  { name: "Bitquery", gives: "GraphQL/WS on-chain (trades/holders/transfers multi-chain)", keys: ["BITQUERY_TOKEN", "BITQUERY_TOKENS"], wired: "discovery/bitquery.ts → dipakai sniper Solana", status: "BLOKIR BILLING — diuji live 2026-10-08: HTTP 402 'No active billing period'; WS eap menerima auth tapi hanya melayani operasi subscription", unused: "seluruh surface (stream & query) — perlu langganan aktif; relevan hanya bila lane Solana dinyalakan" },
  { name: "Bloxroute", gives: "stream swap (recorder bx)", keys: ["BLOXROUTE_AUTH_HEADER", "BLOXROUTE_WS_URL"], wired: "bx:swaps recorder", status: "TIDAK JALAN (tidak di supervisor)" },
  { name: "Feeling/Shadow LLM", gives: "juri vibe posisi + shadow answer", keys: ["FEELING_LLM_URL", "SHADOW_LLM_URL", "SHADOW_LLM_KEY", "FEELING_LLM_KEY"], wired: "server.ts (panels) + sniper", status: "IDLE (lane Solana off); FEELING_LLM_KEY kosong" },
  { name: "Pump.fun cookie/probes", gives: "leaderboard wallet + probe KOL (legacy)", keys: ["PUMPFUN_COOKIE"], wired: "legacy/probes/*", status: "IDLE (probe dimatikan 15 Agu)" },
  { name: "Telegram alerts", gives: "notifikasi operasional", keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], wired: "—", status: "TIDAK DIPASANG" },
  { name: "Postgres/Supabase", gives: "dual-write DB (dashboard historis)", keys: ["DATABASE_URL"], wired: "opsional (db:init)", status: "TIDAK DIPASANG" },
];

async function ping(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    return `HTTP ${res.status}`;
  } catch (e) { return `gagal: ${(e as Error).message.slice(0, 40)}`; }
}

async function main(): Promise<void> {
  console.log("═══ REGISTRY SUMBER DATA ═══\n");
  for (const s of SOURCES) {
    const keys = s.keys.length ? s.keys.map((k) => `${k}:${has(k) ? "✓" : "✗"}`).join(" ") : "(tanpa kunci)";
    console.log(`■ ${s.name}`);
    console.log(`   memberi : ${s.gives}`);
    console.log(`   kunci   : ${keys}`);
    console.log(`   wired   : ${s.wired}`);
    console.log(`   status  : ${s.status}`);
    if (s.unused) console.log(`   BELUM   : ${s.unused}`);
    console.log();
  }

  console.log("═══ CEK HIDUP (ringan) ═══");
  console.log(`  DexScreener         : ${await ping("https://api.dexscreener.com/latest/dex/search?q=SOL")}`);
  console.log(`  GeckoTerminal       : ${await ping("https://api.geckoterminal.com/api/v2/networks/robinhood/pools?page=1")}`);
  const proxy = await ping("http://127.0.0.1:4319/call").catch(() => "?");
  console.log(`  GMGN proxy (lokal)  : ${proxy === "HTTP 404" || proxy.startsWith("HTTP 4") || proxy === "HTTP 200" ? "hidup di :4319" : proxy}`);
  try {
    const sys = await dns.resolve4("web3.okx.com");
    const doh = await (await fetch("https://cloudflare-dns.com/dns-query?name=web3.okx.com&type=A", { headers: { accept: "application/dns-json" } })).json() as { Answer?: Array<{ type: number; data: string }> };
    const real = (doh.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
    console.log(`  OKX                 : ${sys.some((ip) => real.includes(ip)) ? "DNS normal" : `DNS hijack (${sys[0]} vs asli ${real[0]}) — okx:netcheck`}`);
  } catch { console.log("  OKX                 : tak bisa diperiksa"); }

  const idle = SOURCES.filter((s) => /IDLE|TIDAK|BLOKIR|SEBAGIAN/.test(s.status));
  console.log(`\n═══ RINGKAS: ${SOURCES.length} sumber · ${idle.length} idle/blokir/sebagian (tertulis di atas, tidak disembunyikan) ═══`);
}

void main();
