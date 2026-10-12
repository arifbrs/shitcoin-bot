import { useEffect, useRef, useState } from "react";
import type { StatsResponse } from "@/types/stats";
import { connectStatsStream } from "@/lib/statsStream";
import type { ConnectionStatus } from "@/lib/statsStream";

export type { ConnectionStatus } from "@/lib/statsStream";

export function useLiveStats() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [lastReceivedAt, setLastReceivedAt] = useState<number | null>(null);
  const connection = useRef<ReturnType<typeof connectStatsStream> | null>(null);

  useEffect(() => {
    const stream = connectStatsStream({
      onData: (snapshot) => {
        setData(snapshot);
        setLastReceivedAt(Date.now());
      },
      onStatus: setStatus,
      onError: setError,
    });
    connection.current = stream;
    return () => { stream.close(); connection.current = null; };
  }, []);

  return { data, status, error, lastReceivedAt, reconnect: () => connection.current?.reconnect() };
}
