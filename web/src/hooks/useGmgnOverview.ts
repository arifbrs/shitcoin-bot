import { useEffect, useState } from "react";
import { fetchGmgnOverview } from "@/lib/api";
import type { GmgnOverviewResponse } from "@/types/stats";

/** The existing local overview endpoint/cadence, shared by the lane and signal table. */
export function useGmgnOverview(enabled = true) {
  const [data, setData] = useState<GmgnOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const snapshot = await fetchGmgnOverview(controller.signal);
        if (controller.signal.aborted) return;
        if (!snapshot || !Array.isArray(snapshot.recentSignals) || !Array.isArray(snapshot.signals24h)) throw new Error("Format overview GMGN tidak valid.");
        setData(snapshot);
        setError(null);
        setReceivedAt(Date.now());
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof Error && cause.message === "session-expired") { window.location.replace("/login"); return; }
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [enabled, attempt]);
  return { data, error, loading: enabled && loading, receivedAt, retry: () => setAttempt((value) => value + 1) };
}
