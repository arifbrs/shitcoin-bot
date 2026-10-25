/**
 * RUG SIGNALS (GMGN → Robinhood Chain) — pengumpulan bukti, bukan gerbang entry.
 *
 * Owner (2026-10-07): setelah kohort-1 didominasi rug instan (token mati −50%..−100% dalam
 * hitungan detik), ambil sinyal anti-rug dari GMGN untuk kandidat Robinhood Chain.
 *
 * PRINSIP (jangan dilanggar tanpa data): sinyal di sini BELUM memfilter apa pun. Ia dikumpulkan
 * dan disimpan supaya korelasi "sinyal → rug" bisa DIUKUR dari hasil nyata (review harian
 * membandingkan token yang diperkaya dengan outcome-nya). Filter kohort-2 hanya lahir dari angka
 * itu, bukan dari tebakan. GMGN memang support chain "robinhood" (terbukti live: token info +
 * security + trenches).
 *
 * Kuota: setiap panggilan = 2 call GMGN (info + security) lewat proxy ber-cooldown. Pemanggil
 * WAJIB membatasi jumlah per siklus (lihat RH_GMGN_ENRICH_MAX di paper.ts) — GMGN membatasi
 * per-IP dan burst kecil pun bisa memicu ban bertingkat.
 */
import { gmgnTokenInfo, gmgnTokenSecurity } from "../discovery/gmgn.js";

export interface RugSignals {
  at: number;
  holders: number | null;
  // Security (GMGN audit kontrak)
  top10HolderPct: number | null;   // konsentrasi top-10 holder (0..1)
  honeypot: number | boolean | null; // GMGN bisa mengirim 1 ATAU true (terverifikasi live 2026-10-07)
  buyTax: string | null;
  sellTax: string | null;
  burnStatus: string | null;       // "burn" = LP dibakar
  openSource: number | null;
  // Distribusi wallet ber-tag (siapa yang memegang)
  smartWallets: number | null;
  renownedWallets: number | null;
  sniperWallets: number | null;
  bundlerWallets: number | null;
  ratTraderWallets: number | null;
  // Derivat konsentrasi dari stat GMGN (persen sebagai string)
  topBundlerPct: string | null;
  topRatPct: string | null;
  topEntrapmentPct: string | null;
  // Asal-usul (dev)
  devCreatorStatus: string | null; // e.g. "creator_hold", "creator_close"
  devOpenCount: number | null;
}

/** Dua call GMGN (info + security) → satu snapshot sinyal rug. null = data tak tersedia. */
export async function fetchRugSignals(mint: string): Promise<RugSignals | null> {
  const [info, sec] = await Promise.all([
    gmgnTokenInfo("robinhood", mint),
    gmgnTokenSecurity("robinhood", mint),
  ]);
  if (!info && !sec) return null; // proxy mati / cooldown / token tak dikenal
  const top10Raw = sec?.top_10_holder_rate;
  const top10 = top10Raw != null && top10Raw !== "" ? Number(top10Raw) : NaN;
  return {
    at: Date.now(),
    holders: info?.holder_count ?? null,
    top10HolderPct: Number.isFinite(top10) ? Number(top10.toFixed(4)) : null,
    honeypot: sec?.is_honeypot ?? null,
    buyTax: sec?.buy_tax ?? null,
    sellTax: sec?.sell_tax ?? null,
    burnStatus: sec?.burn_status ?? null,
    openSource: sec?.open_source ?? null,
    smartWallets: info?.wallet_tags_stat?.smart_wallets ?? null,
    renownedWallets: info?.wallet_tags_stat?.renowned_wallets ?? null,
    sniperWallets: info?.wallet_tags_stat?.sniper_wallets ?? null,
    bundlerWallets: info?.wallet_tags_stat?.bundler_wallets ?? null,
    ratTraderWallets: info?.wallet_tags_stat?.rat_trader_wallets ?? null,
    topBundlerPct: info?.stat?.top_bundler_trader_percentage ?? null,
    topRatPct: info?.stat?.top_rat_trader_percentage ?? null,
    topEntrapmentPct: (info?.stat as Record<string, unknown> | undefined)?.["top_entrapment_trader_percentage"] as string | null ?? null,
    devCreatorStatus: info?.dev?.creator_token_status ?? null,
    devOpenCount: info?.dev?.creator_open_count ?? null,
  };
}

/** Ringkasan satu baris utk log/analisis: apakah sinyal ini menandai bahaya? (definisi eksplisit) */
export function rugFlags(s: RugSignals): string[] {
  const flags: string[] = [];
  if (s.honeypot === true || s.honeypot === 1) flags.push("honeypot");
  if (s.top10HolderPct != null && s.top10HolderPct > 0.3) flags.push("top10>30%");
  if (s.burnStatus != null && s.burnStatus !== "burn" && s.burnStatus !== "") flags.push(`lp:${s.burnStatus}`);
  const bt = s.topBundlerPct != null ? Number(s.topBundlerPct) : NaN;
  if (Number.isFinite(bt) && bt > 0.5) flags.push("bundler>50%");
  const rt = s.topRatPct != null ? Number(s.topRatPct) : NaN;
  if (Number.isFinite(rt) && rt > 0.3) flags.push("rat>30%");
  if (s.buyTax && s.buyTax !== "0" && s.buyTax !== "") flags.push(`buyTax:${s.buyTax}`);
  if (s.sellTax && s.sellTax !== "0" && s.sellTax !== "") flags.push(`sellTax:${s.sellTax}`);
  // Data parsial JANGAN terbaca sebagai "aman": kalau audit kontrak tak menjawab, katakan.
  if (s.honeypot == null && s.burnStatus == null) flags.push("audit:tak-lengkap");
  return flags;
}
