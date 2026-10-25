import { useCallback, useEffect, useState } from "react";

type SearchRow = { address: string; symbol: string; name: string; priceUsd: number | null; liquidityUsd: number | null; marketCapUsd: number | null; pairAddress: string };
type TokenView = {
  address: string; symbol: string; name: string; observedAt: string; priceUsd: number | null; marketCapUsd: number | null;
  fdvUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null; buys24h: number | null;
  sells24h: number | null; change24hPct: number | null;
  pools: Array<{ address: string; dex: string; url: string | null; quoteSymbol: string | null; liquidityUsd: number | null; volume24hUsd: number | null }>;
  whale: { status: "ok" | "unavailable"; fromBlock: number | null; toBlock: number | null; thresholdUsd: number; transfers: Array<{ id: string; txHash: string; block: number; from: string; to: string; amount: number; estimatedUsd: number; kind: "TRANSFER" }>; warning: string | null };
  decision: { verdict: "AVOID" | "WATCH" | "REVIEW"; score: number; reasons: string[]; blockers: string[]; note: string };
  warnings: string[];
};

const STORAGE_KEY = "micincloud_robinhood_watchlist_v1";
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const money = (value: number | null) => value == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: value < 1 ? 6 : 2 }).format(value);
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (response.status === 401) throw new Error("session-expired");
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function readWatchlist(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(raw) ? [...new Set(raw.filter((item): item is string => typeof item === "string" && ADDRESS.test(item)).map((item) => item.toLowerCase()))].slice(0, 25) : [];
  } catch { return []; }
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-r border-border/60 pr-3 last:border-r-0"><p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono text-sm text-foreground" title={value}>{value}</p></div>;
}

export function RobinhoodChainPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchRow[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>(readWatchlist);
  const [selected, setSelected] = useState<string | null>(() => readWatchlist()[0] ?? null);
  const [view, setView] = useState<TokenView | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist)); }, [watchlist]);

  const inspect = useCallback(async (address: string, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const data = await readJson<TokenView>(`/api/robinhood/token?address=${encodeURIComponent(address)}`, signal);
      if (!signal?.aborted) { setView(data); setError(null); }
    } catch (cause) {
      if (signal?.aborted) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "session-expired") { window.location.href = "/login"; return; }
      setError(message);
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!selected) { setView(null); return; }
    const controller = new AbortController();
    void inspect(selected, controller.signal);
    const timer = window.setInterval(() => { if (!document.hidden) void inspect(selected, controller.signal); }, 120_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [selected, inspect]);

  const runSearch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = query.trim();
    if (ADDRESS.test(q)) { selectToken(q); return; }
    if (q.length < 2) { setError("Masukkan minimal 2 karakter atau alamat kontrak."); return; }
    setSearching(true);
    try { setResults(await readJson<SearchRow[]>(`/api/robinhood/search?q=${encodeURIComponent(q)}`)); setError(null); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "session-expired") { window.location.href = "/login"; return; }
      setError(message);
    } finally { setSearching(false); }
  };

  const selectToken = (address: string) => {
    const key = address.toLowerCase();
    setWatchlist((current) => current.includes(key) ? current : [key, ...current].slice(0, 25));
    setSelected(key);
    setResults([]);
    setView(null);
    setQuery("");
  };

  const removeToken = (address: string) => {
    const next = watchlist.filter((item) => item !== address);
    setWatchlist(next);
    if (selected === address) setSelected(next[0] ?? null);
  };

  return (
    <section className="mx-auto mt-3 max-w-[1700px] rounded-xl border border-border bg-card p-4" aria-label="Robinhood Chain intelligence">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="font-mono text-[9px] uppercase tracking-[0.2em] text-scout">Ethereum L2 · Chain ID 4663 · Observasi saja</p><h2 className="mt-1 text-lg font-semibold text-foreground">Robinhood Chain radar</h2><p className="mt-1 text-xs text-muted-foreground">Screening token, LP, market cap dan transfer besar. Tidak terhubung ke eksekusi Solana atau wallet.</p></div>
        {view && <span className="font-mono text-[10px] text-muted-foreground">Snapshot {new Date(view.observedAt).toLocaleTimeString("id-ID")}</span>}
      </div>
      <form onSubmit={runSearch} className="mt-4 flex gap-2">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari simbol/nama atau tempel alamat kontrak 0x…" aria-label="Cari token Robinhood Chain" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-scout" />
        <button type="submit" disabled={searching} className="rounded-md border border-scout/50 bg-scout/10 px-4 py-2 font-mono text-[10px] text-scout disabled:opacity-50">{searching ? "MENCARI…" : "CARI"}</button>
      </form>
      {error && <p role="alert" className="mt-2 text-xs text-down">{error}</p>}
      {results.length > 0 && <div className="mt-2 max-h-48 overflow-auto rounded-md border border-border">
        {results.map((row) => <button key={row.address} type="button" onClick={() => selectToken(row.address)} className="flex w-full items-center justify-between gap-3 border-b border-border/50 px-3 py-2 text-left text-xs hover:bg-background last:border-b-0"><span><strong>{row.symbol}</strong> <span className="text-muted-foreground">{row.name} · {short(row.address)}</span></span><span className="font-mono text-[10px] text-muted-foreground">LP {money(row.liquidityUsd)}</span></button>)}
      </div>}
      {watchlist.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Token watchlist">{watchlist.map((address) => <div key={address} className={`flex items-center rounded-md border ${selected === address ? "border-scout/60 bg-scout/10" : "border-border"}`}><button type="button" onClick={() => setSelected(address)} className="px-2 py-1.5 font-mono text-[10px] text-foreground" title={address}>{view?.address.toLowerCase() === address ? view.symbol : short(address)}</button><button type="button" onClick={() => removeToken(address)} className="px-1.5 text-muted-foreground hover:text-down" aria-label={`Hapus ${address} dari watchlist`}>×</button></div>)}</div>}
      {selected && <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-mono text-sm font-semibold text-foreground">{view?.symbol || short(selected)}</h3><a className="font-mono text-[10px] text-scout underline" href={`https://robinhoodchain.blockscout.com/token/${selected}`} target="_blank" rel="noopener noreferrer">Kontrak ↗</a><button type="button" onClick={() => void inspect(selected)} disabled={loading} className="ml-auto rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground disabled:opacity-50">{loading ? "Memuat…" : "Refresh"}</button></div>
        {view && <>
          <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-border bg-background/40 p-3 sm:grid-cols-3 lg:grid-cols-6"><Metric label="Harga" value={money(view.priceUsd)} /><Metric label="Market cap" value={money(view.marketCapUsd)} /><Metric label="FDV" value={money(view.fdvUsd)} /><Metric label="Total LP" value={money(view.liquidityUsd)} /><Metric label="Volume 24j" value={money(view.volume24hUsd)} /><Metric label="Perubahan 24j" value={view.change24hPct == null ? "—" : `${view.change24hPct >= 0 ? "+" : ""}${view.change24hPct.toFixed(1)}%`} /></div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-background/30 p-3"><div className="flex items-center gap-2"><h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Decision review</h4><span className={`rounded px-2 py-0.5 font-mono text-[10px] ${view.decision.verdict === "AVOID" ? "bg-down/15 text-down" : view.decision.verdict === "REVIEW" ? "bg-up/15 text-up" : "bg-gold/15 text-gold"}`}>{view.decision.verdict}</span><span className="ml-auto font-mono text-[10px] text-muted-foreground">{view.decision.score}/100</span></div><p className="mt-2 text-xs text-muted-foreground">{view.decision.note}</p><ul className="mt-2 space-y-1 text-xs">{view.decision.reasons.map((reason) => <li key={reason} className="text-up">✓ {reason}</li>)}{view.decision.blockers.map((reason) => <li key={reason} className="text-down">! {reason}</li>)}</ul></div>
            <div className="rounded-lg border border-border bg-background/30 p-3"><h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Whale watch · transfer ERC-20</h4><p className="mt-1 text-[10px] text-muted-foreground">Ambang {money(view.whale.thresholdUsd)} · blok {view.whale.fromBlock ?? "—"}–{view.whale.toBlock ?? "—"}. Transfer ≠ buy/sell; valuasi memakai harga snapshot.</p>{view.whale.status === "unavailable" ? <p className="mt-2 text-xs text-gold">Tidak tersedia: {view.whale.warning}</p> : view.whale.transfers.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">Tidak ada transfer di atas ambang pada jendela blok ini.</p> : <div className="mt-2 max-h-44 space-y-1 overflow-auto">{view.whale.transfers.map((item) => <a key={item.id} href={`https://robinhoodchain.blockscout.com/tx/${item.txHash}`} target="_blank" rel="noopener noreferrer" className="flex justify-between gap-2 border-b border-border/50 py-1 font-mono text-[10px] text-foreground hover:text-scout"><span>{short(item.from)} → {short(item.to)}</span><span>{money(item.estimatedUsd)}</span></a>)}</div>}</div>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-background/30 p-3"><h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Liquidity pools ({view.pools.length})</h4>{view.pools.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Belum ada pool yang terindeks.</p> : <div className="mt-2 space-y-1">{view.pools.map((pool) => <div key={pool.address} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 py-1 text-xs last:border-b-0"><span>{pool.dex} · {pool.quoteSymbol || "?"} <span className="font-mono text-[10px] text-muted-foreground">{short(pool.address)}</span></span><span className="font-mono text-[10px]">LP {money(pool.liquidityUsd)} · Vol {money(pool.volume24hUsd)} {pool.url && <a href={pool.url} target="_blank" rel="noopener noreferrer" className="text-scout underline">Chart ↗</a>}</span></div>)}</div>}</div>
          <p className="mt-2 text-[10px] text-muted-foreground">{view.warnings.join(" ")} HOLD belum bisa dinilai tanpa posisi, harga masuk, dan batas risiko pengguna.</p>
        </>}
      </div>}
      {!selected && <p className="mt-5 text-center text-xs text-muted-foreground">Cari token untuk mulai watchlist Robinhood Chain.</p>}
    </section>
  );
}
