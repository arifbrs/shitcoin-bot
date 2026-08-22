/**
 * Coin art with a letter tile as the fallback, shared by every feed so the paper and live
 * journals cannot drift apart again.
 *
 * `img` resolves ASYNCHRONOUSLY on the server (its own fetch queue), so it is absent on the
 * first tick after a trade and may never arrive for a token whose metadata is unreachable. The
 * tile reserves the same box either way — a row that collapses when the picture is missing
 * makes the whole list jump as art trickles in.
 */
export function CoinIcon({ img, symbol, size = 18 }: { img?: string | null; symbol?: string | null; size?: number }) {
  const box = { height: size, width: size };
  if (img) {
    return (
      <img
        src={img} alt="" loading="lazy" style={box}
        className="shrink-0 rounded-[5px] object-cover"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
      />
    );
  }
  return (
    <span style={box} className="flex shrink-0 items-center justify-center rounded-[5px] bg-muted font-mono text-[9px] text-muted-foreground">
      {(symbol || "?").slice(0, 1)}
    </span>
  );
}
