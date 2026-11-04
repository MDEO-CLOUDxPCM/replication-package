/**
 * Option and dense-layer builders of the run explorer: 2-D scatter, scatter matrix, parallel
 * coordinates. The designs themselves are a dense layer (dense.ts: canvas on screen, SVG paths in
 * exports) so that runs with every evaluated design (50 000 and more) stay fluid; the ECharts
 * option holds the axes (scaled by an invisible bounds series), the brush, and the few overlay
 * marks (A/B, references).
 */
import type { DesignSummary, Run } from '@contract/types';
import type { Palette } from '@/lib/palette';
import { fmt } from '@/lib/format';
import { chrome, escapeHtml, valueAxis } from './base';
import type { DenseSpec, Layer } from './dense';

export interface AxisDef { key: string; label: string; unit?: string; digits?: number; get: (d: DesignSummary) => number }

export function axisDefs(run: Run): AxisDef[] {
  return [
    ...run.objectives.map((o, k) => ({ key: o.key, label: o.label, unit: o.unit, digits: o.digits, get: (d: DesignSummary) => d.objectives[k] })),
    ...run.metrics.map((m) => ({ key: m.key, label: m.label, unit: m.unit, digits: m.digits, get: (d: DesignSummary) => d.metrics[m.key] ?? NaN })),
    { key: 'born', label: 'Born (generation)', digits: 0, get: (d: DesignSummary) => d.born ?? NaN },
  ];
}

export type ColorBy = 'rank' | 'services' | 'born';

const axisName = (a: AxisDef) => `${a.label}${a.unit ? ` (${a.unit})` : ''}`;

export function tooltipHtml(run: Run, d: DesignSummary) {
  const rows = run.objectives.map((o, k) => `<tr><td style="opacity:.7;padding-right:12px">${escapeHtml(o.label)}</td><td style="text-align:right;font-weight:600">${fmt(d.objectives[k], o.digits ?? 2)}${o.unit ? ' ' + o.unit : ''}</td></tr>`).join('');
  const tag = d.label ? `<b>${escapeHtml(d.label)}</b> · ` : '';
  const status = !d.feasible ? 'infeasible' : d.rank === 0 ? 'non-dominated' : `rank ${d.rank}`;
  return `<div style="margin-bottom:4px">${tag}<span style="font-family:monospace;opacity:.75">${d.id.slice(0, 10)}</span></div><div style="opacity:.7;margin-bottom:4px">${status}${d.metrics.services !== undefined ? ` · ${d.metrics.services} services` : ''}</div><table>${rows}</table>`;
}

function extent(designs: DesignSummary[], get: (d: DesignSummary) => number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const d of designs) { const v = get(d); if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}

const colorValue = (colorBy: ColorBy) => (d: DesignSummary) => (colorBy === 'services' ? d.metrics.services ?? NaN : d.born ?? NaN);

// ---------------------------------------------------------------------------------------------
// style classes of the dense layers

interface StyleClass { fill: string | null; stroke?: string | null; alpha: number; lineAlpha: number }
const SEQ_BINS = 6;

/** class per design (index into the returned styles; drawn in this order, later on top) */
function classify(p: Palette, designs: DesignSummary[], colorBy: ColorBy, brushed: Set<string> | null): { styles: StyleClass[]; of: Uint8Array } {
  const styles: StyleClass[] = [];
  const of = new Uint8Array(designs.length);
  const base: StyleClass[] = [
    { fill: null, stroke: p.muted, alpha: 0.6, lineAlpha: 0.12 }, // infeasible
  ];
  if (colorBy === 'rank') {
    base.push({ fill: p.muted, alpha: 0.35, lineAlpha: 0.18 }, { fill: p.series[0], alpha: 0.9, lineAlpha: 0.55 });
  } else {
    const colours = p.seq.slice(1);
    for (let k = 0; k < SEQ_BINS; k++) base.push({ fill: colours[Math.round((k / (SEQ_BINS - 1)) * (colours.length - 1))], alpha: 0.8, lineAlpha: 0.4 });
  }
  const [lo, hi] = colorBy === 'rank' ? [0, 1] : extent(designs, colorValue(colorBy));
  const cv = colorValue(colorBy);
  const classOf = (d: DesignSummary) => {
    if (!d.feasible) return 0;
    if (colorBy === 'rank') return d.rank === 0 ? 2 : 1;
    const v = cv(d);
    return 1 + (Number.isFinite(v) ? Math.min(SEQ_BINS - 1, Math.floor(((v - lo) / (hi - lo || 1)) * SEQ_BINS)) : 0);
  };
  if (brushed) {
    // out of the brush first, faint; the brushed designs on top in their own colours
    styles.push({ fill: p.muted, stroke: null, alpha: 0.1, lineAlpha: 0.04 });
    styles.push(...base);
    designs.forEach((d, i) => { of[i] = brushed.has(d.id) ? 1 + classOf(d) : 0; });
  } else {
    styles.push(...base);
    designs.forEach((d, i) => { of[i] = classOf(d); });
  }
  return { styles, of };
}

function pointLayers(designs: DesignSummary[], cls: { styles: StyleClass[]; of: Uint8Array }, grid: number, x: AxisDef, y: AxisDef, r: number): Layer[] {
  const counts = new Array(cls.styles.length).fill(0);
  for (let i = 0; i < designs.length; i++) counts[cls.of[i]]++;
  const layers = cls.styles.map((s, k) => ({
    kind: 'points' as const, grid, fill: s.fill, stroke: s.stroke ?? null, alpha: s.alpha, r,
    x: new Float64Array(counts[k]), y: new Float64Array(counts[k]), idx: new Int32Array(counts[k]), n: 0,
  }));
  for (let i = 0; i < designs.length; i++) {
    const l = layers[cls.of[i]];
    l.x[l.n] = x.get(designs[i]); l.y[l.n] = y.get(designs[i]); l.idx[l.n] = i; l.n++;
  }
  return layers.filter((l) => l.n > 0).map(({ n: _n, ...l }) => l);
}

const pointRadius = (n: number) => (n > 20000 ? 2 : n > 1500 ? 2.5 : 4);

// ---------------------------------------------------------------------------------------------
// overlays (ECharts series: few points)

/** shared overlay: selection A/B and references, keyed by series id */
export function overlaySeries(p: Palette, pts: { id: string; x: number; y: number; label: string; kind: 'a' | 'b' | 'ref' }[], xAxisIndex = 0, yAxisIndex = 0, suffix = '') {
  return [
    {
      id: `refs${suffix}`, type: 'scatter', xAxisIndex, yAxisIndex, z: 4, symbol: 'diamond', symbolSize: 11, silent: false, tooltip: { show: false },
      data: pts.filter((q) => q.kind === 'ref').map((q) => ({ value: [q.x, q.y], name: q.id, label: { show: true, formatter: q.label, position: 'right', color: p.ink2, fontSize: 10 } })),
      itemStyle: { color: p.ink2, borderColor: p.surface, borderWidth: 2 },
    },
    {
      id: `sel${suffix}`, type: 'scatter', xAxisIndex, yAxisIndex, z: 6, symbolSize: 14, silent: false, tooltip: { show: false },
      data: pts.filter((q) => q.kind === 'a' || q.kind === 'b').map((q) => ({
        value: [q.x, q.y], name: q.id,
        itemStyle: { color: q.kind === 'a' ? p.a : p.b, borderColor: p.surface, borderWidth: 2 },
        label: { show: true, formatter: q.kind.toUpperCase(), color: p.surface, fontSize: 9, fontWeight: 700, position: 'inside' },
      })),
    },
  ];
}

/** an invisible series spanning the data, so ECharts scales the axes as if it drew the designs */
function boundsSeries(xe: [number, number], ye: [number, number], ce: [number, number] | null, xAxisIndex = 0, yAxisIndex = 0, id = 'bounds') {
  return {
    id, type: 'scatter', xAxisIndex, yAxisIndex, silent: true, symbolSize: 0, itemStyle: { opacity: 0 }, tooltip: { show: false }, z: 0,
    data: [[xe[0], ye[0], ce?.[0] ?? 0], [xe[1], ye[1], ce?.[1] ?? 0]],
  };
}


function colorLegend(p: Palette, colorBy: ColorBy, ce: [number, number], seriesIndex: number | number[]) {
  return {
    type: 'continuous', dimension: 2, seriesIndex, orient: 'horizontal', right: 8, top: 0, itemWidth: 10, itemHeight: 120, calculable: false,
    text: [colorBy === 'services' ? 'more services' : 'later', ''], textStyle: { color: p.ink2, fontSize: 10 },
    min: ce[0], max: ce[1], inRange: { color: p.seq.slice(1) },
  };
}

// ---------------------------------------------------------------------------------------------
// scatter

export function scatterOption(p: Palette, designs: DesignSummary[], x: AxisDef, y: AxisDef, colorBy: ColorBy, overlay: Parameters<typeof overlaySeries>[1], _exporting: boolean) {
  const ce = colorBy !== 'rank' ? extent(designs, colorValue(colorBy)) : null;
  return {
    ...chrome(p),
    animation: false,
    grid: { id: 'g0', left: 64, right: overlay.some((q) => q.kind === 'ref') ? 90 : 24, top: colorBy === 'rank' ? 28 : 40, bottom: 48 },
    visualMap: ce ? colorLegend(p, colorBy, ce, 0) : undefined,
    tooltip: { ...chrome(p).tooltip, trigger: 'item', show: false },
    toolbox: { show: false },
    xAxis: valueAxis(p, { name: axisName(x), nameLocation: 'middle', nameGap: 30 }),
    yAxis: valueAxis(p, { name: axisName(y), nameLocation: 'middle', nameGap: 48 }),
    series: [boundsSeries(extent(designs, x.get), extent(designs, y.get), ce), ...overlaySeries(p, overlay)],
  };
}

export function scatterDense(p: Palette, designs: DesignSummary[], x: AxisDef, y: AxisDef, colorBy: ColorBy, brushed: Set<string> | null): DenseSpec {
  const cls = classify(p, designs, colorBy, brushed);
  return {
    keys: designs.map((d) => d.id), ink: p.ink, surface: p.surface,
    layers: pointLayers(designs, cls, 0, x, y, pointRadius(designs.length)),
    locate: (i) => [{ grid: 0, x: x.get(designs[i]), y: y.get(designs[i]) }],
  };
}

// ---------------------------------------------------------------------------------------------
// matrix: one cell per pair of axes (lower triangle)

export function matrixCells(n: number): { c: number; r: number }[] {
  const cells: { c: number; r: number }[] = [];
  for (let r = 1; r < n; r++) for (let c = 0; c < r; c++) cells.push({ c, r });
  return cells;
}

export function matrixOption(p: Palette, designs: DesignSummary[], axes: AxisDef[], sel: { id: string; kind: 'a' | 'b' }[], _exporting: boolean) {
  const n = axes.length;
  const grids: any[] = [], xs: any[] = [], ys: any[] = [], series: any[] = [];
  const gap = 2.5, left = 7, top = 4, size = (100 - left - 3 - gap * (n - 2)) / (n - 1);
  const byId = new Map(designs.map((d) => [d.id, d]));
  const ext = axes.map((a) => extent(designs, a.get));
  matrixCells(n).forEach(({ c, r }, gi) => {
    grids.push({ id: `g${gi}`, left: `${left + c * (size + gap)}%`, top: `${top + (r - 1) * (size + gap)}%`, width: `${size}%`, height: `${size}%` });
    xs.push(valueAxis(p, { gridIndex: gi, name: r === n - 1 ? axisName(axes[c]) : '', nameLocation: 'middle', nameGap: 24, axisLabel: { show: r === n - 1, color: p.muted, fontSize: 9, hideOverlap: true } }));
    ys.push(valueAxis(p, { gridIndex: gi, name: c === 0 ? axisName(axes[r]) : '', nameLocation: 'middle', nameGap: 44, axisLabel: { show: c === 0, color: p.muted, fontSize: 9, hideOverlap: true } }));
    series.push(boundsSeries(ext[c], ext[r], null, gi, gi, `bounds${gi}`));
    const pts = sel.map((s) => byId.get(s.id)).map((d, i) => d && { id: d.id, x: axes[c].get(d), y: axes[r].get(d), label: sel[i].kind, kind: sel[i].kind }).filter(Boolean) as any[];
    series.push(...overlaySeries(p, pts, gi, gi, `-${gi}`).filter((s) => !String(s.id).startsWith('refs')));
  });
  return {
    ...chrome(p),
    animation: false,
    grid: grids, xAxis: xs, yAxis: ys, series,
    tooltip: { show: false },
    toolbox: { show: false },
  };
}

export function matrixDense(p: Palette, designs: DesignSummary[], axes: AxisDef[], colorBy: ColorBy, brushed: Set<string> | null): DenseSpec {
  const cls = classify(p, designs, colorBy, brushed);
  const cells = matrixCells(axes.length);
  const r = designs.length > 20000 ? 1.5 : designs.length > 1500 ? 2 : 3;
  return {
    keys: designs.map((d) => d.id), ink: p.ink, surface: p.surface,
    layers: cells.flatMap((cell, gi) => pointLayers(designs, cls, gi, axes[cell.c], axes[cell.r], r)),
    locate: (i) => cells.map((cell, gi) => ({ grid: gi, x: axes[cell.c].get(designs[i]), y: axes[cell.r].get(designs[i]) })),
  };
}

// ---------------------------------------------------------------------------------------------
// parallel coordinates

export function parallelOption(p: Palette, designs: DesignSummary[], axes: AxisDef[], sel: { id: string; kind: 'a' | 'b' }[]) {
  const byId = new Map(designs.map((d) => [d.id, d]));
  const line = (d: DesignSummary) => axes.map((a) => a.get(d));
  const ext = axes.map((a) => extent(designs, a.get));
  return {
    ...chrome(p),
    animation: false,
    parallel: { left: 64, right: 72, top: 44, bottom: 36, parallelAxisDefault: {
      type: 'value', scale: true, nameLocation: 'end', nameGap: 14, nameTextStyle: { color: p.ink, fontSize: 11, fontWeight: 600 },
      axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { color: p.ink2, fontSize: 10, textBorderColor: p.surface, textBorderWidth: 3 },
      areaSelectStyle: { width: 18, borderWidth: 1, color: 'rgba(42,120,214,0.15)', borderColor: p.series[0], opacity: 1 },
    } },
    parallelAxis: axes.map((a, i) => ({ id: `pa${i}`, dim: i, name: axisName(a), inverse: false })),
    tooltip: { show: false },
    series: [
      { id: 'bounds', type: 'parallel', silent: true, z: 0, lineStyle: { opacity: 0 }, inactiveOpacity: 0, activeOpacity: 0, emphasis: { disabled: true },
        data: [ext.map((e) => e[0]), ext.map((e) => e[1])] },
      { id: 'sel', type: 'parallel', silent: true, z: 5, inactiveOpacity: 1, activeOpacity: 1, emphasis: { disabled: true },
        data: sel.filter((s) => byId.has(s.id)).map((s) => ({ value: line(byId.get(s.id)!), name: s.id, lineStyle: { color: s.kind === 'a' ? p.a : p.b, width: 3, opacity: 1 } })) },
    ],
  };
}

export function parallelDense(p: Palette, designs: DesignSummary[], axes: AxisDef[], colorBy: ColorBy, brushed: Set<string> | null): DenseSpec {
  const cls = classify(p, designs, colorBy, brushed);
  const dims = axes.length;
  const counts = new Array(cls.styles.length).fill(0);
  for (let i = 0; i < designs.length; i++) counts[cls.of[i]]++;
  const layers = cls.styles.map((s, k) => ({
    kind: 'lines' as const, color: s.fill ?? s.stroke ?? p.muted, alpha: s.lineAlpha, width: 1,
    v: new Float64Array(counts[k] * dims), idx: new Int32Array(counts[k]), n: 0,
  }));
  for (let i = 0; i < designs.length; i++) {
    const l = layers[cls.of[i]];
    for (let d = 0; d < dims; d++) l.v[l.n * dims + d] = axes[d].get(designs[i]);
    l.idx[l.n++] = i;
  }
  return {
    keys: designs.map((d) => d.id), dims, ink: p.ink, surface: p.surface,
    layers: layers.filter((l) => l.n > 0).map(({ n: _n, ...l }) => l),
    locate: (i) => axes.map((a) => a.get(designs[i])),
  };
}
