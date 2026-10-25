/** Offline, durable signal coverage. Price marks are never relabeled as net trading profit. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HORIZONS_MINUTES, observationDir, readObservationJournal, type ObservationJournal } from "./discovery/gmgn-signal-observations.js";

export function observationReport(now = Date.now(), root = observationDir(), journal: ObservationJournal = readObservationJournal(root, false)): string[] {
  const lines = ["═══ GMGN PROSPECTIVE — HARGA, BUKAN PROFIT ═══", `  Journal: ${join(root, "journal.jsonl")}`];
  for (const role of ["collector", "tracker"]) {
    try {
      const h = JSON.parse(readFileSync(join(root, `${role}-health.json`), "utf8")) as { status?: string; updatedAt?: number; cycleMs?: number; pollMs?: number; polls?: unknown; error?: string };
      const age = h.updatedAt ? (now - h.updatedAt) / 60_000 : null;
      const stale = age == null || age > (role === "collector" ? (h.cycleMs ?? 900_000) * 2 / 60_000 : 5);
      lines.push(`  ${role}: ${h.status ?? "UNKNOWN"}${stale ? " / STALE" : ""} · tulis ${age == null ? "?" : age.toFixed(1)}m lalu${h.error ? ` · ${h.error}` : ""}`);
      if (role === "collector" && h.polls) lines.push(`  feed status: ${JSON.stringify(h.polls)}`);
    } catch { lines.push(`  ${role}: belum ada heartbeat`); }
  }
  lines.push(`  Sinyal unik: ${journal.signals.length}; token-chain: ${new Set(journal.signals.map((s) => `${s.chain}:${s.mint}`)).size}; malformed=${journal.malformed}; duplicate=${journal.duplicates}`);
  if (journal.malformed || journal.duplicates) lines.push("  DATA INVALID — collector/tracker fail closed; jangan tarik kesimpulan dari tabel ini.");
  if (!journal.signals.length) lines.push("  Belum ada kohort prospektif. Sinyal historis tidak dibackfill atau dianggap trade.");
  const marks = new Map(journal.marks.map((m) => [m.markId, m]));
  const groups = new Map<string, typeof journal.signals>();
  for (const s of journal.signals) {
    const key = `${s.chain} · type ${s.signalType} · ${s.policy.id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [name, signals] of groups) {
    const delay = signals.map((s) => s.observationDelayMs).filter((v): v is number => v != null && v >= 0).sort((a, b) => a - b);
    const days = new Set(signals.map((s) => new Date(s.observedAt).toISOString().slice(0, 10))).size;
    lines.push(`\n  ${name}: n=${signals.length}, token=${new Set(signals.map((s) => s.mint)).size}, UTC-days=${days}, trigger-delay med=${delay.length ? (delay[Math.floor(delay.length / 2)]! / 60_000).toFixed(1) + "m" : "?"}`);
    lines.push("  horizon | due | observed | missing | awaiting | future | price Δ med | price Δ mean");
    for (const h of [0, ...signals[0]!.policy.horizonsMinutes]) {
      let due = 0, observed = 0, missing = 0, awaiting = 0, future = 0;
      const returns: number[] = [];
      for (const s of signals) {
        if (now < s.observedAt + h * 60_000) { future++; continue; }
        due++;
        const m = marks.get(`${s.signalId}:${s.policy.id}:${h}`);
        if (!m) awaiting++;
        else if (m.status === "MISSING") missing++;
        else { observed++; if (m.priceChangePct != null && Number.isFinite(m.priceChangePct)) returns.push(m.priceChangePct); }
      }
      returns.sort((a, b) => a - b);
      const median = returns.length ? returns[Math.floor(returns.length / 2)]!.toFixed(2) + "%" : "—";
      const mean = returns.length ? (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2) + "%" : "—";
      lines.push(`  ${h ? `${h}m` : "entry"} | ${due} | ${observed} | ${missing} | ${awaiting} | ${future} | ${median} | ${mean}`);
    }
    const reasons: Record<string, number> = {};
    const ids = new Set(signals.map((s) => s.signalId));
    for (const m of journal.marks.filter((m) => ids.has(m.signalId) && m.status === "MISSING")) reasons[m.reason ?? "UNKNOWN"] = (reasons[m.reason ?? "UNKNOWN"] ?? 0) + 1;
    if (Object.keys(reasons).length) lines.push(`  missing reasons: ${JSON.stringify(reasons)}`);
  }
  lines.push("\n  VERDIKT PROFIT: BELUM TERBUKTI. Missing bukan return 0; harga feed bukan fill, net fees, atau bukti token bisa dijual.",
    "  Pair/source dikunci saat entry; toleransi mark 5m. Timestamp sumber tidak disediakan API, jadi freshness upstream belum terverifikasi.",
    "  Sinyal berulang pada token/hari yang sama tidak independen. Jangan pilih horizon/threshold pemenang setelah melihat hasil.");
  return lines;
}
