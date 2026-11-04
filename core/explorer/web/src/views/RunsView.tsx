import { useMemo, memo } from 'react';
import { ArrowRight, FlaskConical, Server, Cpu } from 'lucide-react';
import type { Run, RunSummary } from '@contract/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChartCard } from '@/components/ChartCard';
import { Stat } from '@/components/Stat';
import { MetricHelp } from '@/help/MetricHelp';
import { Loading, Problem, Empty } from '@/components/States';
import { useIndex, useRun } from '@/lib/api';
import { usePanelAvailable, workspaceActions as ws } from '@/lib/useWorkspace';
import { fmt, fmtDate, fmtDuration, compact } from '@/lib/format';
import { chrome, valueAxis, legend, ttRow, categoryAxis } from '@/charts/base';
import type { OptionBuilder } from '@/charts/EChart';
import { quantile, bins } from '@/lib/stats';
import { minForm } from '@contract/pareto';
import { cn } from '@/lib/utils';

const sourceIcon = { headless: Cpu, mdeo: Server, bundle: FlaskConical };

function RunRow({ r, active, onSelect }: { r: RunSummary; active: boolean; onSelect: () => void }) {
  const Icon = sourceIcon[r.source.kind];
  return (
    <button onClick={onSelect} className={cn('w-full rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring outline-none', active ? 'border-ring/60 bg-accent/70' : 'bg-card')} aria-current={active}>
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="line-clamp-2 text-sm font-medium leading-snug" title={r.name}>{r.name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmtDate(r.createdAt).split(',')[0]}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{r.problem}</Badge>
        <span>{r.populationSize} × {r.generations}</span>
        <span>· {compact(r.designCount)} designs</span>
        {r.finalHypervolume !== undefined && <span>· HV {fmt(r.finalHypervolume, 3)}</span>}
        {r.source.synthetic && <Badge variant="outline" className="h-5 px-1.5 text-[11px]">synthetic</Badge>}
      </div>
    </button>
  );
}

function hvBuild(run: Run): OptionBuilder {
  return (p) => {
    const hv = run.hypervolume!;
    const gens = run.history.length ? run.history.map((g) => g.index) : hv.population.map((_, i) => i);
    const first = gens[0] ?? 0, last = gens.at(-1) ?? 1;
    const series: any[] = [
      { name: 'Population', type: 'line', data: hv.population.map((v, i) => [gens[i] ?? i, v]), connectNulls: true, showSymbol: hv.population.filter((v) => v !== null).length < 3, symbolSize: 8, lineStyle: { width: 2, color: p.series[0] }, itemStyle: { color: p.series[0] } },
    ];
    if (hv.archive) series.push({ name: 'Archive', type: 'line', data: hv.archive.map((v, i) => [gens[i] ?? i, v]), connectNulls: true, showSymbol: false, lineStyle: { width: 2, color: p.series[1] }, itemStyle: { color: p.series[1] } });
    return {
      ...chrome(p),
      grid: { left: 48, right: 16, top: 30, bottom: 36 },
      legend: legend(p),
      tooltip: { ...chrome(p).tooltip, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: p.axis } },
        formatter: (ps: any[]) => `<div style="margin-bottom:4px;opacity:.7">generation ${ps[0].value[0]}</div>` + ps.filter((x) => x.value[1] !== null).map((x) => ttRow(x.color, fmt(x.value[1], 4), x.seriesName)).join('') },
      xAxis: valueAxis(p, { name: 'generation', nameLocation: 'middle', scale: false, min: first, max: Math.max(first + 1, last), splitLine: { show: false } }),
      yAxis: valueAxis(p, { name: 'hypervolume', nameLocation: 'middle', nameGap: 36, scale: false, min: 0 }),
      series,
    };
  };
}

/** per objective: best and median of the feasible population, with the p10–p90 band */
function convergenceBuild(run: Run, k: number): OptionBuilder {
  // the statistics once, not per option build (a resize builds the option again)
  const dir = run.objectives[k].direction;
  const rows = run.history.map((g) => {
    const v = g.population.filter((x) => x.c.every((c) => c <= 1e-12)).map((x) => x.o[k]).sort((a, b) => a - b);
    if (!v.length) return [g.index, null, null, null, null];
    return [g.index, dir === 'minimize' ? v[0] : v[v.length - 1], quantile(v, 0.5), quantile(v, 0.1), quantile(v, 0.9)];
  });
  return (p) => {
    const unit = run.objectives[k].unit;
    return {
      ...chrome(p),
      grid: { left: 52, right: 12, top: 26, bottom: 30 },
      legend: legend(p, { data: ['best', 'median'] }),
      tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => {
        const r = rows[ps[0].dataIndex];
        return `<div style="opacity:.7;margin-bottom:4px">generation ${r[0]}</div>${ttRow(p.series[0], fmt(r[1] as number, run.objectives[k].digits ?? 2), 'best')}${ttRow(p.series[0], fmt(r[2] as number, run.objectives[k].digits ?? 2), 'median', true)}<div style="opacity:.7">p10–p90 ${fmt(r[3] as number, 2)} – ${fmt(r[4] as number, 2)}</div>`;
      } },
      xAxis: categoryAxis(p, { data: rows.map((r) => r[0]), boundaryGap: false }),
      yAxis: valueAxis(p, { name: unit, nameGap: 8, nameLocation: 'end', nameTextStyle: { align: 'left', color: p.muted } }),
      series: [
        { name: 'p10', type: 'line', data: rows.map((r) => r[3]), stack: 'band', lineStyle: { opacity: 0 }, showSymbol: false, silent: true },
        { name: 'band', type: 'line', data: rows.map((r) => (r[4] === null ? null : (r[4] as number) - (r[3] as number))), stack: 'band', lineStyle: { opacity: 0 }, areaStyle: { color: p.series[0], opacity: 0.1 }, showSymbol: false, silent: true },
        { name: 'median', type: 'line', data: rows.map((r) => r[2]), showSymbol: false, lineStyle: { width: 1.5, type: 'dashed', color: p.series[0] }, itemStyle: { color: p.series[0] } },
        { name: 'best', type: 'line', data: rows.map((r) => r[1]), showSymbol: false, lineStyle: { width: 2, color: p.series[0] }, itemStyle: { color: p.series[0] } },
      ],
    };
  };
}

/** final distribution of an objective over the run's designs (feasible), with reference designs marked */
function distributionBuild(run: Run, values: number[], refs: { label: string; v: number }[], k: number): OptionBuilder {
  const b = bins(values, 22);
  return (p) => {
    const d = run.objectives[k];
    return {
      ...chrome(p),
      grid: { left: 40, right: 12, top: 18, bottom: 30 },
      tooltip: { ...chrome(p).tooltip, trigger: 'item', formatter: (x: any) => `<b>${x.value[2]}</b> designs<div style="opacity:.7">${fmt(x.value[0], d.digits ?? 2)} – ${fmt(x.value[1], d.digits ?? 2)}${d.unit ? ' ' + d.unit : ''}</div>` },
      xAxis: valueAxis(p, { scale: true, splitLine: { show: false } }),
      yAxis: valueAxis(p, { scale: false, minInterval: 1 }),
      series: [{
        type: 'custom',
        renderItem: (_: any, api: any) => {
          const x0 = api.coord([api.value(0), 0]), x1 = api.coord([api.value(1), api.value(2)]);
          const w = Math.max(1, x1[0] - x0[0] - 2);
          return { type: 'rect', shape: { x: x0[0] + 1, y: x1[1], width: w, height: x0[1] - x1[1], r: [3, 3, 0, 0] }, style: { fill: p.series[0] } };
        },
        encode: { x: [0, 1], y: 2 },
        data: b.map((x) => [x.x0, x.x1, x.count]),
        markLine: refs.length ? { symbol: 'none', silent: true, lineStyle: { color: p.ink2, type: 'solid', width: 1 }, label: { formatter: '{b}', color: p.ink2, fontSize: 10, position: 'insideEndTop' }, data: refs.map((r) => ({ name: r.label, xAxis: r.v })) } : undefined,
      }],
    };
  };
}

function timingBuild(run: Run): OptionBuilder {
  return (p) => ({
    ...chrome(p),
    grid: { left: 48, right: 12, top: 18, bottom: 30 },
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => `<div style="opacity:.7">generation ${ps[0].name}</div>${ttRow(p.series[0], fmtDuration(ps[0].value), 'evaluation time')}` },
    xAxis: categoryAxis(p, { data: run.history.map((g) => g.index) }),
    yAxis: valueAxis(p, { scale: false, axisLabel: { color: p.muted, fontSize: 10, formatter: (v: number) => `${Math.round(v / 1000)} s` } }),
    series: [{ type: 'bar', data: run.history.map((g) => g.timeMs ?? 0), barMaxWidth: 12, itemStyle: { color: p.series[0], borderRadius: [3, 3, 0, 0] } }],
  });
}

function RunOverview({ id, onExplore }: { id: string; onExplore: () => void }) {
  const { data: run, isLoading, error } = useRun(id);
  // option builders once per run: a new builder makes its chart apply the option again
  const builds = useMemo(() => (run ? { hv: run.hypervolume ? hvBuild(run) : null, conv: run.objectives.map((_, k) => convergenceBuild(run, k)), time: timingBuild(run) } : null), [run]);
  const designs = useMemo(() => run, [run]);
  if (isLoading) return <Loading label="Loading run" />;
  if (error || !run || !designs) return <Problem title="Run not available">{String(error)}</Problem>;
  const hasPop = run.history.some((g) => g.population.length);
  const lastPop = [...run.history].reverse().find((g) => g.population.length)?.population ?? [];
  const feasibleShare = lastPop.length ? lastPop.filter((x) => x.c.every((c) => c <= 1e-12)).length / lastPop.length : null;
  const dirs = run.objectives.map((o) => o.direction);
  void minForm; void dirs;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[15rem] flex-1">
          <h1 className="text-lg font-semibold tracking-tight">{run.name}</h1>
          <p className="text-sm text-muted-foreground">{run.description}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {run.tags?.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
            <Badge variant="outline">{run.algorithm}</Badge>
            <Badge variant="outline">domain: {run.domainId}</Badge>
          </div>
        </div>
        <Button size="sm" onClick={onExplore}>Explore designs <ArrowRight className="size-4" /></Button>
      </div>
      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @7xl:grid-cols-6">
        <Stat label="Evaluated" value={compact(run.evaluated)} hint={`${run.populationSize} × ${run.generations}`} />
        <Stat label="Designs with data" value={compact(run.designCount)} hint={run.archiveSize !== undefined ? `archive ${run.archiveSize}` : 'final front'} />
        <Stat label={<>Final hypervolume<MetricHelp k="hypervolume" /></>} value={fmt(run.finalHypervolume, 3)} hint={run.hypervolume && !run.hypervolume.ideal ? "the platform's own box" : 'normalised box'} />
        <Stat label="Feasible (last gen.)" value={feasibleShare === null ? '–' : `${Math.round(feasibleShare * 100)} %`} />
        <Stat label="Duration" value={fmtDuration(run.durationMs)} hint={fmtDate(run.finishedAt)} />
        <Stat label="Source" value={<span className="text-sm">{run.source.kind}</span>} hint={<span className="block truncate" title={run.source.location}>{run.source.executionId ?? run.source.location}</span>} />
      </div>
      <div className="grid gap-4 @5xl:grid-cols-3">
        {run.hypervolume ? (
          <ChartCard className="@5xl:col-span-2" title="Hypervolume over generations" subtitle={run.hypervolume.method} build={builds!.hv!} exportName={`${run.id}-hypervolume`} height={250} />
        ) : <Card className="@5xl:col-span-2"><Empty>No hypervolume for this run.</Empty></Card>}
        <Card className="gap-2 py-3">
          <div className="px-4 text-sm font-semibold">Configuration</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 text-xs">
            <dt className="text-muted-foreground">mutation</dt><dd>{run.config.mutationSteps ?? '–'} operators per mutation{run.config.crossover ? `, crossover ${run.config.crossover}` : ', no crossover'}</dd>
            <dt className="text-muted-foreground">start</dt><dd>{run.config.initialisation ?? '–'}</dd>
            <dt className="text-muted-foreground">threads</dt><dd>{run.config.threads ?? '–'}</dd>
            <dt className="text-muted-foreground">seed</dt><dd>{run.config.randomSeed ?? '–'}</dd>
            {run.config.evaluation && <>
              <dt className="text-muted-foreground">evaluation</dt>
              <dd>one SimOxide simulation per design (Palladio semantics, SPD + HPA), <b className="font-medium">{run.config.evaluation.profile}</b> profile, window {run.config.evaluation.warmUpS}–{run.config.evaluation.endS} s, seed {run.config.evaluation.seed}{run.config.evaluation.pluginVersion ? <>, plugin <span className="font-mono">{run.config.evaluation.pluginVersion}</span></> : null}</dd>
              <dt className="text-muted-foreground">{run.constraints.some((c) => c.key === 'cohesion') ? 'C1, C2, C3' : 'C1, C2'}</dt>
              <dd>{run.config.evaluation.latency.statistic} ≤ {run.config.evaluation.latency.factor ?? '?'} × today's ({Object.keys(run.config.evaluation.budgets).length} request types with a budget{run.config.evaluation.latency.minCompletions ? `, ≥ ${run.config.evaluation.latency.minCompletions} reference completions` : ''}); peak bin utilisation ≤ {run.config.evaluation.peakCapacity.limit}{run.constraints.some((c) => c.key === 'cohesion') ? '; every service connected in the domain\'s affinity graph' : ''}</dd>
            </>}
            <dt className="text-muted-foreground">objectives</dt><dd>{run.objectives.map((o) => `${o.direction === 'minimize' ? '↓' : '↑'} ${o.label}`).join(', ')}</dd>
            <dt className="text-muted-foreground">constraints</dt><dd>{run.constraints.map((c) => c.label).join(', ') || '–'}</dd>
          </dl>
          <div className="px-4 pt-1 text-xs font-medium">Operators ({run.config.operators.length})</div>
          <ScrollArea viewportClassName="max-h-36">
            <ul className="px-4 text-xs">
              {run.config.operators.map((o) => <li key={o.name} className="py-0.5"><span className="font-mono">{o.name}</span>{o.description && <span className="text-muted-foreground"> — {o.description}</span>}</li>)}
            </ul>
          </ScrollArea>
          {run.config.notes && <p className="px-4 text-xs text-muted-foreground">{run.config.notes}</p>}
        </Card>
      </div>
      {hasPop ? (
        <>
          <h2 className="pt-2 text-sm font-semibold">Convergence per objective <span className="font-normal text-muted-foreground">— feasible population: best, median, p10–p90</span></h2>
          <div className="grid gap-4 @2xl:grid-cols-2 @7xl:grid-cols-4">
            {run.objectives.map((o, k) => (
              <ChartCard key={o.key} title={`${o.label}${o.unit ? ` (${o.unit})` : ''}`} subtitle={o.direction === 'minimize' ? 'lower is better' : 'higher is better'} build={builds!.conv[k]} exportName={`${run.id}-convergence-${o.key}`} height={190} />
            ))}
          </div>
        </>
      ) : <Card><Empty>This source reports no per-generation populations (a platform run: per generation its counters and its own hypervolume; the dev instance: the final front only).</Empty></Card>}
      <Distributions run={run} />
      {run.history.some((g) => g.timeMs) && (
        <ChartCard title="Time per generation" subtitle="wall-clock evaluation time" build={builds!.time} exportName={`${run.id}-generation-time`} height={170} />
      )}
    </div>
  );
}

function Distributions({ run }: { run: Run }) {
  const lastPop = [...run.history].reverse().find((g) => g.population.length)?.population;
  const builds = useMemo(() => run.objectives.map((_, k) => distributionBuild(run, (lastPop ?? []).filter((x) => x.c.every((c) => c <= 1e-12)).map((x) => x.o[k]), [], k)), [run]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <h2 className="pt-2 text-sm font-semibold">Objective distributions <span className="font-normal text-muted-foreground">— {lastPop ? 'final population, feasible' : 'no population data'}; reference designs marked</span></h2>
      {lastPop && (
        <div className="grid gap-4 @2xl:grid-cols-2 @7xl:grid-cols-4">
          {run.objectives.map((o, k) => (
            <ChartCard key={o.key} title={`${o.label}${o.unit ? ` (${o.unit})` : ''}`} build={builds[k]} exportName={`${run.id}-distribution-${o.key}`} height={170} />
          ))}
        </div>
      )}
    </>
  );
}

/** the runs panel: the run list and the selected run's overview */
export default memo(function RunsView({ runId }: { runId: string | null }) {
  const idx = useIndex();
  const model = usePanelAvailable('model');
  const runs = idx.data?.runs ?? [];
  const synthetic = (r: RunSummary) => !!r.source.synthetic || !!r.tags?.includes('synthetic');
  // runs of an earlier model of the same domain (the Model panel shows the current one)
  const older = (r: RunSummary) => !!r.tags?.includes('earlier-model');
  const groups: [string, RunSummary[]][] = [
    ['Domain-cut runs', runs.filter((r) => !synthetic(r) && !older(r))],
    [model ? 'Earlier models (the Model panel shows the current one)' : 'Earlier models', runs.filter((r) => !synthetic(r) && older(r))],
    ['Synthetic', runs.filter(synthetic)],
  ];
  if (idx.isLoading) return <Loading label="Reading sources" />;
  if (idx.error) return <Problem title="Backend not reachable">{String(idx.error)} — start it with <code>pnpm dev</code>.</Problem>;
  return (
    <ScrollArea className="h-full">
      <div className="grid gap-4 p-3 @5xl:grid-cols-[300px_minmax(0,1fr)] @5xl:gap-6">
        <aside className="space-y-4" aria-label="Run list">
          {groups.filter(([, rs]) => rs.length).map(([title, rs]) => (
            <section key={title} className="space-y-2">
              <h3 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
              {rs.map((r) => <RunRow key={r.id} r={r} active={r.id === runId} onSelect={() => ws.setRun(r.id)} />)}
            </section>
          ))}
          {!runs.length && <Empty>No runs. Export one with <code>pnpm export:run</code>.</Empty>}
        </aside>
        <section className="min-w-0">{runId ? <RunOverview key={runId} id={runId} onExplore={() => ws.openPanel('designs')} /> : null}</section>
      </div>
    </ScrollArea>
  );
});
