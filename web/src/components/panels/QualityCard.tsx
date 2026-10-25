/**
 * KARTU KUALITAS EKSEKUSI (2026-10-11).
 *
 * Menampilkan satu hal yang tidak bisa ditampilkan kartu lain: apakah harga saat kita keluar
 * BENAR-BENAR bertahan. Data datang lewat payload push `/api/stats` (bagian `quality`) — sama
 * seperti lane lain, bukan fetch terpisah.
 *
 * ATURAN PANEL: tidak boleh ada NaN/undefined/Infinity yang lolos ke markup (panel:check gagal).
 * Karena itu setiap angka diformat dengan cadangan "—", dan data yang belum ada ditampilkan
 * sebagai "belum ada", bukan $0.00 (yang akan memalsukan fakta).
 */
type Digest = { file?: string; mtime?: string; lines?: string[] } | null | undefined;
type Retention = { reason?: string; n?: number; p50?: number; p10?: number; vanished?: number };
export type QualityViewData = {
  day?: string;
  traceRows?: number;
  retention?: Retention[];
  stop?: Digest;
  realism?: Digest;
  okxArms?: Digest;
  note?: string;
};

const pct = (v?: number): string => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "—");
const num = (v?: number): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "—");
const ago = (iso?: string): string => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s.toFixed(0)}s` : s < 5_400 ? `${(s / 60).toFixed(0)}m` : `${(s / 3_600).toFixed(1)}j`;
};

export function QualityCard({ data }: { data?: QualityViewData | null }) {
  const rows = Array.isArray(data?.retention) ? data!.retention! : [];
  const empty = rows.length === 0;
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Kualitas eksekusi">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-scout">Kualitas eksekusi</p>
          <h2 className="text-sm font-semibold">Harga pasca-keluar — apakah bisa dijual?</h2>
        </div>
        <p className="text-[10px] text-muted-foreground">
          jejak hari ini: {num(data?.traceRows)} · stop {ago(data?.stop?.mtime)} · realism {ago(data?.realism?.mtime)} · okx {ago(data?.okxArms?.mtime)}
        </p>
      </div>

      {empty ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Belum ada jejak pasca-keluar hari ini. Jejak terisi 1–5 menit setelah setiap penutupan.
        </p>
      ) : (
        <table className="mt-3 w-full text-[11px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="font-normal">alasan keluar</th>
              <th className="font-normal text-right">n</th>
              <th className="font-normal text-right">retensi p50</th>
              <th className="font-normal text-right">p10</th>
              <th className="font-normal text-right">harga lenyap &lt;50%</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((r, i) => (
              <tr key={`${r.reason ?? "?"}-${i}`} className="border-t border-border/50">
                <td className="py-0.5">{r.reason ?? "—"}</td>
                <td className="py-0.5 text-right font-mono">{num(r.n)}</td>
                <td className="py-0.5 text-right font-mono">{pct(r.p50)}</td>
                <td className="py-0.5 text-right font-mono">{pct(r.p10)}</td>
                <td className="py-0.5 text-right font-mono">
                  {num(r.vanished)}
                  {typeof r.n === "number" && r.n > 0 && typeof r.vanished === "number"
                    ? ` (${((100 * r.vanished) / r.n).toFixed(0)}%)`
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data?.note ? <p className="mt-2 text-[10px] text-muted-foreground">{data.note}</p> : null}
    </section>
  );
}
