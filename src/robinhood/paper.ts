/**
 * ROBINHOOD CHAIN PAPER TRADER — 10 VARIAN, RISK $5/TRADE. Read-only, zero capital, nol signing.
 *
 * Owner (2026-10-07): "strategi auto trade meme coin di jaringan layer ETH, robinhood dengan risk
 * 5$ per trade. Lakukan backtest dan forward test, buat 10 varian paper test dengan profil risiko
 * yang berbeda beda."
 *
 * FORWARD TEST = proses ini. 10 varian berjalan bersamaan di universe yang sama (discovery
 * GeckoTerminal + DexScreener, chain "robinhood"), tiap varian punya filter entry, aturan exit,
 * dan profil risiko sendiri — semuanya dengan KERUGIAN MAKSIMAL $5 per trade:
 *   notional = riskUsd / stopPct, dibatasi maxNotionalUsd + 2% likuiditas pool + 50% equity.
 * Semua isian PAPER — tidak ada wallet, tidak ada transaksi. Angka P&L datang dari mark harga
 * nyata (DexScreener) dikurangi model biaya eksplisit: fee DEX 0.30%/sisi, gas L2 $0.01/sisi,
 * slippage dasar 1% + dampak ukuran (notional/likuiditas), haircut tambahan utk pool mati.
 *
 * Aturan main yang menjaga perbandingan tetap sah (jangan diubah tanpa epoch baru):
 *  - Satu posisi per (varian, token); cooldown 6 jam setelah close utk token yang sama.
 *  - Kapasitas 8 posisi/varian; entry hanya saat siklus, exit hanya dari mark (tidak intrabar).
 *  - Semua varian melihat kandidat yang sama; yang membedakan hanya filter + exit + ukuran.
 *  - Tidak ada mark 20 menit → keluar paksa (haircut 50% dari notional) — pool mati tidak bisa
 *    dijual, dan itu harus tercatat sebagai kerugian nyata, bukan posisi menggantung.
 *
 * Run: npm run rh:paper  (RH_PAPER_ONCE=true = satu siklus lalu keluar, utk uji)
 */
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { discoverPools, markTokens, gtTokenMarks, gtPoolMark, dexPromotedTokens, type PoolMetrics } from "./market.js";
import { fetchRugSignals, rugFlags, type RugSignals } from "./rug-signals.js";
import { readParityRows, computeParity, parityGaps, compensatingOpenCount, needsReconciledClose } from "./ledger-parity.js";
import { DEX_FEE_PCT, GAS_USD, slipPct } from "./costs.js";
import { commitState, shouldBlockClose } from "./state-store.js";
import { MARK_TRACE_MAX, shouldCaptureNow, traceFinished } from "./mark-trace.js";
import { tpHoldSatisfied, nextTpHoldStreak } from "./tp-hold.js";
import { readPoolsBatch, onchainExitReason, liquidityDropPct, priceRatio, type OnchainBaseline, type OnchainSnapshot } from "./onchain-liq.js";
import { loadLimits, checkEntryAllowed } from "../risk/limits.js";
import { gmgnEnabled } from "../discovery/gmgn.js";
import { sleep } from "../util/http.js";

const CYCLE_MS = intEnv(process.env.RH_PAPER_CYCLE_MS, 180_000, 30_000);
/**
 * HALAMAN POOLS PER SIKLUS (2026-10-12, permintaan operator: "perluas penemuan kandidat").
 * Memperbanyak kandidat yang DILIHAT — TIDAK mengubah gate masuk varian mana pun, jadi eksperimen
 * tetap sah. Rem otomatis tetap berlaku: TokenBucket + cooldown 429 (45s) di market.ts; kalau
 * rate-limit naik, angkanya akan terlihat di log dan langkah ini dibalik.
 */
const DISCOVERY_TOP_PAGES = intEnv(process.env.RH_DISCOVERY_TOP_PAGES, 1, 1);

// ── PEMANTAU ON-CHAIN (celah #1, 2026-10-12) ────────────────────────────────────────────────
// Dasar terukur: pool RH = V3-style → liquidity() & slot0() terbaca (probe 0528c32). Sinyalnya:
// likuiditas turun tajam (LP ditarik) ATAU harga on-chain jatuh — KEDUANYA dari rantai, bukan mark.
// Saklar balik: RH_ONCHAIN_LIQ=0 mematikan seluruh jalur ini (nol perubahan pada lane).
const ONCHAIN_ENABLED = (process.env.RH_ONCHAIN_LIQ ?? "1") !== "0";
const ONCHAIN_POLL_MS = intEnv(process.env.RH_ONCHAIN_POLL_MS, 20_000, 5_000);
const ONCHAIN_DROP_PCT = numEnv(process.env.RH_ONCHAIN_DROP_PCT, 0.35, 0.05);
// Ambang OBSERVASI (tidak memicu keluar): penurunan mendekati ambang dicatat sebagai data, supaya
// "kejadian nyata" bisa diukur lebih cepat TANPA mengubah aturan keluar 35%.
const ONCHAIN_WATCH_PCT = numEnv(process.env.RH_ONCHAIN_WATCH_PCT, 0.15, 0.05);
// CIRCUIT-BREAKER (2026-10-13): 4.224 kegagalan terkumpul karena pool non-V3 dipoll terus tiap 20s.
// Setelah N gagal BERUNTUN, pool itu dilewati lama (6 jam) — hemat kuota RPC dan deraunya hilang,
// sementara kegagalan sejati (pool V3 yang tiba-tiba tidak menjawab) tetap terlihat.
const ONCHAIN_FAIL_LIMIT = intEnv(process.env.RH_ONCHAIN_FAIL_LIMIT, 3, 1);
const ONCHAIN_SKIP_MS = intEnv(process.env.RH_ONCHAIN_SKIP_MS, 6 * 3_600_000, 60_000);
// Trip berbasis JENDELA (2026-10-13): 1.203 kegagalan terkumpul TANPA satu pun pool mencapai 3 gagal
// BERUNTUN — pola 403 berselang-seling. Jadi trip juga bila ≥`RH_ONCHAIN_FAIL_WINDOW_N` gagal dalam
// 1 jam terakhir (jejak waktu per pool, dipangkas otomatis).
const ONCHAIN_FAIL_WINDOW_N = intEnv(process.env.RH_ONCHAIN_FAIL_WINDOW_N, 6, 2);
const ONCHAIN_RPC = process.env.ROBINHOOD_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
const RISK_USD = numEnv(process.env.RH_RISK_USD, 5, 0.5);
const START_EQUITY_USD = numEnv(process.env.RH_START_EQUITY_USD, 100, 10);
const MAX_OPEN = intEnv(process.env.RH_MAX_OPEN, 8, 1);
const MAX_NOTIONAL_USD = numEnv(process.env.RH_MAX_NOTIONAL_USD, 25, 1);
const COOLDOWN_MS = 6 * 3_600_000;
/**
 * KUNCI PROSES TUNGGAL (2026-10-09). Penutupan ganda berasal dari DUA penulis state: siklus &
 * tick mark pada masa sebelum pemisahan kunci, atau dua PROSES tumpang tindih saat restart.
 * Penjaga di state (closedKeys) mengurangi dampaknya; kunci ini menutupnya di tingkat proses:
 * instance kedua MENOLAK jalan, dan kunci basi (PID sudah mati) diambil alih otomatis.
 */
const LOCK_PATH = join(config.logDir, "rh-paper.lock");
function acquireInstanceLock(): number {
  const take = (): number => {
    const fd = openSync(LOCK_PATH, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    return fd;
  };
  try { return take(); } catch {
    let pid = NaN;
    try { pid = Number(readFileSync(LOCK_PATH, "utf8").trim()); } catch { /* kosong */ }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    if (!alive) { try { unlinkSync(LOCK_PATH); } catch { /* sudah hilang */ } return take(); }
    console.error(`[rh-paper] MENOLAK JALAN: instance lain masih hidup (pid ${pid}, ${LOCK_PATH}).`);
    console.error(`[rh-paper] Dua proses menulis state yang sama = penyebab penutupan ganda 2026-10-09. Hentikan dulu yang lama.`);
    process.exit(1);
  }
}
// Jendela penjaga penutupan duplikat. 10 menit AMAN karena cooldown re-entry satu token = 6 jam:
// dalam 10 menit, penutupan kedua untuk (varian|token|life) yang sama tidak mungkin sah.
/** Jendela penjaga idempotensi penutupan kini di state-store.ts (CLOSE_DEDUP_MS) dan diuji. */
// 30 menit (bukan 20): GT/Dex bisa hiccup satu-dua siklus; satu outage singkat tidak boleh
// membukukan kerugian -50% palsu. mark_basi tetap ada utk pool yang benar-benar tak terjawab.
const STALE_MARK_MS = 30 * 60_000;
// MARK TICK (2026-10-07 → dipercepat 2026-10-09): audit menemukan trade rugi MELEBIHI stop nominal
// karena harga GAP melewati stop antar-mark 3 menit. Mark lebih rapat = exit lebih dekat stop/TP,
// dua arah. Discovery/entry tetap siklus penuh 3 menit.
const MARK_MS = intEnv(process.env.RH_MARK_MS, 10_000, 10_000);
// 2026-10-09: default 30s → 10s. Alasannya terukur: 10 penutupan pertama kohort-3/4 semuanya
// −100% dalam 8–13 menit, dan perisai likuiditas TIDAK sempat menyala — artinya jendela buta antar
// mark (30s) cukup lebar untuk harga GAP dari atas stop langsung ke nol. Biaya mempercepat tick
// sudah dihitung: jalur mark memakai SATU panggilan batch Dex (≤30 token/call) per tick → 6 call/
// menit, jauh di bawah plafon Dex 300/menit; fallback GT per-pool kini dibatasi BERBASIS WAKTU
// (4 call / 120 detik, lihat markAndExit) sehingga mempercepat tick tidak menambah tekanan ke GT
// yang dipakai bersama lane discovery.
// Penanda kohort: aturan eksekusi berubah → sampel lama tidak boleh dicampur. State membawa
// cohort-nya sendiri dan baris log memakai nilai yang sama, jadi kohort tak pernah tercampur diam-diam.
import { makePending, loadPending, savePending, settle, limitFilePath, type PendingLimit } from "./limit-pending.js";
import { loadCache, livePoolOk } from "./livepool-gate.js";
import { ALL_LIMIT_RULES, limitArmId } from "./limit-entry.js";
const COHORT = (process.env.RH_COHORT ?? "mark10s-2026-10-09").trim();
/** Penanda kohort-2 (varian ber-gate). Baris log memakai ini supaya perbandingan vs kohort-1 adil. */
const COHORT2 = (process.env.RH_COHORT2 ?? "rug-gate-2026-10-08").trim();
const COHORT3 = (process.env.RH_COHORT3 ?? "band-rasio-2026-10-09").trim();
const COHORT4 = (process.env.RH_COHORT4 ?? "shield-2026-10-09").trim();
const COHORT5 = (process.env.RH_COHORT5 ?? "stop-likuiditas-2026-10-10").trim();
// KOHORT-6 (2026-10-11): perlindungan dipindah dari HARGA ke LIKUIDITAS. Alasan terukur: penutupan
// stop_loss melewati nominal 55 poin (78% dari seluruh kerugian), sementara penutupan karena
// likuiditas (liq_shield) hanya melewati 3,2 poin. Perlakukan sebagai hipotesis yang diuji, bukan
// kebenaran: gate masuk HARUS identik dengan kontrolnya, dan hanya aturan likuiditas yang berbeda.
const COHORT6 = (process.env.RH_COHORT6 ?? "liq-exit-2026-10-11").trim();
// KOHORT-7 (2026-10-11): uji "TP harus BERTAHAN". Dasar: 89% kemenangan TP harganya lenyap <1 menit
// sesudah keluar (retensi p50 0% dari 3.000+ jejak) → mungkin TP hanya tersentuh satu tick lonjakan
// yang tidak bisa dijual. Arm: tahan 3 / 6 tick vs kontrol (langsung, perilaku lama).
const COHORT7 = (process.env.RH_COHORT7 ?? "tp-hold-2026-10-11").trim();
const COHORT8 = (process.env.RH_COHORT8 ?? "liq-tanpa-trail-2026-10-11").trim();
// KOHORT-9 (2026-10-13): BUANG STOP HARGA, andalkan keluar on-chain. Dasar terukur hari ini:
// 104 keluar on-chain @ −5%…+55% vs stop_loss 83 @ −73% dan pool_mati 21 @ −65%. Gate & sizing
// IDENTIK dengan kontrolnya (stopPct tetap 40 untuk perhitungan ukuran posisi — yang dilepas hanya
// PENGECEKAN stop-nya), sehingga variabel yang diuji benar-benar satu: stop harga ada atau tidak.
const COHORT9 = (process.env.RH_COHORT9 ?? "tanpa-stop-harga-2026-10-13").trim();
const COHORT10 = (process.env.RH_COHORT10 ?? "fee-nyata-2026-10-13").trim();
/** KOHORT-11 (2026-10-13): entry LEWAT LIMIT (jarak × masa berlaku) — sampel baru; arm lama tidak disentuh. */
const COHORT11 = (process.env.RH_COHORT11 ?? "limit-entry-2026-10-13").trim();
/** KOHORT-12 (2026-10-19): gate v42 + syarat "punya pool WETH berlikuid" (8,3% sinyal — terukur). */
const COHORT12 = (process.env.RH_COHORT12 ?? "livepool-2026-10-19").trim();
const LIVEPOOL_CACHE = loadCache(join(config.logDir, "rh-routable.json"));
const RETIRED = new Set<string>(((): string[] => { try { return (JSON.parse(readFileSync(join(config.logDir, "rh-retired.json"), "utf8")) as { retired?: string[] }).retired ?? []; } catch { return []; } })());
/**
 * Penanda kohort SATU tempat (2026-10-10): rantai ternary 4 tingkat sebelumnya tersebar di 4 tempat
 * (open, close, perisai, jejak rug) dan mudah lupa diperbarui saat kohort baru ditambah. Fungsi ini
 * satu-satunya tempat yang tahu urutan prioritasnya.
 */
function cohortTagOf(v: { cohort12?: boolean; cohort11?: boolean; cohort10?: boolean; cohort9?: boolean; cohort8?: boolean; cohort7?: boolean; cohort6?: boolean; cohort5?: boolean; cohort4?: boolean; cohort3?: boolean; cohort2?: boolean }, st: { cohort: string }): string {
  if (v.cohort12) return COHORT12;
  if (v.cohort11) return COHORT11;
  if (v.cohort10) return COHORT10;
  if (v.cohort9) return COHORT9;
  if (v.cohort8) return COHORT8;
  if (v.cohort7) return COHORT7;
  if (v.cohort6) return COHORT6;
  if (v.cohort5) return COHORT5;
  if (v.cohort4) return COHORT4;
  if (v.cohort3) return COHORT3;
  if (v.cohort2) return COHORT2;
  return st.cohort;
}
// RUG-SIGNAL ENRICHMENT (2026-10-07): kandidat terpilih diperkaya sinyal anti-rug GMGN
// (honeypot/top10/burn/bundler/dev). OBSERVASI dulu — belum memfilter apa pun; kohort-2 akan
// memakai filter hanya setelah korelasi sinyal→rug terbukti dari data (review harian).
const ENRICH_MAX = intEnv(process.env.RH_GMGN_ENRICH_MAX, 2, 0); // 2 kandidat = 4 call GMGN/siklus
const ENRICH_TTL_MS = 6 * 3_600_000;
/** Di bawah equity ini, varian tak mampu posisi minimum ($2) → dianggap BANKRUT (entry stop). */
const BANKRUPT_EQUITY = 4;
// LIFE-2 (owner 2026-10-07): varian yang bankrut TIDAK dibiarkan mati selamanya — ia restart dengan
// modal $100 BARU berlabel `life`, P&L dilaporkan per-life DAN kumulatif. Restart terjadi hanya
// setelah seluruh posisi life lama ditutup (tidak ada P&L lama yang tercampur), dan bila equity
// pulih ≥ ambang SEBELUM restart, varian dianggap SELAMAT — life tidak direset.
const AUTO_LIFE = process.env.RH_AUTO_LIFE !== "false";
const ONCE = process.env.RH_PAPER_ONCE === "true";
const STATE_PATH = join(config.logDir, "rh-paper-state.json");

function numEnv(v: string | undefined, def: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}
function intEnv(v: string | undefined, def: number, min: number): number {
  return Math.round(numEnv(v, def, min));
}

// ── Model biaya: PINDAH ke costs.ts (2026-10-11) ───────────────────────────────────────────
// Dulu rumus yang sama hidup di sini, di audit, dan di backtest — angka dari tiap alat bisa tidak
// sebanding tanpa ada yang tahu. Sekarang satu sumber, diuji oleh src/robinhood/costs.test.ts.

// ── 10 VARIAN: profil risiko dari paling konservatif ke paling degen ─────────────────────
interface Variant {
  /** KOHORT-11: bila diisi, arm ini TIDAK beli di pasar — ia mendaftarkan limit lalu menunggu. */
  cohort11?: boolean;
  cohort12?: boolean;
  /** KOHORT-12: hanya token yang punya pool WETH berlikuid (dari cache rh-routable.json, fail-closed). */
  requireLivePool?: boolean;
  limitDistPct?: number;
  limitExpiryMin?: number;
  id: string; label: string;
  stopPct: number; tpPct: number | null; trailFromPct: number | null; trailPct: number | null; maxHoldMin: number;
  minAgeMin: number; maxAgeMin: number | null;
  minLiqUsd: number; minVol24Usd: number; minVol1hUsd: number;
  minBuys1h: number; minBuyRatio1h: number | null; sellRatioMax1h: number | null;
  ch1Min: number | null; ch1Max: number | null; ch24Min: number | null;
  /** KOHORT-2 (bukti 2026-10-08): rasio beli >0.7 = pompa bot (65% mati) vs 0.5–0.6 (20% mati). */
  maxBuyRatio1h?: number;
  /** KOHORT-2: tolak bila token SUDAH diperkaya dan punya flag apa pun (top10>30% = 89% mati). */
  requireCleanGmgn?: boolean;
  /** Penanda baris log: true → cohort-2 (bukti), false/undefined → kohort-1 (mark30s). */
  cohort2?: boolean;
  /** KOHORT-3 (studi 2026-10-09): baris ber-cohort "band-rasio-2026-10-09". */
  cohort3?: boolean;
  /**
   * KOHORT-3 presisi: rentang konsentrasi top-10 holder (0..1, dari pengayaan GMGN).
   * Studinya: top10 0.4–0.6 → n=21 win 38%; ≥0.6 → win 0%; <0.15 → n=97 net −$905 mati 77%.
   * FAIL-CLOSED: bila nilainya belum ada (belum diperkaya), varian ini MENOLAK — gate yang
   * membutuhkan data tidak boleh lolos hanya karena datanya kosong.
   */
  minTop10Pct?: number;
  maxTop10Pct?: number;
  /**
   * KOHORT-4 (2026-10-09, ekor kerugian): PERISAI LIKUIDITAS.
   * Keluar lebih awal ketika likuiditas per-pool turun sekian fraksi dari likuiditas SAAT MASUK —
   * sebelum harga sampai ke stop. Alasan: studi per-alasan-keluar menunjukkan stop_loss n=182
   * (win 0%, net −$1.710, kelebihan $845 karena harga GAP melewati stop) dan pool_mati n=82
   * (mati 100%, −$773) mendominasi kerugian — sementara take_profit/max_hold/trailing yang
   * menghasilkan. LP yang ditarik bertahap terlihat di likuiditas LEBIH DULU daripada di harga.
   * Contoh: 0.30 → keluar bila liq ≤ 70% likuiditas masuk.
   */
  exitLiqDropPct?: number;
  /** KOHORT-4: baris ber-cohort "shield-2026-10-09". */
  cohort4?: boolean;
  /**
   * KOHORT-5 (2026-10-10, dari analisis rh:deep): dua uji yang paling didukung angka —
   *   (a) STOP lebih ketat: 706 stop_loss menghasilkan −$6.539, dan $3.336 di antaranya adalah
   *       "kelebihan di luar niat" (harga melewati stop). Dari 297 jejak rug nyata, SEMUA (297)
   *       sempat turun >20% sebelum mati → stop −20/−30% punya data untuk bertindak.
   *   (b) PITA LIKUIDITAS: bucket masuk 25–50k adalah satu-satunya yang positif (+$3,16/trade),
   *       sedangkan ≥100k adalah lubang terbesar (−$7,40/trade dari 496 trade).
   * CATATAN ETIS: kontrafaktual di atas SATU SISI (tak menghitung kemenangan yang ikut terpotong
   * stop lebih ketat) — karena itu keduanya diuji sebagai arm dengan KONTROL, bukan diterapkan.
   */
  cohort5?: boolean;
  /** KOHORT-6: uji keluar-karena-likuiditas (gate masuk WAJIB sama dengan kontrolnya). */
  cohort6?: boolean;
  /** KOHORT-8: buang trailing, keluar lewat likuiditas (gate sama dengan v42). */
  cohort8?: boolean;
  /** KOHORT-9: uji TANPA stop harga (andalkan keluar on-chain); gate sama dengan kontrolnya. */
  cohort9?: boolean;
  /** Lepas PENGECEKAN stop harga saja; stopPct tetap dipakai untuk ukuran posisi. */
  noPriceStop?: boolean;
  /**
   * KOHORT-10 (2026-10-13): FEE NYATA per pool. Temuan dari rantai: pool yang kita pegang punya fee
   * tier 1,00% (0x64) sedangkan paper memodelkan 0,30%/sisi → setiap PnL paper terlalu optimistis
   * 1,4% per putaran. Arm kohort-10 memakai fee 1,00% yang TERVERIFIKASI; kontrolnya tetap 0,30%,
   * sehingga kita melihat berapa besar edge yang sebenarnya tersisa — tanpa menyunting kohort lama.
   */
  dexFeePct?: number;
  /** KOHORT-10: uji biaya nyata vs model (lihat catatan dexFeePct). */
  cohort10?: boolean;
  /** KOHORT-7: uji TP harus BERTAHAN (gate masuk wajib sama dengan kontrolnya). */
  cohort7?: boolean;
  /** Berapa tick beruntun harga harus ≥ ambang TP sebelum dijual. 0/undefined = perilaku lama. */
  tpHoldTicks?: number;
  /**
   * BLOKIR ENTRY (2026-10-11). Dipakai untuk arm yang SUDAH TERJAWAB atau tidak mungkin menang:
   * kandidat terbatas, jadi arm yang tak berguna hanya memecah aliran bukti. Posisi yang sudah
   * terbuka tetap ditutup normal — yang diblokir hanya entry BARU.
   */
  entryBlocked?: boolean;
  /** Batas ATAS likuiditas masuk — pasangan dari minLiqUsd untuk menguji pita likuiditas. */
  maxLiqUsd?: number;
}
const VARIANTS: Variant[] = [
  { entryBlocked: true, id: "v01-konservatif", label: "Konservatif 24j", stopPct: 18, tpPct: 35, trailFromPct: 18, trailPct: 12, maxHoldMin: 1440, minAgeMin: 1440, maxAgeMin: null, minLiqUsd: 150_000, minVol24Usd: 150_000, minVol1hUsd: 0, minBuys1h: 0, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: -50 },
  { entryBlocked: true, id: "v02-momentum", label: "Momentum 6j", stopPct: 20, tpPct: 45, trailFromPct: 20, trailPct: 15, maxHoldMin: 720, minAgeMin: 360, maxAgeMin: null, minLiqUsd: 100_000, minVol24Usd: 80_000, minVol1hUsd: 0, minBuys1h: 0, minBuyRatio1h: 0.5, sellRatioMax1h: null, ch1Min: 5, ch1Max: 80, ch24Min: 0 },
  { entryBlocked: true, id: "v03-seimbang", label: "Seimbang 1-24j", stopPct: 25, tpPct: 50, trailFromPct: 25, trailPct: 20, maxHoldMin: 360, minAgeMin: 60, maxAgeMin: 1440, minLiqUsd: 60_000, minVol24Usd: 40_000, minVol1hUsd: 0, minBuys1h: 0, minBuyRatio1h: 0.55, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: -60 },
  { entryBlocked: true, id: "v04-dip", label: "Dip-beli", stopPct: 22, tpPct: 40, trailFromPct: null, trailPct: null, maxHoldMin: 480, minAgeMin: 120, maxAgeMin: null, minLiqUsd: 60_000, minVol24Usd: 30_000, minVol1hUsd: 0, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: -30, ch1Max: -8, ch24Min: -65 },
  { entryBlocked: true, id: "v05-agresif-baru", label: "Agresif baru ≤60m", stopPct: 30, tpPct: 70, trailFromPct: 35, trailPct: 25, maxHoldMin: 180, minAgeMin: 0, maxAgeMin: 60, minLiqUsd: 30_000, minVol24Usd: 0, minVol1hUsd: 8_000, minBuys1h: 25, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null },
  { entryBlocked: true, id: "v06-sniper", label: "Sniper fresh ≤20m", stopPct: 35, tpPct: 90, trailFromPct: null, trailPct: null, maxHoldMin: 120, minAgeMin: 0, maxAgeMin: 20, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 12, minBuyRatio1h: null, sellRatioMax1h: 0.45, ch1Min: null, ch1Max: null, ch24Min: null },
  { entryBlocked: true, id: "v07-runner", label: "Runner trailing", stopPct: 30, tpPct: null, trailFromPct: 30, trailPct: 25, maxHoldMin: 240, minAgeMin: 0, maxAgeMin: 360, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 10_000, minBuys1h: 0, minBuyRatio1h: 0.5, sellRatioMax1h: null, ch1Min: 3, ch1Max: null, ch24Min: null },
  { entryBlocked: true, id: "v08-moonshot", label: "Moonshot ≤3j", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: 180, minLiqUsd: 25_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 20, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null },
  { entryBlocked: true, id: "v09-scalp", label: "Scalp 45m", stopPct: 12, tpPct: 18, trailFromPct: null, trailPct: null, maxHoldMin: 45, minAgeMin: 0, maxAgeMin: 180, minLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 15_000, minBuys1h: 0, minBuyRatio1h: 0.57, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null },
  { entryBlocked: true, id: "v10-degen", label: "Degen ≤10m", stopPct: 45, tpPct: 120, trailFromPct: null, trailPct: null, maxHoldMin: 60, minAgeMin: 0, maxAgeMin: 10, minLiqUsd: 8_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 6, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null },
  // ── KOHORT-2 (2026-10-08): gate dari BUKTI kohort-1, exit bergaya v08 (satu-satunya varian yang
  // hijau karena membiarkan menang lari). Gate bersama: umur 2–15m (jendela fat-tail; <15m rug 67%,
  // ≥1j rug 6–11% tapi kehilangan ekor), liq ≥$40k (<$15k rug 69% vs $40–100k 44%), rasio beli ≤0.65
  // (0.5–0.6 = 20% mati; >0.7 = 65% mati), tolak token ber-flag rug saat sudah diperkaya.
  // Semua baris ber-cohort "rug-gate-2026-10-08" sehingga bisa dibandingkan adil vs kohort-1.
  // CATATAN KOREKSI (2026-10-08, 5 menit setelah dipasang): gate rasio ≤0.65 awalnya memblokir
  // 0/200 kandidat — SELURUH aliran jendela 2–15m berasio >0.65 (rasio tinggi = token baru, belum
  // ada penjual; bucket 0.5–0.6 yang "aman" itu token LEBIH TUA, bukan fenomena jendela ini).
  // Gate dilonggarkan ke 0.85 (hanya menolak pompa ekstrem); v16 memakai jendela umur 2–60m utk
  // MENGUKUR hipotesis rasio rendah, dan v20 kontrol tanpa gate rasio sama sekali.
  { entryBlocked: true, id: "v11-gate-moonshot", label: "GATE moonshot (TP250)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 2, maxAgeMin: 15, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 10, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: true, cohort2: true },
  { id: "v12-gate-runner", label: "GATE runner (TP150)", stopPct: 35, tpPct: 150, trailFromPct: 60, trailPct: 30, maxHoldMin: 360, minAgeMin: 2, maxAgeMin: 15, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 12, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: true, cohort2: true },
  { id: "v13-gate-scalp", label: "GATE scalp (TP100)", stopPct: 30, tpPct: 100, trailFromPct: null, trailPct: null, maxHoldMin: 180, minAgeMin: 2, maxAgeMin: 15, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 12, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: true, cohort2: true },
  { entryBlocked: true, id: "v14-gate-fat-tail", label: "GATE fat-tail (TP400)", stopPct: 45, tpPct: 400, trailFromPct: 150, trailPct: 50, maxHoldMin: 1440, minAgeMin: 2, maxAgeMin: 15, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 10, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: true, cohort2: true },
  { entryBlocked: true, id: "v15-gate-liq-tinggi", label: "GATE liq $100k+", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 2, maxAgeMin: 15, minLiqUsd: 100_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 10, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: true, cohort2: true },
  { entryBlocked: true, id: "v16-gate-ratio-rendah", label: "GATE ratio 0.5–0.6 umur 2–60m", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 2, maxAgeMin: 60, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 10, minBuyRatio1h: 0.5, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.6, requireCleanGmgn: true, cohort2: true },
  { entryBlocked: true, id: "v17-gate-tanpa-umur", label: "GATE tanpa gate umur", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: 60, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 10, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: true, cohort2: true },
  { entryBlocked: true, id: "v18-gate-umur-15-60", label: "GATE umur 15–60m", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 15, maxAgeMin: 60, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 10, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: true, cohort2: true },
  { entryBlocked: true, id: "v19-gate-volume", label: "GATE vol1j ≥$20k", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 2, maxAgeMin: 15, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 20_000, minBuys1h: 10, minBuyRatio1h: 0.45, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: true, cohort2: true },
  { entryBlocked: true, id: "v20-gate-kontrol", label: "GATE kontrol (tanpa gate rasio)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 2, maxAgeMin: 15, minLiqUsd: 25_000, minVol24Usd: 0, minVol1hUsd: 0, minBuys1h: 8, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort2: true },
  // ── KOHORT-3 (2026-10-09): gate dari STUDI 353 trade (npm run rh:study), bukan selera.
  //
  // Pemisah terukur terkuat di seluruh populasi:
  //   rasio beli 1j ≥0.85  → n=163 · win 10% · net −$1.503 · mati 90%   (pompa/distribusi)
  //   rasio beli 1j 0.70–0.85 → n=108 · win 34% · net +$293 · p90 +$19.66  (band yang bekerja)
  //   vol1j 20k–100k       → n=88  · win 36% · net +$236
  //   tanpa gate apa pun   → n=353 · win 20% · net −$1.556 = −$4.41/trade
  //
  // Yang menentukan bukan angkanya sendirian, tapi kombinasi yang MASIH MENGALIR: uji dua arah
  // (efek historis + jumlah kandidat hidup) memberi
  //   rasio 0.70–0.85 + vol1j ≥$5k  → n=84 · net +$406 · win 40% · mati 39% · +$4.83/trade · 213 kandidat hidup
  //   + umur 2–15m                  → n=66 · net +$446 · win 42% · +$6.76/trade · 52 kandidat hidup
  // Gate rasio 0.5–0.6 pernah memblokir 100% kandidat — karena itu v21–v26 memakai BAND, bukan
  // ambang tunggal, dan v26 sengaja jadi KONTROL (tanpa gate rasio) di jendela yang sama.
  // Semua varian kohort-3 memakai exit SAMA (gaya v11: TP250/trail 100-40/maxHold 720m) supaya
  // satu-satunya yang berbeda adalah gate masuknya.
  { entryBlocked: true, id: "v21-band-inti", label: "S3 inti: rasio 0.70–0.85 + vol1j ≥$5k", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort3: true },
  { entryBlocked: true, id: "v22-band-fresh", label: "S3 jendela fat-tail: rasio band + umur 2–15m", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 2, maxAgeMin: 15, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort3: true },
  { entryBlocked: true, id: "v23-band-lebar", label: "S3 tanpa batas bawah: rasio <0.85 saja", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort3: true },
  { entryBlocked: true, id: "v24-band-umur-panjang", label: "S3 umur ≥60m: rasio band + tua sedikit", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 60, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort3: true },
  { entryBlocked: true, id: "v25-band-liq-besar", label: "S3 likuiditas dalam ≥$100k + rasio band", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 100_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort3: true },
  { entryBlocked: true, id: "v26-band-kontrol", label: "S3 kontrol: tanpa gate rasio, vol1j ≥$5k", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort3: true },
  // Kombinasi terukur (uji dua arah lagi, 2026-10-09):
  //   band + volPITA 20k–100k + liq≥15k → n=51 · net +$449 · win 43% · +$8.81/trade · 72 kandidat hidup
  //   band + vol≥5k + top10 0.3–0.6      → n=19 · net +$392 · win 47% · +$20.61/trade (terbesar, jarang)
  //   band + vol≥5k + liq 15k–100k       → n=59 · net −$76 → DITOLAK; memotong pool dalam justru merugikan
  { entryBlocked: true, id: "v27-band-volpita", label: "S3 pita volume 20k–100k + rasio band", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 20_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort3: true },
  { entryBlocked: true, id: "v28-band-top10", label: "S3 presisi: rasio band + top10 30–60%", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, minTop10Pct: 0.30, maxTop10Pct: 0.60, requireCleanGmgn: false, cohort3: true },
  // KOREKSI 2026-10-09 (terukur, bukan dugaan): v28 ternyata NYARIS MUSTAHIL di aliran nyata.
  // Kandidat yang lolos gate band punya top10 16,9–22,6% (n=6 terakhir) — SEMUA di bawah 30% —
  // jadi kombinasi "band + top10 30–60%" nyaris tak punya irisan (0 trade, dan itu BUKAN karena
  // pengayaan macet: 11/11 kandidat band sudah diperkaya). Di seluruh 122 pengayaan, hanya 17%
  // token berada di 30–60%. Maka hipotesis top10 diuji di populasi tempat nilainya MEMANG ada:
  // gate masuk longgar (tanpa batas rasio) + top10 30–60%. v28 tetap dipertahankan sebagai uji
  // kombinasi ketat — ia memang akan jarang trading, dan itu jujur, bukan bug.
  { id: "v35-top10-presisi", label: "S3b presisi top10 30–60% (masuk longgar)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, minTop10Pct: 0.30, maxTop10Pct: 0.60, requireCleanGmgn: false, cohort3: true },
  { entryBlocked: true, id: "v36-top10-kontrol", label: "S3b kontrol: sama tanpa gate top10", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort3: true },
  // ── KOHORT-4 (2026-10-09): PERISAI LIKUIDITAS — menyerang EKOR KERUGIAN, bukan pemilihan masuk.
  //
  // Studinya (per alasan keluar, n=356): stop_loss n=182 win 0% net −$1.710 (kelebihan $845 karena
  // harga GAP melewati stop) · pool_mati n=82 mati 100% net −$773 · sebaliknya take_profit +$829
  // (win 100%), max_hold +$175, trailing +$27. Jadi yang membunuh bukan pemilihan masuk lagi,
  // melainkan KELUAR TERLAMBAT: LP yang ditarik bertahap terlihat di LIKUIDITAS lebih dulu
  // daripada di harga, dan aturan pool_mati lama baru menyala setelah likuiditas tinggal 15%.
  //
  // v29/v30 memakai gate masuk IDENTIK v21 (band rasio) — bedanya hanya perisai (−30% / −50%).
  // v31 memakai gate masuk v26 (longgar) + perisai −30%, supaya efeknya terukur di dua jenis masuk.
  // v32/v33 = KONTROL tanpa perisai di kohort yang sama (kondisi pasar sama) — sengaja menduplikasi
  // v21/v26 supaya perbandingan perisai vs tanpa-perisai tidak menyeberangi kohort.
  // v34 = PROBE sensitivitas (−5%): tujuannya MEMBUKTIKAN mekanisme menyala, bukan mencari profit.
  { entryBlocked: true, id: "v29-shield30-band", label: "S4 band + perisai liq −30%", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, exitLiqDropPct: 0.30, requireCleanGmgn: false, cohort4: true },
  { entryBlocked: true, id: "v30-shield50-band", label: "S4 band + perisai liq −50%", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, exitLiqDropPct: 0.50, requireCleanGmgn: false, cohort4: true },
  { entryBlocked: true, id: "v31-shield30-longgar", label: "S4 masuk longgar + perisai liq −30%", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, exitLiqDropPct: 0.30, requireCleanGmgn: false, cohort4: true },
  { entryBlocked: true, id: "v32-shield-kontrol-band", label: "S4 kontrol band (tanpa perisai)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort4: true },
  { entryBlocked: true, id: "v33-shield-kontrol-longgar", label: "S4 kontrol longgar (tanpa perisai)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort4: true },
  // v34 = PROBE sensitivitas (−5%) dengan gate masuk LONGGAR: membuktikan perisai menyala dalam
  // hitungan menit (bukan mencari profit) — gate band terlalu jarang untuk verifikasi cepat.
  { entryBlocked: true, id: "v34-shield-probe5", label: "S4 probe −5% (masuk longgar — bukti mekanisme)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, exitLiqDropPct: 0.05, requireCleanGmgn: false, cohort4: true },
  // ── KOHORT-5 (2026-10-10, dari `npm run rh:deep`) ──────────────────────────────────────────────
  // Dua hipotesis yang paling didukung angka, diuji dengan KONTROL (bukan diterapkan langsung):
  //   A. STOP: −$6.539 dari 706 stop_loss, dan $3.336 di antaranya kelebihan di luar niat; 297/297
  //      jejak rug sempat turun >20% sebelum mati → uji stop −20/−25/−30% vs kontrol −40%, gate
  //      masuk IDENTIK (band 0.70–0.85 + vol1j ≥$5k + liq ≥$15k) supaya hanya stop yang berbeda.
  //      Jujur: kontrafaktual lama satu sisi — kalau stop ketat memotong calon menang, biayanya
  //      akan terlihat di arm ini (itu gunanya kontrol).
  //   B. PITA LIKUIDITAS: bucket masuk 25–50k satu-satunya yang positif (+$3,16/trade), sedangkan
  //      ≥100k lubang terbesar (−$7,40/trade, 496 trade). Uji 25–100k dan 25–50k vs kontrol tanpa
  //      batas atas, gate lain sama (longgar, vol1j ≥$5k, liq ≥$15k).
  { id: "v37-stop20-band", label: "S5 stop −20% + band", stopPct: 20, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort5: true },
  { id: "v38-stop25-band", label: "S5 stop −25% + band", stopPct: 25, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort5: true },
  { id: "v39-stop30-band", label: "S5 stop −30% + band", stopPct: 30, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort5: true },
  { id: "v40-stop40-kontrol", label: "S5 KONTROL stop −40% + band", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: 0.70, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, maxBuyRatio1h: 0.85, requireCleanGmgn: false, cohort5: true },
  { id: "v41-liq25-100", label: "S5 pita liq $25–100k", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 100_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort5: true },
  { id: "v42-liq25-50", label: "S5 pita liq $25–50k (bucket terbaik)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort5: true },
  { id: "v43-liq-kontrol", label: "S5 KONTROL liq ≥$15k tanpa batas atas", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort5: true },
  // ── KOHORT-6 (2026-10-11): PERLINDUNGAN DARI LIKUIDITAS, BUKAN DARI HARGA ────────────────────
  // Gate masuk ketiganya IDENTIK dengan v42 (pita $25–50k) — hanya ATURAN KELUAR yang berbeda.
  // Dasar: stop berbasis harga melewati nominal 55 poin (78% kerugian), sedangkan keluar karena
  // likuiditas hanya melewati 3,2 poin. Kalau hipotesis ini benar, v45/v46 mengalahkan v44 secara
  // berpasangan: token yang sama, gate yang sama, hanya perlindungannya yang beda.
  { id: "v44-liqexit-kontrol", label: "S6 KONTROL pita 25–50k, keluar harga saja", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort6: true },
  { id: "v45-liqdrop50", label: "S6 keluar bila likuiditas −50% dari acuan", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort6: true, exitLiqDropPct: 0.50 },
  { id: "v46-liqdrop35", label: "S6 keluar bila likuiditas −35% dari acuan", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort6: true, exitLiqDropPct: 0.35 },
  // ── KOHORT-7 (2026-10-11): TP HARUS BERTAHAN ────────────────────────────────────────────────
  // Gate masuk IDENTIK dengan v42/v44 (pita $25–50k); hanya ATURAN TP yang berbeda. Kalau hipotesis
  // "lonjakan satu tick tidak bisa dijual" benar, arm tahan mengalahkan kontrol; kalau salah, tahan
  // justru kehilangan puncak dan kontrol menang — keduanya jawaban yang berguna.
  { id: "v47-tp-kontrol", label: "S7 KONTROL jual pada sentuhan TP", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort7: true, entryBlocked: true },
  { id: "v48-tp-tahan3", label: "S7 TP harus bertahan 3 tick (≈30s)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort7: true, entryBlocked: true, tpHoldTicks: 3 },
  { id: "v49-tp-tahan6", label: "S7 TP harus bertahan 6 tick (≈60s)", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort7: true, entryBlocked: true, tpHoldTicks: 6 },
  // ── KOHORT-7b (2026-10-11): PERBAIKAN DESAIN — trailing DIMATIKAN ─────────────────────────────
  // Temuan: arm 7a (v47–v49) memberi hasil IDENTIK sampai sen karena trailing (+100%) menyala lebih
  // dulu daripada TP (+250%) — aturan "TP harus bertahan" tak pernah dieksekusi. Uji yang tidak
  // menguji apa pun bukan hasil. Arm 7b: trailing dilepas, hanya TP yang bisa menutup (selain stop
  // dan batas hold), jadi syarat tahan benar-benar menjadi variabelnya.
  { id: "v50-tp-kontrol-b", label: "S7b KONTROL jual pada sentuhan TP (tanpa trailing)", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort7: true, entryBlocked: true },
  { id: "v51-tp-tahan3-b", label: "S7b TP harus bertahan 3 tick (tanpa trailing)", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort7: true, entryBlocked: true, tpHoldTicks: 3 },
  { id: "v52-tp-tahan6-b", label: "S7b TP harus bertahan 6 tick (tanpa trailing)", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort7: true, entryBlocked: true, tpHoldTicks: 6 },
  // ── KOHORT-8 (2026-10-11): BUANG TRAILING, KELUAR LEWAT LIKUIDITAS ────────────────────────
  // Bukti: trailing retensi p50 55% (46% harga lenyap — terburuk), liq_shield retensi 100%.
  // v42 (gate sama, masih pakai trailing) jadi pembanding ketiga.
  { id: "v53-liqexit-tanpa-trail", label: "S8 tanpa trailing · keluar bila likuiditas −35%", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort8: true, exitLiqDropPct: 0.35 },
  { id: "v54-tanpa-trail-kontrol", label: "S8 KONTROL tanpa trailing (keluar harga saja)", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort8: true },
  // ── KOHORT-9 (2026-10-13): TANPA STOP HARGA, andalkan keluar on-chain ───────────────────────
  { id: "v55-tanpa-stop-harga", label: "S9 tanpa stop harga (on-chain + hold)", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort9: true, noPriceStop: true },
  { id: "v56-kontrol-stop", label: "S9 KONTROL dengan stop harga (pembanding berpasangan)", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort9: true },
  // ── KOHORT-10 (2026-10-13): FEE NYATA 1,00% vs model 0,30% (validitas biaya) ────────────────
  // Konfigurasi sama dengan anchor (pita 25–50k, tanpa trailing, keluar likuiditas −35%); yang
  // berbeda HANYA model biaya. Kalau edge hilang di arm fee-nyata → edge itu artefak biaya.
  { id: "v57-fee-nyata-1pct", label: "S10 fee NYATA 1,00% (terverifikasi rantai)", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort10: true, exitLiqDropPct: 0.35, dexFeePct: 0.01 },
  { id: "v58-fee-model-03pct", label: "S10 KONTROL fee model 0,30% (cara paper lama)", stopPct: 40, tpPct: 250, trailFromPct: null, trailPct: null, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: null, minLiqUsd: 25_000, maxLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 5_000, minBuys1h: 0, minBuyRatio1h: null, sellRatioMax1h: null, ch1Min: null, ch1Max: null, ch24Min: null, requireCleanGmgn: false, cohort10: true, exitLiqDropPct: 0.35, dexFeePct: 0.003 },
];

// SAKLAR: arm kohort-11 BELUM BOLEH berjalan sampai cabang entry limit tersambung — kalau tidak,
// ia akan beli di pasar seperti arm biasa dan mengotori sampel. Ubah ke true SETELAH langkah 4 masuk.
const COHORT11_ARMS_ENABLED = true;

// ── KOHORT-11 (2026-10-13): ENTRY LEWAT LIMIT — 10 varian (5 jarak × 2 masa berlaku) ─────────────
// Gate SALINAN PERSIS anchor v57 (pita 25–50k, fee nyata 1,00%, tanpa trailing). Yang berbeda HANYA
// cara masuk (limit menunggu) → perbandingan berpasangan: gate sama, entry beda.
{
  const anchor11 = VARIANTS.find((x) => x.id === "v57-fee-nyata-1pct");
  if (COHORT11_ARMS_ENABLED && anchor11) {
    for (const r of ALL_LIMIT_RULES) {
      VARIANTS.push({ ...anchor11, id: limitArmId(r), label: "S11 limit " + r.distPct + "% · " + r.expiryMin + " menit", cohort11: true, limitDistPct: r.distPct, limitExpiryMin: r.expiryMin });
    }
  } else {
    console.error("[rh-paper] KOHORT-11: anchor v57 tidak ditemukan — arm limit TIDAK didaftarkan (tidak menebak)");
  }
  // KOHORT-12: salinan PERSIS gate v42 + syarat pool WETH likuid → pembanding berpasangan dengan v42 asli.
  const anchor12 = VARIANTS.find((x) => x.id === "v42-liq25-50");
  if (anchor12) {
    VARIANTS.push({ ...anchor12, id: "v75-livepool-a", label: "S12 gate v42 + hanya token ber-pool WETH likuid", cohort12: true, requireLivePool: true });
  } else {
    console.error("[rh-paper] KOHORT-12: anchor v42 tidak ditemukan — arm v75 TIDAK didaftarkan (tidak menebak)");
  }
  console.log("[rh-paper] KOHORT-11: " + VARIANTS.filter((x) => x.cohort11).length + " arm limit terdaftar (total arm " + VARIANTS.length + ")");
}

interface Position {
  token: string; symbol: string; pool: string; openedAt: number; entryPrice: number; tokensRaw: number;
  notionalUsd: number; peakPrice: number; lastPrice: number; lastMarkAt: number;
  entryLiqUsd: number | null; stopPct: number; tpPct: number | null; trailFromPct: number | null; trailPct: number | null; maxHoldMin: number;
  /** KOHORT-7: berapa tick beruntun harga sudah bertahan ≥ ambang TP (direset saat turun). */
  tpHoldCount?: number;
  /**
   * Likuiditas PER-POOL terakhir yang benar-benar terukur (Dex pair atau GT per-pool) + waktunya.
   * BUG YANG DITUTUP (2026-10-07 malam): mark GT multi-token mengembalikan reserve TOTAL semua
   * pool, sedangkan entry memakai likuiditas per-pool → membandingkan keduanya membuat aturan
   * pool_mati salah skala (pool kita bisa sudah mati sementara pool lain menahan nilai). Aturan
   * pool_mati kini HANYA memakai angka per-pool.
   */
  poolLiqUsd?: number | null; poolLiqAt?: number;
  /** Sumber pengukuran likuiditas terakhir: "dex" (pair), "gt-pool" (per-pool), "gt-multi" (total). */
  poolLiqSrc?: "dex" | "gt-pool" | "gt-multi";
  /** Baseline likuiditas PERTAMA per sumber — pembanding relatif yang konsisten-sumber. */
  liqBase?: Record<string, { v: number; at: number }>;
  /** 6 mark terakhir (harga + likuiditas + sumber) — direkam agar rug bisa dilacak, bukan ditebak. */
  recentMarks?: Array<{ t: number; p: number; liq: number | null; src: string | null }>;
}
interface LifeRecord { life: number; startedAt: number; endedAt: number; endEquityUsd: number; trades: number; wins: number; losses: number; reason: string }

/** Jejak harga pasca-keluar — dipakai realism untuk membuktikan harga keluar bisa dijual atau tidak. */
interface MarkTrace {
  token: string; symbol: string; pool?: string; variant: string; life: number; reason: string;
  closedAt: number; exitPriceUsd: number; marks: Array<{ t: number; p: number | null; liq: number | null }>;
}
interface VariantState {
  equityUsd: number; peakEquityUsd: number; maxDdPct: number; realizedUsd: number;
  /**
   * Penanda kohort DISIMPAN di state (2026-10-10) supaya dashboard bisa mengelompokkan varian
   * tanpa menyalin-tempel pemetaan id→kohort di server (dua tempat = pasti menyimpang).
   */
  cohort?: string;
  wins: number; losses: number; trades: number; positions: Position[]; cooldown: Record<string, number>;
  /** Kapan varian ini pertama kali jatuh di bawah ambang mampu-entry (lihat BANKRUPT_EQUITY). */
  bankruptAt?: number;
  /** LIFE-2: nomor life berjalan (mulai 1), waktu mulai, dan riwayat life yang sudah selesai. */
  life: number;
  lifeStartedAt: number;
  lifeHistory: LifeRecord[];
}
interface State {
  /** KOHORT-11: limit yang menunggu (BUKAN posisi; audit tidak menghitungnya sebagai posisi). */
  limitPending?: PendingLimit[];
  startedAt: number; cycles: number; cohort: string;
  variants: Record<string, VariantState>;
  /** Sinyal rug GMGN per mint (sukses saja) — bertahan melewati retensi log 7 hari. */
  gmgnInfo: Record<string, RugSignals>;
  /** Mint yang sudah DICOBA diperkaya (sukses atau gagal) — agar yang gagal tidak dicoba tiap siklus. */
  gmgnTried: Record<string, number>;
  /** Mint yang DIBLOKIR karena honeypot (agar event blokir tidak spam tiap siklus). */
  honeypotBlocked: Record<string, number>;
  /** KOHORT-2: blokir karena flag rug pada token yang sudah diperkaya (kunci: variant|mint). */
  gateBlocked: Record<string, number>;
  /** Waktu penutupan terakhir per (varian|token|life) — penjaga idempotensi (2026-10-09). */
  closedKeys?: Record<string, number>;
  /** Nomor tulisan state yang naik monoton — bukti apakah state pernah mundur (2026-10-10). */
  stateWrites?: number;
  /** Snapshot equity awal hari untuk batas rugi harian (item 7, 2026-10-11). */
  riskDay?: { date: string; equityUsd: number };
  /** Jejak harga pasca-keluar (2026-10-11): 3 mark setelah penutupan, untuk membuktikan mark bisa dijual. */
  markTrace?: MarkTrace[];
  /** Acuan on-chain per pool (likuiditas + sqrtPriceX96 saat pertama terlihat) — celah #1. */
  onchainBase?: Record<string, OnchainBaseline>;
  /** Kapan pool terakhir dibaca dari rantai (rem laju RPC per pool). */
  onchainCheckedAt?: Record<string, number>;
  /** Kapan kegagalan baca terakhir DILAPORKAN per pool (rem log, bukan rem baca). */
  onchainFailLogged?: Record<string, number>;
  /** Gagal beruntun per pool (circuit-breaker) + sampai kapan pool dilewati. */
  onchainFails?: Record<string, number>;
  /** Jejak waktu gagal per pool (1 jam terakhir) — trip berbasis jendela. */
  onchainFailTimes?: Record<string, number[]>;
  /** Kapan rekonsiliasi berkala terakhir dijalankan (audit temuan D). */
  lastReconcileAt?: number;
  onchainSkipUntil?: Record<string, number>;
  /**
   * Catatan koreksi buku (mis. void penutupan ganda / rekonstruksi equity). HARUS ikut tersimpan:
   * sebelumnya field ini tidak ada di tipe State sehingga DIHAPUS setiap lane menulis state —
   * jejak audit hilang padahal justru itu bukti koreksinya (temuan 2026-10-09).
   */
  corrections?: Array<Record<string, unknown>>;
}

function blankVariant(): VariantState {
  return {
    equityUsd: START_EQUITY_USD, peakEquityUsd: START_EQUITY_USD, maxDdPct: 0, realizedUsd: 0,
    wins: 0, losses: 0, trades: 0, positions: [], cooldown: {},
    life: 1, lifeStartedAt: Date.now(), lifeHistory: [],
  };
}
function loadState(): State {
  if (existsSync(STATE_PATH)) {
    try {
      const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State>;
      // KOHORT: penanda disimpan di state supaya ledger tidak pernah tercampur. Kalau penanda yang
      // dikonfigurasi BERBEDA dari yang tersimpan (aturan eksekusi berubah — mis. mark 30s → 10s),
      // peralihan dilakukan TERBUKA: satu event transisi dicatat, lalu baris baru memakai penanda
      // baru sementara baris lama tetap membawa penandanya sendiri di ledger.
      const storedCohort = s.cohort ?? COHORT;
      if (storedCohort !== COHORT && !cohortSwitchLogged) {
        cohortSwitchLogged = true;
        ui.warn(`[rh-paper] kohort beralih: ${storedCohort} → ${COHORT} (aturan eksekusi berubah — sampel lama tidak dicampur)`);
        try { logRecord("rh-events", { type: "rh-cohort-switch", from: storedCohort, to: COHORT, markMs: MARK_MS, cfg: configHash }); } catch { /* best-effort */ }
      }
      const st: State = {
        startedAt: s.startedAt ?? Date.now(), cycles: s.cycles ?? 0, cohort: COHORT,
        variants: {}, gmgnInfo: s.gmgnInfo ?? {}, gmgnTried: s.gmgnTried ?? {}, honeypotBlocked: s.honeypotBlocked ?? {}, gateBlocked: s.gateBlocked ?? {},
        closedKeys: s.closedKeys ?? {}, stateWrites: s.stateWrites ?? 0,
        corrections: s.corrections ?? [],
      };
      for (const v of VARIANTS) st.variants[v.id] = { ...blankVariant(), cohort: cohortTagOf(v, st), ...(s.variants?.[v.id] ?? {}) };
      return st;
    } catch { /* state rusak — mulai bersih */ }
  }
  const st: State = { startedAt: Date.now(), cycles: 0, cohort: COHORT, variants: {}, gmgnInfo: {}, gmgnTried: {}, honeypotBlocked: {}, gateBlocked: {}, closedKeys: {} };
  for (const v of VARIANTS) st.variants[v.id] = { ...blankVariant(), cohort: cohortTagOf(v, st) };
  return st;
}
function saveState(s: State, by = "?"): void {
  // JEJAK TIDAK BOLEH HILANG (2026-10-11): pernah terjadi markTrace ADA di berkas lalu hilang tanpa
  // satu pun event `rh-mark-after` — kelas yang sama dengan tulisan basi (salinan lama menimpa yang
  // baru). Dua tindakan sekaligus: (1) sebelum menulis, jejak yang ada di BERKAS tapi tidak ada di
  // salinan ini DIPERTAHANKAN (digabung), jadi kehilangan jejak mustahil; (2) kejadiannya dicatat
  // bersama `by` = penulisnya, sehingga kalau nanti muncul lagi, pelakunya terbaca — bukan ditebak.
  try {
    const disk = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { markTrace?: MarkTrace[] };
    const mine = s.markTrace ?? [];
    const keyOf = (t: MarkTrace): string => `${t.variant}|${t.token}|${t.closedAt}`;
    const have = new Set(mine.map(keyOf));
    const missing = (disk.markTrace ?? []).filter((t) => !have.has(keyOf(t)));
    if (missing.length) {
      logRecord("rh-events", { type: "rh-marktrace-preserved", by, missing: missing.length, mine: mine.length, disk: (disk.markTrace ?? []).length, cfg: configHash });
      s.markTrace = [...mine, ...missing].slice(-MARK_TRACE_MAX);
    }
    // CACAT YANG SAMA, KELAS YANG SAMA (2026-10-13): `onchainBase`/`onchainCheckedAt` (celah #1)
    // sempat ADA di berkas lalu HILANG — persis seperti markTrace dulu. Penyebabnya satu: penulisan
    // dari salinan yang lebih tua tidak memuat field baru, dan penjaga hanya melindungi markTrace.
    // Sekarang ketiganya dilindungi dengan aturan yang sama: field yang ada di BERKAS tapi tidak ada
    // di salinan ini TIDAK boleh hilang — dilaporkan sebagai `rh-state-field-preserved`.
    const diskAny = disk as Record<string, unknown>;
    for (const f of ["onchainBase", "onchainCheckedAt"] as const) {
      const diskVal = diskAny[f] as Record<string, unknown> | undefined;
      const mineVal = (s as unknown as Record<string, unknown>)[f] as Record<string, unknown> | undefined;
      const diskN = diskVal ? Object.keys(diskVal).length : 0;
      const mineN = mineVal ? Object.keys(mineVal).length : 0;
      if (diskN > mineN) {
        logRecord("rh-events", { type: "rh-state-field-preserved", by, field: f, disk: diskN, mine: mineN, cfg: configHash });
        (s as unknown as Record<string, unknown>)[f] = diskVal;
      }
    }
  } catch { /* state belum ada — lanjut */ }
  // PENJAGA TULISAN BASI (2026-10-10) — kelas penutupan ganda yang akhirnya TERBUKTI mekanismenya
  // lewat instrumentasi: salinan state LAMA ditulis menimpa yang baru, sehingga `closedKeys` dan
  // penghapusan posisi ikut ter-undo di berkas → tick berikutnya menutup posisi yang sama lagi.
  // Bukti terukur: stateWrites mundur 732→714, 734→715, 739→718, 740→719, 761→721, 776→722
  // (6 varian, @08:25:06) bertepatan dengan 14 pasangan penutupan ≤5 detik.
  // Nomor tulisan naik monoton; tulisan yang nomornya tidak lebih baru dari yang ada di berkas DITOLAK.
  const nextWrites = (s.stateWrites ?? 0) + 1;
  try {
    const disk = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { stateWrites?: number };
    if ((disk.stateWrites ?? 0) >= nextWrites) {
      logRecord("rh-events", { type: "rh-stale-save-blocked", mine: nextWrites, disk: disk.stateWrites ?? 0, cfg: configHash });
      ui.warn(`[rh-paper] TOLAK tulis state basi (punyaku #${nextWrites}, berkas #${disk.stateWrites}) — mencegah timpa-meniimpa`);
      return;
    }
  } catch { /* state belum ada — lanjut menulis */ }
  s.stateWrites = nextWrites;
  // Prune sinyal rug: simpan 48 jam (cukup utk analisa hasil), sama seperti cooldown entry.
  const cutoff = Date.now() - 48 * 3_600_000;
  for (const [mint, sig] of Object.entries(s.gmgnInfo)) if (sig.at < cutoff) delete s.gmgnInfo[mint];
  for (const [mint, at] of Object.entries(s.gmgnTried)) if (at < cutoff) delete s.gmgnTried[mint];
  for (const [mint, at] of Object.entries(s.honeypotBlocked ?? {})) if (at < cutoff) delete s.honeypotBlocked[mint];
  for (const [key, at] of Object.entries(s.gateBlocked ?? {})) if (at < cutoff) delete s.gateBlocked[key];
  // ATOMIC WRITE + PENJAGA MONOTONIK: keduanya pindah ke state-store.ts (2026-10-11) supaya
  // perilakunya bisa diuji tanpa menjalankan lane. Penolakan tulisan basi TIDAK boleh senyap:
  // ia dicatat sebagai peristiwa dan ditampilkan.
  const res = commitState(STATE_PATH, s);
  if (!res.written) {
    logRecord("rh-events", { type: "rh-stale-save-blocked", by, mine: (s.stateWrites ?? 0) + 1, disk: res.diskWrites, cfg: configHash });
    ui.warn(`[rh-paper] TOLAK tulis state basi oleh \`${by}\` (punyaku #${(s.stateWrites ?? 0) + 1}, berkas #${res.diskWrites}).`);
    // AKAR PENUTUPAN DOBEL YANG TERSISA (2026-10-13): penulis yang tulisannya DITOLAK tetap
    // MELANJUTKAN dan menulis baris ledger untuk aksi (mis. penutupan posisi) yang tak pernah
    // tersimpan di state. Proses berikutnya — yang membaca state dari berkas — mengulang aksi itu,
    // dan jadilah dobel (terukur: 2 pasangan baru, audit menggagalkannya). Jadi penulis basi harus
    // BERHENTI, bukan melanjutkan: keluarnya terkendali, supervisor menghidupkan ulang, dan proses
    // baru membaca state yang benar.
    logRecord("rh-events", { type: "rh-state-writer-yield", by, cfg: configHash });
    ui.warn(`[rh-paper] berhenti terkendali: ${by} bukan lagi penulis state (proses lain memegang berkas).`);
    process.exit(1);
  }
}

const ageMinOf = (m: PoolMetrics, now: number): number | null => (m.createdAt ? (now - m.createdAt) / 60_000 : null);

/**
 * PnL hari berjalan (USD) lintas varian — dasar batas rugi harian.
 * Snapshot equity diambil sekali per hari (saat pertama dipanggil), lalu dibandingkan; tidak perlu
 * perubahan di siklus, dan nilai lama tidak bisa "lupa" karena tanggalnya ikut disimpan.
 */
function dayPnlUsd(st: State): number {
  const today = new Date().toISOString().slice(0, 10);
  const total = Object.values(st.variants).reduce((a, v) => a + (v.equityUsd ?? 0), 0);
  if (st.riskDay?.date !== today) {
    st.riskDay = { date: today, equityUsd: total };
    return 0;
  }
  return total - st.riskDay.equityUsd;
}
const buyRatio1h = (m: PoolMetrics): number | null => {
  const b = m.buys["h1"], s = m.sells["h1"];
  if (b == null || s == null || b + s === 0) return null;
  return b / (b + s);
};

/** Alasan tunggal "menunggu data pengayaan" — dipakai rejects() DAN logika prioritas antrean. */
const TOP10_MISSING_REASON = "top10 belum diperkaya (gate presisi menunggu data)";

/** Apakah kandidat lolos filter entry varian? Mengembalikan null (lolos) atau alasan tolakan. */
function rejects(v: Variant, m: PoolMetrics, now: number, sig?: RugSignals | null): string | null {
  const age = ageMinOf(m, now);
  // Varian yang TIDAK punya syarat umur tidak boleh ditolak hanya karena umur pool tak diketahui.
  // Temuan 2026-10-09: baris ini dulu menolak SEMUA varian lebih dulu, sehingga gate kohort-3
  // (rasio beli + volume) tidak pernah dievaluasi sama sekali — 100% kandidat jatuh di sini,
  // padahal 4 dari 6 varian kohort-3 memang tidak memakai umur sebagai syarat.
  if (age == null) {
    if (v.minAgeMin > 0 || v.maxAgeMin != null) return "umur pool tidak diketahui";
  } else {
    if (age < v.minAgeMin) return `umur ${age.toFixed(0)}m < ${v.minAgeMin}m`;
    if (v.maxAgeMin != null && age > v.maxAgeMin) return `umur ${age.toFixed(0)}m > ${v.maxAgeMin}m`;
  }
  if (m.liqUsd == null) return "likuiditas tidak tersedia";
  if (m.liqUsd < v.minLiqUsd) return `liq $${Math.round(m.liqUsd)} < $${v.minLiqUsd}`;
  // KOHORT-5: batas ATAS likuiditas (pita). Fail-open bila angka tak tersedia? TIDAK — gate yang
  // butuh data tidak boleh lolos karena datanya kosong; liqUsd null sudah ditolak di atas.
  if (v.maxLiqUsd != null && m.liqUsd > v.maxLiqUsd) return `liq $${Math.round(m.liqUsd)} > $${v.maxLiqUsd} (di luar pita)`;
  if ((m.vol["h24"] ?? 0) < v.minVol24Usd) return `vol24 < $${v.minVol24Usd}`;
  if ((m.vol["h1"] ?? 0) < v.minVol1hUsd) return `vol1h < $${v.minVol1hUsd}`;
  if ((m.buys["h1"] ?? 0) < v.minBuys1h) return `buys1h < ${v.minBuys1h}`;
  const br = buyRatio1h(m);
  if (v.minBuyRatio1h != null && (br == null || br < v.minBuyRatio1h)) return `rasio beli 1j ${br == null ? "?" : br.toFixed(2)} < ${v.minBuyRatio1h}`;
  // KOHORT-2: rasio beli TERLALU TINGGI = pompa bot (bukti: >0.7 → 65% mati vs 0.5–0.6 → 20%).
  if (v.maxBuyRatio1h != null && (br == null || br > v.maxBuyRatio1h)) return `rasio beli 1j ${br == null ? "?" : br.toFixed(2)} > ${v.maxBuyRatio1h} (pompa)`;
  if (v.sellRatioMax1h != null && br != null && 1 - br > v.sellRatioMax1h) return `rasio jual 1j ${(1 - br).toFixed(2)} > ${v.sellRatioMax1h}`;
  // KOHORT-3 presisi: rentang konsentrasi top-10 (dari pengayaan GMGN). Fail-closed bila data kosong.
  if (v.minTop10Pct != null || v.maxTop10Pct != null) {
    const top10 = sig?.top10HolderPct ?? null;
    if (top10 == null) return TOP10_MISSING_REASON;
    if (v.minTop10Pct != null && top10 < v.minTop10Pct) return `top10 ${(top10 * 100).toFixed(1)}% < ${(v.minTop10Pct * 100).toFixed(0)}%`;
    if (v.maxTop10Pct != null && top10 >= v.maxTop10Pct) return `top10 ${(top10 * 100).toFixed(1)}% ≥ ${(v.maxTop10Pct * 100).toFixed(0)}%`;
  }
  const ch1 = m.chg["h1"], ch24 = m.chg["h24"];
  if (v.ch1Min != null && (ch1 == null || ch1 < v.ch1Min)) return `ch1 ${ch1 ?? "?"} < ${v.ch1Min}`;
  if (v.ch1Max != null && (ch1 == null || ch1 > v.ch1Max)) return `ch1 ${ch1 ?? "?"} > ${v.ch1Max}`;
  if (v.ch24Min != null && (ch24 == null || ch24 < v.ch24Min)) return `ch24 ${ch24 ?? "?"} < ${v.ch24Min}`;
  if (m.priceUsd == null || m.priceUsd <= 0) return "harga tidak tersedia";
  return null;
}

function openPosition(st: State, v: Variant, m: PoolMetrics, now: number, forcedPrice?: number): boolean {
  // KOHORT-11: bila limit terisi, harga masuk = HARGA TARGET limit (bukan harga pasar saat itu).
  const entryPx: number = forcedPrice ?? (m.priceUsd as number);
  const vs = st.variants[v.id] as VariantState;
  if (vs.positions.length >= MAX_OPEN) return false;
  if (vs.positions.some((p) => p.token === m.tokenAddress)) return false;
  const cd = vs.cooldown[m.tokenAddress];
  if (cd && now - cd < COOLDOWN_MS) return false;
  if (m.priceUsd == null || m.priceUsd <= 0) return false;
  const stopRisk = v.stopPct / 100;
  let notional = Math.min(RISK_USD / stopRisk, MAX_NOTIONAL_USD, vs.equityUsd * 0.5);
  if (m.liqUsd != null && m.liqUsd > 0) notional = Math.min(notional, m.liqUsd * 0.02);
  if (v.entryBlocked) return false; // arm yang sudah terjawab — jangan tambah sampel (lihat komentar di Variant)
  if (notional < 2) return false;
  // PENJAGA RISIKO (item 7, 2026-10-11): kill switch / batas rugi harian / batas modal / batas
  // posisi. Semua batas DEFAULT 0 = tidak dibatasi, jadi memasang penjaga ini TIDAK mengubah
  // perilaku lane sampai angkanya diisi di .env — perubahan perilaku tidak boleh senyap.
  const risk = checkEntryAllowed(
    {
      notionalUsd: notional,
      openNotionalUsd: Object.values(st.variants).reduce((a, v) => a + (v.positions ?? []).reduce((b, p) => b + (p.notionalUsd ?? 0), 0), 0),
      openPositions: Object.values(st.variants).reduce((a, v) => a + (v.positions ?? []).length, 0),
      dayPnlUsd: dayPnlUsd(st),
    },
    loadLimits(),
  );
  if (!risk.allowed) {
    logRecord("rh-events", { type: "rh-risk-block", variant: v.id, token: m.tokenAddress, symbol: m.symbol, reason: risk.reason, cohort: st.cohort, cfg: configHash });
    return false;
  }
  const feePct = v.dexFeePct ?? DEX_FEE_PCT;
  const slip = slipPct(notional, m.liqUsd);
  const cost = notional * (feePct + slip) + GAS_USD;
  const tokensRaw = (notional - cost) / entryPx;
  const pos: Position = {
    token: m.tokenAddress, symbol: m.symbol, pool: m.poolAddress, openedAt: now, entryPrice: entryPx, tokensRaw,
    notionalUsd: Number(notional.toFixed(4)), peakPrice: entryPx, lastPrice: entryPx, lastMarkAt: now,
    entryLiqUsd: m.liqUsd, stopPct: v.stopPct, tpPct: v.tpPct, trailFromPct: v.trailFromPct, trailPct: v.trailPct, maxHoldMin: v.maxHoldMin,
  };
  vs.positions.push(pos);
  // DURABILITAS DULU, CATAT KEMUDIAN (2026-10-09): dulu baris RH_OPEN ditulis ke ledger SEBELUM
  // state disimpan (saveState baru di akhir siklus). Kalau proses berhenti di antara keduanya —
  // yang terjadi saat restart beruntun — ledger punya posisi yang STATE TIDAK PERNAH PUNYA
  // (terukur: 9 "posisi hantu" INFLUENCERS @17:45 di 9 varian). Sekarang posisi disimpan lebih
  // dulu; jika proses mati setelah simpan, yang hilang hanyalah baris catatan, bukan uang semu.
  saveState(st, "close");
  const gi = st.gmgnInfo[m.tokenAddress]; // sinyal rug (kalau sudah diperkaya) — ikut ke baris OPEN
  logRecord("rh-paper", {
    action: "RH_OPEN", variant: v.id, variantLabel: v.label, token: m.tokenAddress, symbol: m.symbol, pool: m.poolAddress,
    entryPriceUsd: entryPx, notionalUsd: pos.notionalUsd, riskUsd: Number((pos.notionalUsd * stopRisk).toFixed(2)),
    // Tarif slippage masuk DICATAT (2026-10-10): audit memverifikasi eksak hanya bila KEDUA sisi
    // tercatat (masuk + keluar). Edisi pertama field ini tidak pernah mendarat — akibatnya jalur
    // eksak tak pernah aktif dan semua baris jatuh ke jalur model (terukur: 0 baris eksak).
    entrySlipPct: Number(slipPct(notional, m.liqUsd).toFixed(6)),
    stopPct: v.stopPct, tpPct: v.tpPct, maxHoldMin: v.maxHoldMin, liqUsd: m.liqUsd, ageMin: ageMinOf(m, now),
    vol1hUsd: m.vol["h1"] ?? null, vol24Usd: m.vol["h24"] ?? null, buys1h: m.buys["h1"] ?? null, buyRatio1h: buyRatio1h(m),
    gmgnFlags: gi ? rugFlags(gi) : null, gmgnTop10: gi?.top10HolderPct ?? null, gmgnBurn: gi?.burnStatus ?? null,
    gmgnHoneypot: gi?.honeypot ?? null, gmgnBundlerPct: gi?.topBundlerPct ?? null, gmgnDevStatus: gi?.devCreatorStatus ?? null,
    // Equity PADA SAAT ENTRY (realized) — membuat cek sizing audit eksak. 4 desimal, bukan 2:
    // cap 50% dihitung dari equity penuh, jadi 2 desimal menghasilkan selisih ~$0,002 yang
    // terbaca sebagai "sizing menyimpang" padahal hanya pembulatan log.
    equityAtEntryUsd: Number(vs.equityUsd.toFixed(4)),
    life: vs.life, cohort: cohortTagOf(v, st), sources: m.sources.join("+"), strategy2Epoch: config.strategy2Epoch, cfg: configHash,
  });
  return true;
}

function closePosition(st: State, v: Variant, vs: VariantState, pos: Position, price: number, liqUsd: number | null, reason: string, now: number): void {
  // PENJAGA IDEMPOTENSI (2026-10-09): satu posisi = satu penutupan per (varian|token|life).
  // Temuan audit: 7 penutupan ganda (max_hold lalu mark_basi 0–1 menit kemudian) membukukan PnL
  // DUA KALI dan membuat equity v03/v06 menyimpang — jejak dari masa sebelum pemisahan kunci,
  // saat dua salinan state bisa menutup posisi yang sama. Riwayat tak bisa diperbaiki dari sini,
  // tapi kejadian yang sama tidak boleh terulang: penutupan duplikat DITOLAK, dicatat, dan posisi
  // basi itu tetap dikeluarkan dari daftar supaya tidak menggantung tanpa membukukan apa pun.
  const closeKey = `${v.id}|${pos.token}|${vs.life ?? 1}`;
  const lastClose = st.closedKeys?.[closeKey];
  // INSTRUMENTASI (2026-10-10): ada satu kelas yang MASIH terbuka — satu posisi bisa ditutup dua kali
  // (1 OPEN + 2 CLOSE identik, 37 detik terpisah, penjaga 0 kali menyala, satu proses). Untuk
  // kejadian berikutnya, baris CLOSE kini membawa bukti keadaan penjaga + nomor tulisan state:
  // jika `stateWrites` pada baris kedua LEBIH KECIL dari yang pertama, berarti state pernah mundur
  // (tulisan basi menimpa yang baru) — dan itu menjelaskan semuanya tanpa perlu menebak.
  // (nomor tulisan state diurus saveState — monotonik — sehingga baris CLOSE di bawah memuat
  //  nomor yang BENAR-BENAR tertulis, bukan hasil hitungan lokal.)
  if (lastClose !== undefined && shouldBlockClose(lastClose, now)) {
    vs.positions = vs.positions.filter((p) => p.token !== pos.token);
    logRecord("rh-events", {
      type: "rh-close-dedup-block", token: pos.token, symbol: pos.symbol, variant: v.id, life: vs.life,
      rejectedReason: reason, firstClosedAgoMs: now - lastClose, cohort: cohortTagOf(v, st), cfg: configHash,
    });
    ui.warn(`[rh-paper] TOLAK tutup duplikat ${v.id} ${pos.symbol} (${reason}) — sudah ditutup ${((now - lastClose) / 60_000).toFixed(1)} menit lalu`);
    return;
  }
  st.closedKeys = st.closedKeys ?? {};
  st.closedKeys[closeKey] = now;
  let exitPrice = price;
  if (reason === "pool_mati") exitPrice = price * 0.75; // pool < $2k: asumsikan 25% haircut tambahan
  if (reason === "mark_basi") exitPrice = (price || pos.entryPrice) * 0.5; // tidak ada mark 20 mnt → realistis 50%
  const gross = pos.tokensRaw * exitPrice;
  const slip = slipPct(gross, liqUsd ?? pos.entryLiqUsd);
  const proceeds = gross * (1 - (v.dexFeePct ?? DEX_FEE_PCT) - slip) - GAS_USD;
  const pnl = proceeds - pos.notionalUsd;
  vs.equityUsd += pnl;
  vs.realizedUsd += pnl;
  vs.trades += 1;
  if (pnl >= 0) vs.wins += 1; else vs.losses += 1;
  vs.peakEquityUsd = Math.max(vs.peakEquityUsd, vs.equityUsd);
  const dd = vs.peakEquityUsd > 0 ? ((vs.peakEquityUsd - vs.equityUsd) / vs.peakEquityUsd) * 100 : 0;
  vs.maxDdPct = Math.max(vs.maxDdPct, Number(dd.toFixed(2)));
  vs.cooldown[pos.token] = now;
  vs.positions = vs.positions.filter((p) => p.token !== pos.token);
  // JEJAK PASCA-KELUAR (2026-10-11): harga 1/3/5 menit SETELAH keluar. Tanpa ini, klaim
  // "TP +185%" tidak bisa dipisahkan dari "mark yang lenyap begitu kita jual" — dan itu pertanyaan
  // terbesar yang tersisa dari kohort-5. Aturan slotnya di mark-trace.ts (diuji).
  st.markTrace = [...(st.markTrace ?? []), {
    token: pos.token, symbol: pos.symbol, pool: pos.pool, variant: v.id, life: vs.life,
    reason, closedAt: now, exitPriceUsd: exitPrice, marks: [],
  }].slice(-MARK_TRACE_MAX);
  // Durabilitas dulu, catat kemudian — alasan yang sama dengan openPosition (baris ledger tidak
  // boleh ada tanpa jejak di state).
  saveState(st, "close");
  logRecord("rh-paper", {
    action: "RH_CLOSE", variant: v.id, variantLabel: v.label, token: pos.token, symbol: pos.symbol, reason,
    // PRESISI (2026-10-10): dulu `exitPrice.toFixed(10)` — harga rug 2,16e-12 DIBULATKAN jadi 0,
    // sehingga harga tercatat tidak lagi menjelaskan PnL yang dihitung dari harga asli, dan audit
    // yang menghitung ulang dari baris itu menemukan selisih sampai $8,55 (375 baris terpengaruh).
    // toPrecision(12) mempertahankan nilai sekecil apa pun.
    entryPriceUsd: pos.entryPrice, exitPriceUsd: Number(exitPrice.toPrecision(12)), peakPriceUsd: pos.peakPrice,
    notionalUsd: pos.notionalUsd, stopPct: pos.stopPct, proceedsUsd: Number(proceeds.toFixed(4)), pnlUsd: Number(pnl.toFixed(4)),
    exitSlipPct: Number(slip.toFixed(6)), guardHadKey: Boolean(lastClose), guardAgeMs: lastClose ? now - lastClose : null, stateWrites: st.stateWrites ?? 0,
    pnlPct: Number(((pnl / pos.notionalUsd) * 100).toFixed(2)), heldMin: Number(((now - pos.openedAt) / 60_000).toFixed(1)),
    // Likuiditas yang BENAR-BENAR dipakai untuk slippage keluar (fallback ke likuiditas masuk) —
    // dulu yang tercatat hanya `liqUsd` mentah, sehingga audit memakai default 5% dan angkanya beda.
    liqUsd: liqUsd ?? pos.entryLiqUsd ?? null, equityUsd: Number(vs.equityUsd.toFixed(2)), life: vs.life, cohort: cohortTagOf(v, st), strategy2Epoch: config.strategy2Epoch, cfg: configHash,
  });
  // JEJAK RUG (2026-10-09): 10 penutupan pertama kohort-3/4 semuanya −100% (8–13 menit), dan perisai
  // likuiditas TIDAK menyala untuk CREDITS/boar — pertanyaannya "apakah likuiditas sempat turun
  // sebelum harga nol, atau tidak ada sinyal sama sekali?". Tanpa jejak mark, itu cuma bisa ditebak.
  // Jadi setiap penutupan ≤−80% menyertakan 6 mark terakhir (harga + likuiditas + sumbernya).
  if ((pnl / pos.notionalUsd) * 100 <= -80) {
    logRecord("rh-events", {
      type: "rh-rug-trace", token: pos.token, symbol: pos.symbol, variant: v.id, reason,
      entryPriceUsd: pos.entryPrice, exitPriceUsd: exitPrice, pnlPct: Number(((pnl / pos.notionalUsd) * 100).toFixed(2)),
      entryLiqUsd: pos.entryLiqUsd, shieldsEnabled: v.exitLiqDropPct ?? null, marks: pos.recentMarks ?? [], cohort: cohortTagOf(v, st), cfg: configHash,
    });
  }
}

let busy = false;
/** Penjaga siklus (terpisah dari `busy`) — lihat catatan di cycle(). */
let cycleRunning = false;
/** Exit yang sudah dilakukan tick mark sejak siklus terakhir — supaya laporan siklus tetap benar. */
let exitsSinceCycle = 0;
/** Stempel waktu call GT per-pool (maks 4 per 120 detik) — lihat catatan di markAndExit. */
let gtPoolCallTimes: number[] = [];
/** Transisi kohort dicatat SEKALI per proses (bukan tiap load state). */
let cohortSwitchLogged = false;

/**
 * MARK + EXIT posisi terbuka — dipakai siklus 3 menit DAN tick 10 detik. WAJIB lewat `busy`
 * supaya dua jalur tidak pernah menyentuh state bersamaan.
 */
async function markAndExit(st: State, now: number): Promise<number> {
  const openTokens = [...new Set(Object.values(st.variants).flatMap((vs) => vs.positions.map((p) => p.token)))];
  if (!openTokens.length) return 0;
  const marks = await markTokens(openTokens);
  const gtMarks = new Map<string, { priceUsd: number | null; liqUsd: number | null }>();
  {
    const missing = [...new Set(Object.values(st.variants).flatMap((vs) => vs.positions.map((p) => p.token)))].filter((t) => !marks.has(t));
    if (missing.length) {
      const gt = await gtTokenMarks(missing); // 1 call per ≤30 token — harga saja, likuiditas = TOTAL semua pool
      for (const [t, m] of gt) gtMarks.set(t, m);
    }
  }
  // LIKUIDITAS PER-POOL utk posisi yang tidak ter-cover DexScreener: GT per-pool. Batasnya
  // BERBASIS WAKTU (6 call / 120 detik), bukan per-tick — batas per-tick ikut naik diam-diam saat
  // tick dipercepat (30s → 10s berarti 12 call/menit), dan GT dipakai bersama lane discovery di IP
  // yang sama. Pos TERTUA TIDAK LAGI DIDAHULUKAN: diurut dari yang TERMUDA, karena posisi baru
  // adalah yang paling mungkin sedang mengalami penarikan LP (temuan jejak rug 2026-10-09: 82%
  // korban rug tidak punya angka likuiditas sama sekali).
  const poolMarks = new Map<string, { priceUsd: number | null; liqUsd: number | null }>();
  {
    gtPoolCallTimes = gtPoolCallTimes.filter((t) => now - t < 120_000);
    const byYoungest = Object.values(st.variants).flatMap((vs) => vs.positions).sort((a, b) => b.openedAt - a.openedAt);
    for (const pos of byYoungest) {
      if (gtPoolCallTimes.length >= 6) break;
      if (marks.has(pos.token) || !pos.pool || poolMarks.has(pos.pool)) continue;
      if (pos.poolLiqAt && now - pos.poolLiqAt < 120_000) continue;
      gtPoolCallTimes.push(now);
      // maxWait 0: kalau GT sedang cooldown, LEWATI tick ini — jangan menunggu 45 detik di dalam
      // tick mark (terukur: itu yang membuat jeda mark melonjak ke ~57-61 detik). Tick berikutnya
      // (10 detik lagi) mencoba lagi; nilai likuiditas tersimpan tetap dipakai sampai ada yang baru.
      const m = await gtPoolMark(pos.pool, 0);
      if (m) poolMarks.set(pos.pool, { priceUsd: m.priceUsd, liqUsd: m.liqUsd });
    }
  }
  let exits = 0;
  for (const v of VARIANTS) {
    const vs = st.variants[v.id] as VariantState;
    for (const pos of [...vs.positions]) {
      const mk = marks.get(pos.token);
      const gt = gtMarks.get(pos.token);
      const pm = poolMarks.get(pos.pool);
      // Harga: prioritas Dex (per-pair) → GT per-pool (per-pool) → GT multi (token-level).
      const price = mk?.priceUsd ?? pm?.priceUsd ?? gt?.priceUsd ?? null;
      // Likuiditas PER-POOL saja (bukan total multi-pool) — angka inilah yang sebanding dgn entry.
      // PENGUKURAN SEGAR dipisahkan dari nilai TERSIMPAN: perisai likuiditas hanya boleh memutuskan
      // dari angka yang benar-benar diukur tick ini (menghindari keputusan dari nilai basi), dan
      // sumbernya dicatat supaya perbandingan Dex-pair vs GT-per-pool bisa dilacak saat menyala.
      // DUA nilai likuiditas, sengaja dipisah (2026-10-09) supaya model biaya tidak pernah memakai
      // skala yang salah:
      //  • perPoolLiq  — HANYA sumber per-pool (dex/gt-pool). Dipakai untuk SLIPPAGE keluar, aturan
      //    pool_mati, dan baris RH_CLOSE → harus sebanding dengan likuiditas entry.
      //  • shieldLiq   — boleh GT multi (total semua pool). HANYA untuk perisai likuiditas, dan
      //    hanya dibandingkan dengan baseline dari SUMBER YANG SAMA.
      const freshPerPool: number | null = mk?.liqUsd ?? pm?.liqUsd ?? null;
      const freshPerPoolSrc: "dex" | "gt-pool" | null = mk?.liqUsd != null ? "dex" : pm?.liqUsd != null ? "gt-pool" : null;
      let perPoolLiq: number | null = freshPerPool ?? pos.poolLiqUsd ?? null;
      if (freshPerPool != null) { pos.poolLiqUsd = freshPerPool; pos.poolLiqAt = now; pos.poolLiqSrc = freshPerPoolSrc ?? undefined; }
      const shieldLiq: number | null = freshPerPool ?? gt?.liqUsd ?? null;
      const shieldSrc: "dex" | "gt-pool" | "gt-multi" | null = freshPerPoolSrc ?? (gt?.liqUsd != null ? "gt-multi" : null);
      // Baseline per-sumber = pengamatan PERTAMA untuk sumber itu. Perbandingan relatif di dalam
      // sumber yang sama tetap sah walau skala antar-indexer berbeda (Dex per-pair vs GT total).
      if (shieldLiq != null && shieldSrc && shieldLiq > 0) {
        pos.liqBase = pos.liqBase ?? {};
        if (!pos.liqBase[shieldSrc]) pos.liqBase[shieldSrc] = { v: shieldLiq, at: now };
      }
      if (price == null) {
        if (now - pos.lastMarkAt > STALE_MARK_MS) { closePosition(st, v, vs, pos, pos.lastPrice, perPoolLiq, "mark_basi", now); exits++; }
        continue;
      }
      pos.lastPrice = price; pos.lastMarkAt = now;
      pos.peakPrice = Math.max(pos.peakPrice, price);
      pos.recentMarks = [...(pos.recentMarks ?? []), { t: now, p: price, liq: shieldLiq, src: shieldSrc }].slice(-6);
      const stopPrice = pos.entryPrice * (1 - pos.stopPct / 100);
      if (perPoolLiq != null && perPoolLiq < Math.max(2_000, (pos.entryLiqUsd ?? 0) * 0.15)) { closePosition(st, v, vs, pos, price, perPoolLiq, "pool_mati", now); exits++; continue; }
      // PERISAI LIKUIDITAS (kohort-4, 2026-10-09): keluar SEBELUM harga menyentuh stop ketika
      // likuiditas per-pool turun sekian fraksi dari likuiditas MASUK. Diletakkan sengaja SEBELUM
      // cek stop harga: kerugian terbesar studi berasal dari harga yang GAP melewati stop ($845)
      // dan pool yang mati ($773), sementara LP yang ditarik bertahap terbaca di likuiditas lebih dulu.
      if (v.exitLiqDropPct != null && shieldLiq != null && shieldSrc) {
        // ACUAN, konsisten-sumber: likuiditas ENTRY kalau sumbernya sebanding (dex/gt-pool = per-pool);
        // kalau tidak (gt-multi = total semua pool), pakai BASELINE dari sumber yang sama —
        // perbandingan relatif, bukan absolut, sehingga skala yang berbeda tidak menciptakan alarm palsu.
        const entryRef = (shieldSrc === "dex" || shieldSrc === "gt-pool") && pos.entryLiqUsd != null && pos.entryLiqUsd > 0 ? pos.entryLiqUsd : null;
        const baseRef = pos.liqBase?.[shieldSrc]?.v ?? null;
        const ref = entryRef ?? baseRef;
        const refSrc = entryRef != null ? "entry" : baseRef != null ? `baseline-${shieldSrc}` : null;
        if (ref != null && shieldLiq < ref * (1 - v.exitLiqDropPct)) {
          logRecord("rh-events", { type: "rh-liq-shield", token: pos.token, symbol: pos.symbol, variant: v.id, entryLiqUsd: pos.entryLiqUsd, refUsd: ref, refSrc, nowLiqUsd: shieldLiq, liqSrc: shieldSrc, dropPct: Number((1 - shieldLiq / ref).toFixed(3)), price, cohort: COHORT4, cfg: configHash });
          // Exit memakai angka PER-POOL untuk slippage (bukan total GT) — model biaya konsisten.
          closePosition(st, v, vs, pos, price, perPoolLiq ?? shieldLiq, "liq_shield", now); exits++; continue;
        }
      }
      // KOHORT-9: sebagian arm SENGAJA tanpa pengecekan stop harga — perlindungannya dari rantai
      // (likuiditas/harga on-chain) dan batas hold. stopPct TIDAK diubah supaya sizing tetap sebanding.
      if (!v.noPriceStop && price <= stopPrice) { closePosition(st, v, vs, pos, price, perPoolLiq, "stop_loss", now); exits++; continue; }
      // KOHORT-7 (2026-10-11): TP boleh DITAHAN beberapa tick sebelum dijual. Kontrol (tpHoldTicks
      // 0) berperilaku PERSIS seperti sebelumnya; arm tahan baru menjual setelah harga bertahan di
      // atas ambang — memisahkan "menjual di puncak" dari "menjual pada lonjakan yang tak bisa dijual".
      if (pos.tpPct != null && price >= pos.entryPrice * (1 + pos.tpPct / 100)) {
        pos.tpHoldCount = nextTpHoldStreak(pos.tpHoldCount ?? 0, true);
        if (tpHoldSatisfied(pos.tpHoldCount, v.tpHoldTicks ?? 0)) {
          closePosition(st, v, vs, pos, price, perPoolLiq, "take_profit", now); exits++; continue;
        }
      } else if (pos.tpHoldCount) {
        pos.tpHoldCount = nextTpHoldStreak(pos.tpHoldCount, false);
      }
      if (pos.trailFromPct != null && pos.trailPct != null && pos.peakPrice >= pos.entryPrice * (1 + pos.trailFromPct / 100)) {
        const trailStop = pos.peakPrice * (1 - pos.trailPct / 100);
        if (price <= trailStop) { closePosition(st, v, vs, pos, price, perPoolLiq, "trailing", now); exits++; continue; }
      }
      if ((now - pos.openedAt) / 60_000 >= pos.maxHoldMin) { closePosition(st, v, vs, pos, price, perPoolLiq, "max_hold", now); exits++; continue; }
    }
  }
  return exits;
}

/**
 * KELUAR KARENA RANTAI (celah #1): baca liquidity()+slot0() untuk pool yang sedang dipegang, dan
 * keluar SEBELUM harga menyentuh stop bila (a) likuiditas hilang ≥ ambang atau (b) harga on-chain
 * jatuh ≥ ambang terhadap acuan. Harga keluar memakai mark terakhir (konservatif) — yang diperbaiki
 * jalur ini adalah WAKTUNYA, bukan model harganya, dan itu akan terlihat di rh:stop/rh:realism.
 */
async function onchainExits(st: State, now: number): Promise<void> {
  if (!ONCHAIN_ENABLED) return;
  st.onchainBase = st.onchainBase ?? {};
  st.onchainCheckedAt = st.onchainCheckedAt ?? {};
  // 1) kumpulkan pool yang jatuh tempo — SATU kali per pool, secepat mungkin dikirim sebagai batch
  const due = new Map<string, { v: Variant; vs: VariantState; pos: Position }>();
  for (const v of VARIANTS) {
    const vs = st.variants[v.id] as VariantState;
    for (const pos of [...vs.positions]) {
      if (!pos.pool || due.has(pos.pool)) continue;
      if (now < (st.onchainSkipUntil?.[pos.pool] ?? 0)) continue; // circuit-breaker: pool dilewati
      if (now - (st.onchainCheckedAt[pos.pool] ?? 0) < ONCHAIN_POLL_MS) continue;
      due.set(pos.pool, { v, vs, pos });
    }
  }
  if (!due.size) return;
  const pools = [...due.keys()];
  for (const pl of pools) st.onchainCheckedAt[pl] = now;
  // 2) SATU permintaan HTTP untuk semua pool (akar HTTP 403: dulu 2 panggilan per pool per tick)
  const hasil = await readPoolsBatch(ONCHAIN_RPC, pools);
  let changed = true; // jejak cek berubah → disimpan supaya rem laju bertahan antar-tick
  for (const h of hasil) {
    const ctx = due.get(h.pool);
    if (!ctx) continue;
    if (!h.ok) {
      const gagal = (st.onchainFails?.[h.pool] ?? 0) + 1;
      st.onchainFails = { ...(st.onchainFails ?? {}), [h.pool]: gagal };
      // jejak waktu gagal (1 jam terakhir) untuk trip berbasis jendela
      const jam = now - 3_600_000;
      const jejak = [...((st.onchainFailTimes ?? {})[h.pool] ?? []).filter((t) => t >= jam), now];
      st.onchainFailTimes = { ...(st.onchainFailTimes ?? {}), [h.pool]: jejak };
      if (gagal >= ONCHAIN_FAIL_LIMIT || jejak.length >= ONCHAIN_FAIL_WINDOW_N) {
        st.onchainSkipUntil = { ...(st.onchainSkipUntil ?? {}), [h.pool]: now + ONCHAIN_SKIP_MS };
        logRecord("rh-events", { type: "rh-onchain-skip", pool: h.pool, gagal, dilewatiJam: Number((ONCHAIN_SKIP_MS / 3_600_000).toFixed(1)), reasonTerakhir: h.reason, cfg: configHash });
      } else {
        const sudah = (st.onchainFailLogged ?? {})[h.pool];
        if (!sudah || now - sudah > 600_000) {
          logRecord("rh-events", { type: "rh-onchain-fail", pool: h.pool, reason: h.reason, gagalKe: gagal, cfg: configHash });
          st.onchainFailLogged = { ...(st.onchainFailLogged ?? {}), [h.pool]: now };
        }
      }
      continue;
    }
    // berhasil → hitungan gagal beruntun direset (pool sehat lagi)
    if ((st.onchainFails?.[h.pool] ?? 0) > 0) st.onchainFails = { ...(st.onchainFails ?? {}), [h.pool]: 0 };
    const snap: OnchainSnapshot = { pool: h.pool, liq: h.liq as bigint, sqrtPriceX96: h.sqrtPriceX96 as bigint, block: 0, at: now };
    const base = st.onchainBase[h.pool];
    if (!base) {
      st.onchainBase[h.pool] = { liq: snap.liq.toString(), sqrtPriceX96: snap.sqrtPriceX96.toString(), at: now };
      continue;
    }
    const drop = liquidityDropPct(BigInt(base.liq), snap.liq);
    const rasioHarga = priceRatio(BigInt(base.sqrtPriceX96), snap.sqrtPriceX96);
    // OBSERVASI: penurunan mendekati ambang dicatat sebagai DATA (tidak keluar) — supaya pertanyaan
    // "seberapa sering pool turun tajam?" bisa dijawab sebelum ambang 35% pernah tersentuh.
    if (drop >= ONCHAIN_WATCH_PCT && drop < ONCHAIN_DROP_PCT) {
      const sudah = (st.onchainFailLogged ?? {})[`watch:${h.pool}`];
      if (!sudah || now - sudah > 600_000) {
        logRecord("rh-events", {
          type: "rh-onchain-watch", pool: h.pool, symbol: ctx.pos.symbol, variant: ctx.v.id,
          liqBefore: base.liq, liqNow: snap.liq.toString(), dropPct: Number(drop.toFixed(4)),
          hargaRasio: Number(rasioHarga.toFixed(4)), ambangKeluar: ONCHAIN_DROP_PCT, cfg: configHash,
        });
        st.onchainFailLogged = { ...(st.onchainFailLogged ?? {}), [`watch:${h.pool}`]: now };
      }
    }
    const reason = onchainExitReason(snap, base, ONCHAIN_DROP_PCT);
    if (!reason) continue;
    logRecord("rh-events", {
      type: "rh-onchain-liq", reason, token: ctx.pos.token, symbol: ctx.pos.symbol, variant: ctx.v.id, pool: h.pool,
      liqBefore: base.liq, liqNow: snap.liq.toString(), dropPct: ONCHAIN_DROP_PCT,
      sqrtBefore: base.sqrtPriceX96, sqrtNow: snap.sqrtPriceX96.toString(),
      src: "chain-rh-v3", cohort: st.cohort, cfg: configHash,
    });
    closePosition(st, ctx.v, ctx.vs, ctx.pos, ctx.pos.lastPrice, ctx.pos.poolLiqUsd ?? ctx.pos.entryLiqUsd ?? null, reason, now);
  }
  if (changed) saveState(st, "onchain");
}

/**
 * Ambil mark pasca-keluar untuk jejak yang slot waktunya sudah jatuh tempo (1/3/5 menit).
 *
 * Anggaran jaringan sengaja kecil: SATU panggilan batch per tick untuk semua token yang jatuh tempo
 * (biasanya 1–3). Kalau jaringan gagal, slot itu dicoba lagi tick berikutnya — tidak pernah
 * mengarang angka, dan jejak yang tak lengkap tetap dilaporkan dengan penanda `complete: false`.
 */
async function capturePostExit(st: State, now: number): Promise<void> {
  // JEJAK DIAMBIL DARI BERKAS (2026-10-11): instrumentasi menunjukkan penulis `mark` 17 kali
  // mencoba menulis salinan yang TIDAK memuat jejak (punyaku=0, berkas=1) — salinan memori di awal
  // tick kadang belum memuatnya, sehingga slot mark tak pernah maju. Berkas adalah sumbernya; baru
  // sesudah itu keputusan slot dijalankan.
  let traces = st.markTrace ?? [];
  let adopted = false;
  try {
    const disk = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { markTrace?: MarkTrace[] };
    if ((disk.markTrace?.length ?? 0) > traces.length) {
      traces = disk.markTrace!;
      adopted = true;
    }
  } catch { /* state belum ada */ }
  if (!traces.length) return;
  const dueTokens = new Set<string>();
  for (const t of traces) if (shouldCaptureNow(t.marks.length, now - t.closedAt)) dueTokens.add(t.token);
  let marks = new Map<string, { priceUsd: number | null; liqUsd: number | null }>();
  if (dueTokens.size) {
    try {
      marks = (await markTokens([...dueTokens])) as Map<string, { priceUsd: number | null; liqUsd: number | null }>;
    } catch { /* jaringan — slot ini dicoba lagi tick berikutnya */ }
  }
  let changed = false;
  const keep: MarkTrace[] = [];
  for (const t of traces) {
    const elapsed = now - t.closedAt;
    if (shouldCaptureNow(t.marks.length, elapsed)) {
      const m = marks.get(t.token);
      if (m) {
        t.marks.push({ t: now, p: m.priceUsd, liq: m.liqUsd });
        changed = true;
      }
    }
    if (traceFinished(t.marks.length, elapsed)) {
      logRecord("rh-events", {
        type: "rh-mark-after", token: t.token, symbol: t.symbol, variant: t.variant, life: t.life, reason: t.reason,
        closedAt: new Date(t.closedAt).toISOString(), exitPriceUsd: t.exitPriceUsd, marks: t.marks,
        complete: t.marks.length >= 3, cohort: st.cohort, cfg: configHash,
      });
      changed = true;
    } else keep.push(t);
  }
  if (changed) {
    st.markTrace = keep.slice(-MARK_TRACE_MAX);
    saveState(st, "open");
  }
}

/**
 * Mark + exit saja, tanpa discovery/entry. Kalau siklus penuh sedang berjalan, tick ini MENUNGGU
 * (maks 20 detik) alih-alih dilewatkan begitu saja.
 *
 * BUG YANG DITUTUP (2026-10-09): dulu `if (busy) return;` — dan siklus penuh memegang kunci selama
 * fase discovery yang bisa tertahan cooldown GT 429 (45 detik+). Terukur: mark BERHENTI TOTAL
 * (0 detik kemajuan dalam 60 detik) padahal intervalnya 10 detik, sehingga "mark rapat" hanya jadi
 * angka di log, bukan kenyataan. Sekarang mark menunggu, lalu tetap jalan begitu kunci lepas —
 * dan penantian panjang tercatat sebagai event supaya kelaparan tick tidak pernah tak terlihat lagi.
 */
async function markTick(): Promise<void> {
  const waitStart = Date.now();
  for (let i = 0; i < 40 && busy; i++) await sleep(500);
  if (busy) {
    logRecord("rh-events", { type: "rh-mark-starved", waitedMs: Date.now() - waitStart, cohort: COHORT, cfg: configHash });
    ui.warn(`[rh-paper] mark dilewati: kunci masih dipegang siklus setelah ${((Date.now() - waitStart) / 1000).toFixed(0)}s`);
    return;
  }
  busy = true;
  const heldMs = Date.now() - waitStart;
  try {
    const st = loadState();
    const now = Date.now();
    const exits = await markAndExit(st, now);
    exitsSinceCycle += exits;
    saveState(st, "mark"); // lastMarkAt/peak ikut tersimpan supaya staleness & audit akurat
    // JEJAK PASCA-KELUAR: dijalankan SETELAH state tersimpan, dengan anggaran jaringan kecil
    // (hanya token yang slot waktunya jatuh tempo) supaya kadens mark tidak terganggu.
    await capturePostExit(st, now);
    await onchainExits(st, now);
    // REKONSILIASI BERKALA (2026-10-13, audit temuan D): dulu hanya saat lane start, sehingga kelas
    // "posisi tanpa catatan" membuat audit merah sampai restart berikutnya. Sekarang menyembuhkan
    // diri tiap 30 menit — memakai fungsi yang SUDAH diuji, bukan logika baru.
    const REKONSILIASI_MS = 30 * 60_000;
    if (now - (st.lastReconcileAt ?? 0) > REKONSILIASI_MS) {
      st.lastReconcileAt = now;
      try { reconcileLedgerOnStart(st); } catch (e) { logRecord("rh-events", { type: "rh-reconcile-error", reason: String((e as Error).message ?? "").slice(0, 90), cfg: configHash }); }
      saveState(st, "reconcile-periodic");
    }
    if (exits) logRecord("rh-events", { type: "rh-mark", exits, cohort: st.cohort, cfg: configHash });
    // Penantian >5 detik berarti mark tertahan fase lain — catat supaya kadens nyatanya terbaca.
    if (heldMs > 5_000) logRecord("rh-events", { type: "rh-mark-delayed", waitedMs: heldMs, cohort: st.cohort, cfg: configHash });
  } catch (e) {
    ui.warn(`[rh-paper] mark tick gagal: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

async function cycle(): Promise<void> {
  // DUA kunci terpisah (2026-10-09): `cycleRunning` menjaga agar tidak ada dua siklus tumpang tindih,
  // sementara `busy` hanya menjaga MUTASI STATE. Fase discovery (I/O panjang, bisa tertahan cooldown
  // GT) berjalan TANPA `busy` supaya tick mark tidak pernah kelaparan karenanya.
  if (cycleRunning) { ui.warn("[rh-paper] siklus sebelumnya belum selesai — lewati"); return; }
  cycleRunning = true;
  const t0 = Date.now();
  try {
    const discovered = await discoverPools({ topPages: DISCOVERY_TOP_PAGES });
    if (!discovered.length) { ui.warn("[rh-paper] discovery kosong (rate limit?) — siklus dilewati"); return; }

    // Token tanpa harga/likuiditas dari GT (biasanya jalur dex-promoted) → ambil via mark batch.
    const needsEnrich = discovered.filter((m) => m.priceUsd == null || m.liqUsd == null).map((m) => m.tokenAddress);
    if (needsEnrich.length) {
      const marks = await markTokens(needsEnrich.slice(0, 60));
      for (const m of discovered) {
        const mk = marks.get(m.tokenAddress);
        if (!mk) continue;
        if (m.priceUsd == null) m.priceUsd = mk.priceUsd;
        if (m.liqUsd == null) m.liqUsd = mk.liqUsd;
        if ((!m.symbol || m.symbol === "?") && mk.symbol) m.symbol = mk.symbol; // riset: simbol nyata > "?"
        for (const k of Object.keys(mk.chg)) if (m.chg[k] == null) m.chg[k] = mk.chg[k] ?? null;
      }
    }

    // ── FASE A (TANPA kunci): evaluasi kandidat + susun antrean pengayaan. Nol I/O jaringan. ──
    // State hanya DIBACA di sini; gerbang presisi (top10) tetap melihat pengayaan yang sudah ada.
    const stRead = loadState();
    const nowA = Date.now();
    const observed = discovered.filter((m) => (m.liqUsd ?? 0) >= 5_000).slice(0, 40);
    const enrichQueue: PoolMetrics[] = [];
    // ANTREAN PRIORITAS (2026-10-09): varian presisi (v28, gate top10) FAIL-CLOSED menunggu data
    // pengayaan — dan antrean lama hanya berisi kandidat yang lolos varian LAIN, sehingga v28
    // menunggu data yang tak pernah datang (terukur: 0 trade). Kandidat yang SATU-SATUNYA
    // penghalangnya adalah data itu sekarang masuk antrean terdepan, supaya hipotesisnya bisa diuji.
    const enrichDecisive: PoolMetrics[] = [];
    for (const m of observed) {
      const accepted: string[] = [], rejected: Record<string, string> = {};
      for (const v of VARIANTS) {
        const r = rejects(v, m, Date.now(), stRead.gmgnInfo[m.tokenAddress]);
        if (r) rejected[v.id] = r; else accepted.push(v.id);
      }
      if (accepted.length) enrichQueue.push(m); // prioritas enrichment: kandidat yang lolos ≥1 filter
      const decisive = VARIANTS.some((v) => (v.minTop10Pct != null || v.maxTop10Pct != null) && rejects(v, m, Date.now(), null) === TOP10_MISSING_REASON);
      if (decisive) enrichDecisive.push(m);
      logRecord("rh-events", {
        type: "rh-candidate", token: m.tokenAddress, symbol: m.symbol, pool: m.poolAddress, dex: m.dex,
        priceUsd: m.priceUsd, liqUsd: m.liqUsd, mcUsd: m.mcUsd, ageMin: ageMinOf(m, nowA),
        vol1hUsd: m.vol["h1"] ?? null, vol6hUsd: m.vol["h6"] ?? null, vol24Usd: m.vol["h24"] ?? null,
        buys1h: m.buys["h1"] ?? null, sells1h: m.sells["h1"] ?? null, buyRatio1h: buyRatio1h(m),
        ch1: m.chg["h1"] ?? null, ch6: m.chg["h6"] ?? null, ch24: m.chg["h24"] ?? null,
        acceptedBy: accepted, rejected, sources: m.sources.join("+"), cfg: configHash,
      });
    }

    // ── FASE B (TANPA kunci): pengayaan GMGN — I/O jaringan paling lambat di siklus ini. ──
    // DIPINDAH KE LUAR KUNCI (2026-10-09): dulu ia berjalan DI DALAM `busy`; pace GMGN 10 detik per
    // call × 2 call cukup untuk menahan tick mark sampai ~70 detik (terukur), dan itu justru bagian
    // yang paling butuh mark rapat. Sekarang mark hanya menunggu FASE C, yang tanpa jaringan.
    const seenTargets = new Set<string>();
    const enrichTargets = [...enrichDecisive, ...enrichQueue.sort((a, b) => (b.vol["h1"] ?? 0) - (a.vol["h1"] ?? 0))]
      .filter((m) => {
        if (seenTargets.has(m.tokenAddress)) return false;
        seenTargets.add(m.tokenAddress);
        const info = stRead.gmgnInfo[m.tokenAddress];
        if (info && Date.now() - info.at < ENRICH_TTL_MS) return false;
        const tried = stRead.gmgnTried[m.tokenAddress];
        return !(tried && Date.now() - tried < 30 * 60_000);
      })
      .slice(0, ENRICH_MAX);
    const enrichDone: Array<{ m: PoolMetrics; sig: RugSignals }> = [];
    const enrichFailed: string[] = [];
    if (gmgnEnabled && ENRICH_MAX > 0) {
      for (const m of enrichTargets) {
        const sig = await fetchRugSignals(m.tokenAddress);
        if (!sig) { enrichFailed.push(m.tokenAddress); continue; }
        enrichDone.push({ m, sig });
      }
    }

    // ── FASE C (KUNCI): gabungkan pengayaan + gerbang + entry + simpan. Nol I/O jaringan. ──
    for (let i = 0; i < 120 && busy; i++) await sleep(500);
    busy = true;
    const st = loadState();
    const now = Date.now();
    // Gagal (proxy cooldown / kosong) → dicoba lagi setelah 30 menit; sukses → disimpan TTL 6 jam.
    for (const t of enrichFailed) st.gmgnTried[t] = Date.now();
    for (const { m, sig } of enrichDone) {
      st.gmgnTried[m.tokenAddress] = Date.now();
      st.gmgnInfo[m.tokenAddress] = sig;
      const flags = rugFlags(sig);
      logRecord("rh-events", {
        type: "rh-gmgn-enrich", token: m.tokenAddress, symbol: m.symbol, flags,
        holders: sig.holders, top10Pct: sig.top10HolderPct, honeypot: sig.honeypot, burnStatus: sig.burnStatus,
        buyTax: sig.buyTax, sellTax: sig.sellTax, bundlerPct: sig.topBundlerPct, ratPct: sig.topRatPct,
        smartWallets: sig.smartWallets, renownedWallets: sig.renownedWallets, sniperWallets: sig.sniperWallets,
        devStatus: sig.devCreatorStatus, devOpenCount: sig.devOpenCount, cohort: st.cohort, cfg: configHash,
      });
      ui.info(`[rh-paper] sinyal rug ${m.symbol}: ${flags.join(" ") || "tanpa tanda bahaya"}`);
      // Kalau token yang SUDAH dipegang ternyata honeypot: catat terang-terangan. Exit tetap
      // jalan lewat aturan normal (kita tidak bisa memodelkan "tidak bisa dijual" dengan jujur
      // hanya dari satu flag) — tapi pembaca laporan harus tahu posisi itu ada.
      if (sig.honeypot === true || sig.honeypot === 1) {
        const heldBy = VARIANTS.filter((v) => (st.variants[v.id] as VariantState).positions.some((p) => p.token === m.tokenAddress)).map((v) => v.id);
        if (heldBy.length) {
          logRecord("rh-events", { type: "rh-honeypot-held", token: m.tokenAddress, symbol: m.symbol, heldBy, cohort: st.cohort, cfg: configHash });
          ui.warn(`[rh-paper] PERINGATAN: ${m.symbol} ditandai honeypot tapi sudah dipegang ${heldBy.join(",")} — exit tetap jalan, hasilnya harus dibaca hati-hati`);
        }
      }
    }

    // MARK + exit: TIDAK lagi dijalankan di sini (2026-10-09). Dulu baris ini memanggil markAndExit,
    // yang bisa `await` cooldown GT 45 detik DI DALAM kunci `busy` — akibatnya tick mark 10 detik
    // ikut tertahan (terukur: jeda sampai 88 detik, dan sesekali berhenti total). Jalur exit tunggal
    // sekarang adalah tick 10 detik; siklus hanya MELAPORKAN berapa exit yang terjadi sejak siklus lalu.
    const exits = exitsSinceCycle;
    exitsSinceCycle = 0;

    // ENTRY: kandidat diurut likuiditas volume 1j; tiap varian mengambil yang lolos filternya.
    // HONEYPOT = BLOKIR KERAS (2026-10-07, permintaan owner): honeypot bukan "sinyal untuk
    // diukur" — membelinya berarti kerugian total yang pasti (kontrak menolak jual). Token yang
    // diblokir TETAP tercatat sebagai kandidat & kesempatan terlewat, jadi akurasi flag GMGN
    // masih bisa diverifikasi dari pergerakan harganya, tanpa mempertaruhkan modal.
    const ranked = [...discovered].sort((a, b) => (b.vol["h1"] ?? 0) - (a.vol["h1"] ?? 0) || (b.vol["h24"] ?? 0) - (a.vol["h24"] ?? 0));
    let opened = 0, honeypotBlockedNow = 0;
    for (const v of VARIANTS) {
      const vs = st.variants[v.id] as VariantState;
      // SELAMAT: equity pulih ≥ ambang sebelum life baru dimulai → batal bankrut, lanjut life yang sama.
      if (vs.bankruptAt && vs.equityUsd >= BANKRUPT_EQUITY) {
        logRecord("rh-events", { type: "rh-life-recovered", variant: v.id, equityUsd: Number(vs.equityUsd.toFixed(2)), life: vs.life, cohort: st.cohort, cfg: configHash });
        ui.info(`[rh-paper] ${v.id} pulih ≥ $${BANKRUPT_EQUITY} — batal bankrut, life ${vs.life} lanjut`);
        vs.bankruptAt = undefined;
      }
      // BANKRUT: modal < $4 → tak mampu posisi minimum $2. Entry berhenti; posisi terbuka tetap
      // dikelola sampai habis; baru SETELAH itu life baru dimulai (Life-2, keputusan owner).
      if (vs.equityUsd < BANKRUPT_EQUITY || vs.bankruptAt) {
        if (!vs.bankruptAt) {
          vs.bankruptAt = Date.now();
          logRecord("rh-paper", {
            action: "RH_BANKRUPT", variant: v.id, variantLabel: v.label, equityUsd: Number(vs.equityUsd.toFixed(2)),
            trades: vs.trades, wins: vs.wins, losses: vs.losses, maxDdPct: vs.maxDdPct, life: vs.life, cohort: st.cohort, cfg: configHash,
          });
          ui.warn(`[rh-paper] ${v.id} BANKRUT: equity $${vs.equityUsd.toFixed(2)} — entry berhenti, posisi terbuka diselesaikan dulu`);
        }
        if (AUTO_LIFE && vs.positions.length === 0) {
          const closed: LifeRecord = {
            life: vs.life, startedAt: vs.lifeStartedAt, endedAt: Date.now(), endEquityUsd: Number(vs.equityUsd.toFixed(2)),
            trades: vs.trades, wins: vs.wins, losses: vs.losses, reason: "bankrut",
          };
          vs.lifeHistory.push(closed);
          vs.life += 1; vs.lifeStartedAt = Date.now();
          vs.equityUsd = START_EQUITY_USD; vs.peakEquityUsd = START_EQUITY_USD; vs.maxDdPct = 0; vs.realizedUsd = 0;
          // Cooldown per-token SENGAJA TIDAK dihapus saat life restart: memori "token ini baru saja
          // keluar" harus bertahan lintas life, kalau tidak life baru bisa langsung membeli ulang
          // token yang barusan merugikan (menghapus satu-satunya proteksi re-entry).
          vs.trades = 0; vs.wins = 0; vs.losses = 0; vs.bankruptAt = undefined;
          logRecord("rh-paper", {
            action: "RH_LIFE", variant: v.id, variantLabel: v.label, life: vs.life, previousLifeEndEquityUsd: closed.endEquityUsd,
            previousLifeTrades: closed.trades, startEquityUsd: START_EQUITY_USD, cohort: st.cohort, cfg: configHash,
          });
          ui.warn(`[rh-paper] ${v.id} LIFE ${vs.life} dimulai: modal $${START_EQUITY_USD} (life ${vs.life - 1} berakhir $${closed.endEquityUsd})`);
        }
        continue;
      }
      // KOHORT-11: selesaikan limit yang menunggu dengan harga SIKLUS INI (tanpa melihat masa depan).
      try {
        const lf = limitFilePath(config.logDir);
        const loaded = loadPending(lf);
        if (loaded.corrupt) logRecord("rh-events", { type: "rh-limit-store-corrupt", cohort: COHORT11, cfg: configHash });
        if (loaded.items.length) {
          const priceMap = new Map<string, number>();
          for (const mm of ranked) priceMap.set(mm.tokenAddress, mm.priceUsd as number);
          const res = settle(loaded.items, (t) => priceMap.get(t) ?? null, Date.now());
          for (const f of res.filled) {
            logRecord("rh-events", { type: "rh-limit-fill", variant: f.armId, token: f.token, fillPrice: f.fillPrice, targetPrice: f.targetPrice, cohort: COHORT11, cfg: configHash });
            const mm = ranked.find((x) => x.tokenAddress === f.token);
            const vv = VARIANTS.find((x) => x.id === f.armId);
            if (mm && vv && f.fillPrice != null) openPosition(st, vv, mm, Date.now(), f.fillPrice);
          }
          for (const x of res.expired) logRecord("rh-events", { type: "rh-limit-expire", variant: x.armId, token: x.token, cohort: COHORT11, cfg: configHash });
          savePending(lf, res.items);
        }
      } catch (e) {
        logRecord("rh-events", { type: "rh-limit-error", msg: String(e && (e as Error).message ? (e as Error).message : e).slice(0, 140), cohort: COHORT11, cfg: configHash });
      }
      for (const m of ranked) {
        if (rejects(v, m, now, st.gmgnInfo[m.tokenAddress]) !== null) continue;
        const sig = st.gmgnInfo[m.tokenAddress];
        if (sig && (sig.honeypot === true || sig.honeypot === 1)) {
          honeypotBlockedNow++;
          if (!st.honeypotBlocked[m.tokenAddress]) {
            st.honeypotBlocked[m.tokenAddress] = Date.now();
            logRecord("rh-events", {
              type: "rh-honeypot-block", token: m.tokenAddress, symbol: m.symbol, variant: v.id, variantLabel: v.label,
              flags: rugFlags(sig), top10Pct: sig.top10HolderPct, cohort: st.cohort, cfg: configHash,
            });
            ui.warn(`[rh-paper] BLOKIR honeypot: ${m.symbol} (${v.id} mau beli) — tidak dieksekusi`);
          }
          continue;
        }
        // KOHORT-2 GATE: token yang SUDAH diperkaya dan punya flag apa pun ditolak (bukti kohort-1:
        // top10>30% → 89% mati; rat>30% → 100%). Hanya berlaku saat DATA-nya ada — token yang belum
        // diperkaya tidak diblokir (keterbatasan kuota yang diakui, bukan disamarkan).
        if (v.requireCleanGmgn && sig) {
          const flags = rugFlags(sig);
          if (flags.length) {
            const key = `${v.id}|${m.tokenAddress}`;
            if (!st.gateBlocked[key]) {
              st.gateBlocked[key] = Date.now();
              logRecord("rh-events", {
                type: "rh-gate-block", token: m.tokenAddress, symbol: m.symbol, variant: v.id, flags,
                top10Pct: sig.top10HolderPct, cohort: COHORT2, cfg: configHash,
              });
            }
            continue;
          }
        }
        if (RETIRED.has(v.id)) continue; // aturan bunuh: arm yang dipensiunkan tidak lagi membuka posisi
        if (v.requireLivePool && !livePoolOk(m.tokenAddress, LIVEPOOL_CACHE)) {
          logRecord("rh-events", { type: "rh-livepool-block", variant: v.id, token: m.tokenAddress, symbol: m.symbol, cohort: COHORT12, cfg: configHash });
          continue;
        }
        if (v.limitDistPct && v.limitExpiryMin) {
          // KOHORT-11: JANGAN beli di pasar. Daftarkan limit (target = harga × (1 − jarak)) lalu tunggu.
          const pend = (st.limitPending ??= []);
          const dup = pend.some((q) => q.armId === v.id && q.token === m.tokenAddress && q.status === "waiting");
          if (!dup) {
            const item = makePending({ id: v.id + "|" + m.tokenAddress + "|" + now, token: m.tokenAddress, armId: v.id, cohort: COHORT11, signalMs: now, signalPrice: m.priceUsd as number, distPct: v.limitDistPct, expiryMin: v.limitExpiryMin });
            pend.push(item);
            // FIX 2026-10-16: registrasi HARUS ikut ditulis ke berkas pending — settle() membaca berkas,
            // bukan state. Tanpa baris ini: 100 pending terdaftar di state tapi berkas kosong → settle
            // tak pernah melihatnya → fill=0 DAN expire=0 (bug yang terukur malam ini).
            savePending(limitFilePath(config.logDir), pend);
            logRecord("rh-events", { type: "rh-limit-pending", variant: v.id, token: m.tokenAddress, symbol: m.symbol, targetPrice: Number(item.targetPrice.toPrecision(12)), signalPrice: m.priceUsd, cohort: COHORT11, cfg: configHash });
          }
        } else if (openPosition(st, v, m, now)) opened++;
      }
    }

    st.cycles += 1;
    saveState(st, "once");
    const summary = VARIANTS.map((v) => {
      const vs = st.variants[v.id] as VariantState;
      return `${v.id}: eq $${vs.equityUsd.toFixed(0)} pos ${vs.positions.length} trd ${vs.trades} W${vs.wins}/L${vs.losses}`;
    }).join(" | ");
    const openNow = Object.values(st.variants).reduce((a, vs) => a + vs.positions.length, 0);
    logRecord("rh-events", { type: "rh-cycle", n: st.cycles, discovered: discovered.length, observed: observed.length, openTokens: openNow, opened, exits, honeypotBlocked: honeypotBlockedNow, enrichDecisive: enrichDecisive.length, cohort: st.cohort, ms: Date.now() - t0, cfg: configHash });
    ui.info(`[rh-paper] siklus ${st.cycles}: ${discovered.length} pool, ${opened} entry baru, ${openNow} posisi terbuka, ${exits} exit (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    ui.info(`[rh-paper] ${summary}`);
  } catch (e) {
    ui.warn(`[rh-paper] siklus gagal: ${(e as Error).message}`);
  } finally {
    busy = false;
    cycleRunning = false;
  }
}

/**
 * REKONSILIASI LEDGER SAAT STARTUP (2026-10-09).
 *
 * Kenapa perlu: state dan ledger adalah DUA berkas — proses yang berhenti di antara "simpan state"
 * dan "tulis catatan" meninggalkan selisih di salah satu arah. HARI INI terbukti dua arah:
 *   • 9 "posisi hantu" — ledger punya OPEN, state tidak (proses mati sebelum simpan)
 *   • beberapa posisi — state menutup, baris CLOSE hilang (proses mati sebelum catat)
 * Alih-alih menambal manual tiap kali (dan berlomba dengan restart), lane membereskan SENDIRI saat
 * start: baris yang hilang ditulis dengan penanda `reconciled: true` + alasan, sehingga tidak ada
 * yang disembunyikan dan audit bisa menghitungnya terpisah.
 */
function reconcileLedgerOnStart(st: State): void {
  try {
    // Daftar void (dibuat fix-dupes): baris yang SUDAH dinyatakan batal harus diperlakukan sama
    // seperti di audit, kalau tidak kedua sisi menghitung hal yang berbeda.
    const voids = new Set<string>();
    try {
      const j = JSON.parse(readFileSync(join(config.logDir, "rh-paper-voids.json"), "utf8")) as { voids?: Array<{ variant: string; token: string; ts: string }> };
      for (const v of j.voids ?? []) voids.add(`${v.variant}|${v.token}|${v.ts}`);
    } catch { /* belum ada */ }
    const files = readdirSync(config.logDir).filter((f) => f.startsWith("rh-paper-") && f.endsWith(".jsonl")).sort();
    void files;
    // SATU RUMUS (2026-10-10): paritas dihitung modul bersama ledger-parity.ts — modul yang SAMA
    // dipakai audit. Sebelum ini rekonsiliasi memakai baris NYATA sementara audit memakai baris
    // EFEKTIF, sehingga rekonsiliasi menulis penyeimbang yang tidak pernah memuaskan audit → berputar.
    const heldRaw = new Map<string, number>();
    for (const [id, vs] of Object.entries(st.variants)) {
      for (const p of vs.positions ?? []) heldRaw.set(`${id}|${p.token}`, (heldRaw.get(`${id}|${p.token}`) ?? 0) + 1);
    }
    const parityRows = readParityRows(config.logDir, voids);
    // LIFE LEBIH BARU DI LEDGER (2026-10-10): ledger bersifat append-only dan memuat nomor life di
    // tiap barisnya, jadi ia sumber kebenaran untuk life. Kalau state tertinggal (tersangka: tulisan
    // state basi SEBELUM penjaga monotonik dipasang), state diselaraskan ke life ledger dan equity
    // life itu dibangun ulang dari baris bersih. Posisi life lama dikosongkan — ia memang sudah mati.
    const maxLife = new Map<string, number>();
    for (const r of parityRows) {
      const isOpen = r.action === "RH_OPEN" && !r.reconciled;
      const isLife = r.action === "RH_LIFE";
      // Baris CLOSE juga diperhitungkan: kalau proses sempat menutup posisi pada life yang lebih baru
      // tetapi tulisan state-nya hilang, hanya baris CLOSE inilah yang memberi tahu bahwa life itu ada.
      const isClose = r.action === "RH_CLOSE" && !r.reconciled;
      if (!r.variant || (!isOpen && !isLife && !isClose)) continue;
      maxLife.set(r.variant, Math.max(maxLife.get(r.variant) ?? 1, r.life ?? 1));
    }
    let lifeFixed = 0;
    for (const [id, ml] of maxLife) {
      const vs = st.variants[id];
      if (!vs || (vs.life ?? 1) >= ml) continue;
      const mine = parityRows.filter((r) => r.variant === id && r.action === "RH_CLOSE" && !r.reconciled && (r.life ?? 1) === ml);
      const pnl = mine.reduce((a, c) => a + Number((c as { pnlUsd?: number }).pnlUsd ?? 0), 0);
      ui.warn(`[rh-paper] life state tertinggal: ${id} state ${vs.life ?? 1} → ledger ${ml} (equity dibangun ulang: $${(100 + pnl).toFixed(2)}, ${mine.length} close)`);
      vs.life = ml; vs.positions = []; vs.equityUsd = Number((100 + pnl).toFixed(4)); vs.realizedUsd = Number(pnl.toFixed(4));
      vs.trades = mine.length; vs.wins = mine.filter((c) => Number((c as { pnlUsd?: number }).pnlUsd ?? 0) >= 0).length;
      vs.losses = mine.length - vs.wins;
      st.corrections = [...(st.corrections ?? []), { at: new Date().toISOString(), type: "life-bump-from-ledger", variant: id, to: ml, pnl }];
      lifeFixed++;
    }
    if (lifeFixed) saveState(st, "reconcile");
    // AKAR SISA PARITAS (2026-10-11): penyelarasan life MENGOSONGKAN posisi life lama
    // (`vs.positions = []`). Dulu `heldRaw` dibangun SEBELUM penyelarasan, sehingga pasangan
    // "residual ledger +1 / state pegang 1" dinilai dengan state yang sudah basi — kuncinya tak
    // pernah dijelaskan dan audit tetap merah sampai run berikutnya. Dibangun ULANG di sini.
    heldRaw.clear();
    for (const [id, vs] of Object.entries(st.variants)) {
      for (const p of vs.positions ?? []) heldRaw.set(`${id}|${p.token}`, (heldRaw.get(`${id}|${p.token}`) ?? 0) + 1);
    }
    const parity = computeParity(parityRows, heldRaw, (v) => st.variants[v]?.life ?? 1);
    const gaps = parityGaps(parity);
    let addedOpen = 0, addedClose = 0;
    for (const [key, gap] of gaps) {
      const [id, token] = key.split("|") as [string, string];
      const life = Number(key.split("|")[2] ?? 1);
      const heldHere = heldRaw.get(`${id}|${token}`) ?? 0;
      // Aturan tulis dipindah ke ledger-parity.ts sebagai fungsi murni supaya bisa diuji:
      // compensatingOpenCount() menolak menambal residual negatif milik kunci yang tidak dipegang
      // (kelas yang dulu membuat rekonsiliasi berputar tanpa henti), dan needsReconciledClose()
      // membatasi penjelas sisi-lebih menjadi SATU per kunci.
      const kurang = compensatingOpenCount(gap, heldHere);
      if (kurang > 0) {
        const p = (st.variants[id]?.positions ?? []).find((x) => x.token === token);
        for (let i = 0; i < kurang; i++) {
          logRecord("rh-paper", {
            action: "RH_OPEN", reconciled: true, reason: "state punya posisi ini, baris catatannya hilang (proses berhenti sebelum mencatat)",
            variant: id, token, symbol: p?.symbol ?? "?", pool: p?.pool, entryPriceUsd: p?.entryPrice,
            notionalUsd: p?.notionalUsd, stopPct: p?.stopPct, tpPct: p?.tpPct, life, cohort: st.cohort, cfg: configHash,
          });
          addedOpen++;
        }
      } else if (needsReconciledClose(gap, parity.reconciledCloseKeys.has(key))) {
        // ledger mencatat buka yang tidak dipegang state → SATU baris penjelas per kunci sudah cukup
        // (baris rekonsiliasi TIDAK mengurangi residual — ia menjelaskan; menulis berkali-kali hanya
        //  membuat log membengkak tanpa menambah kebenaran).
        logRecord("rh-paper", {
          action: "RH_CLOSE", reconciled: true, reason: "rekonsiliasi_startup (state sudah menutup posisi ini; baris catatannya hilang)",
          variant: id, token, symbol: "?", pnlUsd: 0, pnlPct: 0, life: Number(key.split("|")[2] ?? 1), cohort: st.cohort, cfg: configHash,
        });
        addedClose++;
      }
    }
    if (addedOpen || addedClose) ui.warn(`[rh-paper] rekonsiliasi ledger: +${addedOpen} OPEN dan +${addedClose} CLOSE ditulis (bertanda reconciled, tidak diaudit)${addedOpen ? ` · kunci: ${[...gaps].filter(([, g]) => g < 0).map(([k, g]) => `${k}(${g})`).slice(0, 3).join(" ")}` : ""}`);
    else ui.info("[rh-paper] ledger konsisten dengan state — tidak ada yang perlu direkonsiliasi");
  } catch (e) {
    ui.warn(`[rh-paper] rekonsiliasi ledger gagal: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const lockFd = acquireInstanceLock(); // satu proses saja — lihat acquireInstanceLock()
  // BOCOR KUNCI YANG DITUTUP (2026-10-10): jalur keluar LEBIH AWAL (ONCE / RECONCILE_ONLY) dulu
  // `return` tanpa menghapus kunci, dan proses kedua yang mulai di jendela itu bisa lolos —
  // penyebab ledakan 49 penutupan ganda @10:18 (baris identik, 20 detik terpisah). Sekarang kunci
  // dilepas di SEMUA jalur keluar lewat process.on("exit"), bukan hanya di handler SIGINT/SIGTERM.
  let lockReleased = false;
  const releaseLock = (): void => {
    if (lockReleased) return;
    lockReleased = true;
    // JANGAN HAPUS BERKAS KUNCI (2026-10-11) — ini menutup kelas dua-penulis yang TERBUKTI hari ini.
    // Bukti: 4 pasangan penutupan ganda, SEMUANYA pada dua detik yang sama (16:29:42 & 16:30:24,
    // jeda 42 detik) — momen ketika lane di-restart. Penyebabnya: proses lama MENGHAPUS berkas kunci
    // saat keluar sementara timer/jalurnya masih berjalan, sehingga proses baru mengambil kunci dan
    // keduanya menulis. Kunci basi SUDAH ditangani dengan benar oleh jalur takeover (PID diperiksa:
    // PID mati → kunci diambil alih), jadi menghapusnya tidak diperlukan sama sekali.
    try { closeSync(lockFd); } catch { /* best-effort */ }
  };
  process.on("exit", releaseLock);
  // Dex promoted tokens ikut dipanggil sekali di awal supaya kegagalan path-nya terlihat di log start.
  console.log(`[rh-paper] Robinhood Chain paper lane — 10 varian, risk $${RISK_USD}/trade, modal awal $${START_EQUITY_USD}/varian.`);
  console.log(`[rh-paper] kohort: ${COHORT} · mark+exit tiap ${MARK_MS / 1000}s · discovery+kandidat+entry tiap ${CYCLE_MS / 1000}s.`);
  console.log(`[rh-paper] model biaya: fee DEX ${(DEX_FEE_PCT * 100).toFixed(2)}%/sisi, gas $${GAS_USD}/sisi, slippage dasar 1% + dampak. NOL wallet, NOL eksekusi.`);
  console.log(`[rh-paper] state: ${STATE_PATH}`);
  void dexPromotedTokens().then((r) => ui.info(`[rh-paper] sinyal promosi DexScreener: ${r.length} token Robinhood`));
  reconcileLedgerOnStart(loadState()); // bereskan selisih ledger↔state dari restart sebelumnya
  // Mode khusus: rekonsiliasi lalu BERHENTI (tanpa siklus). Dipakai untuk audit dalam keadaan
  // BETUL-BETUL diam — kalau siklus ikut jalan, posisi baru membuka dan kedua sisi bergerak lagi.
  if (process.env.RH_PAPER_RECONCILE_ONLY === "true") { releaseLock(); return; }
  await cycle();
  if (ONCE) return;
  const t1 = setInterval(() => void cycle(), CYCLE_MS);
  const t2 = setInterval(() => void markTick(), MARK_MS);
  const shutdown = () => {
    clearInterval(t1); clearInterval(t2);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  void sleep(1);
}

void main();
