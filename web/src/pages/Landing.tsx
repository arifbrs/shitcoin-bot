import { Button } from "@/components/ui/button";
import { GateStrip } from "@/components/GateStrip";

const STAGES = [
  {
    label: "SCAN",
    color: "text-foreground",
    body: "Setiap token baru di pump.fun dibaca saat lahir — bonding curve, likuiditas, holder, dev wallet.",
  },
  {
    label: "GATE",
    color: "text-gold",
    body: "Rug-cluster, insider network, serial-deployer, dan liquidity floor disaring dulu — hard-fail langsung tereliminasi.",
  },
  {
    label: "CONFIRM",
    color: "text-scout",
    body: "Demand harus nyata: net buyer positif, buy volume di atas sell volume — bukan cuma atribut token yang \"kelihatan aman\".",
  },
  {
    label: "ENTER",
    color: "text-up",
    body: "Cost-aware: friction riil dari quote asli dihitung dulu sebelum entry — bukan estimasi, bukan model.",
  },
] as const;

export default function Landing() {
  return (
    <div className="min-h-svh bg-background">
      {/* Nav */}
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-up shadow-[0_0_8px_rgba(75,208,127,0.8)]" />
          <span className="font-mono text-xs font-semibold tracking-[0.2em] text-foreground">SHITCOIN</span>
          <span className="font-mono text-[9px] tracking-[0.2em] text-muted-foreground">SOLANA MOMENTUM ENGINE</span>
        </div>
        <Button asChild size="sm" variant="outline" className="rounded-full border-border font-mono text-[10px] tracking-widest">
          <a href="/login">MASUK KONSOL</a>
        </Button>
      </header>

      {/* Hero */}
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-8">
        <p className="font-mono text-[10px] tracking-[0.3em] text-muted-foreground">
          READ-ONLY GATE · NOL MODAL SAMPAI TERBUKTI
        </p>
        <h1 className="mt-4 max-w-3xl font-sans text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl">
          Kebanyakan token pump.fun{" "}
          <span className="text-down">tidak pernah bergerak</span> setelah diluncurkan.
        </h1>
        <p className="mt-6 max-w-xl text-balance font-mono text-sm leading-relaxed text-muted-foreground">
          Instrumen ini menyaring yang mana yang punya bukti demand nyata — sebelum modal ikut campur.
          Setiap sinyal diukur, dicatat, dan divalidasi ulang; tidak ada yang dipercaya begitu saja.
        </p>
        <div className="mt-8 flex items-center gap-4">
          <Button asChild size="lg" className="rounded-full font-mono text-xs font-semibold tracking-widest">
            <a href="/login">ENTER CONSOLE →</a>
          </Button>
          <a href="#gate" className="font-mono text-xs tracking-widest text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            LIHAT CARA KERJA GATE
          </a>
        </div>

        {/* Signature element */}
        <div id="gate" className="mt-16">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[9px] tracking-[0.25em] text-muted-foreground">LIVE ILLUSTRATION · BUKAN DATA REAL</span>
            <span className="font-mono text-[9px] tracking-[0.25em] text-muted-foreground">~78% REJECTED AT GATE</span>
          </div>
          <GateStrip />
        </div>

        {/* Pipeline explainer — real vocabulary, real checks, no invented stats */}
        <div className="mt-20 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {STAGES.map((s) => (
            <div key={s.label} className="bg-card p-5">
              <span className={`font-mono text-[10px] font-bold tracking-[0.2em] ${s.color}`}>{s.label}</span>
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>

        {/* Why the gate exists */}
        <div className="mt-20 max-w-2xl">
          <span className="font-mono text-[9px] tracking-[0.25em] text-muted-foreground">KENAPA GATE INI ADA</span>
          <p className="mt-4 font-mono text-sm leading-relaxed text-muted-foreground">
            Gross P&amp;L rata-rata mendekati nol — seluruh kerugian selama ini datang dari biaya exit saat token
            collapse, bukan dari salah pilih kandidat. Menyaring kandidat lebih ketat tidak memperbaiki itu sendirian.
            Yang diperbaiki di sini: basis harga exit yang konsisten, konfirmasi demand sebelum entry, dan
            eksposur yang selalu terukur — bukan janji, catatan yang bisa diaudit.
          </p>
        </div>
      </main>

      <footer className="mx-auto max-w-5xl px-6 py-10">
        <p className="font-mono text-[9px] tracking-[0.2em] text-muted-foreground">
          READ-ONLY OLEH DEFAULT · TIDAK ADA MODAL BERGERAK TANPA KONFIRMASI EKSPLISIT
        </p>
      </footer>
    </div>
  );
}
