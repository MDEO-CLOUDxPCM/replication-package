import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import type { EChartHandle } from '@/charts/EChart';
import type { AxisDef } from '@/charts/explorerCharts';
import type { Area } from '@/lib/areas';
import { fmt } from '@/lib/format';

/** a grid of the chart (scatter: one; matrix: one per cell) and its two axes */
export interface AreaGrid { gi: number; x: AxisDef; y: AxisDef }

interface Props {
  chartRef: RefObject<EChartHandle | null>;
  /** the grids an area can be drawn in (none: no marking, e.g. parallel coordinates) */
  grids: AreaGrid[];
  areas: Area[];
  /** a new area; additive (shift): add it to the others, else replace them */
  onAdd: (a: Area, additive: boolean) => void;
  onRemove: (index: number) => void;
  children: ReactNode;
}

/** below this much movement a press is a click (selects A / B), above it a drag marks an area */
const DRAG_PX = 5;

export const areaLabel = (a: Area, axes: AxisDef[]) => {
  const ax = axes.find((q) => q.key === a.x), ay = axes.find((q) => q.key === a.y);
  const r = (lo: number, hi: number) => `${fmt(lo, Math.abs(hi - lo) < 10 ? 2 : 0)}–${fmt(hi, Math.abs(hi - lo) < 10 ? 2 : 0)}`;
  return `${ax?.label ?? a.x} ${r(a.x0, a.x1)} × ${ay?.label ?? a.y} ${r(a.y0, a.y1)}`;
};

/**
 * Mark areas by dragging in the chart: a press that moves more than a few pixels draws a rectangle
 * in the grid it started in (shift: another one); a press without movement stays a click. The
 * areas are drawn from their data ranges, so they follow resizes and re-renders.
 */
export function ChartAreas({ chartRef, grids, areas, onAdd, onRemove, children }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [, setTick] = useState(0);
  const suppressClick = useRef(false);

  // redraw the rectangles whenever the chart lays out again (resize, legend wrap, new option)
  useEffect(() => {
    const inst = chartRef.current?.instance();
    if (!inst) return;
    const h = () => setTick((t) => t + 1);
    inst.on('finished', h);
    return () => { inst.off('finished', h); };
  });

  const dom = () => chartRef.current?.instance()?.getDom() as HTMLElement | undefined;

  const onPointerDown = (e: React.PointerEvent) => {
    const inst = chartRef.current?.instance();
    const el = dom();
    if (!inst || !el || e.button !== 0 || !grids.length || (e.target as HTMLElement).closest('button')) return;
    const r = el.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const grid = grids.find((g) => inst.containPixel({ gridIndex: g.gi }, [px, py]));
    if (!grid) return;
    const sx = e.clientX, sy = e.clientY, additive = e.shiftKey;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_PX) return;
      dragging = true;
      setDrag({ x0: px, y0: py, x1: ev.clientX - r.left, y1: ev.clientY - r.top });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (!dragging) return;
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      const a = inst.convertFromPixel({ gridIndex: grid.gi }, [px, py]) as number[];
      const b = inst.convertFromPixel({ gridIndex: grid.gi }, [ev.clientX - r.left, ev.clientY - r.top]) as number[];
      if (!a || !b) return;
      onAdd({ x: grid.x.key, y: grid.y.key, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) }, additive);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // the areas in pixels (only those whose axes are shown in a grid of this chart)
  const inst = chartRef.current?.instance();
  const el = dom();
  const off = el && wrap.current ? { x: el.getBoundingClientRect().left - wrap.current.getBoundingClientRect().left, y: el.getBoundingClientRect().top - wrap.current.getBoundingClientRect().top } : null;
  const rects: { i: number; left: number; top: number; width: number; height: number }[] = [];
  if (inst && off) {
    areas.forEach((a, i) => {
      for (const g of grids) {
        if (g.x.key !== a.x || g.y.key !== a.y) continue;
        try {
          const p0 = inst.convertToPixel({ gridIndex: g.gi }, [a.x0, a.y1]) as number[];
          const p1 = inst.convertToPixel({ gridIndex: g.gi }, [a.x1, a.y0]) as number[];
          if (p0 && p1 && p0.every(Number.isFinite) && p1.every(Number.isFinite)) rects.push({ i, left: off.x + Math.min(p0[0], p1[0]), top: off.y + Math.min(p0[1], p1[1]), width: Math.abs(p1[0] - p0[0]), height: Math.abs(p1[1] - p0[1]) });
        } catch { /* the grid is not ready yet */ }
      }
    });
  }

  return (
    <div ref={wrap} className="relative h-full w-full" onPointerDownCapture={onPointerDown}
      onClickCapture={(e) => { if (suppressClick.current) { e.stopPropagation(); e.preventDefault(); suppressClick.current = false; } }}>
      {children}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {rects.map((r, k) => (
          <div key={k} className="absolute rounded-[2px] border border-series-1 bg-series-1/10" style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
            <button className="pointer-events-auto absolute -right-2 -top-2 grid size-4 place-items-center rounded-full border bg-card text-muted-foreground shadow-sm hover:text-foreground"
              onClick={(e) => { e.stopPropagation(); onRemove(r.i); }} aria-label="Remove area" title="Remove this area">
              <X className="size-2.5" />
            </button>
          </div>
        ))}
        {drag && off && (
          <div className="absolute border border-dashed border-series-1 bg-series-1/10"
            style={{ left: off.x + Math.min(drag.x0, drag.x1), top: off.y + Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} />
        )}
      </div>
    </div>
  );
}
