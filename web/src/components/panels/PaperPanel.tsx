import { useEffect, useState } from "react";

type PaperData = {
  engine: string;
  cycles: number;
  positions: Array<{ symbol: string; token: string; ageMin: number; entryWeth: number; stuck: boolean; stuckReason: string | null }>;
  closed: number;
  stuck: number;
  rule: string;
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

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-xs font-bold text-black">PAPER 1:1</span>
        <span className="text-xs text-white/50">
          {d.engine} · siklus {d.cycles} · tutup {d.closed} · stuck {d.stuck}
        </span>
      </div>
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
                {p.stuck ? "STUCK · " + (p.stuckReason ?? "") : "terbuka"}
              </td>
            </tr>
          ))}
          {d.positions.length === 0 && (
            <tr><td colSpan={4} className="py-2 text-white/40">belum ada posisi (engine berjalan, menunggu kandidat lolos dua arah)</td></tr>
          )}
        </tbody>
      </table>
      <div className="mt-2 text-[11px] text-white/40">{d.rule}</div>
    </div>
  );
}
