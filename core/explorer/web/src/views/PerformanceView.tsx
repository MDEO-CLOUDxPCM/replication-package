import { useMemo, useState, memo } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search } from 'lucide-react';
import type { Design, DesignDetail, ResponseStats, Run } from '@contract/types';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ChartCard } from '@/components/ChartCard';
import { Loading, Problem, Empty } from '@/components/States';
import { budgetBuild, capacityBuild, cdfBuild, histBuild, mixBuild, overTimeBuild, podsBuild, utilBuild, type Phases, type Side } from '@/charts/perfCharts';
import { useDesign, useDetail, useDomain, useRun } from '@/lib/api';
import { PALETTES, serviceAccent } from '@/lib/palette';
import { useMaySimulate, usePatchUrl, useUrlParams } from '@/lib/useWorkspace';
import type { DesignRef } from '@/lib/workspace';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTheme } from '@/lib/theme';
import { fmt, fmtMs, fmtPct, slugless } from '@/lib/format';
import { useTexts } from '@/lib/packet';
import { cn } from '@/lib/utils';
import { MetricHelp } from '@/help/MetricHelp';
import { ModelJump } from '@/help/ModelJump';

type Tab = 'requests' | 'operations' | 'sessions' | 'services' | 'resources';
/** the performance panel's URL parameters */
const PERF_KEYS = ['ptab', 'key', 'm'] as const;

interface Loaded { r: { runId: string; designId: string }; run: Run; design: Design; detail: DesignDetail; status: string }

function useLoaded(r: DesignRef | null) {
  const run = useRun(r?.runId);
  const design = useDesign(r?.runId, r?.designId);
  const simulate = useMaySimulate();
  const detail = useDetail(r?.runId, r?.designId, simulate);
  const loaded: Loaded | null = r && run.data && design.data && detail.data ? { r, run: run.data, design: design.data, detail: detail.data, status: detail.data.origin } : null;
  return { r, simulate, loaded, loading: !!r && (run.isLoading || design.isLoading || detail.isLoading), error: run.error ?? design.error ?? detail.error };
}

const label = (d: Design) => d.label ?? d.id.slice(0, 10);
const statOf = (r: ResponseStats | undefined, stat: string) => (r ? r.statisticMs ?? (stat === 'mean' ? r.meanMs : stat === 'p50' ? r.p50Ms : stat === 'p90' ? r.p90Ms : r.p95Ms) : undefined);
const phasesOf = (d: DesignDetail): Phases => ({ phases: d.phases, warmupS: d.simulator.warmupS });

function StatTable({ rows, names, selected, onSelect, two, modelKind, stat, budgets }: { rows: { key: string; a: ResponseStats; b?: ResponseStats }[]; names: (k: string) => string; selected: string | null; onSelect: (k: string) => void; two: boolean; modelKind: string; stat: string; budgets: boolean }) {
  const [q, setQ] = useState('');
  const shown = rows.filter((r) => !q || names(r.key).toLowerCase().includes(q.toLowerCase()));
  const idx = shown.findIndex((r) => r.key === selected);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const j = Math.max(0, Math.min(shown.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      if (shown[j]) onSelect(shown[j].key);
    }
  };
  const over = (s?: ResponseStats) => !!s?.budgetMs && (statOf(s, stat) ?? 0) > s.budgetMs;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative border-b p-2">
        <Search className="absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${rows.length}`} className="h-8 pl-7 text-xs" />
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportProps={{ tabIndex: 0, onKeyDown: onKey, role: 'listbox', 'aria-label': 'Load items' }}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card text-left text-[11px] text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-1.5 font-medium">name</th>
              <th className="pl-2 text-right font-medium">count</th>
              {two ? <><th className="pl-2 text-right font-medium">{stat} A</th><th className="pl-2 text-right font-medium">{stat} B</th></>
                : <><th className="pl-2 text-right font-medium">mean</th><th className="pl-2 text-right font-medium">{stat === 'mean' ? 'p95' : stat}</th></>}
              <th className="pl-2 pr-3 text-right font-medium">{budgets ? 'budget' : 'p99'}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} role="option" aria-selected={r.key === selected} onClick={() => onSelect(r.key)}
                className={cn('group cursor-pointer border-b border-border/50 hover:bg-accent/60', r.key === selected && 'bg-accent')}>
                <td className="max-w-[14rem] px-3 py-1.5" title={r.key}><span className="flex items-center gap-1"><span className="truncate">{names(r.key)}</span><ModelJump target={`${modelKind}:${r.key}`} /></span></td>
                <td className="text-right tabular text-muted-foreground">{fmt(r.a.count, 0)}</td>
                {two ? <>
                  <td className={cn('text-right tabular', over(r.a) && 'font-semibold text-[var(--status-critical)]')}>{fmt(statOf(r.a, stat), 1)}</td>
                  <td className={cn('text-right tabular', over(r.b) && 'font-semibold text-[var(--status-critical)]')}>{r.b ? fmt(statOf(r.b, stat), 1) : '–'}</td>
                </> : <>
                  <td className="text-right tabular">{fmt(r.a.meanMs, 1)}</td>
                  <td className={cn('text-right tabular', over(r.a) && 'font-semibold text-[var(--status-critical)]')}>{fmt(stat === 'mean' ? r.a.p95Ms : statOf(r.a, stat), 1)}</td>
                </>}
                <td className="pr-3 text-right tabular text-muted-foreground">{budgets ? (r.a.budgetMs ? fmt(r.a.budgetMs, 1) : '–') : fmt(r.a.p99Ms, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
      <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">times in ms over the measured window{budgets ? ` · red: ${stat} above C1's budget` : ''} · ↑ ↓ to move</div>
    </div>
  );
}

function SideChip({ L, slot }: { L: Loaded; slot: 'a' | 'b' }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-xs">
      <span className={cn('grid size-5 place-items-center rounded-full text-[10px] font-bold text-white', slot === 'a' ? 'bg-select-a' : 'bg-select-b')}>{slot.toUpperCase()}</span>
      <span className="font-medium">{label(L.design)}</span>
      <span className="text-muted-foreground">{L.run.name}</span>
      <Badge variant={L.status === 'simulated' ? 'secondary' : 'outline'} className="h-5 text-[10px]" title={L.detail.simulator.name}>{L.status}</Badge>
    </div>
  );
}

/** the simulation as the search evaluated it: status, and C1/C2 of this simulation against the design's values */
function Consistency({ L }: { L: Loaded }) {
  const d = L.detail, st = d.status;
  const ev = L.run.config.evaluation;
  const tx = useTexts();
  const ci = (k: string) => L.run.constraints.findIndex((c) => c.key === k);
  const iC1 = ci('latencyBudget'), iC2 = ci('peakCapacity');
  const same = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
  const c1 = d.constraints?.latencyBudget, c2 = d.constraints?.peakCapacity;
  const s1 = L.design.constraints[iC1], s2 = L.design.constraints[iC2];
  const versionDiffers = !!ev?.pluginVersion && !!d.simulator.version && ev.pluginVersion !== d.simulator.version;
  // the reported metrics the search kept (references and the final population): C2's quantity and the peak pods
  const peakBin = Math.max(0, ...d.resources.filter((r) => r.peakCapacity).map((r) => r.maxBinUtilisation ?? 0));
  const pu = L.design.metrics.peakUtilisation, pp = L.design.metrics.peakPods;
  const metricsDiffer = (pu !== undefined && !same(pu, peakBin)) || (pp !== undefined && !same(pp, d.hpa.peakPods));
  const equal = same(c1, s1) && same(c2, s2) && !versionDiffers && !metricsDiffer;
  const bad = st.failed || st.capped || st.timedOut;
  return (
    <div className="space-y-1.5">
      {bad && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--status-critical)]/40 bg-[var(--status-critical)]/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--status-critical)]" />
          <span><b>{label(L.design)}: simulation {st.capped ? 'capped' : st.timedOut ? 'timed out' : 'failed'}</b>{st.message ? ` — ${st.message}` : ''}. The design is infeasible (C1 1000, C2 1); the figures below are what was measured until the stop.</span>
        </div>
      )}
      <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border px-3 py-1.5 text-[11.5px]', equal ? 'text-muted-foreground' : 'border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10')}>
        {equal ? <CheckCircle2 className="size-3.5 text-[var(--status-good)]" /> : <AlertTriangle className="size-3.5 text-[var(--status-warning)]" />}
        <span className="font-medium text-foreground">{label(L.design)}</span>
        <span>{d.model === 'as evaluated' ? 'the model the search evaluated' : d.model === 'rebuilt' ? 'rebuilt from the seed and its decision links' : 'simulated'}, the search's request</span>
        <span>· C1 here {fmt(c1, 3)} / search {fmt(s1, 3)} · C2 here {fmt(c2, 3)} / search {fmt(s2, 3)}</span>
        {pu !== undefined && <span>· peak bin utilisation here {fmt(peakBin, 4)} / search {fmt(pu, 4)}</span>}
        {pp !== undefined && <span>· peak pods here {fmt(d.hpa.peakPods, 0)} / search {fmt(pp, 0)}</span>}
        {versionDiffers && <span>· plugin {d.simulator.version} (the run: {ev?.pluginVersion})</span>}
        {!equal && !versionDiffers && <span>· {tx('perf.consistency.indicative') || 'this simulation is not exactly the one the search ran: its figures are indicative'}</span>}
        <MetricHelp k="perf.status" className="ml-auto" />
      </div>
    </div>
  );
}

function Tiles({ A, B }: { A: Loaded; B: Loaded | null }) {
  const ev = A.run.config.evaluation;
  const reqMean = (d: DesignDetail) => { const t = d.requests.reduce((s, x) => s + x.count, 0) || 1; return d.requests.reduce((s, x) => s + x.meanMs * x.count, 0) / t; };
  const peakBin = (d: DesignDetail) => Math.max(0, ...d.resources.filter((r) => r.peakCapacity).map((r) => r.maxBinUtilisation ?? 0));
  const over = (d: DesignDetail) => d.requests.filter((r) => r.budgetMs && (r.statisticMs ?? 0) > r.budgetMs).length;
  const items: [string, (d: DesignDetail) => string, string | undefined, string][] = [
    ['C1 of this simulation', (d) => fmt(d.constraints?.latencyBudget, 2), `${ev?.latency.statistic ?? 'p95'} vs budget · ${over(A.detail)} of ${A.detail.requests.filter((r) => r.budgetMs).length} over${B ? ` / ${over(B.detail)}` : ''}`, 'perf.latencyBudget'],
    ['Peak bin utilisation', (d) => fmtPct(peakBin(d), 0), `databases, broker · C2 limit ${fmtPct(ev?.peakCapacity.limit, 0)}`, 'perf.peakCapacity'],
    ['Requests simulated', (d) => fmt(d.requests.reduce((s, r) => s + r.count, 0), 0), `window ${A.detail.simulator.warmupS ?? 0}–${A.detail.simulator.durationS} s`, 'perf.requests'],
    ['Mean response time', (d) => fmtMs(reqMean(d)), 'request types, count-weighted', 'perf.responseTime'],
    ['Peak pods', (d) => fmt(d.hpa.peakPods, 0), `created ${A.detail.hpa.createdPods}${B ? ` / ${B.detail.hpa.createdPods}` : ''} · rescales ${A.detail.hpa.rescales}${B ? ` / ${B.detail.hpa.rescales}` : ''}`, 'perf.pods'],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @4xl:grid-cols-5">
      {items.map(([l, f, h, k]) => (
        <div key={l} className="rounded-lg border bg-card px-3 py-2">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">{l}<MetricHelp k={k} className="ml-auto" /></div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="flex items-center gap-1 text-base font-semibold">{B && <span className="size-2 rounded-full bg-select-a" />}{f(A.detail)}</span>
            {B && <span className="flex items-center gap-1 text-base font-semibold"><span className="size-2 rounded-full bg-select-b" />{f(B.detail)}</span>}
          </div>
          {h && <div className="text-[10.5px] text-muted-foreground">{h}</div>}
        </div>
      ))}
    </div>
  );
}

/** the performance panel: the simulation of A (and B) as the search evaluated it */
export default memo(function PerformanceView({ a, b }: { a: DesignRef; b: DesignRef | null }) {
  const sp = useUrlParams(PERF_KEYS);
  const set = usePatchUrl();
  const A = useLoaded(a);
  const B = useLoaded(b);
  const { data: domain } = useDomain(A.loaded?.run.domainId);
  const { theme } = useTheme();
  const tab = (sp.get('ptab') as Tab) ?? 'requests';
  const stat = A.loaded?.run.config.evaluation?.latency.statistic ?? 'p95';
  const metric = (sp.get('m') as 'p95Ms' | 'meanMs') ?? (stat === 'mean' ? 'meanMs' : 'p95Ms');

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of domain?.operations ?? []) m.set(o.id, o.name);
    for (const r of domain?.requests ?? []) m.set(r.id, r.name);
    for (const s of domain?.sessions ?? []) m.set(s.id, s.name);
    return m;
  }, [domain]);

  const listKey = tab === 'operations' ? 'operations' : tab === 'sessions' ? 'sessions' : 'requests';
  const rows = useMemo(() => {
    if (!A.loaded) return [];
    const bm = new Map((B.loaded?.detail[listKey] ?? []).map((x) => [x.key, x]));
    const ratio = (x: ResponseStats) => (x.budgetMs ? (x.statisticMs ?? 0) / x.budgetMs : -1);
    return [...A.loaded.detail[listKey]].sort((x, y) => (listKey === 'requests' ? ratio(y) - ratio(x) : 0) || y.count - x.count).map((a) => ({ key: a.key, a, b: bm.get(a.key) }));
  }, [A.loaded, B.loaded, listKey]);
  const key = sp.get('key') && rows.some((r) => r.key === sp.get('key')) ? sp.get('key')! : rows[0]?.key ?? null;
  const budgetRows = useMemo(() => {
    if (!A.loaded) return [];
    const bm = new Map((B.loaded?.detail.requests ?? []).map((x) => [x.key, x]));
    return A.loaded.detail.requests.map((x) => ({ key: x.key, label: names.get(x.key) ?? x.key, a: x, b: bm.get(x.key) }));
  }, [A.loaded, B.loaded, names]);

  if (A.loading || B.loading) return <Loading label={A.simulate ? 'Loading or simulating the design (one SimOxide run, as the search evaluated it)' : "Loading the design's performance detail"} />;
  if (A.error || !A.loaded) return <Problem title="No performance detail">{String(A.error ?? 'not available')}</Problem>;
  const La = A.loaded, Lb = B.loaded;
  const ev = La.run.config.evaluation;
  const row = rows.find((r) => r.key === key);
  const sides: Side[] = row ? [{ label: `A ${label(La.design)}`, stats: row.a, detail: La.detail, color: 'a' }, ...(Lb && row.b ? [{ label: `B ${label(Lb.design)}`, stats: row.b, detail: Lb.detail, color: 'b' as const }] : [])] : [];
  const nm = (k: string) => names.get(k) ?? slugless(k);
  const exportBase = `perf-${label(La.design)}${Lb ? `-vs-${label(Lb.design)}` : ''}`;
  const svcName = (L: Loaded) => { const m = new Map(L.design.decisions?.services.map((s) => [s.id, s.name]) ?? []); return new Map(L.detail.services.map((s) => [s.service, m.get(s.service) ?? s.label ?? s.service])); };
  const svcAccent = (L: Loaded) => (s: string) => { const i = L.design.decisions?.services.findIndex((x) => x.id === s) ?? -1; return i < 0 ? null : serviceAccent(PALETTES[theme], i, L.design.decisions?.services.length ?? 99); };
  const sessionNames = Object.fromEntries((domain?.sessions ?? []).map((s) => [s.id, s.name]));
  const ph = phasesOf(La.detail);
  const both = [La, ...(Lb ? [Lb] : [])];
  const sideOf = (L: Loaded, i: number) => ({ label: `${i ? 'B' : 'A'} ${label(L.design)}`, detail: L.detail, color: (i ? 'b' : 'a') as 'a' | 'b' });

  return (
    <ScrollArea className="h-full">
    <div className="mx-auto max-w-[1700px] space-y-4 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SideChip L={La} slot="a" />
        {Lb && <SideChip L={Lb} slot="b" />}
        {B.r && !Lb && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> B…</span>}
        <span className="ml-auto text-xs text-muted-foreground">SimOxide (Palladio semantics, SPD + HPA){La.detail.simulator.version ? ` · plugin ${La.detail.simulator.version}` : ''} · {La.detail.simulator.profile ?? ev?.profile} profile · window {La.detail.simulator.warmupS}–{La.detail.simulator.durationS} s · seed {La.detail.simulator.seed}</span>
      </div>
      {both.map((L) => <Consistency key={L.design.id} L={L} />)}
      {Lb && Lb.run.config.evaluation?.profile !== ev?.profile && <Problem title="A and B were evaluated under different load profiles">{ev?.profile} vs {Lb.run.config.evaluation?.profile}: their figures do not compare.</Problem>}
      <Tiles A={La} B={Lb} />
      <div className="grid gap-4 @4xl:grid-cols-2">
        <ChartCard title={`C1: ${stat} per request type against its budget`} subtitle={`${budgetRows.filter((r) => r.a?.budgetMs).length} request types with a budget (${ev?.latency.factor ?? '?'} × today's ${stat} under the ${ev?.profile} profile); red bars add to C1`} build={budgetBuild(budgetRows, stat)} exportName={`${exportBase}-budgets`} height={Math.max(240, 16 * budgetRows.filter((r) => r.a?.budgetMs).length + 50)} />
        <div className="space-y-4">
          <ChartCard title="Pods over the load profile" subtitle="SimOxide's HPA, all scaling groups: pods (ready + starting) and ready; phases of the profile shaded, warm-up not measured" build={podsBuild(both.map(sideOf), ph)} exportName={`${exportBase}-pods`} height={220} />
          <ChartCard title="Session mix over time" subtitle={`${La.detail.load.label}: share of the sessions started`} build={mixBuild(La.detail.load, sessionNames)} exportName={`${exportBase}-mix`} height={190} />
        </div>
      </div>
      <Tabs value={tab} onValueChange={(v) => set({ ptab: v === 'requests' ? null : v, key: null })}>
        <TabsList>
          <TabsTrigger value="requests" className="cursor-pointer">Request types</TabsTrigger>
          <TabsTrigger value="operations" className="cursor-pointer">Operations</TabsTrigger>
          <TabsTrigger value="sessions" className="cursor-pointer">Sessions</TabsTrigger>
          <TabsTrigger value="services" className="cursor-pointer">Scaling groups</TabsTrigger>
          <TabsTrigger value="resources" className="cursor-pointer">Databases and broker</TabsTrigger>
        </TabsList>
      </Tabs>
      {(tab === 'requests' || tab === 'operations' || tab === 'sessions') && (
        <div className="grid gap-4 @4xl:grid-cols-[minmax(360px,34%)_minmax(0,1fr)]">
          <Card className="h-[640px] gap-0 overflow-hidden p-0"><StatTable rows={rows} names={nm} selected={key} onSelect={(k) => set({ key: k })} two={!!Lb} modelKind={tab === 'operations' ? 'op' : tab === 'sessions' ? 'session' : 'req'} stat={stat} budgets={tab === 'requests'} /></Card>
          {row ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                <span className="flex items-center gap-1 text-base font-semibold">{nm(row.key)}<ModelJump always target={`${tab === 'operations' ? 'op' : tab === 'sessions' ? 'session' : 'req'}:${row.key}`} title="in the Model panel: what it is and how it expands" /></span>
                {([['mean', 'meanMs'], ['p50', 'p50Ms'], ['p90', 'p90Ms'], ['p95', 'p95Ms'], ['p99', 'p99Ms']] as const).map(([l, f]) => (
                  <span key={l} className={cn('text-xs text-muted-foreground', tab === 'requests' && l === stat && 'rounded bg-muted px-1')}>{l} <b className="text-foreground">{fmtMs(row.a[f])}</b>{row.b && <> / <b className="text-foreground">{fmtMs(row.b[f])}</b></>}</span>
                ))}
                {tab === 'requests' && (row.a.budgetMs
                  ? <span className={cn('text-xs', (row.a.statisticMs ?? 0) > row.a.budgetMs ? 'font-medium text-[var(--status-critical)]' : 'text-muted-foreground')}>C1 budget {fmtMs(row.a.budgetMs)} ({stat}) · {fmt((row.a.statisticMs ?? 0) / row.a.budgetMs, 2)}×{row.b?.budgetMs ? ` / ${fmt((row.b.statisticMs ?? 0) / row.b.budgetMs, 2)}×` : ''}</span>
                  : <span className="text-xs text-muted-foreground">no C1 budget (too few completions in today's reference run)</span>)}
              </div>
              <div className="grid gap-4 @6xl:grid-cols-2">
                <ChartCard title="Response-time distribution (CDF)" subtitle="share of the window's completions at or below a time, log scale" build={cdfBuild(sides, tab === 'requests' ? stat : 'p95')} exportName={`${exportBase}-${row.key}-cdf`} height={240} />
                <ChartCard title="Histogram" subtitle="log-spaced bins of the simulation, share of completions" build={histBuild(sides)} exportName={`${exportBase}-${row.key}-histogram`} height={240} />
              </div>
              <ChartCard title="Over the load profile" subtitle={`top: sessions started per second · bottom: response time per bin (completion time); phases shaded${tab === 'requests' && row.a.budgetMs ? '; C1 compares the window\'s statistic with the budget' : ''}`} build={overTimeBuild(La.detail.load, sides, metric, ph, tab === 'requests' && ((metric === 'p95Ms' && stat === 'p95') || (metric === 'meanMs' && stat === 'mean')) ? row.a.budgetMs : undefined)} exportName={`${exportBase}-${row.key}-over-time`} height={320}
                actions={<ToggleGroup type="single" size="sm" variant="outline" value={metric} onValueChange={(v) => v && set({ m: v === (stat === 'mean' ? 'meanMs' : 'p95Ms') ? null : v })}><ToggleGroupItem value="p95Ms" className="h-7 cursor-pointer px-2 text-xs">p95</ToggleGroupItem><ToggleGroupItem value="meanMs" className="h-7 cursor-pointer px-2 text-xs">mean</ToggleGroupItem></ToggleGroup>} />
            </div>
          ) : <Empty>No data.</Empty>}
        </div>
      )}
      {tab === 'services' && (
        <div className={cn('grid gap-4', Lb && '@4xl:grid-cols-2')}>
          {both.map((L, i) => (
            <div key={i} className="space-y-4">
              <ChartCard title={`${Lb ? (i ? 'B ' : 'A ') : ''}Pods per scaling group`} subtitle={`${label(L.design)}: pods (ready + starting) per bin, SimOxide's HPA`} build={utilBuild(L.detail.services, svcName(L), 'replicas', svcAccent(L), phasesOf(L.detail), L.detail.simulator.durationS)} exportName={`perf-${label(L.design)}-pods`} height={240} />
              <ChartCard title={`${Lb ? (i ? 'B ' : 'A ') : ''}CPU utilisation per ready pod`} subtitle={`${label(L.design)}: what the HPA measures against its target`} build={utilBuild(L.detail.services, svcName(L), 'utilisation', svcAccent(L), phasesOf(L.detail), L.detail.simulator.durationS)} exportName={`perf-${label(L.design)}-utilisation`} height={240} />
              <Card className="gap-0 py-0">
                <div className="px-4 pt-3 text-sm font-semibold">{Lb ? `${i ? 'B' : 'A'} ` : ''}HPA activity <span className="font-normal text-muted-foreground">{label(L.design)} · window means</span></div>
                <table className="m-2 text-xs">
                  <thead className="text-left text-[11px] text-muted-foreground"><tr><th className="px-2 py-1 font-medium">group</th><th className="px-2 text-right font-medium">cores/pod</th><th className="px-2 text-right font-medium">mean ready</th><th className="px-2 text-right font-medium">peak ready</th><th className="px-2 text-right font-medium">rescales</th><th className="px-2 text-right font-medium">created</th></tr></thead>
                  <tbody>
                    {[...L.detail.services].sort((x, y) => (y.meanReady ?? 0) - (x.meanReady ?? 0)).map((g) => (
                      <tr key={g.service} className="border-t border-border/50">
                        <td className="px-2 py-1">{svcName(L).get(g.service) ?? g.service}</td>
                        <td className="px-2 text-right tabular">{fmt(g.cores, 1)}</td>
                        <td className="px-2 text-right tabular">{fmt(g.meanReady, 2)}</td>
                        <td className="px-2 text-right tabular">{fmt(g.peakReady, 0)}</td>
                        <td className="px-2 text-right tabular">{fmt(g.rescales, 0)}</td>
                        <td className="px-2 text-right tabular">{fmt(g.createdPods, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ))}
        </div>
      )}
      {tab === 'resources' && (
        <div className={cn('grid gap-4', Lb && '@4xl:grid-cols-2')}>
          {both.map((L, i) => {
            const limit = L.run.config.evaluation?.peakCapacity.limit ?? 1;
            return (
              <div key={i} className="space-y-4">
                <ChartCard title={`${Lb ? (i ? 'B ' : 'A ') : ''}Utilisation per bin: databases and broker`} subtitle={`${label(L.design)}: the six busiest of the containers C2 checks, ${L.detail.simulator.binS}-s bins, against the limit`} build={capacityBuild(L.detail, limit, phasesOf(L.detail))} exportName={`perf-${label(L.design)}-capacity`} height={250} />
                <Card className="gap-0 py-0">
                  <div className="px-4 pt-3 text-sm font-semibold">{Lb ? `${i ? 'B' : 'A'} ` : ''}Resources that do not scale <span className="font-normal text-muted-foreground">{label(L.design)}</span></div>
                  <table className="m-2 text-xs">
                    <thead className="text-left text-[11px] text-muted-foreground"><tr><th className="px-2 py-1 font-medium">resource</th><th className="px-2 font-medium">kind</th><th className="px-2 text-right font-medium">mean</th><th className="px-2 text-right font-medium">peak bin</th><th className="px-2 text-right font-medium">wait</th></tr></thead>
                    <tbody>
                      {[...L.detail.resources].sort((x, y) => (y.maxBinUtilisation ?? y.utilisation) - (x.maxBinUtilisation ?? x.utilisation)).map((r) => {
                        const pk = r.maxBinUtilisation ?? r.utilisation;
                        return (
                          <tr key={r.id} className="border-t border-border/50">
                            <td className="px-2 py-1">{r.label}{r.peakCapacity && <span className="ml-1 text-[10px] text-muted-foreground">C2</span>}</td>
                            <td className="px-2 text-muted-foreground">{r.kind}</td>
                            <td className="px-2 text-right tabular">{fmtPct(r.utilisation, 1)}</td>
                            <td className="px-2 text-right tabular">
                              <span className="inline-flex items-center gap-2"><span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, pk * 100)}%`, background: r.peakCapacity && pk > limit ? 'var(--status-critical)' : pk > 0.7 ? 'var(--status-warning)' : 'var(--series-1)' }} /></span>{fmtPct(pk, 0)}</span>
                            </td>
                            <td className="px-2 text-right tabular">{r.waitMs !== undefined ? fmtMs(r.waitMs) : '–'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </div>
    </ScrollArea>
  );
});
