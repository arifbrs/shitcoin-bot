import type { StatsResponse, GateRejections } from "@/types/stats";

/**
 * Why candidates did not become positions.
 *
 * This panel exists because the dashboard previously had no answer to the most obvious question
 * an empty positions list raises: is the scout finding nothing, or is everything it finds being
 * filtered out? The API even asserted a 100% pass rate as a literal while hundreds of candidates
 * were being rejected. Those are opposite problems with opposite fixes, so the funnel shows the
 * real counts and names the gate that did the rejecting.
 */

// Ordered as the trader evaluates them, so the bars read as an actual pipeline rather than an
// arbitrary tally. Labels say what was WRONG with the candidate, not the gate's internal name.
const GATES: Array<{ key: keyof GateRejections; label: string; hint: string }> = [
  { key: "deadToken", label: "sudah mati", hint: "likuiditas ~0 / tidak ada swap sejam terakhir" },
  { key: "staleMc", label: "MC sudah pindah", hint: "market cap live keluar dari band" },
  { key: "unroutable", label: "tak bisa dirutekan", hint: "likuid tapi tidak ada rute beli" },
  { key: "cost", label: "biaya masuk mahal", hint: "friksi entry di atas plafon" },
  { key: "bundle", label: "terkoordinasi", hint: "2+ top holder beli di detik yang sama" },
  { key: "ath", label: "terlalu dekat ATH", hint: "harga dalam 15% dari tertinggi sepanjang masa" },
];

export function GateFunnel({ data }: { data: StatsResponse }) {
  const s2 = data.strategy2Primary;
  if (!s2) return <p className="font-mono text-[10px] text-muted-foreground">Strategy 2 tidak aktif.</p>;

  const rej = s2.gateRejections;
  const rows = GATES.map((g) => ({ ...g, n: rej?.[g.key] ?? 0 })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
  const { gated, passed, rejected, passRate } = s2.totals;
  const max = Math.max(1, ...rows.map((r) => r.n));

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      <div className="flex shrink-0 items-baseline gap-3 font-mono">
        <span className="text-[9px] tracking-widest text-muted-foreground/60">ADMISSION</span>
        <span className="text-[11px] text-up">{passed} masuk</span>
        <span className="text-[11px] text-down">{rejected} ditolak</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {(passRate * 100).toFixed(1)}% dari {gated} dinilai
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          Belum ada penolakan gate tercatat pada epoch ini.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
          {rows.map((r) => (
            <div key={r.key} className="group flex items-center gap-2" title={r.hint}>
              <span className="w-[104px] shrink-0 truncate font-mono text-[10px] text-muted-foreground">{r.label}</span>
              <div className="h-[9px] min-w-0 flex-1 overflow-hidden rounded-sm bg-border/40">
                <div
                  className="h-full rounded-sm bg-down/50 transition-[width] duration-500 group-hover:bg-down/70"
                  style={{ width: `${Math.max(2, (r.n / max) * 100)}%` }}
                />
              </div>
              <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-down">{r.n}</span>
            </div>
          ))}
        </div>
      )}

      <p className="shrink-0 font-mono text-[9px] leading-tight text-muted-foreground/50">
        {s2.seenMints.toLocaleString()} kandidat terlihat scout · hanya yang lolos saringan awal sampai ke gate ini
      </p>
    </div>
  );
}
