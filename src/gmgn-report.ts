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
import { exactCandidateMark, gmgnCandidateKey, gmgnCohortKey, latestAsOf, walletIdentity, validExactLedger } from "./analysis/gmgn-evidence.js";
import { observationReport } from "./gmgn-observation-report.js";

const DAILY = process.argv.includes("--daily");
const DAY_MS = 24 * 3_600_000;
const REPEAT_MS = DAILY ? DAY_MS : process.argv.includes("--loop") ? 15 * 60_000 : null;

interface WalletRow {
  chain: string; wallet: string; tags: string[]; winrate: number | null; realizedProfit: number | null;
  tokens: number | null; buys: number | null; sells: number | null; at: number;
}
interface WatchedTrade { chain: string; mint: string; side: string; maker: string; at: number; tradeAt: number | null; txHash: string; cfg: string; epoch: string; watchType: string }
interface Mark { chain: string; mint: string; source: string; cfg: string; epoch: string; firstSeenAt: number; mcChangePct: number | null; ageH: number | null; checkedAt: number; currentMcUsd: number | null; ruggedNow: boolean | null }
interface CandRow { chain: string; mint: string; sym: string; source: string; cfg: string; epoch: string; firstSeenAt: number; mcUsd: number; features: Record<string, unknown> }
interface SignalRow { chain: string; mint: string; signalType: number; sym: string; mcUsd: number | null; at: number }
interface PositionRow { mint: string; sym: string; stillHolding: number; exited: number; avgUnrealizedPnl: number | null; at: number }

function eventsFiles(): string[] {
  try {
    return readdirSync(config.logDir).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl")).sort().map((f) => join(config.logDir, f));
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
  const walletHistory = new Map<string, WalletRow[]>();
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
      const chain = typeof r["chain"] === "string" ? r["chain"] : "sol";
      if (t === "gmgn-wallet-quality") {
        const w = String(r["wallet"] ?? "");
        if (!w) continue;
        const quality: WalletRow = {
          chain, wallet: w, tags: Array.isArray(r["tags"]) ? (r["tags"] as string[]) : [],
          winrate: typeof r["winrate"] === "number" ? r["winrate"] : null,
          realizedProfit: typeof r["realizedProfit"] === "number" ? r["realizedProfit"] : null,
          tokens: typeof r["tokens"] === "number" ? r["tokens"] : null,
          buys: typeof r["buys"] === "number" ? r["buys"] : null,
          sells: typeof r["sells"] === "number" ? r["sells"] : null, at: typeof r["scoredAt"] === "number" ? r["scoredAt"] : ts,
        };
        const key = walletIdentity(chain, w);
        walletHistory.set(key, [...(walletHistory.get(key) ?? []), quality]);
        if (!wallets.has(key) || wallets.get(key)!.at < quality.at) wallets.set(key, quality);
      } else if (t === "gmgn-watched-trade") {
        trades.push({ chain, mint: String(r["mint"] ?? ""), side: String(r["side"] ?? ""), maker: String(r["maker"] ?? ""), at: ts,
          tradeAt: typeof r["tradeAt"] === "number" ? r["tradeAt"] : null, txHash: String(r["txHash"] ?? ""), cfg: String(r["cfg"] ?? "unknown"), epoch: String(r["strategy2Epoch"] ?? "unknown"), watchType: String(r["watchType"] ?? "?") });
      } else if (t === "gmgn-signal") {
        signals.push({ chain, mint: String(r["mint"] ?? ""), signalType: Number(r["signalType"] ?? 0), sym: String(r["sym"] ?? "?"), mcUsd: typeof r["mcUsd"] === "number" ? r["mcUsd"] : null, at: ts });
      } else if (t === "gmgn-full-position") {
        const mint = String(r["mint"] ?? "");
        const key = `${chain}:${mint}`;
        if (mint && (!positions.has(key) || positions.get(key)!.at < ts)) positions.set(key, {
          mint, sym: String(r["sym"] ?? "?"), stillHolding: Number(r["stillHolding"] ?? 0), exited: Number(r["exited"] ?? 0),
          avgUnrealizedPnl: typeof r["avgUnrealizedPnl"] === "number" ? r["avgUnrealizedPnl"] : null, at: ts,
        });
      } else if (t === "strategy2-candidate") {
        const mint = String(r["mint"] ?? "");
        if (!mint) continue;
        const key = gmgnCohortKey(r);
        if (!key || !gmgnCandidateKey(r)) continue;
        const firstSeenAt = Number(r["firstSeenAt"] ?? 0);
        const prev = cands.get(key);
        if (prev && prev.firstSeenAt <= firstSeenAt) continue;
        cands.set(key, {
          chain, mint, sym: String(r["sym"] ?? "?"), source: String(r["source"] ?? "unknown"), cfg: String(r["cfg"]), epoch: String(r["strategy2Epoch"]),
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
        const key = gmgnCandidateKey(r);
        if (!mint || !key) continue;
        const checkedAt = Number(r["checkedAt"] ?? 0);
        const firstSeenAt = Number(r["firstSeenAt"] ?? 0);
        if (!Number.isFinite(checkedAt) || checkedAt < firstSeenAt) continue;
        const prev = marks.get(key);
        if (prev && prev.checkedAt <= checkedAt) continue;
        marks.set(key, {
          chain, mint, source: String(r["source"]), cfg: String(r["cfg"]), epoch: String(r["strategy2Epoch"]), firstSeenAt,
          mcChangePct: typeof r["mcChangePct"] === "number" && Number.isFinite(r["mcChangePct"]) ? r["mcChangePct"] : null, checkedAt,
          ageH: (checkedAt - firstSeenAt) / 3_600_000,
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
      const key = walletIdentity("sol", w);
      const prev = wallets.get(key);
      if (prev && prev.at >= (q.at ?? 0)) continue; // baris events lebih baru
      const quality: WalletRow = {
        chain: "sol", wallet: w, tags: q.tags ?? prev?.tags ?? [], winrate: q.winrate ?? null, realizedProfit: q.realizedProfit ?? null,
        tokens: q.tokens ?? null, buys: q.buys ?? null, sells: q.sells ?? null, at: q.at ?? 0,
      };
      wallets.set(key, quality); walletHistory.set(key, [...(walletHistory.get(key) ?? []), quality]);
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
    say(`  mark outcome       : ${marks.size} identitas kandidat (mark PERTAMA; source/cfg/epoch/first-seen exact)`);
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

  section("C. KELAYAKAN JOIN WALLET × OUTCOME (bukan profit copy-trade)");
  {
    const buys = trades.filter((t) => t.side === "buy" && t.maker);
    let joinable = 0;
    const seen = new Set<string>();
    for (const t of buys) {
      if (!t.tradeAt || !t.txHash || t.tradeAt > now) continue;
      const txKey = `${t.chain}:${t.txHash}:${t.maker}:${t.mint}`;
      if (seen.has(txKey)) continue;
      seen.add(txKey);
      const w = latestAsOf(walletHistory.get(walletIdentity(t.chain, t.maker)) ?? [], t.tradeAt);
      if (!w || w.winrate == null || t.tradeAt - w.at > DAY_MS * 7) continue;
      const candidates = [...cands.values()].filter((c) => c.chain === t.chain && c.mint === t.mint && c.cfg === t.cfg && c.epoch === t.epoch && c.firstSeenAt <= t.tradeAt!);
      if (candidates.length !== 1) continue; // A trade has no source identity; ambiguity is not guessed.
      const c = candidates[0]!, m = marks.get(gmgnCandidateKey(c as unknown as Record<string, unknown>)!);
      if (m && m.mcChangePct != null && m.checkedAt > t.tradeAt && exactCandidateMark(c as unknown as Record<string, unknown>, m as unknown as Record<string, unknown>)) joinable++;
    }
    say(`  ${joinable}/${buys.length} buy rows punya skor SEBELUM trade + satu kandidat exact + mark SETELAH trade (transaksi didedupe).`);
    say("  Tabel edge wallet lama dinonaktifkan: latest wallet score membocorkan masa depan, dan mark kandidat bukan return sejak harga buy wallet.");
    say("  Menunggu saja tidak memperbaiki join atau membuktikan copyability. Statistik wallet bagian B hanya deskriptif retrospektif.");
  }

  section("D. SINYAL 24 JAM");
  {
    const s24 = signals.filter((x) => now - x.at <= DAY_MS);
    if (!s24.length) say("  (belum ada sinyal hari ini)");
    else {
      const byType = new Map<string, SignalRow[]>();
      for (const s of s24) { const key = `${s.chain} type ${s.signalType}`; const a = byType.get(key); if (a) a.push(s); else byType.set(key, [s]); }
      for (const [type, g] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const mc = g.filter((s) => s.mcUsd != null).map((s) => s.mcUsd as number);
        say(`  ${type.padEnd(18)} n=${String(g.length).padStart(3)}  mc med ${mc.length ? "$" + Math.round(q(mc, 0.5)).toLocaleString() : "?"}  contoh: ${g.slice(0, 4).map((s) => s.sym).join(", ")}`);
      }
      say("  Sinyal lama tidak punya outcome yang dapat direkonstruksi dengan jujur. Kohort BARU dilacak di journal terpisah, bukan candidate trader.");
    }
  }

  for (const line of observationReport(now)) say(line);

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
    const ledgerPath = join(config.logDir, "gmgn-study-ledger-v2.jsonl");
    const seen = new Set<string>();
    try {
      for (const l of readFileSync(ledgerPath, "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          const r = JSON.parse(l) as Record<string, unknown>;
          if (validExactLedger(r)) seen.add(`${gmgnCandidateKey(r)}|${(r.mark as { checkedAt: number }).checkedAt}`);
        } catch { /* baris rusak — abaikan */ }
      }
    } catch { /* ledger belum ada */ }
    let added = 0;
    for (const c of cands.values()) {
      const candidateKey = gmgnCandidateKey(c as unknown as Record<string, unknown>);
      const m = candidateKey ? marks.get(candidateKey) : undefined;
      if (!m || m.mcChangePct == null || !exactCandidateMark(c as unknown as Record<string, unknown>, m as unknown as Record<string, unknown>)) continue;
      const key = `${candidateKey}|${m.checkedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        appendFileSync(ledgerPath, JSON.stringify({
          pairingVersion: "gmgn-exact-v2", chain: c.chain, cfg: c.cfg, strategy2Epoch: c.epoch,
          mint: c.mint, sym: c.sym, source: c.source, firstSeenAt: c.firstSeenAt, entryMcUsd: c.mcUsd,
          features: c.features,
          mark: { chain: m.chain, mint: m.mint, source: m.source, cfg: m.cfg, strategy2Epoch: m.epoch, firstSeenAt: m.firstSeenAt,
            mcChangePct: m.mcChangePct, ageH: m.ageH, checkedAt: m.checkedAt, currentMcUsd: m.currentMcUsd, ruggedNow: m.ruggedNow },
        }) + "\n");
        added++;
      } catch { /* best-effort */ }
    }
    say(`  pasangan kandidat+mark: +${added} baris baru (total ${seen.size}) → ${ledgerPath}`);
    say(`  (nama file ini sengaja bukan prefix stream mana pun, jadi tidak ikut terhapus retensi.)`);
    say("  Ledger v1 tetap disimpan, tetapi tidak dipercaya: exporter lama mencampur identitas mint/source/config/epoch.");
    if (!added && !seen.size) say(`  (belum ada pasangan kandidat+mark di jendela 7 hari — akan terisi saat scout/kolektor menulis kandidat)`);
  }

  say(`\nUntuk studi kohort fitur→outcome (fitur kandidat, bukan wallet): npm run gmgn:study`);
  say(`File laporan ini: ${join(config.logDir, `gmgn-report-${day}.md`)}`);

  try { writeFileSync(join(config.logDir, `gmgn-report-${day}.md`), out.join("\n") + "\n"); } catch { /* best-effort */ }
}

runReport();

if (REPEAT_MS != null) {
  console.log(`\n[gmgn-report] offline loop — menjalankan ulang tiap ${REPEAT_MS / 60_000} menit.`);
  setInterval(() => {
    console.log(`\n[gmgn-report] ${new Date().toISOString()} — laporan harian berikutnya:`);
    try { runReport(); } catch (e) { console.warn(`[gmgn-report] laporan gagal: ${(e as Error).message}`); }
  }, REPEAT_MS);
}
