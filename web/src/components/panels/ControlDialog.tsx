import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchWallet, postControl, withdrawWallet } from "@/lib/api";
import { ModeSwitch } from "@/components/panels/ModeSwitch";
import type { StatsResponse, WalletInfo } from "@/types/stats";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: StatsResponse | null;
}

type WithdrawStep = "form" | "confirm" | "sending" | "done";

export function ControlDialog({ open, onOpenChange, data }: Props) {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<WithdrawStep>("form");
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Flatten Strategy 2 — same 2-click arm-to-confirm pattern as the old dashboard: first click
  // arms for 3s, second click within that window actually fires. A single accidental click can
  // never flatten every open position.
  const [flattenArmed, setFlattenArmed] = useState(false);
  const flattenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flattenMsg, setFlattenMsg] = useState<string | null>(null);

  // Deposit acknowledge — the owner topped up the bot wallet, which BY DESIGN trips
  // reconcile-or-HALT ("unexplained balance move"). First click arms for 3s; second confirms.
  const [ackArmed, setAckArmed] = useState(false);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ackMsg, setAckMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      fetchWallet().then(setWallet).catch(() => setWallet(null));
      setStep("form");
      setResult(null);
      setFlattenMsg(null);
      setAckMsg(null);
      setAckArmed(false);
    }
  }, [open]);

  function clickAck() {
    if (!ackArmed) {
      setAckArmed(true);
      ackTimer.current = setTimeout(() => setAckArmed(false), 3000);
      return;
    }
    if (ackTimer.current) clearTimeout(ackTimer.current);
    setAckArmed(false);
    setAckMsg("mengakui setoran…");
    postControl({ walletAck: true })
      .then((st) => {
        const ack = (st as { walletAck?: { ok: boolean; sol: number | null } }).walletAck;
        setAckMsg(ack?.ok ? `✓ setoran diakui — snapshot ${ack.sol?.toFixed(4)} SOL, kill switch dilepas` : "✗ gagal baca saldo on-chain — kill switch DIPERTAHANKAN");
      })
      .catch((e) => setAckMsg(`gagal: ${e.message}`));
  }

  function requestSend(e: React.FormEvent) {
    e.preventDefault();
    setStep("confirm");
  }

  async function confirmSend() {
    setStep("sending");
    const amt = amount === "all" ? "all" : Number(amount);
    const res = await withdrawWallet(dest, amt);
    if (res.ok) {
      setResult({ ok: true, msg: `Terkirim ${res.sentSol} SOL · ${res.signature?.slice(0, 12)}…` });
      fetchWallet().then(setWallet).catch(() => {});
    } else {
      setResult({ ok: false, msg: res.error ?? "gagal, tidak diketahui sebabnya" });
    }
    setStep("done");
  }

  function clickFlatten() {
    if (!flattenArmed) {
      setFlattenArmed(true);
      flattenTimer.current = setTimeout(() => setFlattenArmed(false), 3000);
      return;
    }
    if (flattenTimer.current) clearTimeout(flattenTimer.current);
    setFlattenArmed(false);
    setFlattenMsg("mengirim perintah flatten…");
    postControl({ strategy2Command: "flatten" })
      .then(() => setFlattenMsg("✓ perintah flatten terkirim — akan menutup semua posisi terbuka"))
      .catch((e) => setFlattenMsg(`gagal: ${e.message}`));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md font-mono">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-widest">◈ CONTROL</DialogTitle>
        </DialogHeader>

        <ModeSwitch data={data} walletFallback={wallet?.address} />

        <div className="space-y-1 border-t border-border pt-4 text-[11px]">
          <div className="flex justify-between text-muted-foreground">
            <span>address</span>
            <span className="text-foreground">{wallet?.address.slice(0, 10) ?? "—"}…</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>mainnet</span>
            <span className="text-foreground">{wallet ? `${wallet.mainnet.toFixed(4)} SOL` : "—"}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>devnet</span>
            <span className="text-foreground">{wallet ? `${wallet.devnet.toFixed(4)} SOL` : "—"}</span>
          </div>
        </div>

        {data?.liveBridge?.halted && (
          <div className="space-y-2 border-t border-down/40 pt-4">
            <p className="text-[10px] leading-relaxed text-down">
              ⛔ HALTED — {data.liveBridge.haltReason ?? "kill switch"}. Kalau penyebabnya SETORAN
              yang baru masuk, akui setoran di bawah: snapshot saldo diperbarui ke nilai on-chain
              lalu kill switch dilepas. Kalau bukan setoranmu — jangan tekan, itu alarm.
            </p>
            <Button type="button" variant="outline"
              onClick={clickAck}
              className={`w-full font-mono text-[10px] tracking-widest ${ackArmed ? "border-gold text-gold" : ""}`}>
              {ackArmed ? "YAKIN? KLIK LAGI UNTUK AKUI SETORAN" : "AKUI SETORAN"}
            </Button>
            {ackMsg && <p className="font-mono text-[10px] text-muted-foreground">{ackMsg}</p>}
          </div>
        )}

        <div className="border-t border-border pt-4">
          <p className="mb-2 text-[10px] tracking-widest text-muted-foreground">WITHDRAW SOL</p>

          {step === "form" && (
            <form onSubmit={requestSend} className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="dest" className="text-[9px] tracking-widest text-muted-foreground">DESTINATION</Label>
                <Input id="dest" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="alamat wallet tujuan" className="font-mono text-xs" required minLength={32} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="amt" className="text-[9px] tracking-widest text-muted-foreground">AMOUNT</Label>
                <Input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.5 atau 'all'" className="font-mono text-xs" required />
              </div>
              <Button type="submit" className="w-full font-mono text-[10px] tracking-widest" disabled={!dest || !amount}>
                LANJUT
              </Button>
            </form>
          )}

          {step === "confirm" && (
            <div className="space-y-3 rounded-lg border border-gold/40 bg-gold/5 p-3">
              <p className="text-[11px] text-foreground">
                Kirim <b className="text-gold">{amount}</b> SOL nyata ke<br />
                <span className="break-all text-foreground">{dest}</span>?
              </p>
              <p className="text-[10px] text-muted-foreground">Ini transfer on-chain sungguhan, tidak bisa dibatalkan setelah terkirim.</p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1 font-mono text-[10px] tracking-widest" onClick={() => setStep("form")}>
                  BATAL
                </Button>
                <Button className="flex-1 font-mono text-[10px] tracking-widest" onClick={confirmSend}>
                  KONFIRMASI &amp; KIRIM
                </Button>
              </div>
            </div>
          )}

          {step === "sending" && <p className="text-[11px] text-muted-foreground">mengirim…</p>}

          {step === "done" && result && (
            <div className="space-y-2">
              <p className={`text-[11px] ${result.ok ? "text-up" : "text-down"}`}>{result.ok ? "✓ " : "✗ "}{result.msg}</p>
              <Button variant="outline" className="w-full font-mono text-[10px] tracking-widest" onClick={() => { setStep("form"); setDest(""); setAmount(""); }}>
                TUTUP
              </Button>
            </div>
          )}
        </div>

        <div className="border-t border-border pt-4">
          <Button
            variant="destructive"
            // whitespace-normal overrides Button's own whitespace-nowrap default: this label is a
            // full sentence, not a short action word, and nowrap was forcing the whole dialog's
            // CSS Grid column to size to this button's full unwrapped text width (found live,
            // 2026-07-30 — every row in the dialog was getting clipped ~10-26px on the right
            // because of it, e.g. "0.2497 SOL" rendering as "0.2497 SO").
            className="h-auto w-full whitespace-normal font-mono text-[10px] tracking-widest"
            onClick={clickFlatten}
          >
            {flattenArmed ? "⚠ KLIK LAGI UNTUK KONFIRMASI FLATTEN" : "🔴 FLATTEN STRATEGY 2 — tutup semua posisi sekarang"}
          </Button>
          {flattenMsg && <p className="mt-2 text-[10px] text-muted-foreground">{flattenMsg}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
