/**
 * DEXSCREENER WEBSOCKET — 6 stream realtime (profiles, profile-updates, CTO, ads, boosts, boosts-top).
 *
 * DIUKUR, BUKAN DIASUMSIKAN (2026-10-08, uji langsung dari mesin ini): keenam stream menerima
 * koneksi HTTP 101 TANPA kunci, TANPA akun, dan mengalirkan data dalam hitungan detik
 * (profiles 68KB / updates 95KB / CTO 37KB / ads 13KB / boosts 71KB / boosts-top 71KB per 10s).
 * Dokumentasi DexScreener tidak memuat harga WS; API Terms menyebut ada versi gratis & berbayar
 * dengan limit "dilihat saat checkout". Jadi status biaya: tidak dipublikasikan; kenyataan uji: gratis.
 *
 * Modul ini hanya MENGANGKUT data ke atas (callback). Dedupe, penyaringan chain, dan penulisan
 * state tetap di dex-full — supaya satu tempat menyimpan kebenaran "pernah dilihat".
 */
import WebSocket from "ws";
import { ui, logRecord } from "../util/log.js";
import { configHash } from "../config.js";

export type DexWsKind = "profiles" | "profile-updates" | "cto" | "ads" | "boosts" | "boosts-top";

const STREAMS: Array<{ kind: DexWsKind; path: string }> = [
  { kind: "profiles", path: "token-profiles/latest/v1" },
  { kind: "profile-updates", path: "token-profiles/recent-updates/v1" },
  { kind: "cto", path: "community-takeovers/latest/v1" },
  { kind: "ads", path: "ads/latest/v1" },
  { kind: "boosts", path: "token-boosts/latest/v1" },
  { kind: "boosts-top", path: "token-boosts/top/v1" },
];

interface Row { chainId?: string; tokenAddress?: string; [k: string]: unknown }

/** Stream diam > 5 menit = dianggap putus (server bisa menutup tanpa pesan error). */
const SILENCE_RECONNECT_MS = 5 * 60_000;

export function startDexWs(onRows: (kind: DexWsKind, rows: Row[]) => void): () => void {
  const stats = new Map<DexWsKind, { msgs: number; rows: number; lastAt: number; reconnects: number }>();
  const alive = new Set<DexWsKind>();
  const timers: NodeJS.Timeout[] = [];
  let closed = false;

  const connect = (stream: { kind: DexWsKind; path: string }, attempt: number): void => {
    if (closed) return;
    const st = stats.get(stream.kind) ?? { msgs: 0, rows: 0, lastAt: 0, reconnects: 0 };
    stats.set(stream.kind, st);
    let silence: NodeJS.Timeout | null = null;
    const ws = new WebSocket(`wss://api.dexscreener.com/${stream.path}`, { handshakeTimeout: 15_000 });

    const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));

    ws.on("open", () => {
      alive.add(stream.kind);
      if (attempt > 0) logRecord("events", { type: "dex-ws-reconnect", stream: stream.kind, attempt, cfg: configHash });
      silence = setInterval(() => {
        if (Date.now() - st.lastAt > SILENCE_RECONNECT_MS) {
          ui.warn(`[dex-ws] ${stream.kind} diam ${Math.round((Date.now() - st.lastAt) / 1000)}s — sambung ulang`);
          try { ws.terminate(); } catch { /* */ }
        }
      }, 60_000);
      timers.push(silence);
    });

    ws.on("message", (data) => {
      st.msgs++;
      st.lastAt = Date.now();
      const text = data.toString();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return; }
      let rows: Row[] = [];
      if (Array.isArray(parsed)) rows = parsed as Row[];
      else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)) rows = (parsed as { data: Row[] }).data;
      if (!rows.length) return;
      st.rows += rows.length;
      onRows(stream.kind, rows);
    });

    const retry = (why: string) => {
      if (silence) clearInterval(silence);
      alive.delete(stream.kind);
      if (closed) return;
      st.reconnects++;
      ui.warn(`[dex-ws] ${stream.kind} ${why} — coba lagi ${Math.round(backoff / 1000)}s`);
      const t = setTimeout(() => connect(stream, attempt + 1), backoff);
      timers.push(t);
    };
    ws.on("error", (e) => retry(`error: ${String(e.message).slice(0, 60)}`));
    ws.on("close", () => retry("tertutup"));
  };

  for (const stream of STREAMS) connect(stream, 0);

  // Status berkala supaya "hidup" bisa dibuktikan dari log, bukan dari perasaan. Status pertama
  // dikirim 5 detik setelah start — tanpa itu, dashboard menampilkan "0/6 stream hidup" sampai
  // 10 menit pertama setelah setiap restart, dan angka yang salah sementara itu ikut dipercaya.
  const emitStatus = (): void => {
    const line = [...stats.entries()].map(([k, s]) => `${k}=${s.msgs}msg/${s.rows}row${s.reconnects ? `/r${s.reconnects}` : ""}`).join(" ");
    logRecord("events", { type: "dex-ws-status", alive: [...alive].length, streams: line, cfg: configHash });
    if (alive.size < STREAMS.length) ui.warn(`[dex-ws] ${alive.size}/${STREAMS.length} stream hidup`);
  };
  const first = setTimeout(emitStatus, 5_000);
  timers.push(first);
  const status = setInterval(emitStatus, 10 * 60_000);
  timers.push(status);

  ui.info(`[dex-ws] ${STREAMS.length} stream realtime dimulai (tanpa kunci — biaya: tidak dipublikasikan, uji: gratis).`);
  return () => {
    closed = true;
    for (const t of timers) clearInterval(t);
  };
}
