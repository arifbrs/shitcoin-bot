import type { StatsResponse } from "@/types/stats";

/**
 * Says out loud when the numbers on screen have stopped moving.
 *
 * Built after a real 20-hour blackout: the machine was shut down, every process stopped, and the
 * dashboard went on rendering the last equity and the last open position exactly as if they were
 * live. The card showed +0.1% while that position, unattended, drifted to -43% — the trailing stop
 * would have exited hours earlier had anything been running. Nothing on the page hinted that it
 * was looking at a photograph.
 *
 * The whole point is to be unmissable and specific: how long the trader has been silent, and what
 * that means for the numbers below. It sits above the grid rather than inside a tile, because a
 * frozen feed invalidates every tile at once, not one of them.
 *
 * Thresholds are read off the trader's own cadence (a 30s poll): a couple of missed polls is
 * ordinary jitter or a deploy restart and stays quiet; beyond that it is a real absence.
 */

const WARN_AFTER_SEC = 120; // ~4 missed polls — past jitter, worth flagging quietly
const DEAD_AFTER_SEC = 600; // 10 minutes of silence — treat the whole page as historical

function humanAge(sec: number): string {
  if (sec < 90) return `${sec} detik`;
  if (sec < 5400) return `${Math.round(sec / 60)} menit`;
  return `${(sec / 3600).toFixed(1)} jam`;
}

export function StaleBanner({ data }: { data: StatsResponse }) {
  const age = data.strategy2Primary?.paper.heartbeatAgeSec ?? null;
  if (age == null || age < WARN_AFTER_SEC) return null;

  const dead = age >= DEAD_AFTER_SEC;
  const openN = data.strategy2Primary?.paper.open ?? 0;

  return (
    <div
      role="status"
      className={`mx-auto mb-3 flex max-w-[1700px] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3.5 py-2 font-mono text-[11px] ${
        dead ? "border-down/50 bg-down/10 text-down" : "border-gold/40 bg-gold/5 text-gold"
      }`}
    >
      <span className="font-semibold tracking-wide">
        {dead ? "■ TRADER BERHENTI" : "▲ FEED TERTINGGAL"}
      </span>
      <span className="text-foreground/80">
        Tidak ada update {humanAge(age)}
      </span>
      <span className="text-muted-foreground">
        {dead
          ? "Semua angka di bawah ini adalah rekaman terakhir, bukan kondisi sekarang."
          : "Angka di bawah mungkin belum yang terbaru."}
      </span>
      {dead && openN > 0 && (
        <span className="text-down">
          {openN} posisi terbuka tidak sedang dijaga — trailing stop tidak berjalan.
        </span>
      )}
    </div>
  );
}
