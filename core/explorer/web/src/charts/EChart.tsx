import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { echarts, type Option } from './echarts';
import { PALETTES, type Palette } from '@/lib/palette';
import { useTheme } from '@/lib/theme';
import { FONT } from './base';
import { denseSvg, drawDense, injectUnder, drawHighlight, hitTest, project, projectionKey, type DenseSpec, type HitIndex, type Projection } from './dense';

export interface ChartContext { exporting: boolean; title?: string }
export type OptionBuilder = (p: Palette, ctx: ChartContext) => Option;
export type DenseBuilder = (p: Palette) => DenseSpec | null;

export interface EChartHandle {
  /** the chart as standalone SVG in the light theme */
  toSvg(title?: string): string;
  instance(): echarts.ECharts | null;
  /** timing of the last dense draw (ms) and the number of marks drawn */
  denseStats(): { ms: number; drawn: number } | null;
}

interface Props {
  build: OptionBuilder;
  /** the many-points layer (designs) drawn on a canvas under the chart, see dense.ts */
  dense?: DenseBuilder | null;
  /** key (index into the dense spec's keys) to mark */
  highlight?: number | null;
  onDenseHover?: (key: number | null) => void;
  onDenseClick?: (key: number, e: MouseEvent) => void;
  onDenseDblClick?: (key: number) => void;
  denseTooltip?: (key: number) => string;
  height?: number | string;
  className?: string;
  onEvents?: Record<string, (params: any, chart: echarts.ECharts) => void>;
  /** replace instead of merge on update (lists of series that shrink) */
  notMerge?: boolean;
  renderer?: 'canvas' | 'svg';
}

// ---------------------------------------------------------------------------------------------
// legends: wrapped into rows that fit the width (never clipped, never paged); the plot moves down

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(s: string, size: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * size * 0.6;
  measureCtx.font = `${size}px ${FONT}`;
  return measureCtx.measureText(s).width;
}

/** lays the (single, horizontal) legend out in rows; returns the extra height the rows need */
export function wrapLegend(opt: Record<string, any>, width: number): number {
  const lg = opt.legend;
  if (!lg || Array.isArray(lg) || lg.show === false || lg.orient === 'vertical') return 0;
  const series: any[] = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : [];
  const names: string[] = (lg.data ?? [...new Set(series.map((s) => s.name).filter(Boolean))]).map((d: any) => (typeof d === 'string' ? d : d.name));
  if (!names.length) return 0;
  const size = lg.textStyle?.fontSize ?? 12;
  const iconW = lg.itemWidth ?? 25, gap = lg.itemGap ?? 10;
  const grid = Array.isArray(opt.grid) ? opt.grid[0] : opt.grid;
  const left = typeof grid?.left === 'number' ? grid.left : 8;
  // keep the builder's alignment: right-aligned legends wrap over the whole width and stay right-aligned
  const alignRight = lg.left === undefined && lg.right !== undefined;
  const rightPad = typeof lg.right === 'number' ? lg.right : 8;
  const avail = Math.max(80, alignRight ? width - rightPad - 10 : width - left - 8);
  let rows = 1, x = 0;
  for (const n of names) {
    const w = iconW + 5 + textWidth(n, size);
    if (x > 0 && x + w > avail) { rows++; x = 0; }
    x += w + gap;
  }
  const top = typeof lg.top === 'number' ? lg.top : 0;
  const pitch = Math.max(lg.itemHeight ?? 14, size + 3) + gap;
  opt.legend = alignRight
    ? { ...lg, type: 'plain', right: rightPad, top: top + 2, orient: 'horizontal' }
    : { ...lg, type: 'plain', left, right: 8, top: top + 2, orient: 'horizontal' };
  const extra = (rows - 1) * pitch + 2;
  const shift = (g: any) => (g && typeof g.top === 'number' ? { ...g, top: g.top + extra } : g);
  if (Array.isArray(opt.grid)) opt.grid = opt.grid.map(shift);
  else if (opt.grid) opt.grid = shift(opt.grid);
  if (opt.parallel) opt.parallel = shift(opt.parallel);
  return extra;
}

export const EChart = forwardRef<EChartHandle, Props>(function EChart(
  { build, dense, highlight = null, onDenseHover, onDenseClick, onDenseDblClick, denseTooltip, height = 280, className, onEvents, notMerge = true, renderer = 'canvas' }, ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const under = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const { theme } = useTheme();
  const [extra, setExtra] = useState(0);
  const st = useRef({
    build, dense, theme, spec: null as DenseSpec | null, proj: null as Projection | null, projKey: '', index: null as HitIndex | null,
    stats: null as { ms: number; drawn: number } | null, densePending: false, denseRaf: 0, highlight, hover: null as number | null, onDenseHover, onDenseClick, onDenseDblClick, denseTooltip,
  });
  Object.assign(st.current, { build, dense, theme, highlight, onDenseHover, onDenseClick, onDenseDblClick, denseTooltip });
  const tip = useRef<HTMLDivElement>(null);

  // the chart's own (cached) size: reading clientWidth would force a layout on every hover redraw
  const size = () => { const c = chart.current; return c && !c.isDisposed() ? { w: c.getWidth(), h: c.getHeight() } : { w: host.current?.clientWidth ?? 0, h: host.current?.clientHeight ?? 0 }; };

  /** (re)draw the dense layer if the data or the projection changed */
  const redrawDense = (force = false) => {
    const c = chart.current, s = st.current;
    if (!c || !under.current) return;
    if (!s.spec) {
      if (s.projKey) { under.current.getContext('2d')?.clearRect(0, 0, under.current.width, under.current.height); s.projKey = ''; s.index = null; }
      return;
    }
    const { w, h } = size();
    // a hidden chart (size 0, e.g. a panel mounting collapsed) waits: the resize observer draws it once it has a size
    if (!w || !h) { s.densePending = true; return; }
    const proj = project(c, s.spec);
    const key = projectionKey(proj);
    if (!force && !s.densePending && key === s.projKey) return;
    s.densePending = false;
    cancelAnimationFrame(s.denseRaf);
    const r = drawDense(under.current, s.spec, proj, w, h, window.devicePixelRatio || 1);
    s.proj = proj;
    s.projKey = key;
    s.index = r.index;
    s.stats = { ms: Math.round(r.ms * 10) / 10, drawn: r.drawn };
    redrawHighlight();
  };
  const redrawHighlight = () => {
    const s = st.current;
    if (!over.current) return;
    const { w, h } = size();
    drawHighlight(over.current, s.spec, s.proj, s.hover ?? s.highlight, w, h, window.devicePixelRatio || 1);
  };

  const apply = (notMergeNow: boolean, forceDense = true) => {
    const c = chart.current, s = st.current;
    if (!c) return;
    const p = PALETTES[s.theme];
    const opt = s.build(p, { exporting: false }) as Record<string, any>;
    const ex = wrapLegend(opt, el.current?.clientWidth ?? 600);
    setExtra(ex);
    // the dense layer is drawn once the chart has rendered ('finished', with the final projection; it may fire inside
    // setOption), else in the next frame: drawing it after setOption as well drew 60 000 points twice per change
    if (forceDense) s.densePending = true;
    c.setOption(opt, { notMerge: notMergeNow });
    cancelAnimationFrame(s.denseRaf);
    if (s.densePending) s.denseRaf = requestAnimationFrame(() => redrawDense());
  };

  useEffect(() => {
    const c = echarts.init(host.current!, undefined, { renderer });
    chart.current = c;
    const zr = c.getZr();
    let raf = 0;
    zr.on('mousemove', (e: any) => {
      const s = st.current;
      if (!s.index) return;
      cancelAnimationFrame(raf);
      const mx = e.offsetX, my = e.offsetY;
      raf = requestAnimationFrame(() => {
        const k = hitTest(s.index, mx, my);
        if (k !== s.hover) {
          s.hover = k;
          s.onDenseHover?.(k);
          redrawHighlight();
        }
        const t = tip.current;
        if (t) {
          if (k !== null && s.denseTooltip) {
            t.innerHTML = s.denseTooltip(k);
            t.style.display = 'block';
            const { w } = size();
            const tw = t.offsetWidth, th = t.offsetHeight;
            t.style.left = `${mx + 14 + tw > w ? mx - tw - 14 : mx + 14}px`;
            t.style.top = `${Math.max(0, my - th - 10)}px`;
          } else t.style.display = 'none';
        }
        zr.setCursorStyle(k !== null ? 'pointer' : 'default');
      });
    });
    zr.on('globalout', () => {
      const s = st.current;
      cancelAnimationFrame(raf);
      if (tip.current) tip.current.style.display = 'none';
      if (s.hover !== null) { s.hover = null; s.onDenseHover?.(null); redrawHighlight(); }
    });
    zr.on('click', (e: any) => {
      const s = st.current;
      const k = hitTest(s.index, e.offsetX, e.offsetY);
      if (k !== null) s.onDenseClick?.(k, e.event as MouseEvent);
    });
    zr.on('dblclick', (e: any) => {
      const s = st.current;
      const k = hitTest(s.index, e.offsetX, e.offsetY);
      if (k !== null) s.onDenseDblClick?.(k);
    });
    // the projection changes after layout passes (legend wrap, axis rescale, resize)
    c.on('finished', () => redrawDense());
    st.current.spec = st.current.dense?.(PALETTES[st.current.theme]) ?? null;
    Object.assign(st.current, { denseFn: st.current.dense, specTheme: st.current.theme });
    apply(true);
    // resizes come in bursts (a panel divider dragged, a panel opened): resize and redraw once the
    // size has been still for a moment, not on every frame; a hidden chart (size 0) waits
    let resizeTimer = 0;
    const doResize = () => {
      const w = el.current?.clientWidth ?? 0, h = el.current?.clientHeight ?? 0;
      if (!w || !h || c.isDisposed()) return;
      if (w === c.getWidth() && h === c.getHeight()) return;
      c.resize();
      const opt = st.current.build(PALETTES[st.current.theme], { exporting: false }) as Record<string, any>;
      const ex = wrapLegend(opt, w);
      if (ex !== extraRef.current) apply(false);
      redrawDense();
    };
    const ro = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(doResize, 120); });
    ro.observe(el.current!);
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(st.current.denseRaf); clearTimeout(resizeTimer); ro.disconnect(); c.dispose(); chart.current = null; };
  }, [renderer]); // eslint-disable-line react-hooks/exhaustive-deps

  const extraRef = useRef(0);
  extraRef.current = extra;

  useEffect(() => {
    if (!chart.current) return;
    // the dense layer is drawn again only when its spec or the projection changed (e.g. not when
    // only the overlay marks A / B changed)
    const s = st.current as typeof st.current & { denseFn?: unknown; specTheme?: string };
    const fresh = s.denseFn !== dense || s.specTheme !== theme;
    if (fresh) { s.spec = dense?.(PALETTES[theme]) ?? null; s.denseFn = dense; s.specTheme = theme; }
    apply(notMerge, fresh);
  }, [build, dense, theme, notMerge]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { redrawHighlight(); }, [highlight]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { chart.current?.resize(); redrawDense(true); }, [extra]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = chart.current;
    if (!c || !onEvents) return;
    const entries = Object.entries(onEvents);
    for (const [ev, fn] of entries) c.on(ev, (p: unknown) => fn(p, c));
    return () => { if (!c.isDisposed()) for (const [ev] of entries) c.off(ev); };
  }, [onEvents]);

  useImperativeHandle(ref, () => ({
    instance: () => chart.current,
    denseStats: () => st.current.stats,
    toSvg(title?: string) {
      const w = el.current?.clientWidth || 800;
      const h0 = host.current?.clientHeight || 400;
      const opt = st.current.build(PALETTES.light, { exporting: true, title }) as Record<string, any>;
      const ex = wrapLegend(opt, w);
      const top = title ? 34 : 0;
      const ssr = echarts.init(null as unknown as HTMLElement, undefined, { renderer: 'svg', ssr: true, width: w, height: h0 - extraRef.current + ex + top });
      opt.animation = false;
      opt.backgroundColor = PALETTES.light.surface;
      if (title) {
        opt.title = { text: title, left: 12, top: 8, textStyle: { fontFamily: FONT, fontSize: 14, fontWeight: 600, color: PALETTES.light.ink } };
        const shift = (g: any) => (g && typeof g === 'object' && !Array.isArray(g) ? { ...g, top: (typeof g.top === 'number' ? g.top : 40) + top } : g);
        if (Array.isArray(opt.grid)) opt.grid = opt.grid.map(shift);
        else if (opt.grid) opt.grid = shift(opt.grid);
        if (opt.parallel) opt.parallel = shift(opt.parallel);
        if (opt.legend && !Array.isArray(opt.legend)) opt.legend = { ...opt.legend, top: (opt.legend.top ?? 0) + top };
        if (opt.visualMap && !Array.isArray(opt.visualMap) && typeof opt.visualMap.top === 'number') opt.visualMap = { ...opt.visualMap, top: opt.visualMap.top + top };
      }
      ssr.setOption(opt);
      const spec = st.current.dense?.(PALETTES.light);
      // drop the renderer's hover-only CSS: the export is a static picture
      let svg = ssr.renderToSVGString().replace(/<style[\s\S]*?<\/style>/g, '');
      if (spec) svg = injectUnder(svg, denseSvg(spec, project(ssr, spec)));
      ssr.dispose();
      return svg;
    },
  }));

  const h = typeof height === 'number' ? height + extra : height;
  return (
    <div ref={el} className={className} style={{ height: h, width: '100%', position: 'relative' }}>
      <canvas ref={under} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} />
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={over} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} />
      <div ref={tip} className="pointer-events-none absolute z-10 hidden rounded-lg border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg" style={{ fontFamily: FONT }} />
    </div>
  );
});
