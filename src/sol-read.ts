/**
 * SOL READ — membaca token/wallet Solana dari sumber yang MEMANG bisa (bukan yang dikira bisa).
 *
 * Status sumber (diuji live 2026-10-08, hasil apa adanya):
 *   Solana Tracker  AKTIF. Host = subdomain aman milik kunci; JANGAN kirim header kunci (400).
 *                   Tersedia: /tokens/{mint} (meta+pools+risk+events), /tokens/{mint}/holders,
 *                   /wallet/{addr}, /tokens/trending. Tidak tersedia di host ini: /trades, /chart, /stats (404).
 *   Solscan Pro     BLOKIR KELAS KUNCI — pro-api v2 → 401 "Please upgrade your api key level".
 *                   Yang jalan hanya /chaininfo publik (dipakai server utk status blok).
 *   Bitquery        BLOKIR BILLING — HTTP 402 "No active billing period". WS eap menerima auth
 *                   tetapi hanya menerima operasi subscription (butuh langganan streaming).
 *
 * Run:
 *   npm run sol:read -- --token <mint>     baca token: pool, likuiditas, LP burn, risiko, konsentrasi
 *   npm run sol:read -- --holders <mint>   top holder + konsentrasi top-10
 *   npm run sol:read -- --wallet <addr>    posisi token sebuah wallet
 *   npm run sol:read -- --trending         daftar trending
 *   npm run sol:read -- --guide            status sumber + cara baca
 */
import "dotenv/config";
import { config } from "./config.js";

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const HOST = config.solTracker.host;

const usd = (v: number | null | undefined): string => v == null || !Number.isFinite(v) ? "—" : `$${Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(2)}`;
const pct = (v: number | null | undefined): string => v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

async function st<T>(path: string): Promise<T | null> {
  if (!HOST) return null;
  try {
    const res = await fetch(`${HOST}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

interface Pool {
  poolId?: string; liquidity?: { usd?: number; quote?: number }; price?: { usd?: number; quote?: number };
  lpBurn?: number; tokenSupply?: number; marketCap?: { usd?: number }; market?: string;
  security?: { freezeAuthority?: string | null; mintAuthority?: string | null };
  deployer?: string; createdAt?: number; bundleId?: string | null;
}
interface Risk {
  rugged?: boolean; score?: number; top10?: number;
  snipers?: { count?: number; totalPercentage?: number };
  insiders?: { count?: number; totalPercentage?: number };
  bundlers?: { count?: number; totalPercentage?: number; totalInitialPercentage?: number };
  dev?: { percentage?: number; amount?: number };
  risks?: Array<{ name?: string; level?: string }>;
  [k: string]: unknown;
}
interface TokenInfo {
  token?: { name?: string; symbol?: string; mint?: string; createdOn?: string; twitter?: string; website?: string; creation?: { creator?: string; created_tx?: string } };
  pools?: Pool[];
  events?: Record<string, { priceChangePercentage?: number }>;
  risk?: Risk;
  buys?: number; sells?: number; txns?: number; holders?: number;
}

function verdict(lpBurn: number | null, liqUsd: number | null, top10: number | null, snipersPct: number | null, security: Pool["security"], bundlesInitialPct: number | null): string {
  const w: string[] = [];
  if (lpBurn != null && lpBurn < 100) w.push(`LP burn ${lpBurn}% (belum 100% — LP bisa ditarik)`);
  if (liqUsd != null && liqUsd < 15_000) w.push(`likuiditas ${usd(liqUsd)} < $15k`);
  if (top10 != null && top10 > 25) w.push(`top-10 pegang ${top10.toFixed(1)}% supply`);
  if (snipersPct != null && snipersPct > 10) w.push(`sniper ${snipersPct.toFixed(1)}% supply`);
  if (security?.freezeAuthority) w.push("freeze authority MASIH AKTIF (developer bisa membekukan saldo)");
  if (security?.mintAuthority) w.push("mint authority MASIH AKTIF (supply bisa ditambah)");
  if (bundlesInitialPct != null && bundlesInitialPct > 25) w.push(`bundler pegang ${bundlesInitialPct.toFixed(1)}% supply awal`);
  return w.length ? `⚠︎ ${w.join(" · ")}` : "○ tidak ada bendera merah dari data ini (bukan jaminan aman)";
}

async function readToken(mint: string): Promise<void> {
  const d = await st<TokenInfo>(`/tokens/${mint}`);
  if (!d?.token) { console.log("  Solana Tracker tidak mengembalikan data untuk mint ini."); return; }
  const t = d.token;
  const pools = [...(d.pools ?? [])].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const main = pools[0];
  const liq = pools.reduce((a, p) => a + (p.liquidity?.usd ?? 0), 0);
  const r = d.risk ?? {};
  const snipersPct = r.snipers?.totalPercentage ?? null;
  const top10 = r.top10 ?? null;
  console.log(`  ${t.symbol ?? "?"} — ${t.name ?? "?"}  (${t.createdOn ?? "?"})`);
  console.log(`  creator ${t.creation?.creator ?? "?"} · sosial: ${[t.twitter ? "x" : null, t.website ? "web" : null].filter(Boolean).join("+") || "—"}`);
  console.log(`  harga ${main?.price?.usd != null ? `$${main.price.usd.toPrecision(4)}` : "—"} · liq total ${usd(liq)} (${pools.length} pool, utama ${main?.market ?? "?"} ${usd(main?.liquidity?.usd)}) · mc ${usd(main?.marketCap?.usd)}`);
  console.log(`  LP burn: ${main?.lpBurn ?? "—"}% · holder ${d.holders ?? "—"} · txns ${d.txns ?? "—"} (B${d.buys ?? "?"}/S${d.sells ?? "?"}, rasio beli ${d.buys && d.sells ? (d.buys / (d.buys + d.sells)).toFixed(2) : "—"})`);
  const ev = d.events ?? {};
  console.log(`  perubahan: ${["1m", "5m", "15m", "30m", "1h", "2h", "6h", "24h"].filter((k) => ev[k]).map((k) => `${k} ${pct(ev[k]?.priceChangePercentage)}`).join(" · ")}`);
  console.log(`  risiko: rugged=${r.rugged ?? "—"} skor=${r.score ?? "—"} top10=${top10 != null ? `${top10.toFixed(1)}%` : "—"} sniper=${r.snipers?.count ?? "—"} insider=${r.insiders?.count ?? "—"} bundler=${r.bundlers?.count ?? "—"}${r.bundlers?.totalInitialPercentage != null ? ` (${r.bundlers.totalInitialPercentage.toFixed(1)}% supply awal)` : ""} dev=${r.dev?.percentage != null ? `${r.dev.percentage.toFixed(2)}%` : "—"}`);
  if (r.risks?.length) console.log(`  peringatan sumber: ${r.risks.slice(0, 4).map((x) => `${x.level ?? "?"}:${x.name ?? "?"}`).join(" · ")}`);
  console.log(`  VERDIKT: ${verdict(main?.lpBurn ?? null, liq, top10, snipersPct, main?.security, r.bundlers?.totalInitialPercentage ?? null)}`);
}

async function readHolders(mint: string): Promise<void> {
  const d = await st<{ total?: number; accounts?: Array<{ wallet: string; amount: number; value?: { usd?: number }; percentage?: number }> }>(`/tokens/${mint}/holders`);
  if (!d?.accounts) { console.log("  tidak ada data holder."); return; }
  console.log(`  ${d.total ?? "?"} holder total · menampilkan ${Math.min(d.accounts.length, 15)} teratas:\n`);
  let top10 = 0;
  d.accounts.slice(0, 15).forEach((h, i) => {
    if (i < 10) top10 += h.percentage ?? 0;
    console.log(`   ${String(i + 1).padStart(2)}. ${h.wallet}  ${String((h.percentage ?? 0).toFixed(2)).padStart(6)}%  ${usd(h.value?.usd).padStart(10)}`);
  });
  console.log(`\n  KONSENTRASI top-10 (dari daftar ini): ${top10.toFixed(1)}%${top10 > 25 ? "  ⚠︎ tinggi" : ""}`);
}

async function readWallet(addr: string): Promise<void> {
  const d = await st<{ tokens?: Array<{ token?: { mint?: string; symbol?: string; name?: string }; balance?: number; value?: { usd?: number }; pnl?: { realized?: number; unrealized?: number; total?: number; percent?: number } }>; total?: number }>(`/wallet/${addr}`);
  if (!d?.tokens) { console.log("  tidak ada data wallet."); return; }
  const rows = [...d.tokens].sort((a, b) => (b.value?.usd ?? 0) - (a.value?.usd ?? 0));
  const totalUsd = rows.reduce((a, x) => a + (x.value?.usd ?? 0), 0);
  console.log(`  ${addr}\n  ${rows.length} posisi · nilai ${usd(totalUsd)}\n`);
  for (const x of rows.slice(0, 12)) {
    const pnl = x.pnl?.percent;
    console.log(`   ${String(x.token?.symbol ?? "?").padEnd(12)} ${usd(x.value?.usd).padStart(10)}${pnl != null ? `  PnL ${pct(pnl)}` : ""}`);
  }
}

async function trending(): Promise<void> {
  const rows = await st<Array<{ token?: { symbol?: string; name?: string; mint?: string }; pools?: Pool[]; events?: Record<string, { priceChangePercentage?: number }>; risk?: Risk }>>("/tokens/trending");
  if (!rows?.length) { console.log("  tidak ada data trending."); return; }
  for (const x of rows.slice(0, 12)) {
    const liq = (x.pools ?? []).reduce((a, p) => a + (p.liquidity?.usd ?? 0), 0);
    console.log(`   ${String(x.token?.symbol ?? "?").padEnd(12)} liq ${usd(liq).padStart(9)}  1h ${pct(x.events?.["1h"]?.priceChangePercentage).padStart(7)}  24h ${pct(x.events?.["24h"]?.priceChangePercentage).padStart(7)}  rugged=${x.risk?.rugged ?? "—"}`);
  }
}

function guide(): void {
  console.log(`═══ SUMBER SOLANA — STATUS NYATA (diuji 2026-10-08) ═══

  Solana Tracker  AKTIF (host = kredensial; JANGAN tambah header kunci — dijawab 400).
    /tokens/{mint}          meta, pools (liq/price/lpBurn/supply), RISK (snipers/insider/bundler/rugged),
                            events (perubahan 1m..24h), buys/sells/txns, jumlah holder
    /tokens/{mint}/holders  top holder + % supply + nilai USD  → konsentrasi terukur
    /wallet/{addr}          posisi token wallet (+PnL bila ada)
    /tokens/trending        daftar trending
    TIDAK tersedia di host ini: /trades, /chart, /stats (404)

  Solscan Pro     BLOKIR KELAS KUNCI. pro-api v2 → 401 "Please upgrade your api key level".
                  Yang jalan hanya /chaininfo publik (dipakai server utk status blok).
                  Butuh: naikkan tier kunci Solscan. Tanpa itu, jangan berharap data holder/transfer dari sini.

  Bitquery        BLOKIR BILLING. HTTP 402 "No active billing period" (auth dikenali, tagihan tidak aktif).
                  WS eap menerima auth tetapi hanya melayani operasi subscription.
                  Butuh: langganan/aktifkan billing. Berguna hanya bila lane Solana dinyalakan lagi.

  CARA BACA (aturan yang sama seperti lane lain):
   a. Semua angka ini PENGUKURAN, bukan rekomendasi. Liq < $15k + LP burn < 100% = exit risk nyata.
   b. top-10 > 25% supply = satu wallet bisa menghancurkan harga; sniper > 10% = pasokan murah siap jual.
   c. bandingkan harga/liq dengan sumber lain (GMGN, DexScreener) — dua sumber salah dengan cara berbeda
      lebih baik daripada satu sumber yang dipercaya buta.`);
}

async function main(): Promise<void> {
  if (argv.includes("--guide") || argv.length === 0) return guide();
  const token = flag("--token"), holders = flag("--holders"), wallet = flag("--wallet");
  if (token) return readToken(token);
  if (holders) return readHolders(holders);
  if (wallet) return readWallet(wallet);
  if (argv.includes("--trending")) return trending();
  guide();
}

void main();
