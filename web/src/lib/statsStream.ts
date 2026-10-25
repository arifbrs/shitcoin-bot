import type { StatsResponse } from "@/types/stats";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "session-expired";

interface StreamObserver {
  onData: (data: StatsResponse) => void;
  onStatus: (status: ConnectionStatus) => void;
  onError: (error: string | null) => void;
}

function isSnapshot(value: unknown): value is StatsResponse {
  if (!value || typeof value !== "object") return false;
  return "now" in value && typeof value.now === "string" && Number.isFinite(Date.parse(value.now))
    && ["control", "system", "feeling", "paper", "strategy2"].every((key) =>
      key in value && typeof Reflect.get(value, key) === "object" && Reflect.get(value, key) !== null);
}

async function checkSession(signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/stats", { signal, cache: "no-store" });
  return response.status === 401;
}

export function connectStatsStream(observer: StreamObserver) {
  let source: EventSource | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let authCheck: AbortController | null = null;
  let retryMs = 3_000;

  async function verifySession() {
    if (authCheck) return;
    const controller = new AbortController();
    authCheck = controller;
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const expired = await checkSession(controller.signal);
      if (!stopped && !controller.signal.aborted && expired) {
        close();
        observer.onStatus("session-expired");
      }
    } catch {
      if (!stopped && !controller.signal.aborted) observer.onError("Koneksi server terputus. Mencoba menyambungkan kembali.");
    } finally {
      clearTimeout(timeout);
      if (authCheck === controller) authCheck = null;
    }
  }

  function connect() {
    if (stopped) return;
    const current = new EventSource("/api/stream");
    source = current;
    current.onmessage = (event) => {
      if (source !== current || stopped) return;
      try {
        const snapshot: unknown = JSON.parse(event.data);
        if (!isSnapshot(snapshot)) throw new Error("Format snapshot tidak valid.");
        observer.onData(snapshot);
        observer.onError(null);
        observer.onStatus("open");
        retryMs = 3_000;
        authCheck?.abort();
        authCheck = null;
      } catch {
        observer.onError("Update tidak valid. Menampilkan snapshot valid terakhir.");
      }
    };
    current.onerror = () => {
      if (source !== current || stopped) return;
      observer.onStatus("reconnecting");
      void verifySession();
      if (current.readyState === EventSource.CLOSED) {
        current.close();
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    };
  }

  function close() {
    stopped = true;
    source?.close();
    clearTimeout(retryTimer);
    authCheck?.abort();
  }

  function reconnect() {
    if (stopped) return;
    source?.close();
    clearTimeout(retryTimer);
    authCheck?.abort();
    authCheck = null;
    observer.onError(null);
    observer.onStatus("connecting");
    connect();
  }

  connect();
  return { close, reconnect };
}
