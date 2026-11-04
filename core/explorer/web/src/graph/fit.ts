/**
 * Fitting a React Flow pane to what is drawn. The fit is computed from our own layout (the boxes
 * as drawn, nodes moved by hand included, and edge bends when asked) and the pane's current size, not from React
 * Flow's internal node measurements (stale after a drop re-creates node objects) or its fitView button (in the compare
 * it fitted one pane to its own nodes and left the other behind). A pane refits by itself after it resized while the
 * user has not panned or zoomed it since the last fit.
 */
import { useEffect, useRef } from 'react';
import { useReactFlow, type Viewport } from '@xyflow/react';
import type { Box, LayoutResult } from '@layout/index';

/** the boxes of a layout, and optionally the edges' points (a route may run outside the nodes' box) */
export function contentBounds(r: LayoutResult, edges = false): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of Object.values(r.nodes)) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
  if (edges) for (const e of Object.values(r.edges)) for (const p of e.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** the viewport that centres `b` in a w × h pane with `padding` (share of the pane) on each side */
export function fitViewport(b: Box, w: number, h: number, o: { padding: number; minZoom: number; maxZoom: number }): Viewport {
  const zw = (w * (1 - 2 * o.padding)) / Math.max(1, b.width), zh = (h * (1 - 2 * o.padding)) / Math.max(1, b.height);
  const zoom = Math.max(o.minZoom, Math.min(o.maxZoom, zw, zh));
  return { x: w / 2 - (b.x + b.width / 2) * zoom, y: h / 2 - (b.y + b.height / 2) * zoom, zoom };
}

/**
 * `fit(duration)` frames `boundsOf()` in the pane `box`; `userMoved()` (call it from onMove with an event) stops the
 * automatic refit until the next fit. `onFitted` gets the new viewport (the compare publishes it to the other pane).
 */
export function useFit(box: React.RefObject<HTMLDivElement | null>, boundsOf: () => Box | null, o: { padding?: number; minZoom?: number; maxZoom?: number; onFitted?: (v: Viewport) => void } = {}) {
  const rf = useReactFlow();
  const st = useRef({ boundsOf, o, moved: false });
  st.current.boundsOf = boundsOf;
  st.current.o = o;
  const fit = (duration = 0) => {
    const el = box.current, b = st.current.boundsOf();
    if (!el || !b || !el.clientWidth || !el.clientHeight) return;
    const v = fitViewport(b, el.clientWidth, el.clientHeight, { padding: o.padding ?? 0.06, minZoom: o.minZoom ?? 0.1, maxZoom: o.maxZoom ?? 1.25 });
    st.current.moved = false;
    void rf.setViewport(v, { duration });
    st.current.o.onFitted?.(v);
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // the pane resized (a divider, a panel collapsed or expanded, the window, a rail shown again): refit unless the
  // user has panned or zoomed since the last fit; resizes come in bursts, so wait until it is still
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let t = 0, w = el.clientWidth, h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w && el.clientHeight === h) return;
      const wasHidden = !w || !h;
      w = el.clientWidth; h = el.clientHeight;
      if (!w || !h) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => { if (wasHidden || !st.current.moved) fitRef.current(0); }, wasHidden ? 0 : 120);
    });
    ro.observe(el);
    return () => { window.clearTimeout(t); ro.disconnect(); };
  }, [box]);
  return { fit: (d?: number) => fitRef.current(d), userMoved: (moved = true) => { st.current.moved = moved; } };
}
