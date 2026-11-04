/** Option builders of the performance view. A and B always wear the selection colours. */
import type { DesignDetail, LoadProfile, ResponseStats, ServiceTimeline } from '@contract/types';
import type { Palette } from '@/lib/palette';
import type { OptionBuilder } from './EChart';
import { fmt, fmtMs, fmtPct } from '@/lib/format';
import { chrome, escapeHtml, legend, ttRow, valueAxis } from './base';

export interface Side { label: string; stats?: ResponseStats; detail: DesignDetail; color: 'a' | 'b' }

const col = (p: Palette, s: { color: 'a' | 'b' }) => (s.color === 'a' ? p.a : p.b);

function cdfPoints(st: ResponseStats): [number, number][] {
  const { edgesMs, counts } = st.histogram;
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const out: [number, number][] = [[edgesMs[0], 0]];
  counts.forEach((c, i) => { acc += c; out.push([edgesMs[i + 1], acc / total]); });
  return out;
}

const T = { interval: 120, scale: false, splitLine: { show: false } };

const logAxis = (p: Palette, extra: Record<string, unknown> = {}) => ({
  ...valueAxis(p), type: 'log', logBase: 10, scale: false,
  axisLabel: { color: p.muted, fontSize: 10, formatter: (v: number) => (v >= 1000 ? `${v / 1000} s` : `${v} ms`) },
  minorSplitLine: { show: false }, ...extra,
});

function range(sides: Side[]) {
  const lo = Math.min(...sides.map((s) => Math.max(0.5, s.stats!.p50Ms / 8)));
  const hi = Math.max(...sides.map((s) => s.stats!.maxMs * 1.5));
  return { min: 10 ** Math.floor(Math.log10(lo)), max: 10 ** Math.ceil(Math.log10(hi)) };
}

/** the CDF with a mark at C1's statistic (`stat`: mean, p50, p90, p95) of each side */
export const cdfBuild = (sides: Side[], stat = 'p95'): OptionBuilder => (p) => {
  const s = sides.filter((x) => x.stats);
  const r = range(s);
  return {
    ...chrome(p),
    grid: { left: 44, right: 16, top: 30, bottom: 34 },
    legend: s.length > 1 ? legend(p) : undefined,
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => `<div style="opacity:.7;margin-bottom:4px">≤ ${fmtMs(ps[0].value[0])}</div>` + ps.map((x) => ttRow(x.color, fmtPct(x.value[1]), x.seriesName)).join('') },
    xAxis: logAxis(p, { name: 'response time', nameLocation: 'middle', nameGap: 24, ...r }),
    yAxis: valueAxis(p, { min: 0, max: 1, scale: false, axisLabel: { color: p.muted, fontSize: 10, formatter: (v: number) => `${Math.round(v * 100)} %` } }),
    series: s.map((x) => ({
      name: x.label, type: 'line', data: cdfPoints(x.stats!), showSymbol: false, step: false, smooth: 0.2,
      lineStyle: { width: 2, color: col(p, x) }, itemStyle: { color: col(p, x) },
      markLine: { symbol: 'none', silent: true, label: { formatter: (m: any) => m.name, color: p.ink2, fontSize: 10, position: 'end' }, lineStyle: { color: col(p, x), width: 1, type: 'solid', opacity: 0.6 },
        data: [((v: number) => ({ name: `${stat} ${fmtMs(v)}`, xAxis: v }))(stat === 'p95' ? x.stats!.p95Ms : x.stats!.statisticMs ?? x.stats!.p95Ms)] },
    })),
  };
};

export const histBuild = (sides: Side[]): OptionBuilder => (p) => {
  const s = sides.filter((x) => x.stats);
  const r = range(s);
  const n = s.length;
  return {
    ...chrome(p),
    grid: { left: 48, right: 16, top: 30, bottom: 34 },
    legend: n > 1 ? legend(p, { icon: 'rect', itemHeight: 8, itemWidth: 12 }) : undefined,
    tooltip: { ...chrome(p).tooltip, trigger: 'item', formatter: (x: any) => `<div style="opacity:.7;margin-bottom:4px">${fmtMs(x.value[0])} – ${fmtMs(x.value[1])}</div>${ttRow(x.color, `${fmt(x.value[3] * 100, 1)} %`, `${escapeHtml(x.seriesName)} (${x.value[2].toLocaleString()} requests)`)}` },
    xAxis: logAxis(p, { name: 'response time', nameLocation: 'middle', nameGap: 24, ...r }),
    yAxis: valueAxis(p, { scale: false, axisLabel: { color: p.muted, fontSize: 10, formatter: (v: number) => `${Math.round(v * 100)} %` } }),
    series: s.map((x, si) => {
      const total = x.stats!.histogram.counts.reduce((a, b) => a + b, 0) || 1;
      return {
        name: x.label, type: 'custom', itemStyle: { color: col(p, x) },
        renderItem: (_: any, api: any) => {
          const a = api.coord([api.value(0), 0]), b = api.coord([api.value(1), api.value(3)]);
          const w = (b[0] - a[0]) / n;
          return { type: 'rect', shape: { x: a[0] + si * w + 1, y: b[1], width: Math.max(1, w - 2), height: a[1] - b[1], r: [2, 2, 0, 0] }, style: { fill: col(p, x), opacity: 0.9 } };
        },
        encode: { x: [0, 1], y: 3 },
        data: x.stats!.histogram.counts.map((c, i) => [x.stats!.histogram.edgesMs[i], x.stats!.histogram.edgesMs[i + 1], c, c / total]).filter((d) => d[2] > 0),
      };
    }),
  };
};

/** the profile's phases as alternating bands, the warm-up (not measured) hatched darker; for markArea on one series per grid */
export interface Phases { phases?: { name: string; fromS: number; toS: number }[]; warmupS?: number }
export function phaseAreas(p: Palette, ph: Phases, labels = true) {
  const span = Math.max(1, ...(ph.phases ?? []).map((x) => x.toS));
  // a short phase (the day's 60-s burst) is shaded but not labelled: its name would run into its neighbour's
  const data: any[] = (ph.phases ?? []).map((x, i) => [
    { xAxis: x.fromS, name: labels && (x.toS - x.fromS) / span >= 0.065 ? x.name : '', itemStyle: { color: p.ink2, opacity: i % 2 ? 0.07 : 0.025 } }, { xAxis: x.toS },
  ]);
  if (ph.warmupS) data.push([{ xAxis: 0, name: labels ? 'warm-up' : '', itemStyle: { color: p.muted, opacity: 0.16 } }, { xAxis: ph.warmupS }]);
  return { silent: true, data, label: { show: labels, position: 'insideTop', color: p.muted, fontSize: 9.5, distance: 2 } };
}

/** two grids sharing the time axis: the load (sessions/s) above, the response time per bin below (with C1's budget). Never two y-scales on one plot. */
export const overTimeBuild = (load: LoadProfile, sides: Side[], metric: 'p95Ms' | 'meanMs', ph: Phases, budgetMs?: number): OptionBuilder => (p) => {
  const s = sides.filter((x) => x.stats?.overTime);
  const t = load.t;
  const end = Math.max(t[t.length - 1] ?? 0, ...s.map((x) => { const tt = x.stats!.overTime!.t; return (tt[tt.length - 1] ?? 0) + (sides[0].detail.simulator.binS ?? 10); }));
  const lab = metric === 'p95Ms' ? 'p95' : 'mean';
  return {
    ...chrome(p),
    axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: p.axis } },
    legend: s.length > 1 ? legend(p) : undefined,
    grid: [{ left: 56, right: 16, top: 30, height: '22%' }, { left: 56, right: 16, top: '42%', bottom: 34 }],
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => {
      const tt = ps[0].value[0];
      const rows = ps.map((x) => ttRow(x.color, x.seriesIndex === 0 ? `${fmt(x.value[1], 1)}/s` : fmtMs(x.value[1]), x.seriesIndex === 0 ? 'sessions started' : `${x.seriesName} ${lab}`));
      return `<div style="opacity:.7;margin-bottom:4px">t = ${tt} s</div>${rows.join('')}`;
    } },
    xAxis: [
      valueAxis(p, { gridIndex: 0, min: 0, max: end, ...T, axisLabel: { show: false } }),
      valueAxis(p, { gridIndex: 1, min: 0, max: end, ...T, name: 'time (s)', nameLocation: 'middle', nameGap: 24 }),
    ],
    yAxis: [
      valueAxis(p, { gridIndex: 0, scale: false, name: 'sessions/s', nameLocation: 'end', nameGap: 6, nameTextStyle: { align: 'left', color: p.muted, fontSize: 10 }, splitNumber: 2 }),
      valueAxis(p, { gridIndex: 1, scale: false, name: `${lab} per ${sides[0].detail.simulator.binS ?? 10}-s bin (ms)`, nameLocation: 'end', nameGap: 6, nameTextStyle: { align: 'left', color: p.muted, fontSize: 10 } }),
    ],
    series: [
      { name: 'load', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: t.map((x, i) => [x, load.sessionsPerSecond[i]]), showSymbol: false, step: 'end', lineStyle: { width: 1.5, color: p.ink2 }, areaStyle: { color: p.ink2, opacity: 0.08 }, itemStyle: { color: p.ink2 }, markArea: phaseAreas(p, ph) },
      ...s.map((x, i) => {
        const o = x.stats!.overTime!;
        // bins without a completion carry no value (a gap, not a 0 ms response)
        return { name: x.label, type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, connectNulls: false, data: o.t.map((tt, j) => [tt, o.throughput[j] > 0 ? o[metric][j] : null]), lineStyle: { width: 2, color: col(p, x) }, itemStyle: { color: col(p, x) },
          markArea: i === 0 ? phaseAreas(p, ph, false) : undefined,
          markLine: i === 0 && budgetMs ? { symbol: 'none', silent: true, data: [{ yAxis: budgetMs }], lineStyle: { color: p.critical, type: 'dashed', width: 1 }, label: { formatter: `budget ${fmtMs(budgetMs)} (C1, over the window)`, color: p.ink2, fontSize: 10, position: 'insideEndTop' } } : undefined };
      }),
    ],
  };
};

/** per request type C1's statistic over its budget (1 = at the budget); bars above 1 add to C1 */
export const budgetBuild = (rows: { key: string; label: string; a?: ResponseStats; b?: ResponseStats }[], statistic: string): OptionBuilder => (p) => {
  const r = rows.filter((x) => x.a?.budgetMs).map((x) => ({ ...x, ra: (x.a!.statisticMs ?? 0) / x.a!.budgetMs!, rb: x.b?.budgetMs ? (x.b.statisticMs ?? 0) / x.b.budgetMs : undefined }))
    .sort((x, y) => Math.max(y.ra, y.rb ?? 0) - Math.max(x.ra, x.rb ?? 0));
  const two = r.some((x) => x.rb !== undefined);
  // one design: a bar above its budget turns red; two designs keep A's and B's colours (the budget line marks the excess)
  const bar = (v: number, base: string) => ({ value: v, itemStyle: { color: !two && v > 1 ? p.critical : base, borderRadius: [0, 2, 2, 0] } });
  return {
    ...chrome(p),
    grid: { left: 150, right: 30, top: two ? 28 : 12, bottom: 30 },
    legend: two ? legend(p, { icon: 'rect', itemHeight: 8, itemWidth: 12, data: ['A', 'B'] }) : undefined,
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: any[]) => {
      const x = r[ps[0].dataIndex];
      const line = (s: ResponseStats | undefined, l: string, c: string) => (s?.budgetMs ? ttRow(c, `${fmtMs(s.statisticMs ?? 0)} / ${fmtMs(s.budgetMs)}`, `${l} ${statistic} / budget (${fmt(s.count, 0)} completions)`) : '');
      return `<div style="opacity:.7;margin-bottom:4px">${escapeHtml(x.label)}</div>${line(x.a, 'A', p.a)}${line(x.b, 'B', p.b)}`;
    } },
    yAxis: { type: 'category', inverse: true, data: r.map((x) => x.label), axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false }, axisLabel: { color: p.ink2, fontSize: 10, width: 140, overflow: 'truncate' } },
    xAxis: valueAxis(p, { min: 0, scale: false, name: `${statistic} / budget`, nameLocation: 'middle', nameGap: 22, axisLabel: { color: p.muted, fontSize: 10, formatter: (v: number) => `${fmt(v, 1)}×` } }),
    series: [
      { name: 'A', type: 'bar', barMaxWidth: 10, itemStyle: { color: p.a }, data: r.map((x) => bar(x.ra, p.a)), markLine: { symbol: 'none', silent: true, data: [{ xAxis: 1 }], lineStyle: { color: p.critical, type: 'solid', width: 1 }, label: { formatter: 'budget', color: p.ink2, fontSize: 10, position: 'start' } } },
      ...(two ? [{ name: 'B', type: 'bar', barMaxWidth: 10, itemStyle: { color: p.b }, data: r.map((x) => (x.rb === undefined ? null : bar(x.rb, p.b))) }] : []),
    ],
  };
};

export const mixBuild = (load: LoadProfile, names: Record<string, string>): OptionBuilder => (p) => {
  const keys = Object.keys(load.mix);
  // stacked areas need a category axis (ECharts stacks per category)
  return {
    ...chrome(p),
    grid: { left: 44, right: 16, top: 34, bottom: 30 },
    legend: legend(p, { icon: 'rect', itemHeight: 8, itemWidth: 12 }),
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => `<div style="opacity:.7;margin-bottom:4px">t = ${ps[0].name} s</div>` + [...ps].reverse().map((x) => ttRow(x.color, fmtPct(x.value), x.seriesName)).join('') },
    xAxis: { type: 'category', data: load.t, boundaryGap: false, axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false }, axisLabel: { color: p.muted, fontSize: 10, interval: (i: number) => load.t[i] % 120 === 0 }, name: 'time (s)', nameLocation: 'middle', nameGap: 22, nameTextStyle: { color: p.ink2, fontSize: 11 } },
    yAxis: valueAxis(p, { min: 0, max: 1, scale: false, axisLabel: { color: p.muted, fontSize: 10, formatter: (v: number) => `${Math.round(v * 100)} %` } }),
    series: keys.map((k, i) => ({
      name: names[k] ?? k, type: 'line', stack: 'mix', showSymbol: false, data: load.mix[k],
      lineStyle: { width: 0 }, areaStyle: { color: p.series[i % 8], opacity: 0.85 }, itemStyle: { color: p.series[i % 8] },
    })),
  };
};

/** one scaling group per line while there are at most 8; beyond that the 7 busiest and the rest in grey; the profile's phases shaded */
export const utilBuild = (tl: ServiceTimeline[], names: Map<string, string>, field: 'utilisation' | 'replicas' | 'ready', accent: (s: string) => string | null, ph: Phases = {}, end?: number): OptionBuilder => (p) => {
  const val = (x: ServiceTimeline) => (field === 'ready' ? x.ready ?? x.replicas : x[field]);
  const peak = (x: ServiceTimeline) => Math.max(...val(x));
  const sorted = [...tl].sort((a, b) => peak(b) - peak(a));
  const many = tl.length > 8;
  const shown = new Set((many ? sorted.slice(0, 7) : sorted).map((x) => x.service));
  const pods = field !== 'utilisation';
  return {
    ...chrome(p),
    grid: { left: 44, right: 16, top: 36, bottom: 30 },
    legend: legend(p, { data: tl.filter((x) => shown.has(x.service)).map((x) => names.get(x.service) ?? x.service) }),
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => `<div style="opacity:.7;margin-bottom:4px">t = ${ps[0].value[0]} s</div>` + ps.filter((x) => shown.has(x.seriesId)).sort((a, b) => b.value[1] - a.value[1]).map((x) => ttRow(x.color, pods ? fmt(x.value[1], 2) : fmtPct(x.value[1], 0), x.seriesName)).join('') },
    xAxis: valueAxis(p, { min: 0, max: end ?? ((tl[0]?.t[tl[0].t.length - 1] ?? 0) + 10), ...T, name: 'time (s)', nameLocation: 'middle', nameGap: 22 }),
    yAxis: valueAxis(p, !pods
      ? { min: 0, max: 1, scale: false, axisLabel: { color: p.muted, fontSize: 10, formatter: (v: number) => `${Math.round(v * 100)} %` } }
      : { min: 0, scale: false, minInterval: 1, name: field === 'ready' ? 'ready pods' : 'pods (ready + starting)', nameLocation: 'end', nameGap: 6, nameTextStyle: { align: 'left', color: p.muted, fontSize: 10 } }),
    series: tl.map((x, k) => {
      const c = shown.has(x.service) ? accent(x.service) ?? p.series[[...shown].indexOf(x.service) % 8] : p.muted;
      return {
        id: x.service, name: names.get(x.service) ?? x.service, type: 'line', showSymbol: false, step: pods ? 'end' : false,
        data: x.t.map((t, i) => [t, val(x)[i]]), lineStyle: { width: shown.has(x.service) ? 2 : 1, color: c, opacity: shown.has(x.service) ? 1 : 0.4 }, itemStyle: { color: c }, z: shown.has(x.service) ? 3 : 1,
        markArea: k === 0 ? phaseAreas(p, ph) : undefined,
        markLine: !pods && k === 0 ? { symbol: 'none', silent: true, data: [{ yAxis: 0.7, name: 'HPA target' }], lineStyle: { color: p.ink2, type: 'solid', width: 1, opacity: 0.5 }, label: { formatter: 'HPA target 70 %', color: p.ink2, fontSize: 10, position: 'insideEndTop' } } : undefined,
      };
    }),
  };
};

/** all scaling groups together: pods (ready + starting) and ready pods per bin */
export const podsBuild = (sides: { label: string; detail: DesignDetail; color: 'a' | 'b' }[], ph: Phases): OptionBuilder => (p) => {
  const end = Math.max(...sides.map((x) => x.detail.simulator.durationS));
  return {
    ...chrome(p),
    grid: { left: 44, right: 16, top: 34, bottom: 30 },
    legend: legend(p),
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => `<div style="opacity:.7;margin-bottom:4px">t = ${ps[0].value[0]} s</div>` + ps.map((x) => ttRow(x.color, fmt(x.value[1], 1), x.seriesName, /ready/.test(x.seriesName))).join('') },
    xAxis: valueAxis(p, { min: 0, max: end, ...T, name: 'time (s)', nameLocation: 'middle', nameGap: 22 }),
    yAxis: valueAxis(p, { min: 0, scale: false, minInterval: 1, name: 'pods, all groups', nameLocation: 'end', nameGap: 6, nameTextStyle: { align: 'left', color: p.muted, fontSize: 10 } }),
    series: sides.flatMap((x, i) => [
      { name: `${x.label} pods`, type: 'line', step: 'end', showSymbol: false, data: x.detail.hpa.t.map((t, j) => [t, x.detail.hpa.pods[j]]), lineStyle: { width: 2, color: col(p, x) }, itemStyle: { color: col(p, x) }, markArea: i === 0 ? phaseAreas(p, ph) : undefined },
      { name: `${x.label} ready`, type: 'line', step: 'end', showSymbol: false, data: x.detail.hpa.t.map((t, j) => [t, x.detail.hpa.ready[j]]), lineStyle: { width: 1.5, color: col(p, x), type: 'dashed' }, itemStyle: { color: col(p, x) } },
    ]),
  };
};

/** per-bin utilisation of the resources C2 checks (database servers, broker): the busiest few, against the limit */
export const capacityBuild = (d: DesignDetail, limit: number, ph: Phases, top = 6): OptionBuilder => (p) => {
  const rs = d.resources.filter((r) => r.peakCapacity && r.utilisationOverTime).sort((a, b) => (b.maxBinUtilisation ?? 0) - (a.maxBinUtilisation ?? 0)).slice(0, top);
  return {
    ...chrome(p),
    grid: { left: 44, right: 16, top: 36, bottom: 30 },
    legend: legend(p),
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => `<div style="opacity:.7;margin-bottom:4px">t = ${ps[0].value[0]} s</div>` + [...ps].sort((a, b) => b.value[1] - a.value[1]).map((x) => ttRow(x.color, fmtPct(x.value[1], 1), x.seriesName)).join('') },
    xAxis: valueAxis(p, { min: 0, max: d.simulator.durationS, ...T, name: 'time (s)', nameLocation: 'middle', nameGap: 22 }),
    yAxis: valueAxis(p, { min: 0, max: Math.max(1, limit), scale: false, axisLabel: { color: p.muted, fontSize: 10, formatter: (v: number) => `${Math.round(v * 100)} %` } }),
    series: rs.map((r, i) => ({
      name: r.label.replace(/ CPU$/, ''), type: 'line', showSymbol: false, data: r.t!.map((t, j) => [t, r.utilisationOverTime![j]]), lineStyle: { width: 2, color: p.series[i % 8] }, itemStyle: { color: p.series[i % 8] },
      markArea: i === 0 ? phaseAreas(p, ph) : undefined,
      markLine: i === 0 ? { symbol: 'none', silent: true, data: [{ yAxis: limit }], lineStyle: { color: p.critical, type: 'solid', width: 1 }, label: { formatter: `C2 limit ${fmtPct(limit, 0)}`, color: p.ink2, fontSize: 10, position: 'insideEndTop' } } : undefined,
    })),
  };
};
