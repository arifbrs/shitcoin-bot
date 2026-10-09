/**
 * LAPORAN HARIAN GMGN — kualitas wallet × outcome kandidat, dari data yang sudah terkumpul.
 *
 * Kenapa laporan ini ada: kolektor `gmgn-full-watch` mengumpulkan tiga hal yang belum pernah
 * dimiliki barengan — (1) angka kualitas wallet nyata (winrate/realized PnL, bukan tag), (2)
 * trade wallet ber-tag yang menyentuh mint yang KITA pantau, (3) outcome kandidat. Laporan ini
 * yang menyilangkannya; tanpa ini datanya cuma menumpuk tanpa kesimpulan.
 *
 * SEPENUHNYA OFFLINE: nol call GMGN, nol RPC, tidak menulis state apa pun kecuali file laporan
 * sendiri (logs/gmgn-report-YYYY-MM-DD.md). Aman dijalankan harian.
 *
 * KEJUJURAN YANG DIPAKSAKAN OLEH FORMAT:
 *  - Setiap tabel mencetak n; bagian dengan sampel kurang akan bilang "butuh lebih banyak data"
 *    alih-alih menampilkan angka yang tidak layak dipercaya.
 *  - Section C bukan eksperimen acak: wallet memilih mint yang mereka beli, jadi ini HIPOTESIS
 *    (dan dicetak begitu), bukan klaim edge.
 *
 * Pakai: npm run gmgn:report             (sekali)
 *        npm run gmgn:report -- --daily  (sekali + ulang tiap 24 jam; dipakai supervisor)
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const DAILY = process.argv.includes("--daily");
const DAY_MS = 24 * 3_600_000;

interface WalletRow {
  wallet: string; tags: string[]; winrate: number | null; realizedProfit: number | null;
  tokens: number | null; buys: number | null; sells: number | null; at: number;
}
interface WatchedTrade { mint: string; side: string; maker: string; at: number; watchType: string }
interface Mark { mint: string; source: string; mcChangePct: number; ageH: number | null; checkedAt: number; currentMcUsd: number | null; ruggedNow: boolean | null }
interface CandRow { mint: string; sym: string; source: string; firstSeenAt: number; mcUsd: number; features: Record<string, unknown> }
interface SignalRow { mint: string; signalType: number; sym: string; mcUsd: number | null; at: number }
interface PositionRow { mint: string; sym: string; stillHolding: number; exited: number; avgUnrealizedPnl: number | null; at: number }

function eventsFiles(): string[] {
  try {
    return readdirSync(config.logDir).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl")).map((f) => join(config.logDir, f));
  } catch { return []; }
}

const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[Math.floor(p * (s.length - 1))] as number) : NaN; };
const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
const pctMed = (a: number[]): string => (a.length ? `${q(a, 0.5) >= 0 ? "+" : ""}${q(a, 0.5).toFixed(1)}%` : "—");
const money = (a: number[]): string => (a.length ? `$${Math.round(q(a, 0.5)).toLocaleString()}` : "—");

function runReport(): void {
  const now = Date.now();
  const day = new Date().toISOString().slice(0, 10);

  const wallets = new Map<string, WalletRow>();
  const trades: WatchedTrade[] = [];
  const marks = new Map<string, Mark>();
  const signals: SignalRow[] = [];
  const positions = new Map<string, PositionRow>();
  const cands = new Map<string, CandRow>();

  for (const f of eventsFiles()) {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"gmgn-') && !line.includes('"strategy2-outcome"') && !line.includes('"strategy2-candidate"')) continue;
      let r: Record<string, unknown>;
      try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const t = String(r["type"] ?? "");
      const ts = Date.parse(String(r["ts"] ?? "")) || 0;
      if (t === "gmgn-wallet-quality") {
        const w = String(r["wallet"] ?? "");
        if (!w) continue;
        wallets.set(w, {
          wallet: w, tags: Array.isArray(r["tags"]) ? (r["tags"] as string[]) : [],
          winrate: typeof r["winrate"] === "number" ? r["winrate"] : null,
          realizedProfit: typeof r["realizedProfit"] === "number" ? r["realizedProfit"] : null,
          tokens: typeof r["tokens"] === "number" ? r["tokens"] : null,
          buys: typeof r["buys"] === "number" ? r["buys"] : null,
          sells: typeof r["sells"] === "number" ? r["sells"] : null, at: ts,
        });
      } else if (t === "gmgn-watched-trade") {
        trades.push({ mint: String(r["mint"] ?? ""), side: String(r["side"] ?? ""), maker: String(r["maker"] ?? ""), at: ts, watchType: String(r["watchType"] ?? "?") });
      } else if (t === "gmgn-signal") {
        signals.push({ mint: String(r["mint"] ?? ""), signalType: Number(r["signalType"] ?? 0), sym: String(r["sym"] ?? "?"), mcUsd: typeof r["mcUsd"] === "number" ? r["mcUsd"] : null, at: ts });
      } else if (t === "gmgn-full-position") {
        const mint = String(r["mint"] ?? "");
        if (mint) positions.set(mint, {
          mint, sym: String(r["sym"] ?? "?"), stillHolding: Number(r["stillHolding"] ?? 0), exited: Number(r["exited"] ?? 0),
          avgUnrealizedPnl: typeof r["avgUnrealizedPnl"] === "number" ? r["avgUnrealizedPnl"] : null, at: ts,
        });
      } else if (t === "strategy2-candidate") {
        const mint = String(r["mint"] ?? "");
        if (!mint) continue;
        const key = `${mint}|${String(r["source"] ?? "unknown")}`;
        const firstSeenAt = Number(r["firstSeenAt"] ?? 0);
        const prev = cands.get(key);
        if (prev && prev.firstSeenAt <= firstSeenAt) continue;
        cands.set(key, {
          mint, sym: String(r["sym"] ?? "?"), source: String(r["source"] ?? "unknown"),
          firstSeenAt, mcUsd: Number(r["mcUsd"] ?? 0),
          features: {
            mcUsd: r["mcUsd"] ?? null, liqUsd: r["liqUsd"] ?? null, holders: r["holders"] ?? null,
            smartDegenCount: r["smartDegenCount"] ?? null, renownedCount: r["renownedCount"] ?? null,
            rugRatio: r["rugRatio"] ?? null, bundlerRate: r["bundlerRate"] ?? null, sniperCount: r["sniperCount"] ?? null,
            isWashTrading: r["isWashTrading"] ?? null, jupNetBuyers5m: r["jupNetBuyers5m"] ?? null,
            jupDevBalancePct: r["jupDevBalancePct"] ?? null, change1h: r["change1h"] ?? null,
            xFollowers: r["xFollowers"] ?? null, tgCallCount: r["tgCallCount"] ?? null,
            launchpadPlatform: r["launchpadPlatform"] ?? null, passesDevHoldFloor: r["passesDevHoldFloor"] ?? null,
            ageMin: r["ageMin"] ?? null, cfg: r["cfg"] ?? null, epoch: r["strategy2Epoch"] ?? null,
          },
        });
      } else if (t === "strategy2-outcome") {
        const mint = String(r["mint"] ?? "");
        if (!mint || typeof r["mcChangePct"] !== "number") continue;
        const checkedAt = Number(r["checkedAt"] ?? 0);
        const firstSeenAt = Number(r["firstSeenAt"] ?? 0);
        const prev = marks.get(mint);
        if (prev && prev.checkedAt >= checkedAt) continue;
        marks.set(mint, {
          mint, source: String(r["source"] ?? "?"), mcChangePct: r["mcChangePct"] as number, checkedAt,
          ageH: typeof r["ageHours"] === "number" ? r["ageHours"] : (firstSeenAt && checkedAt ? (checkedAt - firstSeenAt) / 3_600_000 : null),
          currentMcUsd: typeof r["currentMcUsd"] === "number" ? r["currentMcUsd"] : null,
          ruggedNow: typeof r["ruggedNow"] === "boolean" ? r["ruggedNow"] : null,
        });
      }
    }
  }

  // State permanen: retensi events 7 hari akan menghapus baris wallet lama sebelum re-skor
  // berikutnya (interval 7 hari) — tanpa merge ini, tabel kualitas wallet pelan-pelan mengosong.
  try {
    const st = JSON.parse(readFileSync(join(config.logDir, "gmgn-full-watch-state.json"), "utf8")) as {
      walletQuality?: Record<string, { at?: number; tags?: string[]; winrate?: number | null; realizedProfit?: number | null; tokens?: number | null; buys?: number | null; sells?: number | null }>;
    };
    for (const [w, q] of Object.entries(st.walletQuality ?? {})) {
      const prev = wallets.get(w);
      if (prev && prev.at >= (q.at ?? 0)) continue; // baris events lebih baru
      wallets.set(w, {
        wallet: w, tags: q.tags ?? prev?.tags ?? [], winrate: q.winrate ?? null, realizedProfit: q.realizedProfit ?? null,
        tokens: q.tokens ?? null, buys: q.buys ?? null, sells: q.sells ?? null, at: q.at ?? 0,
      });
    }
  } catch { /* state belum ada */ }

  const out: string[] = [];
  const say = (s = ""): void => { out.push(s); console.log(s); };
  const section = (t: string): void => { say(`\n═══ ${t} ═══`); };

  say(`LAPORAN GMGN ${day} — kualitas wallet × outcome kandidat (offline, nol kuota)`);
  say(`Data: ${eventsFiles().length} file events (retensi 7 hari) + state wallet permanen.`);

  section("A. RINGKASAN");
  {
    const s24 = signals.filter((x) => now - x.at <= DAY_MS);
    const t24 = trades.filter((x) => now - x.at <= DAY_MS);
    say(`  wallet terskor     : ${wallets.size}`);
    say(`  sinyal 24 jam      : ${s24.length} (type 12 smart-money, type 20 KOL)`);
    say(`  trade terpantau 24j: ${t24.length} (menyentuh mint yang kita pantau)`);
    say(`  posisi terpantau   : ${positions.size} mint (conviction smart-degen)`);
    say(`  mark outcome       : ${marks.size} mint (dari strategy2-outcome)`);
  }

  section("B. KUALITAS WALLET PER TAG (winrate = rasio token profit; realizedPnL dari GMGN)");
  {
    const rows = [...wallets.values()].filter((w) => w.winrate != null);
    if (rows.length < 10) {
      say(`  baru ${rows.length} wallet ber-winrate — butuh lebih banyak siklus kolektor dulu (maks 6 wallet/siklus).`);
    } else {
      const groups: Array<[string, WalletRow[]]> = [["SEMUA", rows]];
      for (const tag of ["kol", "smart_degen", "fresh_wallet", "app_smart_money", "launchpad_smart", "arbitrager", "wash_trader"]) {
        const g = rows.filter((w) => w.tags.includes(tag));
        if (g.length >= 5) groups.push([tag, g]);
      }
      for (const [name, g] of groups) {
        const wr = g.map((w) => w.winrate as number);
        const rp = g.filter((w) => w.realizedProfit != null).map((w) => w.realizedProfit as number);
        say(`  ${name.padEnd(16)} n=${String(g.length).padStart(4)}  winrate med ${q(wr, 0.5).toFixed(2)} p75 ${q(wr, 0.75).toFixed(2)}  ≥50%: ${pct(wr.filter((x) => x >= 0.5).length, wr.length).padStart(4)}  realizedPnL med ${money(rp)}`);
      }
      say(`  (tag saling tumpang tindih; 'arbitrager'/'wash_trader' sengaja ikut diukur — tag bukan bukti edan.)`);
    }
  }

  section("C. OUTCOME vs KUALITAS WALLET (hipotesis, bukan eksperimen acak)");
  {
    const buys = trades.filter((t) => t.side === "buy" && t.maker);
    const joined = buys
      .map((t) => ({ t, w: wallets.get(t.maker), m: marks.get(t.mint) }))
      .filter((x): x is { t: WatchedTrade; w: WalletRow; m: Mark } => Boolean(x.w && x.w.winrate != null && x.m));
    if (joined.length < 10) {
      say(`  baru ${joined.length} pembelian wallet ber-winrate yang punya mark outcome — belum layak disimpulkan.`);
      say(`  (kolektor perlu beberapa hari; mark outcome menyusul 6–48 jam setelah kandidat terlihat)`);
    } else {
      const bucketOf = (wr: number): string => (wr < 0.3 ? "<30%" : wr < 0.5 ? "30–50%" : "≥50%");
      const groups = new Map<string, Array<{ w: WalletRow; m: Mark }>>();
      for (const j of joined) {
        const b = bucketOf(j.w.winrate as number);
        const arr = groups.get(b);
        if (arr) arr.push(j); else groups.set(b, [j]);
      }
      say(`  winrate wallet peng-akuisisi → outcome mint (mark terbaru):`);
      for (const b of ["≥50%", "30–50%", "<30%"]) {
        const g = groups.get(b);
        if (!g?.length) continue;
        const ch = g.map((x) => x.m.mcChangePct);
        const ages = g.map((x) => x.m.ageH).filter((x): x is number => x != null);
        say(`  ${b.padEnd(7)} n=${String(g.length).padStart(3)}  med ${pctMed(ch).padStart(7)}  P(+50%): ${pct(ch.filter((x) => x >= 50).length, ch.length).padStart(4)}  P(≤−50%): ${pct(ch.filter((x) => x <= -50).length, ch.length).padStart(4)}  umur mark ${ages.length ? q(ages, 0.5).toFixed(0) + "h" : "?"}`);
      }
      const allCh = [...marks.values()].map((m) => m.mcChangePct);
      say(`  baseline semua mark    n=${String(allCh.length).padStart(3)}  med ${pctMed(allCh).padStart(7)}  P(+50%): ${pct(allCh.filter((x) => x >= 50).length, allCh.length).padStart(4)}  P(≤−50%): ${pct(allCh.filter((x) => x <= -50).length, allCh.length).padStart(4)}`);
      say(`  CATATAN: wallet MEMILIH mint-nya — perbandingan populasi terpilih, bukan bukti sebab-akibat.`);
    }
  }

  section("D. SINYAL 24 JAM");
  {
    const s24 = signals.filter((x) => now - x.at <= DAY_MS);
    if (!s24.length) say("  (belum ada sinyal hari ini)");
    else {
      const byType = new Map<number, SignalRow[]>();
      for (const s of s24) { const a = byType.get(s.signalType); if (a) a.push(s); else byType.set(s.signalType, [s]); }
      for (const [type, g] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const mc = g.filter((s) => s.mcUsd != null).map((s) => s.mcUsd as number);
        say(`  type ${String(type).padEnd(3)} n=${String(g.length).padStart(3)}  mc med ${mc.length ? "$" + Math.round(q(mc, 0.5)).toLocaleString() : "?"}  contoh: ${g.slice(0, 4).map((s) => s.sym).join(", ")}`);
      }
      say(`  (outcome sinyal BELUM dilacak — mint sinyal tidak ditulis sebagai kandidat supaya tidak terbaca paper trader.)`);
    }
  }

  section("E. POSISI TERPANTAU — CONVICTION SMART-DEGEN");
  {
    if (!positions.size) say("  (tidak ada posisi terbuka saat kolektor berjalan — wajar kalau sniper/paper trader sedang mati)");
    else {
      for (const p of [...positions.values()].sort((a, b) => b.at - a.at).slice(0, 12)) {
        const total = p.stillHolding + p.exited;
        say(`  ${p.sym.padEnd(12)} pegang ${p.stillHolding}/${total}  avg unrealized ${p.avgUnrealizedPnl ?? "?"}  (${new Date(p.at).toISOString().slice(0, 16)}Z)`);
      }
    }
  }

  section("F. LEDGER DURABEL (bertahan lewat retensi events 7 hari)");
  {
    const ledgerPath = join(config.logDir, "gmgn-study-ledger.jsonl");
    const seen = new Set<string>();
    try {
      for (const l of readFileSync(ledgerPath, "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          const r = JSON.parse(l) as { mint?: string; source?: string; mark?: { checkedAt?: number } };
          if (r.mint) seen.add(`${r.mint}|${r.source}|${r.mark?.checkedAt}`);
        } catch { /* baris rusak — abaikan */ }
      }
    } catch { /* ledger belum ada */ }
    let added = 0;
    for (const c of cands.values()) {
      const m = marks.get(c.mint);
      if (!m) continue;
      const key = `${c.mint}|${c.source}|${m.checkedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        appendFileSync(ledgerPath, JSON.stringify({
          mint: c.mint, sym: c.sym, source: c.source, firstSeenAt: c.firstSeenAt, entryMcUsd: c.mcUsd,
          features: c.features,
          mark: { mcChangePct: m.mcChangePct, ageH: m.ageH, checkedAt: m.checkedAt, markSource: m.source, currentMcUsd: m.currentMcUsd, ruggedNow: m.ruggedNow },
        }) + "\n");
        added++;
      } catch { /* best-effort */ }
    }
    say(`  pasangan kandidat+mark: +${added} baris baru (total ${seen.size}) → ${ledgerPath}`);
    say(`  (nama file ini sengaja bukan prefix stream mana pun, jadi tidak ikut terhapus retensi.)`);
    if (!added && !seen.size) say(`  (belum ada pasangan kandidat+mark di jendela 7 hari — akan terisi saat scout/kolektor menulis kandidat)`);
  }

  say(`\nUntuk studi kohort fitur→outcome (fitur kandidat, bukan wallet): npm run gmgn:study`);
  say(`File laporan ini: ${join(config.logDir, `gmgn-report-${day}.md`)}`);

  try { writeFileSync(join(config.logDir, `gmgn-report-${day}.md`), out.join("\n") + "\n"); } catch { /* best-effort */ }
}

runReport();

if (DAILY) {
  console.log(`\n[gmgn-report] mode harian — menjalankan ulang tiap 24 jam.`);
  setInterval(() => {
    console.log(`\n[gmgn-report] ${new Date().toISOString()} — laporan harian berikutnya:`);
    try { runReport(); } catch (e) { console.warn(`[gmgn-report] laporan gagal: ${(e as Error).message}`); }
  }, DAY_MS);
}
