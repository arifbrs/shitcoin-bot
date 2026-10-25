/** Read-only Robinhood Chain research lane. No signer or execution imports. */

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC = process.env.ROBINHOOD_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
const DEX_API = "https://api.dexscreener.com";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const REQUEST_TIMEOUT_MS = 8_000;

type Json = Record<string, unknown>;
type Pair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  url?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string | null;
  liquidity?: { usd?: number } | null;
  marketCap?: number | null;
  fdv?: number | null;
  volume?: { h24?: number; h1?: number };
  txns?: { h24?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
  priceChange?: { h24?: number; h1?: number };
  pairCreatedAt?: number;
};

export type RobinhoodPool = {
  address: string;
  dex: string;
  url: string | null;
  quoteSymbol: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  createdAt: number | null;
};

export type WhaleTransfer = {
  id: string;
  txHash: string;
  block: number;
  from: string;
  to: string;
  amount: number;
  estimatedUsd: number;
  kind: "TRANSFER";
};

export type RobinhoodTokenView = {
  chainId: 4663;
  address: string;
  symbol: string;
  name: string;
  observedAt: string;
  source: "DexScreener + Robinhood Chain RPC";
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  marketCapSource: "provider" | "unavailable";
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
  change24hPct: number | null;
  pools: RobinhoodPool[];
  whale: { status: "ok" | "unavailable"; fromBlock: number | null; toBlock: number | null; thresholdUsd: number; transfers: WhaleTransfer[]; warning: string | null };
  decision: { verdict: "AVOID" | "WATCH" | "REVIEW"; score: number; reasons: string[]; blockers: string[]; note: string };
  warnings: string[];
};

const finite = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  return response.json();
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(ROBINHOOD_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Robinhood RPC HTTP ${response.status}`);
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message || "Robinhood RPC error");
  return payload.result;
}

function validPair(value: unknown): Pair | null {
  if (!value || typeof value !== "object") return null;
  const pair = value as Pair;
  return pair.chainId === "robinhood" && pair.pairAddress ? pair : null;
}

export async function searchRobinhoodTokens(query: string): Promise<Array<{ address: string; symbol: string; name: string; priceUsd: number | null; liquidityUsd: number | null; marketCapUsd: number | null; pairAddress: string }>> {
  const q = query.trim();
  if (q.length < 2 || q.length > 80) throw new Error("Query must be 2–80 characters");
  const payload = await getJson(`${DEX_API}/latest/dex/search?q=${encodeURIComponent(q)}`) as { pairs?: unknown[] };
  const byToken = new Map<string, Pair>();
  for (const raw of payload.pairs ?? []) {
    const pair = validPair(raw);
    const address = pair?.baseToken?.address;
    if (!pair || !address || !ADDRESS.test(address)) continue;
    const key = address.toLowerCase();
    const previous = byToken.get(key);
    if (!previous || (finite(pair.liquidity?.usd) ?? 0) > (finite(previous.liquidity?.usd) ?? 0)) byToken.set(key, pair);
  }
  return [...byToken.values()].sort((a, b) => (finite(b.liquidity?.usd) ?? 0) - (finite(a.liquidity?.usd) ?? 0)).slice(0, 25).map((pair) => ({
    address: pair.baseToken!.address!, symbol: pair.baseToken?.symbol || "?", name: pair.baseToken?.name || "Unknown",
    priceUsd: finite(pair.priceUsd), liquidityUsd: finite(pair.liquidity?.usd), marketCapUsd: finite(pair.marketCap),
    pairAddress: pair.pairAddress!,
  }));
}

export function assessRobinhoodToken(input: { liquidityUsd: number | null; volume24hUsd: number | null; marketCapUsd: number | null; buys24h: number | null; sells24h: number | null; change24hPct: number | null }): RobinhoodTokenView["decision"] {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const { liquidityUsd: lp, volume24hUsd: volume, marketCapUsd: mc, buys24h: buys, sells24h: sells, change24hPct: change } = input;
  if (lp == null) blockers.push("Likuiditas pool tidak tersedia");
  else if (lp < 25_000) blockers.push("Likuiditas pool di bawah $25k; exit berisiko");
  else reasons.push(`Likuiditas teramati $${Math.round(lp).toLocaleString("en-US")}`);
  if (mc == null) blockers.push("Market cap beredar tidak tersedia; FDV bukan pengganti");
  if (volume == null) blockers.push("Volume 24 jam tidak tersedia");
  else if (volume < 10_000) blockers.push("Volume 24 jam di bawah $10k");
  else reasons.push("Volume 24 jam cukup untuk evaluasi awal");
  const total = (buys ?? 0) + (sells ?? 0);
  if (!total) blockers.push("Data transaksi buy/sell 24 jam tidak tersedia");
  else if (total < 20) blockers.push("Jumlah transaksi 24 jam terlalu sedikit");
  else if ((buys ?? 0) / total < 0.4) blockers.push("Tekanan jual lebih dominan");
  else reasons.push("Aktivitas buy/sell tidak didominasi penjualan");
  if (change != null && change > 100) blockers.push("Kenaikan 24 jam >100%; risiko mengejar harga");
  if (change != null && change < -35) blockers.push("Penurunan 24 jam >35%; periksa sebabnya");
  const score = Math.max(0, Math.min(100, 50 + reasons.length * 12 - blockers.length * 18));
  const verdict = lp != null && lp < 25_000 ? "AVOID" : blockers.length ? "WATCH" : "REVIEW";
  return { verdict, score, reasons, blockers, note: "Screening observasional, bukan instruksi BUY/HOLD. Belum ada verifikasi kontrak, holder, sellability, atau posisi Anda." };
}

async function recentTransfers(address: string, priceUsd: number | null, thresholdUsd: number): Promise<RobinhoodTokenView["whale"]> {
  const empty: RobinhoodTokenView["whale"] = { status: "unavailable", fromBlock: null, toBlock: null, thresholdUsd, transfers: [], warning: null };
  if (priceUsd == null || priceUsd <= 0) return { ...empty, warning: "Harga tidak tersedia; nilai transfer whale tidak dapat diperkirakan" };
  try {
    const [chain, latest, decimalsRaw] = await Promise.all([
      rpc("eth_chainId", []), rpc("eth_blockNumber", []), rpc("eth_call", [{ to: address, data: "0x313ce567" }, "latest"]),
    ]);
    if (chain !== "0x1237") throw new Error(`RPC chain ID salah: ${String(chain)}`);
    const toBlock = Number.parseInt(String(latest), 16);
    const decimals = Number.parseInt(String(decimalsRaw), 16);
    if (!Number.isInteger(toBlock) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Block/decimals ERC-20 tidak valid");
    const fromBlock = Math.max(0, toBlock - 119);
    const rawLogs = await rpc("eth_getLogs", [{ address, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, topics: [TRANSFER_TOPIC] }]);
    if (!Array.isArray(rawLogs)) throw new Error("Respons eth_getLogs tidak valid");
    const transfers: WhaleTransfer[] = [];
    for (const item of rawLogs.slice(0, 2_000)) {
      const log = item as { topics?: string[]; data?: string; transactionHash?: string; logIndex?: string; blockNumber?: string; removed?: boolean };
      if (log.removed || log.topics?.length !== 3 || !log.data || !log.transactionHash || !log.blockNumber) continue;
      const amount = Number(BigInt(log.data)) / 10 ** decimals;
      const estimatedUsd = amount * priceUsd;
      if (!Number.isFinite(estimatedUsd) || estimatedUsd < thresholdUsd) continue;
      transfers.push({ id: `${log.transactionHash}:${log.logIndex ?? "0x0"}`, txHash: log.transactionHash, block: Number.parseInt(log.blockNumber, 16),
        from: `0x${log.topics[1]!.slice(-40)}`, to: `0x${log.topics[2]!.slice(-40)}`, amount, estimatedUsd, kind: "TRANSFER" });
    }
    transfers.sort((a, b) => b.block - a.block || b.estimatedUsd - a.estimatedUsd);
    return { status: "ok", fromBlock, toBlock, thresholdUsd, transfers: transfers.slice(0, 30), warning: rawLogs.length >= 2_000 ? "Hasil dibatasi 2.000 log; sebagian event mungkin terlewat" : null };
  } catch (error) {
    return { ...empty, warning: error instanceof Error ? error.message : String(error) };
  }
}

export async function inspectRobinhoodToken(address: string, thresholdUsd = 10_000): Promise<RobinhoodTokenView> {
  if (!ADDRESS.test(address)) throw new Error("Alamat token EVM tidak valid");
  if (!Number.isFinite(thresholdUsd) || thresholdUsd < 0 || thresholdUsd > 1e9) throw new Error("Ambang whale tidak valid");
  const payload = await getJson(`${DEX_API}/token-pairs/v1/robinhood/${address}`);
  // DexScreener's price/marketCap fields describe baseToken, never the quote token.
  const pairs = (Array.isArray(payload) ? payload : []).map(validPair).filter((pair): pair is Pair => pair !== null)
    .filter((pair) => pair.baseToken?.address?.toLowerCase() === address.toLowerCase());
  const sorted = pairs.sort((a, b) => (finite(b.liquidity?.usd) ?? 0) - (finite(a.liquidity?.usd) ?? 0));
  const primary = sorted[0];
  const priceUsd = finite(primary?.priceUsd);
  const whale = await recentTransfers(address, priceUsd, thresholdUsd);
  const liquidityUsd = sorted.reduce((sum, pair) => sum + (finite(pair.liquidity?.usd) ?? 0), 0) || null;
  const volume24hUsd = sorted.reduce((sum, pair) => sum + (finite(pair.volume?.h24) ?? 0), 0) || null;
  const buys24h = sorted.reduce((sum, pair) => sum + (finite(pair.txns?.h24?.buys) ?? 0), 0) || null;
  const sells24h = sorted.reduce((sum, pair) => sum + (finite(pair.txns?.h24?.sells) ?? 0), 0) || null;
  const marketCapUsd = finite(primary?.marketCap);
  const warnings = ["Metrik pasar berasal dari DexScreener; waktu pembaruan underlying tidak dijamin."];
  if (!primary) warnings.push("Token belum memiliki pool yang terindeks di DexScreener.");
  if (whale.warning) warnings.push(`Whale watch: ${whale.warning}`);
  return {
    chainId: ROBINHOOD_CHAIN_ID, address, symbol: primary?.baseToken?.symbol || "?", name: primary?.baseToken?.name || "Unknown",
    observedAt: new Date().toISOString(), source: "DexScreener + Robinhood Chain RPC", priceUsd, marketCapUsd,
    fdvUsd: finite(primary?.fdv), marketCapSource: marketCapUsd == null ? "unavailable" : "provider", liquidityUsd,
    volume24hUsd, buys24h, sells24h, change24hPct: finite(primary?.priceChange?.h24),
    pools: sorted.slice(0, 15).map((pair) => ({ address: pair.pairAddress!, dex: pair.dexId || "?", url: pair.url || null,
      quoteSymbol: pair.quoteToken?.symbol || null, liquidityUsd: finite(pair.liquidity?.usd), volume24hUsd: finite(pair.volume?.h24),
      createdAt: finite(pair.pairCreatedAt) })), whale,
    decision: assessRobinhoodToken({ liquidityUsd, volume24hUsd, marketCapUsd, buys24h, sells24h, change24hPct: finite(primary?.priceChange?.h24) }), warnings,
  };
}
