/**
 * GMGN READ — cara membaca SEMUA permukaan data GMGN, dikodekan jadi tool yang bisa dijalankan.
 *
 * Sumber pengetahuan (bukan tebakan): skills resmi di dalam paket `gmgn-cli`
 *   node_modules/gmgn-cli/skills/{gmgn-market,gmgn-token,gmgn-holder-analysis,gmgn-wallet-score}/SKILL.md
 * Field, ambang batas, dan arti tiap angka diambil dari dokumen itu; temuan lapangan repo ini
 * dicantumkan sebagai catatan terpisah (dan diberi label sebagai temuan empiris, bukan doktrin).
 *
 * Tiga mode:
 *   npm run gmgn:read -- --guide                     → cheatsheet: field, arti, ambang, etiket limit
 *   npm run gmgn:read -- --token <mint> [--chain sol] → baca satu koin lengkap + verdikt
 *   npm run gmgn:read -- --wallet <addr> [--chain sol]→ baca satu wallet (track-record, bukan copyability penuh)
 *
 * Kuota: --guide nol call. --token ≈6 call. --wallet ≈1-2 call. Semua lewat proxy ber-cooldown;
 * bila satu bagian gagal (429), bagian itu ditandai "tak tersedia" — TIDAK pernah dikarang.
 */
import "dotenv/config";
import {
  gmgnEnabled, gmgnTokenInfo, gmgnTokenSecurity, gmgnTopHolders, gmgnTopTraders,
  gmgnCreatedTokens, gmgnWalletStats, type GmgnHolderRow,
} from "./discovery/gmgn.js";

const chain = (arg("--chain") ?? "sol").toLowerCase();
const mint = arg("--token");
const wallet = arg("--wallet");
function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

const usd = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toPrecision(4)}`; // harga mikro: jangan tampilkan $0.00
  return `$${Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(2)}`;
};

/** Coba sekali lagi setelah cooldown GMGN (proxy menahan call berikutnya sampai reset).
 *  Manual tool: satu retry berbatas itu wajar; burst tidak pernah dilakukan. */
async function withRetry<T>(fn: () => Promise<T | null>, label: string): Promise<T | null> {
  const first = await fn();
  if (first) return first;
  console.log(`  … ${label} gagal (429/cooldown) — tunggu 35 detik lalu coba sekali lagi`);
  await new Promise((r) => setTimeout(r, 35_000));
  return fn();
}
const pct = (v: number | null | undefined): string => v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(2)}%`;
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;
const num = (v: unknown): number | null => { const n = typeof v === "string" ? Number(v) : (typeof v === "number" ? v : NaN); return Number.isFinite(n) ? n : null; };
const hours = (s: number): string => (s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}j` : `${(s / 86400).toFixed(1)}h`);

/** Temuan lapangan repo ini (empiris, bukan dari dokumen resmi) — selalu diberi label. */
const FIELD_NOTES = [
  "TEMUAN REPO: jumlah smart_degen/renowned BUKAN katalis linier — di 125 close Solana, pemenang justru rata-rata punya LEBIH SEDIKIT (config s2e11); pakai sebagai konteks, bukan gerbang.",
  "TEMUAN REPO: 'smart money buy' sering terjadi SETELAH kita entry (lane OKX copy gagal karena ini) — yang penting: apakah wallet itu MASIH memegang.",
  "TEMUAN REPO: GMGN mengirim honeypot sebagai 1 ATAU true (boolean) — pemeriksa harus menerima keduanya, kalau tidak honeypot lolos.",
  "TEMUAN DOKUMEN: SOL tidak punya is_honeypot (EVM-only) — kosong di SOL artinya 'tidak berlaku', bukan 'aman'.",
];

function guide(): void {
  console.log(`═══ CARA BACA GMGN (dari skills resmi gmgn-cli) ═══

── PERMUKAAN DATA ─────────────────────────────────────────────
market trending   : peringkat token per jendela 1m/5m/1h/6h/24h. hot_level = intensitas (bandingkan dalam satu hasil, bukan antar waktu). Filter chain OTOMATIS: SOL=renounced+frozen; EVM=not_honeypot+verified+renounced — mengosongkan --filter BUKAN berarti tanpa filter.
market trenches   : peluncuran baru per tahap: new_creation (masih bonding curve) → near_completion (hampir lulus; selalu muncul di data.pump) → completed (lulus ke DEX). Di sinilah dev-reputation & bundler rate paling awal terlihat.
market kline      : OHLCV. volume = USD; amount = JUMLAH TOKEN (bedanya bisa 5000× utk token $0,0002). time = milidetik.
market signal     : feed event real-time (tipe 1-21: 6 spike, 7 ATH, 10 bundler sell, 11 CTO, 12 smart-money buy, 13 platform call, 14 large buy, 20 KOL buy). Max 50/grup. Hanya sol/bsc/robinhood.
market hot-searches: yang paling dicari orang (visiting_count) — minat, bukan kualitas.
token info        : harga/pasar + wallet_tags_stat (smart/renowned/sniper/bundler/rat/whale/top) + stat (top_rat/top_bundler/top_entrapment %) + dev.
token security    : honeypot, tax beli/jual, open source, top_10_holder_rate, burn_status (LP dibakar?), renounced.
token top holders : 100 holder + tag per wallet (maker_token_tags: bundler/rat_trader/sniper/whale/top_holder/transfer_in/dev_team/creator; tags: smart_degen/pump_smart/renowned/fresh_wallet/wash_trader/kol) + avg_cost + unrealized_pnl + sell_amount_percentage + native_transfer (sumber dana) + native_balance (daya beli).
token top traders : wallet paling untung di token ini (siapa yang diuntungkan = siapa yang bisa keluar kapan saja).
portfolio created : riwayat dev: inner_count (tidak lulus) / open_count (lulus) / creator_ath_info (token terbaik dev).
portfolio stats   : kualitas wallet: realized_profit, pnl_stat{token_num,winrate,pnl_*_num buckets}. track-record ≠ copyable (lihat bawah).
kol / smartmoney  : feed trade wallet ber-tag — untuk MELIHAT, bukan serta-merta mengikuti.

── AMBANG BACA (dari skill resmi) ─────────────────────────────
rug_ratio > 0.3            → risiko tinggi (bukan biner; gabung dgn top10, dev hold, honeypot)
rat_trader > 10% supply    → bahaya (zero-cost, bisa dump kapan saja)
1 wallet > 15% supply      → bahaya (konsentrasi ekstrem)
dev sock puppet            → token_transfer_out dev mengarah ke wallet di top100 = bahaya
top_10_holder_rate          → >30% waspada, >50% bahaya
airdrop wallet (>15%)       → wallet dengan buy_tx=0 tapi pegang token (dapat transfer) = bisa dump tanpa rugi
risk wallets >30% (bundler+sniper+rat+fresh+wash) → waspada
LP burn_status ≠ burn       → likuiditas tidak terkunci
creator_token_status        → creator_hold = dev masih pegang (tekanan jual); creator_close = sudah keluar
cto_flag=1                  → community takeover (netral-positif, nilai konteksnya)

── TEKANAN JUAL TOP5 (cara paling berguna) ─────────────────────
Untuk tiap holder besar: entry MC (median usul: total_supply × avg_cost) vs MC sekarang → ROI; sell_amount_percentage → sudah keluar berapa; buy/sell tx → sedang apa.
Aturan praktis: ROI besar + sell_count naik = sumber jual berikutnya. ROI negatif = kecil kemungkinan jual rugi jangka pendek.

── WALLET: TRACK-RECORD vs COPYABLE (dari skill gmgn-wallet-score) ──
Track-record (0-100): distribusi hasil, bukan sekadar winrate — 30% winrate bisa bagus kalau kalah kecil & menang besar (bucket pnl_gt_5x/x2_5/0x_2/nd5_0/lt_nd5).
Copyability: entry sub-$100k MC, hold 5 detik, atau frekuensi bot = TIDAK bisa disalin; tambahkan latency (default 3s) + slippage (5%/sisi) + gas ke backtest → "yang benar-benar kamu dapat" << "yang dia dapat".
Dev wallet: kalau created_token_count > ½ traded tokens → ia PEMBUAT token; skor trading-nya harus didiskon (ia mengontrol harga tokennya sendiri).

── ETIKET LIMIT (WAJIB) ───────────────────────────────────────
Leaky bucket rate=20, capacity=20. Beban per call: kline=2, trending=1, trenches=3, signal=3, hot-searches=3.
429 → baca reset_at; JANGAN kirim request selama cooldown (tiap pelanggaran menambah 5 detik, maks 5 menit).
Tool ini lewat proxy ber-cooldown; pace aman terukur: ~1 call / 10 detik.

── CATATAN LAPANGAN REPO INI ──────────────────────────────────
${FIELD_NOTES.map((n) => "· " + n).join("\n")}
`);
}

async function readToken(): Promise<void> {
  if (!mint) { console.error("pakai: --token <mint>"); process.exit(2); }
  if (!gmgnEnabled) { console.error("GMGN_API_KEY tidak ada"); process.exit(2); }
  console.log(`═══ BACA KOIN ${chain.toUpperCase()} ${mint} ═══\n`);

  const info = await withRetry(() => gmgnTokenInfo(chain, mint), "token info");
  const sec = await withRetry(() => gmgnTokenSecurity(chain, mint), "security");
  const holders = await withRetry(() => gmgnTopHolders(chain, mint, undefined, "amount_percentage", 100), "top holders");

  // ── 1. Identitas & pasar ──
  console.log("── IDENTITAS & PASAR");
  if (!info) console.log("  (token info tak tersedia — 429/cooldown?)");
  else {
    const price = num(info.price?.price); const ath = num(info.ath_price);
    console.log(`  ${info.symbol ?? "?"} · holder ${info.holder_count ?? "?"} · harga ${usd(price)} · ATH ${usd(ath)}` + (price && ath ? ` (sekarang ${((price / ath) * 100).toFixed(1)}% dari ATH)` : ""));
    const p = info.price ?? {};
    console.log(`  1j: swap ${p.swaps_1h ?? "?"} · vol ${usd(num(p.volume_1h))} · beli/jual ${p.buys_1h ?? "?"}/${p.sells_1h ?? "?"}  |  5m: swap ${p.swaps_5m ?? "?"} · vol ${usd(num(p.volume_5m))}`);
    console.log(`  likuiditas ${usd(num(info.liquidity))} · dev ${info.dev?.creator_token_status ?? "?"} · dev pernah buat ${info.dev?.creator_open_count ?? "?"} token`);
  }

  // ── 2. Keamanan kontrak ──
  console.log("\n── KEAMANAN KONTRAK (ambang: dokumen resmi)");
  if (!sec) console.log("  (security tak tersedia)");
  else {
    const top10 = num(sec.top_10_holder_rate);
    const hp = sec.is_honeypot;
    console.log(`  honeypot: ${hp === null || hp === undefined ? "— (SOL: tidak berlaku)" : String(hp) + (hp === true || hp === 1 ? "  🔴 JANGAN BELI" : " ✅")}`);
    console.log(`  top10 holder rate: ${pct(top10)}  ${top10 == null ? "" : top10 > 0.5 ? "🔴 ekstrem" : top10 > 0.3 ? "🟡 tinggi" : "🟢 normal"}`);
    console.log(`  tax beli/jual: ${sec.buy_tax ?? "?"}/${sec.sell_tax ?? "?"} · open source ${sec.open_source ?? "?"} · LP burn: ${sec.burn_status ?? "?"}${sec.burn_status && sec.burn_status !== "burn" && sec.burn_status !== "" ? "  🟡 likuiditas tidak terkunci" : ""}`);
  }

  // ── 3. Struktur chip dari 100 holder ──
  console.log("\n── STRUKTUR CHIP (top 100 holder)");
  if (!holders?.length) console.log("  (holders tak tersedia)");
  else {
    const now = Math.floor(Date.now() / 1000);
    const isAirdrop = (h: GmgnHolderRow): boolean => (num(h["buy_tx_count_cur"]) ?? 0) === 0 && (num(h["balance"]) ?? 0) > 0;
    const tagsOf = (h: GmgnHolderRow): string[] => [...((h["maker_token_tags"] as string[] | undefined) ?? []), ...((h["tags"] as string[] | undefined) ?? [])];
    const sum = (f: (h: GmgnHolderRow) => boolean): number => holders.filter(f).reduce((a, h) => a + (h.amount_percentage ?? 0), 0);
    const top10 = holders.slice(0, 10).reduce((a, h) => a + (h.amount_percentage ?? 0), 0);
    const top20 = holders.slice(0, 20).reduce((a, h) => a + (h.amount_percentage ?? 0), 0);
    const risk = (h: GmgnHolderRow): boolean => tagsOf(h).some((t) => ["bundler", "rat_trader", "sniper", "fresh_wallet", "wash_trader"].includes(t));
    console.log(`  Top10 ${pct(top10)} ${top10 > 0.5 ? "🔴" : top10 > 0.3 ? "🟡" : "🟢"} · Top20 ${pct(top20)}`);
    console.log(`  airdrop (beli=0 tapi pegang): ${pct(sum(isAirdrop))} ${sum(isAirdrop) > 0.15 ? "🔴 bisa dump tanpa rugi" : "🟢"}`);
    console.log(`  wallet risiko (bundler/rat/sniper/fresh/wash): ${pct(sum(risk))} ${sum(risk) > 0.3 ? "🟡" : "🟢"}`);
    console.log(`  rat_trader ${pct(sum((h) => tagsOf(h).includes("rat_trader")))}${sum((h) => tagsOf(h).includes("rat_trader")) > 0.1 ? "  🔴 >10% supply" : ""} · sniper ${pct(sum((h) => tagsOf(h).includes("sniper")))} · bundler ${pct(sum((h) => tagsOf(h).includes("bundler")))}`);
    const burn = sum((h) => (num(h["addr_type"]) ?? 0) === 1);
    const dex = sum((h) => (num(h["addr_type"]) ?? 0) === 2);
    console.log(`  burn addr ${pct(burn)} ${burn > 0.05 ? "✅ supply terbakar" : ""} · DEX/pool ${pct(dex)} (tidak dinilai)`);
    const smart = sum((h) => tagsOf(h).includes("smart_degen") || tagsOf(h).includes("pump_smart"));
    const kol = sum((h) => tagsOf(h).includes("kol") || tagsOf(h).includes("renowned"));
    const whale = sum((h) => tagsOf(h).includes("whale"));
    const diamond = sum((h) => (num(h["sell_tx_count_cur"]) ?? 0) === 0 && (num(h["balance"]) ?? 0) > 0);
    console.log(`  kualitas: smart ${pct(smart)} · KOL ${pct(kol)} · whale ${pct(whale)} · diamond (belum pernah jual) ${pct(diamond)}`);
    for (const n of FIELD_NOTES.slice(0, 2)) console.log(`  catatan: ${n}`);

    // ── 4. Tekanan jual Top5 ──
    console.log("\n── TEKANAN JUAL TOP5 (entry MC → MC kini; yang penting bukan 'siapa', tapi 'sudah untung berapa')");
    const supplySamples = holders.filter((h) => (h.amount_percentage ?? 0) > 0 && (num(h["balance"]) ?? 0) > 0).map((h) => (num(h["balance"]) ?? 0) / (h.amount_percentage as number));
    const totalSupply = supplySamples.length ? supplySamples.sort((a, b) => a - b)[Math.floor(supplySamples.length / 2)] as number : null;
    for (const h of holders.slice(0, 5)) {
      const avg = num(h["avg_cost"]); const up = num(h["unrealized_pnl"]); const sold = num(h["sell_amount_percentage"]);
      const buyTx = num(h["buy_tx_count_cur"]) ?? 0; const sellTx = num(h["sell_tx_count_cur"]) ?? 0;
      const tags = tagsOf(h).filter((t) => ["smart_degen", "pump_smart", "kol", "renowned", "whale", "top_holder"].includes(t));
      const entryMc = avg && totalSupply ? avg * totalSupply : null;
      const age = num(h["start_holding_at"]);
      const status = (num(h["balance"]) ?? 0) <= 0 ? "sudah keluar" : sold != null && sold >= 0.8 ? "🔴 hampir keluar semua" : sold != null && sold >= 0.3 ? "🟡 sedang keluar" : buyTx === 0 ? "⚠️ airdrop (tanpa beli)" : "masih pegang";
      const pressure = buyTx === 0 ? "TINGGI (zero-cost)" : up != null && up > 1 ? "TINGGI (untung >100%)" : up != null && up > 0.1 ? "sedang" : "rendah (dekat/‌bawah modal)";
      console.log(`  ${short(h.address)} ${pct(h.amount_percentage)} ${tags.length ? "[" + tags.join("·") + "] " : ""}${status}`);
      console.log(`     entry MC ${usd(entryMc)}${up != null ? ` → kini ${up > 0 ? "+" : ""}${(up * 100).toFixed(0)}%` : ""} · tx beli/jual ${buyTx}/${sellTx} · usia ${age ? hours(now - age) : "?"} · tekanan ${pressure}`);
    }
    for (const n of FIELD_NOTES.slice(1, 2)) console.log(`  catatan: ${n}`);
  }

  // ── 5. Top traders (siapa yang diuntungkan) ──
  const traders = await withRetry(() => gmgnTopTraders(chain, mint, "profit", 10), "top traders");
  console.log("\n── TOP TRADERS (yang paling untung di koin ini)");
  if (!traders?.length) console.log("  (tak tersedia)");
  else for (const t of traders.slice(0, 6)) console.log(`  ${short(t.address)} ${String(t.wallet_tag_v2 ?? "").padEnd(10)} profit ${usd(num(t.profit) ?? num(t.realized_profit))} · pegang ${pct(num(t.amount_percentage))}`);

  // ── 6. Dev & riwayat ──
  const creator = info?.dev?.creator_address;
  if (creator) {
    console.log("\n── DEV & RIWAYAT LAUNCH");
    console.log(`  creator ${short(creator)} · status ${info?.dev?.creator_token_status ?? "?"}${info?.dev?.creator_token_status === "creator_hold" ? "  🟡 masih pegang" : ""}`);
    const hist = await withRetry(() => gmgnCreatedTokens(chain, creator), "riwayat dev");
    if (!hist) console.log("  (riwayat dev tak tersedia)");
    else {
      console.log(`  pernah buat ${(hist.inner_count ?? 0) + (hist.open_count ?? 0)} token · lulus ${hist.open_count ?? 0} (open_ratio ${hist.open_ratio ?? "?"})`);
      if (hist.creator_ath_info?.ath_mc) console.log(`  token terbaik dev: ${hist.creator_ath_info.token_symbol ?? "?"} ATH ${usd(num(hist.creator_ath_info.ath_mc))} (pedigree, BUKAN ATH token ini)`);
    }
  }

  // ── 7. Verdict ──
  console.log("\n── VERDIKT (ambang resmi; bukan nasihat beli)");
  const verdict: string[] = [];
  if (sec && (sec.is_honeypot === true || sec.is_honeypot === 1)) verdict.push("🔴 HONEYPOT — tidak bisa dijual");
  if (holders?.length) {
    const top10 = holders.slice(0, 10).reduce((a, h) => a + (h.amount_percentage ?? 0), 0);
    if (top10 > 0.5) verdict.push("🔴 Top10 >50% supply");
    const biggest = holders[0]?.amount_percentage ?? 0;
    if (biggest > 0.15) verdict.push(`🔴 1 wallet ${pct(biggest)} supply (>15%)`);
  }
  if (info?.dev?.creator_token_status === "creator_hold") verdict.push("🟡 dev masih pegang");
  if (!verdict.length) verdict.push("🟢 tidak ada bendera merah dari ambang resmi — tetap ukur sendiri sebelum masuk");
  for (const v of verdict) console.log(`  ${v}`);
}

async function readWallet(): Promise<void> {
  if (!wallet) { console.error("pakai: --wallet <addr>"); process.exit(2); }
  const st = await gmgnWalletStats(chain, [wallet], "7d");
  console.log(`═══ BACA WALLET ${chain.toUpperCase()} ${wallet} (7 hari) ═══\n`);
  if (!st) { console.log("  (stats tak tersedia)"); return; }
  const pnl = st.pnl_stat ?? {};
  console.log(`  realized ${usd(num(st.realized_profit))} · pnl ratio ${st.realized_profit_pnl ?? "?"} · beli/jual ${st.buy ?? "?"}/${st.sell ?? "?"}`);
  console.log(`  token ditradingkan ${pnl.token_num ?? "?"} · winrate ${pnl.winrate != null ? (Number(pnl.winrate) * 100).toFixed(0) + "%" : "?"}`);
  console.log(`  biaya: beli ${usd(num(st.bought_cost))} + fee ${usd(num(st.bought_fee))} → jual ${usd(num(st.sold_income))} - fee ${usd(num(st.sold_fee))}`);
  console.log("\n  CARA BACA (skill resmi gmgn-wallet-score):");
  console.log("   · Track-record ≠ copyable. Wallet hebat bisa tak tersalin: entry sub-$100k MC, hold detik-detik, atau frekuensi bot.");
  console.log("   · Backtest kasar: kurangi latency entry (default 3s) + slippage (5%/sisi) + gas → 'yang benar-benar kamu dapat' bisa jauh < yang dia dapat.");
  console.log("   · Kalau wallet ini juga PEMBUAT token (created > ½ traded), skor trading-nya harus didiskon — ia mengontrol harga tokennya sendiri.");
}

async function main(): Promise<void> {
  if (process.argv.includes("--guide")) return guide();
  if (mint) return readToken();
  if (wallet) return readWallet();
  guide();
}

void main();
