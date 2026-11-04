import { useLayoutEffect, useState, type RefObject } from 'react';

/** an element's width (ResizeObserver); null before the first measurement; follows the ref to a new element */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [w, setW] = useState<number | null>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { if (ref.current !== el) setEl(ref.current); });
  useLayoutEffect(() => {
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((es) => setW(Math.round(es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}
