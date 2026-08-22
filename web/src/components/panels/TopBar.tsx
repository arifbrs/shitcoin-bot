import { useEffect, useState } from "react";
import type { StatsResponse } from "@/types/stats";

function Pill({ children, tone }: { children: React.ReactNode; tone: "on" | "off" | "sim" | "dim" | "live" }) {
  const toneClass = {
    on: "text-up border-up/35",
    off: "text-down border-down/35",
    sim: "text-gold border-gold/35",
    dim: "text-muted-foreground border-border",
    // LIVE must not look like any other state. It is the only one spending real money.
    live: "text-down border-down bg-down/15 font-semibold",
  }[tone];
  return (
    <span className={`rounded-full border px-2.5 py-1 font-mono text-[9px] tracking-[0.13em] whitespace-nowrap ${toneClass}`}>
      {children}
    </span>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Pill tone="on">{now.toLocaleTimeString("id-ID", { hour12: false })}</Pill>;
}

interface Props {
  data: StatsResponse | null;
  onOpenControl: () => void;
  onOpenDiagnostics: () => void;
}

export function TopBar({ data, onOpenControl, onOpenDiagnostics }: Props) {
  const isS2 = !!data?.strategy2Primary;
  const primaryUp = isS2 ? data?.system.strategy2Alive : data?.system.sniperAlive;
  const execMode = data?.control.execMode ?? "dry-run";
  const paused = data?.control.paused === true;
  const agentOn = data?.feeling.enabled !== false;

  return (
    <header className="flex items-center justify-between border-b border-border px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-up shadow-[0_0_7px_rgba(75,208,127,0.8)]" />
        <span className="font-mono text-xs font-semibold tracking-[0.2em] text-foreground">SHITCOIN</span>
        <span className="hidden font-mono text-[9px] tracking-[0.2em] text-muted-foreground sm:inline">SOLANA MOMENTUM ENGINE</span>
      </div>
      <div className="flex items-center gap-2">
        <Pill tone={primaryUp ? "on" : "off"}>{primaryUp ? "FEED LIVE" : "ARCHIVED"}</Pill>
        <Pill tone={agentOn ? "on" : "dim"}>{agentOn ? "AGENT ON" : "AGENT —"}</Pill>
        <Pill tone={paused ? "off" : execMode === "live" ? "live" : execMode === "dry-run" ? "dim" : "sim"}>
          {execMode === "live" ? "● LIVE" : execMode.toUpperCase()}{paused ? " · PAUSED" : ""}
        </Pill>
        <Clock />
        <button
          onClick={onOpenDiagnostics}
          className="rounded-full border border-border px-2.5 py-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
          title="Diagnostics"
        >
          ◎
        </button>
        <button
          onClick={onOpenControl}
          className="rounded-full border border-border px-2.5 py-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
          title="Control"
        >
          ⚙
        </button>
        <a href="/logout" className="rounded-full border border-border px-2.5 py-1 font-mono text-[9px] tracking-[0.13em] text-muted-foreground hover:text-foreground">
          LOGOUT
        </a>
      </div>
    </header>
  );
}
