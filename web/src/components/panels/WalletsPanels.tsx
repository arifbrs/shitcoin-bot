import { useEffect, useState } from "react";

/** (S12-§C) Panel wallet SOLANA — dari /api/wallet (read-only; tanpa membaca/membuat kunci di browser). */
export function SolanaWalletPanel() {
  const [data, setData] = useState<{ address: string | null; mainnet: number | null; devnet: number | null; note?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch("/api/wallet", { cache: "no-store" });
        if (res.status === 401) { window.location.replace("/login"); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { address: string | null; mainnet: number; devnet: number; note?: string };
        if (!stopped) { setData(j); setError(null); setReceivedAt(Date.now()); }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { stopped = true; window.clearInterval(t); };
  }, []);
  const bal = (v: number | null | undefined): { text: string; cls: string } =>
    v == null ? { text: "tak terbaca (RPC gagal — bukan nol)", cls: "text-amber-400" }
      : v < 0 ? { text: "tak terbaca (RPC gagal — bukan nol)", cls: "text-amber-400" }
        : { text: `${v.toFixed(4)} SOL`, cls: "text-foreground" };
  const m = bal(data?.mainnet), d = bal(data?.devnet);
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Wallet Solana">
      <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-gold">Solana mainnet/devnet · read-only</p>
      <h3 className="mt-1 text-base font-semibold text-foreground">Wallet Solana (bot)</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-foreground">{data?.address ? `${data.address.slice(0, 8)}…${data.address.slice(-6)}` : "—"}</span>
        {data?.address && (
          <button type="button" className="terminal-button !px-2 !py-0.5 text-[10px]" onClick={() => { void navigator.clipboard.writeText(data.address!); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>
            {copied ? "tersalin ✓" : "salin alamat"}
          </button>
        )}
        {receivedAt != null && <span className="font-mono text-[10px] text-muted-foreground">refresh {Math.max(0, Math.round((Date.now() - receivedAt) / 1000))}s lalu</span>}
      </div>
      {data?.note && <p className="mt-1 font-mono text-[10px] text-amber-400">{data.note}</p>}
      {error && <p className="mt-1 font-mono text-[10px] text-red-400">galat: {error}</p>}
      <dl className="mt-2 grid gap-1 font-mono text-[11px]">
        <div className="flex justify-between"><dt className="text-muted-foreground">Mainnet (pool RPC)</dt><dd className={m.cls}>{m.text}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">Devnet</dt><dd className={d.cls}>{d.text}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">Estimasi USD</dt><dd className="text-muted-foreground">hanya bila quote valid — tidak dikarang</dd></div>
      </dl>
      <p className="mt-2 font-mono text-[9px] text-muted-foreground">Kunci privat TIDAK pernah dikirim ke browser; pembacaan tidak membuat wallet baru.</p>
    </section>
  );
}

interface RhLive {
  wallet: string; chainId: string | null;
  balances: { eth: number; weth: number; usdg: number };
  balanceErrors: { eth: string | null; weth: string | null; usdg: string | null };
  positions: Array<{ token: string; symbol?: string; qty: number | null; status: string; unverifiedSell: boolean; sellable: boolean | null; stalePrice: boolean; notionalUsd?: number; ageMin: number; lastSellTxHash: string | null; decimals: number | null }>;
  sells: Array<{ token: string; symbol?: string; ts: number; confirmed: boolean; txHash: string | null }>;
  error?: string;
}

const STATUS_TONE: Record<string, string> = { OPEN: "text-emerald-400", CLOSED_CONFIRMED: "text-muted-foreground", GHOST: "text-amber-400", UNKNOWN: "text-amber-400", UNEXITABLE: "text-red-400" };
const balText = (v: number, err: string | null): { text: string; cls: string } =>
  err != null || v < 0 ? { text: "tak terbaca (RPC gagal — bukan nol)", cls: "text-amber-400" } : { text: String(v), cls: "text-foreground" };

/** (S12-§C) Panel wallet ROBINHOOD CHAIN — dari /api/live (posisi NYATA, terpisah dari paper). */
export function RobinhoodWalletPanel() {
  const [data, setData] = useState<RhLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        if (res.status === 401) { window.location.replace("/login"); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as RhLive;
        if (!stopped) { setData(j); setError(null); setReceivedAt(Date.now()); }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { stopped = true; window.clearInterval(t); };
  }, []);
  const eth = balText(data?.balances.eth ?? -1, data?.balanceErrors.eth ?? null);
  const weth = balText(data?.balances.weth ?? -1, data?.balanceErrors.weth ?? null);
  const usdg = balText(data?.balances.usdg ?? -1, data?.balanceErrors.usdg ?? null);
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Wallet Robinhood Chain">
      <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-gold">Robinhood Chain · EVM · dana NYATA</p>
      <h3 className="mt-1 text-base font-semibold text-foreground">Wallet Robinhood Chain (bot)</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-foreground">{data?.wallet ? `${data.wallet.slice(0, 8)}…${data.wallet.slice(-6)}` : "—"}</span>
        {data?.wallet && <button type="button" className="terminal-button !px-2 !py-0.5 text-[10px]" onClick={() => { void navigator.clipboard.writeText(data.wallet); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>{copied ? "tersalin ✓" : "salin alamat"}</button>}
        <span className="font-mono text-[10px] text-muted-foreground">chainId {data?.chainId ?? "?"} (4663 = 0x1237)</span>
        {receivedAt != null && <span className="font-mono text-[10px] text-muted-foreground">refresh {Math.max(0, Math.round((Date.now() - receivedAt) / 1000))}s lalu</span>}
      </div>
      {error && <p className="mt-1 font-mono text-[10px] text-red-400">galat: {error}</p>}
      {data?.error && <p className="mt-1 font-mono text-[10px] text-red-400">RPC: {data.error}</p>}
      <dl className="mt-2 grid gap-1 font-mono text-[11px]">
        <div className="flex justify-between"><dt className="text-muted-foreground">ETH (native)</dt><dd className={eth.cls}>{eth.text}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">WETH</dt><dd className={weth.cls}>{weth.text}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">USDG</dt><dd className={usdg.cls}>{usdg.text}</dd></div>
      </dl>
      <h4 className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Posisi live (rekonstruksi on-chain — BUKAN paper)</h4>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-left"><thead><tr className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          <th className="pr-3 pb-1">token</th><th className="pr-3 pb-1 text-right">kuantitas</th><th className="pr-3 pb-1">status</th><th className="pr-3 pb-1">jual tak-verifikasi</th><th className="pr-3 pb-1">harga</th><th className="pb-1">umur</th>
        </tr></thead><tbody>
          {(data?.positions ?? []).map((p) => (
            <tr key={p.token} className="border-t border-border/60 font-mono text-[10px]">
              <td className="py-1 pr-3 text-foreground">{p.symbol ?? p.token.slice(0, 10)}</td>
              <td className="py-1 pr-3 text-right text-foreground">{p.qty != null ? p.qty.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "UNKNOWN (RPC)"}</td>
              <td className={`py-1 pr-3 ${STATUS_TONE[p.status] ?? ""}`}>{p.status}</td>
              <td className="py-1 pr-3 text-amber-400">{p.unverifiedSell ? "ADA — baris ok tanpa bukti tx" : "—"}</td>
              <td className="py-1 pr-3 text-muted-foreground">{p.stalePrice ? `${p.notionalUsd ?? "?"} (harga beli — basi)` : "—"}</td>
              <td className="py-1 text-muted-foreground">{p.ageMin > 1440 ? `${(p.ageMin / 1440).toFixed(1)}h` : `${p.ageMin.toFixed(0)}m`}</td>
            </tr>
          ))}
          {data && data.positions.length === 0 && <tr><td colSpan={6} className="py-2 text-muted-foreground">tidak ada posisi live</td></tr>}
        </tbody></table>
      </div>
      <p className="mt-2 font-mono text-[9px] text-muted-foreground">CLOSED_CONFIRMED menuntut tx hash + saldo terverifikasi 0; UNEXITABLE = saldo ada tapi tanpa rute jual; kuantitas pakai decimals() kontrak. Kunci TIDAK pernah tampil.</p>
    </section>
  );
}

import type { StatsResponse } from "@/types/stats";

/** (S12-§H) Grid status 5 kategori — paper vs live TIDAK dicampur; sumber tiap angka dilabel. */
export function LaneStatusGrid({ data, localEquityUsd, localStale }: { data: StatsResponse | null; localEquityUsd: number | null; localStale: boolean }) {
  const h = data?.laneHealth;
  const s2 = data?.strategy2Paper;
  const rh = data?.laneRobinhood;
  const fresh = (k?: { ageSec: number | null; fresh: boolean }): { t: string; c: string } =>
    !k ? { t: "TAK ADA DATA", c: "text-red-400" } : k.fresh ? { t: "AKTIF", c: "text-emerald-400" } : { t: "DIAM/TERTUNDA", c: "text-amber-400" };
  const rows: Array<{ lane: string; kind: "paper-browser" | "paper-server" | "paper-server" | "riset" | "live"; state: { t: string; c: string }; detail: string; pnl?: string }> = [
    { lane: "Paper browser (lokal)", kind: "paper-browser", state: { t: "AKTIF (di browser)", c: "text-emerald-400" }, detail: `ekuitas ${localEquityUsd != null ? `$${localEquityUsd.toFixed(2)}` : "?"}${localStale ? " · sebagian harga basi" : ""}`, pnl: undefined },
    { lane: "Robinhood server paper", kind: "paper-server", state: fresh(h?.robinhood), detail: rh ? `${rh.variants.reduce((a, v) => a + v.openPositions, 0)} posisi terbuka (arm server)` : "state rh-paper belum terbaca" },
    { lane: "Solana / Strategy 2 paper", kind: "paper-server", state: fresh(h?.okxPaper), detail: s2 ? `${s2.openPositions.length} posisi · PnL ${s2.pnlUsd >= 0 ? "+" : ""}$${s2.pnlUsd.toFixed(2)} (${s2.pnlPct.toFixed(1)}%)` : "state S2 belum terbaca" },
    { lane: "Pump.fun H2 riset (shadow)", kind: "riset", state: fresh(h?.pumpfun), detail: "event H2 + outcome bayangan — BUKAN posisi wallet" },
    { lane: "Wallet live (dana nyata)", kind: "live", state: { t: "READ-ONLY", c: "text-gold" }, detail: "panel di bawah — Solana & Robinhood terpisah" },
  ];
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Status lane">
      <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-gold">5 kategori · paper ≠ live · tidak dicampur</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left"><thead><tr className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          <th className="pr-3 pb-1">lane</th><th className="pr-3 pb-1">kategori</th><th className="pr-3 pb-1">status</th><th className="pb-1">detil</th>
        </tr></thead><tbody>
          {rows.map((r) => (
            <tr key={r.lane} className="border-t border-border/60 font-mono text-[10px]">
              <td className="py-1 pr-3 text-foreground">{r.lane}</td>
              <td className="py-1 pr-3 text-muted-foreground">{r.kind === "live" ? "DANA NYATA" : r.kind === "riset" ? "RISET" : "PAPER"}</td>
              <td className={`py-1 pr-3 ${r.state.c}`}>{r.state.t}</td>
              <td className="py-1 text-muted-foreground">{r.detail}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <p className="mt-2 font-mono text-[9px] text-muted-foreground">Heartbeat dari mtime berkas state (kecuali paper-browser & live) — candle/candle-lama BUKAN tick realtime.</p>
    </section>
  );
}
