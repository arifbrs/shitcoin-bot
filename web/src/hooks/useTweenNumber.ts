import { useEffect, useRef, useState } from "react";

/** Eases the displayed number toward `target` over ~600ms — mirrors the old dashboard's tweenNum() count-up effect. */
export function useTweenNumber(target: number): number {
  const [value, setValue] = useState(target);
  const raf = useRef<number | null>(null);
  const from = useRef(target);
  const start = useRef(0);

  useEffect(() => {
    from.current = value;
    start.current = performance.now();
    const DURATION = 600;
    function step(now: number) {
      const t = Math.min(1, (now - start.current) / DURATION);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quad
      setValue(Math.round(from.current + (target - from.current) * eased));
      if (t < 1) raf.current = requestAnimationFrame(step);
    }
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target]);

  return value;
}
