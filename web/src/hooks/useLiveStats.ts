import { useEffect, useRef, useState } from "react";
import type { StatsResponse } from "@/types/stats";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "session-expired";

/**
 * Live dashboard data via Server-Sent Events (owner choice, 2026-07-29: push instead of the old
 * 3s poll). /api/stream (src/server.ts) writes an initial full snapshot on connect, then a fresh
 * one on every log-dir change (debounced, min 700ms gap) plus a `: ping` comment every 20s to
 * keep the connection alive through proxies. Every `data:` frame is the exact same JSON shape as
 * GET /api/stats, so this hook's return value is a drop-in replacement for a poll-based one.
 *
 * Reconnection: the browser's native EventSource retries automatically on a dropped connection —
 * no manual backoff logic needed. `status` exposes the raw readyState so the UI can show
 * "reconnecting" (mirrors the old dashboard's FEED LIVE/ARCHIVED pill) without guessing.
 */
export function useLiveStats() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    esRef.current = es;
    es.onopen = () => setStatus("open");
    es.onmessage = (e) => {
      try {
        setData(JSON.parse(e.data) as StatsResponse);
        setStatus("open");
      } catch {
        // A malformed frame is a server-side bug, not something to crash the UI over — keep
        // showing the last good snapshot rather than blanking the dashboard.
      }
    };
    es.onerror = () => {
      // EventSource sets readyState back to CONNECTING while it auto-retries on a dropped
      // connection — surface that as "reconnecting". CLOSED means it gave up for good, which
      // happens when a reconnect attempt gets a non-2xx response (e.g. the session cookie expired
      // and /api/stream now 401s) — that's the one case the caller should react to by sending the
      // user back to /login, since no amount of waiting will fix an expired session.
      setStatus(es.readyState === EventSource.CLOSED ? "session-expired" : "reconnecting");
    };
    return () => es.close();
  }, []);

  return { data, status };
}
