import { useEffect, useRef, useState } from "react";
import type { PumpwatchModel } from "@/types/pumpwatch";

export type PumpwatchConnection = "connecting" | "live" | "stalled" | "error";

/**
 * (S12) Status pump-caller via /api/pumpwatch (cache mtime di server — bukan reread JSONL).
 * Poll adaptif: 15s saat tab aktif; 60s saat tersembunyi; tombol pause MENYERET polling
 * visual saja — kolektor server tidak pernah berhenti.
 */
export function usePumpwatch(paused = false) {
  const [data, setData] = useState<PumpwatchModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch("/api/pumpwatch", { cache: "no-store" });
        if (res.status === 401) { window.location.replace("/login"); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const snapshot = (await res.json()) as PumpwatchModel;
        if (!stopped) { setData(snapshot); setError(null); setReceivedAt(Date.now()); }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden && !pausedRef.current) void load(); }, 15_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [attempt]);

  const conn: PumpwatchConnection = error ? "error"
    : receivedAt == null ? "connecting"
      : Date.now() - receivedAt > 45_000 ? "stalled" : "live";
  return { data, error, receivedAt, connection: conn, retry: () => setAttempt((v) => v + 1) };
}
