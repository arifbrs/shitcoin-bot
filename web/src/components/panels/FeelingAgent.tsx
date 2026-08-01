import { useEffect, useRef, useState } from "react";
import type { StatsResponse } from "@/types/stats";

/**
 * Speech bubble — faithful port of the old `window.__agentSay` (public/_archive-pre-react/
 * app.html lines ~1172-1186), owner-corrected 2026-07-30 after a first attempt shipped as plain
 * floating text ("bubble kayak chat, posisi atas/bawah random, ada typing juga"). Kept imperative
 * (direct DOM writes via a ref, not React state) exactly like the canvas panels — a typewriter
 * effect with a live blinking cursor mid-render fights React's diffing far more than it helps.
 * Behavior ported exactly: dedup identical messages, 9s minimum gap between pop-ins, random
 * above/below placement each time (tail flips to keep pointing at the face), a "···" thinking
 * pop-in, then a 22ms/char typewriter reveal, auto-hiding after 8.5s.
 */
function useAgentSay(message: string | undefined) {
  const elRef = useRef<HTMLDivElement>(null);
  const lastMsgRef = useRef<string | undefined>(undefined);
  const lastSayAtRef = useRef(0);
  const timersRef = useRef<{ t1?: ReturnType<typeof setTimeout>; t2?: ReturnType<typeof setTimeout>; tw?: ReturnType<typeof setInterval> }>({});

  useEffect(() => {
    const el = elRef.current;
    if (!el || !message) return;
    if (message === lastMsgRef.current) return; // same (possibly stale, re-polled) thought — don't re-type it
    const now = Date.now();
    if (now - lastSayAtRef.current < 9000) return; // rate limit — verdicts poll every few seconds
    lastSayAtRef.current = now;
    lastMsgRef.current = message;

    clearTimeout(timersRef.current.t1);
    clearTimeout(timersRef.current.t2);
    clearInterval(timersRef.current.tw);

    const below = Math.random() < 0.5;
    el.className = "agent-say" + (below ? " below" : "");
    el.style.top = below ? `${66 + Math.random() * 6}%` : `${15 + Math.random() * 5}%`;
    el.style.bottom = "auto";
    el.textContent = "···";
    void el.offsetWidth; // force reflow so the .on transition actually plays from the reset state
    el.classList.add("on");

    const full = "◈ " + message;
    timersRef.current.t1 = setTimeout(() => {
      let i = 0;
      el.textContent = "";
      timersRef.current.tw = setInterval(() => {
        i++;
        el.innerHTML = full.slice(0, i) + (i < full.length ? '<span class="cur">▍</span>' : "");
        if (i >= full.length) clearInterval(timersRef.current.tw);
      }, 22);
    }, 520);
    timersRef.current.t2 = setTimeout(() => el.classList.remove("on"), 8500);
  }, [message]);

  useEffect(() => () => {
    clearTimeout(timersRef.current.t1);
    clearTimeout(timersRef.current.t2);
    clearInterval(timersRef.current.tw);
  }, []);

  return elRef;
}

/**
 * Ported 1:1 from the old dashboard's canvas-free SVG face — eyes track the cursor (RAF-lerped
 * toward the pointer vector), a randomized blink loop, and a typed-out speech bubble for the
 * latest agent/feeling verdict. `data.agent.last` (merged mechanical+LLM feed) is preferred;
 * falls back to `data.feeling.last` (raw LLM vibe) if the merged feed hasn't produced anything yet.
 */
export function FeelingAgent({ data }: { data: StatsResponse }) {
  const faceRef = useRef<HTMLDivElement>(null);
  const [pupil, setPupil] = useState({ x: 0, y: 0 });
  const [openness, setOpenness] = useState(1); // 1 = fully open, 0 = closed (blink)
  const target = useRef({ x: 0, y: 0 });

  // Eye-tracking: cursor position -> normalized offset -> RAF-smoothed pupil position.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const el = faceRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(1, dist / 300);
      target.current = { x: (dx / dist) * clamped * 3, y: (dy / dist) * clamped * 2 };
    }
    window.addEventListener("mousemove", onMove);
    let raf: number;
    function tick() {
      setPupil((p) => ({ x: p.x + (target.current.x - p.x) * 0.15, y: p.y + (target.current.y - p.y) * 0.15 }));
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => { window.removeEventListener("mousemove", onMove); cancelAnimationFrame(raf); };
  }, []);

  // Blink loop: mostly-open, occasional quick close, rare double-blink.
  useEffect(() => {
    let cancelled = false;
    function scheduleBlink() {
      const delay = 2500 + Math.random() * 4000;
      setTimeout(() => {
        if (cancelled) return;
        setOpenness(0);
        setTimeout(() => { if (!cancelled) setOpenness(1); }, 110);
        if (Math.random() < 0.15) {
          setTimeout(() => { if (!cancelled) setOpenness(0); }, 260);
          setTimeout(() => { if (!cancelled) setOpenness(1); }, 370);
        }
        scheduleBlink();
      }, delay);
    }
    scheduleBlink();
    return () => { cancelled = true; };
  }, []);

  const beat = data.agent.last ?? (data.feeling.last ? { mood: data.feeling.last.vibe ?? "neutral", say: `${data.feeling.last.symbol ? data.feeling.last.symbol + ": " : ""}${data.feeling.last.reason ?? data.feeling.last.vibe ?? ""}` } : null);
  const health = data.feeling.health;
  /**
   * How old the agent's opinion is.
   *
   * The face used to render the last verdict as if it were the current mood, with no indication
   * of when it was formed — so during a relay outage it sat frozen on an hours-old expression and
   * read as "the agent has no expression / it disappeared". That is the same failure as trusting a
   * stale market cap: an old answer presented as a live one. The verdict is still shown (it is
   * real, and the last thing the agent actually thought), but once it goes stale it is visibly
   * dimmed and labelled with its age rather than passed off as now.
   */
  const STALE_AFTER_MS = 5 * 60_000;
  const ageMs = health.lastSuccessAt ? Date.now() - health.lastSuccessAt : null;
  const stale = ageMs != null && ageMs > STALE_AFTER_MS;
  const ageLabel = ageMs == null ? null
    : ageMs < 60_000 ? `${Math.round(ageMs / 1000)}d lalu`
    : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m lalu`
    : `${Math.round(ageMs / 3_600_000)}j lalu`;
  const healthLabel = !health.enabled ? "OFF" : !health.up ? "▲ DOWN" : stale ? "◐ IDLE" : "● LIVE";
  const healthClass = !health.enabled ? "text-muted-foreground" : !health.up ? "text-down" : stale ? "text-gold" : "text-up";

  const mood = beat?.mood ?? "alive";
  // Mood palette ported 1:1 from the old #agent.mood-{alive,dying,dead} CSS variables.
  const MOOD_COLORS: Record<string, [string, string, string, string]> = {
    alive: ["rgba(96,224,180,.9)", "rgba(120,200,255,.9)", "rgba(90,180,150,.85)", "rgba(150,230,200,.55)"],
    dying: ["rgba(232,197,106,.9)", "rgba(180,140,255,.85)", "rgba(200,150,120,.8)", "rgba(220,190,150,.5)"],
    dead: ["rgba(255,120,120,.85)", "rgba(150,110,140,.8)", "rgba(120,110,130,.75)", "rgba(200,150,160,.45)"],
  };
  const [a1, a2, a3, a4] = MOOD_COLORS[mood] ?? MOOD_COLORS.alive!;
  const sayRef = useAgentSay(beat?.say);

  return (
    <div className="relative flex h-full flex-col items-center justify-center">
      <span className={`absolute right-0 top-0 flex items-baseline gap-1.5 font-mono text-[9px] ${healthClass}`}>
        {healthLabel}
        {ageLabel && <span className="text-muted-foreground/60">{ageLabel}</span>}
      </span>
      {/* Size ported 1:1 from the old #agent{ width:min(260px,68%) } (owner, 2026-07-30: a prior
          min(45cqw,45cqh) attempt was still "too small" per direct feedback — this is the
          original's own value, not a re-guess). overflow:visible so the oversized blurred aura
          clouds (inset:-70px/-48px) aren't clipped into a hard circle. */}
      <div
        ref={faceRef}
        className="relative aspect-square overflow-visible transition-opacity duration-700"
        style={{
          width: "min(260px, 68%)",
          // Dimmed while the verdict is stale — the aura keeps its mood colour so the last real
          // opinion is still readable, it just stops claiming to be current.
          opacity: stale ? 0.45 : 1,
          ["--a1" as string]: a1, ["--a2" as string]: a2, ["--a3" as string]: a3, ["--a4" as string]: a4,
        }}
      >
        <div className="agent-aura" />
        <div className="agent-aura2" />
        <svg viewBox="0 0 150 150" className="agent-face-svg absolute inset-0 h-full w-full overflow-visible">
          <path d="M55 66 Q61 61 68 65" fill="none" stroke="#f2f7ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 4px rgba(200,225,255,.7))" }} />
          <path d="M82 65 Q89 61 95 66" fill="none" stroke="#f2f7ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 4px rgba(200,225,255,.7))" }} />
          <ellipse cx={61 + pupil.x} cy={79 + pupil.y} rx="3.2" ry={3.2 * openness} fill="#f2f7ff" style={{ filter: "drop-shadow(0 0 3px rgba(200,225,255,.8))" }} />
          <ellipse cx={89 + pupil.x} cy={79 + pupil.y} rx="3.2" ry={3.2 * openness} fill="#f2f7ff" style={{ filter: "drop-shadow(0 0 3px rgba(200,225,255,.8))" }} />
          <path d="M75 80 L75 89 L82 89" fill="none" stroke="#f2f7ff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 4px rgba(200,225,255,.7))" }} />
        </svg>
      </div>
      <div ref={sayRef} className="agent-say" />
    </div>
  );
}
