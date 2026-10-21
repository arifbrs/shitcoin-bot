import { useEffect, useState } from "react";

type PaperData = {
  engine: string;
  cycles: number;
  candidates: number;
  positions: Array<{ symbol: string; token: string; ageMin: number; entryWeth: number; stuck: boolean; stuckReason: string | null }>;
  closed: number;
  stuck: number;
  rule: string;
  updatedAt: string;
};

export function PaperPanel() {
  const [d, setD] = useState<PaperData | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/paper");
        const j = (await r.json()) as PaperData;
        if (alive) setD(j);
      } catch {
        /* biarkan data terakhir */
      }
    };
    void load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!d) return null;
  const idle = d.positions.length === 0 && d.closed === 0;

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-xs font-bold text-black">PAPER 1:1</span>
          <span className="text-xs text-white/60">lolos uji dua arah</span>
        </div>
        <div className="flex gap-3 text-xs text-white/50">
          <span>siklus <b className="text-white/80">{d.cycles}</b></span>
          <span>kandidat <b className="text-white/80">{d.candidates}</b></span>
          <span>tutup <b className="text-emerald-400">{d.closed}</b></span>
          <span>stuck <b className={d.stuck > 0 ? "text-amber-400" : "text-white/80"}>{d.stuck}</b></span>
        </div>
      </div>

      {idle && (
        <p className="mt-3 text-sm text-white/50">
          Engine berjalan, belum ada posisi. Ia hanya masuk ke token yang <b className="text-white/80">terbukti bisa dibeli dan dijual</b> —
          hari ini {d.candidates} kandidat lolos dari seluruh token yang dipindai.
        </p>
      )}

      {!idle && (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-white/40">
              <th>token</th><th>umur</th><th>WETH masuk</th><th>status</th>
            </tr>
          </thead>
          <tbody>
            {d.positions.map((p) => (
              <tr key={p.token} className="border-t border-white/5">
                <td className="py-1 font-semibold">{p.symbol}</td>
                <td>{p.ageMin} mnt</td>
                <td>{p.entryWeth.toFixed(6)}</td>
                <td className={p.stuck ? "text-amber-400" : "text-white/60"}>
                  {p.stuck ? "STUCK · " + (p.stuckReason ?? "") : "terbuka · menunggu exit sesuai aturan"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11px] text-white/40">
        <span>{d.rule}</span>
        <span>diperbarui {new Date(d.updatedAt).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
