/**
 * REVIEW HARIAN ROBINHOOD CHAIN (08:00 waktu lokal) + RISET UNTUK HARI BERIKUTNYA.
 *
 * Owner (2026-10-07): "Setelah 10 forward test berhasil, buat jadwal review strategi setiap hari
 * setiap jam 8 pagi. siapkan juga hasil riset untuk di hari selanjutnya."
 *
 * Proses ini OFFLINE (nol API berbayar; hanya satu panggilan mark batch DexScreener utk mengukur
 * kesempatan yang terlewat). Setiap hari ia:
 *  1. MERINGKAS 10 varian: equity, PnL, trade, win rate, max drawdown, posisi terbuka, dan
 *     PROGRES kriteria sukses forward test (lane ≥7 hari dan tiap varian ≥10 trade tertutup).
 *  2. Mengukur KESEMPATAN TERLEWAT — kandidat yang lolos filter sebuah varian tapi tidak dibeli
 *     (kapasitas/cooldown); harga sekarang vs harga saat terlihat → bukti apakah filternya
 *     benar-benar punya edge yang terbuang, bukan asumsi.
 *  3. MENGEKSPOR LEDGER DURABEL (logs/rh-discovery-ledger.jsonl): fitur kandidat + hasil
 *     lanjutannya. Nama file sengaja bukan prefix stream mana pun → tidak ikut retensi, jadi
 *     riset besok tetap punya sejarah saat rh-events (14 hari) menguap.
 *  4. Menyusun "RENCANA RISET BESOK" dari angka hari ini (bukan opini): aturan penolak tersering,
 *     performa per alasan exit, dan usulan parameter yang bisa diuji.
 *  5. (2026-10-08) Melampirkan status lane lain — OKX strict-paper (termasuk VERIFIKASI hash-chain
 *     ledger-nya) dan DexScreener (promosi berbayar + narasi) — supaya laporan 08:00 ini benar-benar
 *     satu laporan untuk semua lane hidup, bukan cuma Robinhood.
 *
 * Jadwal: jalan sekali saat start, lalu tepat 08:00 setiap hari (RH_REVIEW_AT utk mengubah).
 * Run: npm run rh:review   (RH_REVIEW_ONCE=true = sekali lalu keluar)
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { config } from "../config.js";
import { ui } from "../util/log.js";
import { markTokens } from "./market.js";
import { verifyStrictLedger } from "../discovery/okx-strict-ledger.js";

const AT = (process.env.RH_REVIEW_AT ?? "08:00").trim();
const ONCE = process.env.RH_REVIEW_ONCE === "true";
const START_EQUITY = (() => { const n = Number(process.env.RH_START_EQUITY_USD); return Number.isFinite(n) && n > 0 ? n : 100; })();
const STATE_PATH = join(config.logDir, "rh-paper-state.json");
const LEDGER_PATH = join(config.logDir, "rh-discovery-ledger.jsonl");

interface Position { token: string; symbol: string; openedAt: number; entryPrice: number; lastPrice: number; notionalUsd: number; peakPrice: number }
interface VariantState {
  equityUsd: number; peakEquityUsd: number; maxDdPct: number; realizedUsd: number;
  wins: number; losses: number; trades: number; positions: Position[]; cooldown: Record<string, number>;
  bankruptAt?: number; life?: number; lifeHistory?: Array<{ endEquityUsd: number; trades?: number }>;
}
interface State { startedAt: number; cycles: number; variants: Record<string, VariantState> }

interface ClosedTrade { variant: string; token: string; symbol: string; reason: string; pnlUsd: number; pnlPct: number; heldMin: number; ts: string; notionalUsd?: number; stopPct?: number }
interface CandidateObs {
  token: string; symbol: string; ts: string; priceUsd: number | null; liqUsd: number | null; ageMin: number | null;
  vol1hUsd: number | null; ch1: number | null; ch24: number | null;
  acceptedBy: string[]; rejected: Record<string, string>;
}

function logFiles(prefix: string, days: number): string[] {
  try {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return readdirSync(config.logDir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl") && f.slice(prefix.length, prefix.length + 10) >= cutoff).map((f) => join(config.logDir, f));
  } catch { return []; }
}

function readJsonl<T>(files: string[], filter: (r: Record<string, unknown>) => boolean): T[] {
  const out: T[] = [];
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        if (filter(r)) out.push(r as T);
      } catch { /* baris rusak — abaikan */ }
    }
  }
  return out;
}

const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[Math.floor(p * (s.length - 1))] as number) : NaN; };
const money = (n: number): string => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

async function runReview(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const dayMs = 86_400_000;
  const lines: string[] = [];
  const say = (s = ""): void => { lines.push(s); console.log(s); };
  const section = (t: string): void => { say(`\n═══ ${t} ═══`); };

  let state: State | null = null;
  try { state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State; } catch { /* belum jalan */ }
  const closes = readJsonl<ClosedTrade>(logFiles("rh-paper-", 7), (r) => r["action"] === "RH_CLOSE");
  const closes24 = closes.filter((t) => Date.parse(String(t.ts ?? "")) >= now - dayMs);
  const candidates = readJsonl<CandidateObs>(logFiles("rh-events-", 2), (r) => r["type"] === "rh-candidate");

  say(`REVIEW HARIAN ROBINHOOD CHAIN — ${day} ${new Date().toLocaleTimeString("id-ID")}`);
  say(`Sumber: state paper + rh-paper (7 hari) + rh-events (2 hari). OFF-line, nol biaya API kecuali 1 mark batch.`);

  section("A. STATUS 10 VARIAN (forward test)");
  if (!state) {
    say("  state rh-paper belum ada — jalankan `npm run rh:paper` dulu.");
  } else {
    const laneDays = (now - state.startedAt) / dayMs;
    say(`  Lane berumur ${laneDays.toFixed(1)} hari, ${state.cycles} siklus. Kohort: ${(state as { cohort?: string }).cohort ?? "?"}. Kriteria sukses: ≥7 hari & tiap varian ≥10 trade tertutup.`);
    say(`  varian                 equity    pnl$    trade  W/L      win%   maxDD%  pos  status`);
    for (const [id, vs] of Object.entries(state.variants)) {
      const pnl = vs.equityUsd - START_EQUITY; // modal awal per varian (RH_START_EQUITY_USD)
      const winRate = vs.trades ? `${((vs.wins / vs.trades) * 100).toFixed(0)}%` : "—";
      const done = laneDays >= 7 && vs.trades >= 10;
      // LIFE-2: tampilkan life berjalan + P&L kumulatif lintas life (kematian tidak disembunyikan).
      const life = vs.life ?? 1;
      const histPnl = (vs.lifeHistory ?? []).reduce((a, l) => a + (l.endEquityUsd - START_EQUITY), 0);
      const cum = histPnl + pnl;
      const lifeTag = life > 1 ? ` · life${life} kum${cum >= 0 ? "+" : "−"}$${Math.abs(cum).toFixed(2)}` : "";
      const status = vs.bankruptAt != null || vs.equityUsd < 4 ? "BANKRUT (entry stop)" : done ? "SIAP DIREVIEW" : `jalan (${laneDays < 7 ? "hari" : "trade"} kurang)`;
      say(`  ${id.padEnd(22)} $${vs.equityUsd.toFixed(2).padStart(7)} ${money(pnl).padStart(8)} ${String(vs.trades).padStart(5)}  ${vs.wins}/${vs.losses}  ${winRate.padStart(5)}  ${vs.maxDdPct.toFixed(1).padStart(5)}  ${String(vs.positions.length).padStart(3)}  ${status}${lifeTag}`);
    }
    const openTotal = Object.values(state.variants).reduce((a, v) => a + v.positions.length, 0);
    say(`  Total posisi terbuka: ${openTotal}`);
  }

  section("B. TRADE TERTUTUP 24 JAM");
  if (!closes24.length) say("  (belum ada trade tertutup dalam 24 jam)");
  else {
    // PELANGGARAN BATAS RISIKO (audit 2026-10-07): $5 adalah NIAT SIZING, bukan batas rugi nyata.
    // Diukur tiap hari dari data, bukan diasumsikan: rugi > notional×stop% + biaya ≈ 2,6% + gas.
    const withData = closes24.filter((t) => typeof t.notionalUsd === "number" && typeof t.stopPct === "number");
    const breached = withData.filter((t) => -t.pnlUsd > (t.notionalUsd as number) * ((t.stopPct as number) / 100) + (t.notionalUsd as number) * 0.026 + 0.022);
    const excess = breached.reduce((a, t) => a + (-t.pnlUsd - ((t.notionalUsd as number) * ((t.stopPct as number) / 100) + (t.notionalUsd as number) * 0.026 + 0.022)), 0);
    if (withData.length) {
      say(`  RISIKO: ${breached.length}/${withData.length} trade rugi melebihi stop nominal — kelebihan $${excess.toFixed(2)} (gap/rug; $5 = niat sizing, bukan jaminan).`);
      const byR: Record<string, number> = {};
      for (const t of breached) byR[t.reason] = (byR[t.reason] ?? 0) + 1;
      if (breached.length) say(`  pelanggar per alasan: ${Object.entries(byR).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
    for (const id of Object.keys(state?.variants ?? {})) {
      const t = closes24.filter((x) => x.variant === id);
      if (!t.length) continue;
      const pnl = t.reduce((a, x) => a + x.pnlUsd, 0);
      const byReason: Record<string, number> = {};
      for (const x of t) byReason[x.reason] = (byReason[x.reason] ?? 0) + 1;
      say(`  ${id.padEnd(22)} n=${String(t.length).padStart(3)}  PnL ${money(pnl).padStart(8)}  exit: ${JSON.stringify(byReason)}`);
    }
    const best = [...closes24].sort((a, b) => b.pnlPct - a.pnlPct)[0];
    const worst = [...closes24].sort((a, b) => a.pnlPct - b.pnlPct)[0];
    if (best && worst) say(`  terbaik: ${best.symbol} ${money(best.pnlUsd)} (${best.pnlPct}%) · terburuk: ${worst.symbol} ${money(worst.pnlUsd)} (${worst.pnlPct}%)`);
    const reasons = new Map<string, number>();
    for (const t of closes24) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
    say(`  alasan exit: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }

  section("C. KANDIDAT & KESEMPATAN TERLEWAT (bukti, bukan asumsi)");
  const changes: number[] = []; // perubahan harga kandidat "lolos filter tapi tak dibeli" — dipakai lagi di bagian D
  const cand24 = candidates.filter((c) => Date.parse(String(c.ts)) >= now - dayMs);
  const accepted = cand24.filter((c) => c.acceptedBy?.length);
  say(`  kandidat teramati 24 jam: ${cand24.length} (liq≥$5k) — ${accepted.length} lolos filter ≥1 varian.`);
  const rejectCount = new Map<string, number>();
  for (const c of cand24) for (const r of Object.values(c.rejected ?? {})) { const key = r.split(" ")[0] as string; rejectCount.set(key, (rejectCount.get(key) ?? 0) + 1); }
  say(`  aturan penolak tersering: ${[...rejectCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(" ")}`);
  // "Terlewat" = lolos filter minimal satu varian TAPI tidak dipegang/ditutup varian mana pun
  // (kapasitas/cooldown). Bukan sekadar "tidak ada di daftar" — dibandingkan dengan set yang benar.
  const openTokenSet = new Set(Object.values(state?.variants ?? {}).flatMap((vs) => vs.positions.map((p) => p.token)));
  const closedTokenSet = new Set(closes.map((t) => t.token));
  const missedPool = accepted.filter((c) => !openTokenSet.has(c.token) && !closedTokenSet.has(c.token));
  const followUp = missedPool.slice(-30);
  if (!followUp.length) say("  (tidak ada kandidat terlewat utk diukur)");
  else {
    const marks = await markTokens(followUp.map((c) => c.token));
    const ledgerHas = new Set<string>();
    if (existsSync(LEDGER_PATH)) {
      try {
        for (const l of readFileSync(LEDGER_PATH, "utf8").split("\n")) {
          if (!l.trim()) continue;
          try { const r = JSON.parse(l) as { token?: string; observedAt?: number }; if (r.token) ledgerHas.add(`${r.token}|${r.observedAt}`); } catch { /* skip */ }
        }
      } catch { /* belum ada */ }
    }
    let appended = 0;
    for (const c of followUp) {
      const mk = marks.get(c.token);
      if (!mk?.priceUsd || !c.priceUsd || c.priceUsd <= 0) continue;
      const changePct = ((mk.priceUsd - c.priceUsd) / c.priceUsd) * 100;
      changes.push(changePct);
      const key = `${c.token}|${c.ts}`;
      if (!ledgerHas.has(key)) {
        try {
          appendFileSync(LEDGER_PATH, JSON.stringify({
            token: c.token, symbol: c.symbol, observedAt: c.ts, observedPriceUsd: c.priceUsd, liqUsd: c.liqUsd,
            ageMin: c.ageMin, vol1hUsd: c.vol1hUsd, ch1: c.ch1, ch24: c.ch24, acceptedBy: c.acceptedBy, rejected: c.rejected,
            followedUpAt: now, followUpPriceUsd: mk.priceUsd, changePct: Number(changePct.toFixed(2)),
          }) + "\n");
          appended++;
        } catch { /* best-effort */ }
      }
    }
    if (changes.length) {
      say(`  ${changes.length} kandidat lolos-filter tapi tak dibeli (kapasitas/cooldown) diukur ulang:`);
      say(`  perubahan sejak terlihat: med ${q(changes, 0.5).toFixed(1)}%  p25 ${q(changes, 0.25).toFixed(1)}%  p75 ${q(changes, 0.75).toFixed(1)}%  → ${changes.filter((x) => x > 0).length}/${changes.length} naik`);
    }
    say(`  ledger durabel: +${appended} baris baru → ${LEDGER_PATH}`);
  }

  section("D. SINYAL RUG GMGN vs HASIL (bukti untuk gerbang kohort-2)");
  {
    const enrich = readJsonl<{ token?: string; symbol?: string; flags?: string[] }>(logFiles("rh-events-", 2), (r) => r["type"] === "rh-gmgn-enrich");
    const hpBlocks = readJsonl<{ symbol?: string }>(logFiles("rh-events-", 2), (r) => r["type"] === "rh-honeypot-block");
    const byMint = new Map<string, { flags: string[]; symbol: string }>();
    for (const e of enrich) if (e.token) byMint.set(e.token, { flags: e.flags ?? [], symbol: e.symbol ?? "?" });
    if (hpBlocks.length) say(`  honeypot DIBLOKIR: ${hpBlocks.length} event (${[...new Set(hpBlocks.map((h) => h.symbol ?? "?"))].join(", ")}) — token tetap dilacak sebagai kesempatan terlewat di seksi C, jadi akurasi flag tetap terukur.`);
    if (!byMint.size) say("  (belum ada token diperkaya — enrichment jalan tiap siklus; cek lagi besok)");
    else {
      // Outcome per mint: pnl% terburuk lintas varian + apakah pernah mati (pool_mati / ≤ −50%).
      const outcome = new Map<string, { worst: number; died: boolean }>();
      for (const t of closes) {
        const prev = outcome.get(t.token) ?? { worst: 0, died: false };
        prev.worst = Math.min(prev.worst, t.pnlPct);
        if (t.reason === "pool_mati" || t.pnlPct <= -50) prev.died = true;
        outcome.set(t.token, prev);
      }
      const rows = [...byMint.entries()].map(([mint, e]) => ({ mint, ...e, o: outcome.get(mint) })).filter((r): r is { mint: string; flags: string[]; symbol: string; o: { worst: number; died: boolean } } => Boolean(r.o));
      say(`  token diperkaya: ${byMint.size} · yang sudah punya hasil (pernah dibeli & ditutup): ${rows.length}`);
      if (rows.length) {
        const died = rows.filter((r) => r.o.died).length;
        say(`  mati (pool_mati atau ≤−50%): ${died}/${rows.length} (${((died / rows.length) * 100).toFixed(0)}%)`);
        const flagStats = new Map<string, { n: number; died: number }>();
        for (const r of rows) for (const f of r.flags) {
          const s = flagStats.get(f) ?? { n: 0, died: 0 };
          s.n++; if (r.o.died) s.died++;
          flagStats.set(f, s);
        }
        for (const [f, s] of [...flagStats.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
          say(`   ${f.padEnd(14)} n=${String(s.n).padStart(3)}  mati ${s.died} (${((s.died / s.n) * 100).toFixed(0)}%)`);
        }
        const noFlag = rows.filter((r) => r.flags.length === 0);
        if (noFlag.length) say(`   ${"tanpa tanda bahaya".padEnd(14)} n=${String(noFlag.length).padStart(3)}  mati ${noFlag.filter((r) => r.o.died).length}`);
        say(`  CATATAN: n masih kecil — gerbang kohort-2 hanya dibuat bila pola ini bertahan di ≥30 token.`);
      }
    }
  }

  section("E. OKX STRICT-PAPER + OBSERVASI (uang kertas, tanpa signer/broadcast)");
  {
    const okxStatePath = join(config.logDir, "okx-strict-paper-v2-state.json");
    const okxLedgerPath = join(config.logDir, "okx-strict-paper-v2.jsonl");
    if (!existsSync(okxStatePath)) say("  state belum ada — lane belum pernah jalan.");
    else {
      const sp = JSON.parse(readFileSync(okxStatePath, "utf8")) as {
        positions?: Record<string, { status?: string; policyVersion?: number }>;
        budget?: { premiumUsed?: number; basicUsed?: number };
        primed?: { scanner?: boolean; ranking?: boolean; signal?: boolean; trackers?: string[] };
        updatedAt?: string;
      };
      const pos = Object.values(sp.positions ?? {});
      const open = pos.filter((p) => p.status === "OPEN");
      const closed = pos.filter((p) => p.status === "CLOSED");
      const staleMin = Math.round((Date.now() - (Date.parse(sp.updatedAt ?? "") || Date.now())) / 60_000);
      say(`  posisi: ${open.length} terbuka / ${closed.length} tertutup · state ditulis ${staleMin}m lalu · primed scan=${sp.primed?.scanner ? "✓" : "✗"} rank=${sp.primed?.ranking ? "✓" : "✗"} signal=${sp.primed?.signal ? "✓" : "✗"} tracker=${sp.primed?.trackers?.length ?? 0}`);
      say(`  budget: premium ${sp.budget?.premiumUsed ?? 0}/10000 · basic ${sp.budget?.basicUsed ?? 0}/25000`);
    }
    const verified = verifyStrictLedger(okxLedgerPath);
    say(verified.ok
      ? `  ledger hash-chain: UTUH — ${verified.records.length} baris, seq terakhir ${verified.records.at(-1)?.seq ?? 0} (satu byte diubah → verifikasi gagal, jadi angka tidak bisa dipoles).`
      : `  ledger hash-chain: RUSAK — ${verified.error}. Angka paper BELUM bisa dipercaya sampai ini beres.`);
    const okxRows = readJsonl<Record<string, unknown>>([okxLedgerPath].filter((p) => existsSync(p)), (r) => Date.now() - (Date.parse(String(r["ts"] ?? "")) || 0) <= 86_400_000);
    if (okxRows.length) {
      const kind = new Map<string, number>();
      for (const r of okxRows) kind.set(String(r["type"]), (kind.get(String(r["type"])) ?? 0) + 1);
      const closesToday = okxRows.filter((r) => r["type"] === "POSITION_CLOSED");
      const pnl = closesToday.reduce((a, r) => a + (Number(r["pnlLamports"] ?? 0) / 1e9), 0);
      say(`  24 jam: ${[...kind.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "—"}`);
      if (closesToday.length) say(`  tutup 24 jam: ${closesToday.length} posisi · Σ ${pnl >= 0 ? "+" : ""}${pnl.toFixed(5)} SOL (uang kertas)`);
      const term = okxRows.filter((r) => r["type"] === "CANDIDATE_TERMINAL");
      const reasons = new Map<string, number>();
      for (const t of term) {
        const rs = (t["reasons"] ?? t["reason"] ?? "") as string | string[];
        for (const one of Array.isArray(rs) ? rs : String(rs).split(",")) if (one) reasons.set(one.trim(), (reasons.get(one.trim()) ?? 0) + 1);
      }
      if (reasons.size) say(`  penolak tersering: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(" ")}`);
    } else say("  (belum ada baris ledger 24 jam)");
  }

  section("F. DEXSCREENER (promosi berbayar + narasi; 13 endpoint)");
  {
    const dexRows = readJsonl<Record<string, unknown>>(logFiles("events-", 1), (r) => String(r["type"] ?? "").startsWith("dex-"));
    if (!dexRows.length) say("  belum ada data — jalankan `npm run dex:full`.");
    else {
      const kind = new Map<string, number>();
      for (const r of dexRows) kind.set(String(r["type"]).replace("dex-", ""), (kind.get(String(r["type"]).replace("dex-", "")) ?? 0) + 1);
      say(`  24 jam: ${[...kind.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "—"}`);
      const statePath = join(config.logDir, "dex-full-state.json");
      const watch = existsSync(statePath)
        ? (JSON.parse(readFileSync(statePath, "utf8")) as { watch?: Record<string, { chain: string; symbol: string; liqUsd: number | null; vol24: number | null; chg24: number | null }> }).watch ?? {}
        : {};
      say(`  watchlist: ${Object.keys(watch).length} token (snapshot terakhir di state, bukan event)`);
      const boosts = new Map<string, number>();
      for (const r of dexRows) if (r["type"] === "dex-boosts") boosts.set(String(r["token"]), Number(r["totalAmount"] ?? 0));
      const promoted = [...boosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([token, amt]) => {
        const chain = String(dexRows.find((r) => r["token"] === token)?.chain ?? "?");
        const w = watch[`${chain}|${token}`];
        const liq = w?.liqUsd ?? null;
        return `${w?.symbol ?? token.slice(0, 8)} $${amt}${liq != null ? ` liq $${(liq / 1000).toFixed(0)}k` : ""}${liq != null && liq < 15_000 ? " ⚠︎likuiditas-tipis" : ""}`;
      });
      if (promoted.length) say(`  promosi teratas: ${promoted.join(" · ")}`);
      const metas = dexRows.filter((r) => r["type"] === "dex-metas").at(-1)?.["top"] as Array<{ slug: string; tokens: number; vol: number }> | undefined;
      if (metas?.length) say(`  narasi teratas: ${metas.slice(0, 5).map((m) => `${m.slug}(${m.tokens} token, vol $${Math.round((m.vol ?? 0) / 1e6)}M)`).join(" · ")}`);
      say(`  CATATAN: promosi = UPAYA berbayar, bukan kualitas — contoh terukur: token boost $100 dengan likuiditas tipis & −97%/24j.`);
    }
  }

  section("G. RENCANA RISET BESOK (dihitung dari angka hari ini)");
  if (!state) say("  (belum ada state — belum bisa menyusun rencana)");
  else {
    const perVariant = Object.entries(state.variants).map(([id, vs]) => ({ id, vs }));
    const rate = (vs: VariantState): number => (vs.equityUsd - 100) / Math.max(1, vs.trades);
    const ranked = [...perVariant].sort((a, b) => rate(b.vs) - rate(a.vs));
    say(` 1) Peringkat $/trade saat ini: ${ranked.slice(0, 3).map((r) => `${r.id} ${money(rate(r.vs))}`).join(" · ")}.`);
    say(`    Terburuk: ${ranked.slice(-2).map((r) => `${r.id} ${money(rate(r.vs))}`).join(" · ")} — kandidat utama utk pengetatan filter.`);
    const reasonCount = new Map<string, number>();
    for (const t of closes) reasonCount.set(t.reason, (reasonCount.get(t.reason) ?? 0) + 1);
    const stopShare = (reasonCount.get("stop_loss") ?? 0) / Math.max(1, [...reasonCount.values()].reduce((a, b) => a + b, 0));
    say(` 2) ${(stopShare * 100).toFixed(0)}% trade tertutup keluar via stop_loss → ${stopShare > 0.6 ? "stop terlalu ketat utk volatilitas meme; uji stop +5 poin pada 1-2 varian minggu ini" : "profil stop masuk akal; fokus ke filter entry"}.`);
    if (changes.length >= 10) say(` 3) Sinyal terlewat ${q(changes, 0.5).toFixed(1)}% median — ${q(changes, 0.5) > 0 ? "kapasitas (maxOpen) layak dinaikkan pada varian yang filter-nya paling sering lolos" : "kapasitas bukan masalah; filternya memang sedang salah"}.`);
    else say(` 3) Kesempatan terlewat baru ${changes.length} sampel — belum cukup utk menyimpulkan; kumpulkan 1-2 hari lagi.`);
    const candLedgerLines = existsSync(LEDGER_PATH) ? readFileSync(LEDGER_PATH, "utf8").split("\n").filter((l) => l.trim()).length : 0;
    say(` 4) Ledger riset: ${candLedgerLines} baris tersimpan (target 7 hari pertama ≥300 utk analisa fitur → outcome).`);
    say(` 5) Besok: jalankan \`npm run rh:backtest\` setelah data forward 24 jam bertambah, bandingkan peringkat backtest vs forward.`);
  }

  section("H. STUDI ENTRY — fitur masuk vs hasil (otomatis, nol API)");
  // Studi yang menemukan pemisah kohort-3 (rasio band, pita volume, top10) ikut dicetak di sini,
  // supaya verdict pagi ini tidak bergantung pada orang yang ingat menjalankan perintahnya.
  try {
    const out = execSync("npx tsx src/robinhood/study.ts", { encoding: "utf8", timeout: 120_000, cwd: process.cwd() });
    for (const line of out.split("\n").slice(0, 90)) say(`  ${line}`);
  } catch (e) {
    say(`  (studi gagal dijalankan: ${(e as Error).message.slice(0, 120)})`);
  }

  say(`\nFile review: ${join(config.logDir, `robinhood-review-${day}.md`)}`);
  try { writeFileSync(join(config.logDir, `robinhood-review-${day}.md`), lines.join("\n") + "\n"); } catch { /* best-effort */ }
}

function msUntilNext(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number.isFinite(h) ? (h as number) : 8, Number.isFinite(m) ? (m as number) : 0, 0, 0);
  if (next.getTime() <= now.getTime() + 1_000) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function main(): Promise<void> {
  console.log(`[rh-review] review harian jam ${AT} waktu lokal. Jalan sekarang, lalu terjadwal.`);
  try { await runReview(); } catch (e) { ui.warn(`[rh-review] review gagal: ${(e as Error).message}`); }
  if (ONCE) return;
  const schedule = (): void => {
    const wait = msUntilNext(AT);
    console.log(`[rh-review] review berikutnya dalam ${(wait / 3_600_000).toFixed(1)} jam (${AT}).`);
    setTimeout(() => {
      void runReview().catch((e) => ui.warn(`[rh-review] review gagal: ${(e as Error).message}`)).finally(schedule);
    }, wait);
  };
  schedule();
}

void main();
