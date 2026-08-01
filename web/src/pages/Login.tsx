import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginRequest } from "@/lib/api";

type Phase = "idle" | "checking" | "denied" | "locked";

export default function Login() {
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>(() =>
    new URLSearchParams(window.location.search).get("e") === "1" ? "denied" : "idle",
  );
  const [retryAfterS, setRetryAfterS] = useState<number | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPhase("checking");
    try {
      const res = await loginRequest(password);
      if (res.status === 429) {
        setRetryAfterS(Number(res.headers.get("retry-after") ?? 0) || null);
        setPhase("locked");
        return;
      }
      if (res.url.endsWith("/app")) {
        window.location.href = "/app";
        return;
      }
      setPhase("denied");
      setPassword("");
    } catch {
      setPhase("denied");
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-up shadow-[0_0_8px_rgba(75,208,127,0.8)]" />
          <span className="font-mono text-xs font-semibold tracking-[0.2em] text-foreground">SHITCOIN</span>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <p className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground">ACCESS CHECKPOINT</p>
          <h1 className="mt-2 font-sans text-xl font-semibold text-foreground">Masuk ke konsol</h1>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password" className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground">
                ACCESS KEY
              </Label>
              <Input
                id="password"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (phase !== "idle" && phase !== "checking") setPhase("idle"); }}
                placeholder="••••••••"
                className="font-mono"
                disabled={phase === "checking" || phase === "locked"}
              />
            </div>

            {phase === "denied" && (
              <p className="font-mono text-[11px] tracking-wide text-down">
                AKSES DITOLAK — access key salah. Coba lagi.
              </p>
            )}
            {phase === "locked" && (
              <p className="font-mono text-[11px] tracking-wide text-down">
                TERLALU BANYAK PERCOBAAN — tunggu {retryAfterS ?? "beberapa"} detik lalu coba lagi.
              </p>
            )}

            <Button
              type="submit"
              className="w-full rounded-lg font-mono text-xs font-semibold tracking-widest"
              disabled={!password || phase === "checking" || phase === "locked"}
            >
              {phase === "checking" ? "MEMERIKSA…" : "MASUK"}
            </Button>
          </form>
        </div>

        <div className="mt-6 flex justify-center gap-4">
          <a href="/" className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground hover:text-foreground">
            ← KEMBALI
          </a>
        </div>
      </div>
    </div>
  );
}
