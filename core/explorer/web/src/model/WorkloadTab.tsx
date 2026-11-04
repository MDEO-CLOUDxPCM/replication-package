import { useMemo } from 'react';
import type { Domain, InputModel, ModelProfile } from '@contract/types';
import { planVia } from '@contract/plan';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ChartCard } from '@/components/ChartCard';
import { chrome, legend, ttRow, valueAxis } from '@/charts/base';
import type { OptionBuilder } from '@/charts/EChart';
import { phaseAreas } from '@/charts/perfCharts';
import { workspaceActions } from '@/lib/useWorkspace';
import type { ModelTarget } from '@/lib/modelTarget';
import { cn } from '@/lib/utils';
import { SeffTree, timingLabel } from './SeffTree';
import { CallTree, PLAN_VIA_ABOUT, PLAN_VIA_LABEL } from './CallTree';
import { ModelLink, Section, fmtN, fmtRate, type DesignContext } from './shared';
import { MText, useT } from './text';

/** a session class's arrival rate at time t: the model's rate × the factor of its last step (a named scenario's steps override the all-scenario ones; before the first step 1) */
export function profileRate(pr: ModelProfile, session: string, t: number): number {
  const last = (xs: ModelProfile['steps']) => xs.filter((x) => x.timeS <= t).sort((a, b) => a.timeS - b.timeS).at(-1);
  const f = (last(pr.steps.filter((x) => x.session === session)) ?? last(pr.steps.filter((x) => x.session === null)))?.factor ?? 1;
  return (pr.baseRates[session] ?? 0) * f;
}

/** the load profile of a model variant: sessions/s per session class over time (stacked; a category axis of 10-s samples, as ECharts stacks per category), C's phases shaded, the warm-up hatched */
const profileBuild = (pr: ModelProfile, names: Record<string, string>): OptionBuilder => (p) => {
  // the session classes in the model's order, so both profiles colour them alike
  const sessions = [...Object.keys(names).filter((k) => k in pr.baseRates), ...Object.keys(pr.baseRates).filter((k) => !(k in names))];
  const t = Array.from({ length: Math.floor(pr.endS / 10) }, (_, i) => i * 10);
  const phases = pr.phases.map((x, i) => ({ name: x.name, fromS: x.fromS, toS: Math.min(pr.endS, pr.phases[i + 1]?.fromS ?? pr.endS) })).filter((x) => x.fromS < pr.endS);
  const idx = (s: number) => String(t[Math.min(t.length - 1, Math.round(s / 10))]);
  const areas = phaseAreas(p, { phases, warmupS: pr.warmUpS });
  areas.data = areas.data.map(([a, b]: any[]) => [{ ...a, xAxis: idx(a.xAxis) }, { xAxis: idx(b.xAxis) }]);
  return {
    ...chrome(p),
    grid: { left: 44, right: 16, top: 34, bottom: 30 },
    legend: legend(p, { icon: 'rect', itemHeight: 8, itemWidth: 12 }),
    tooltip: { ...chrome(p).tooltip, trigger: 'axis', formatter: (ps: any[]) => `<div style="opacity:.7;margin-bottom:4px">t = ${ps[0].name} s · ${ps.reduce((s, x) => s + (x.value ?? 0), 0).toFixed(1)} sessions/s</div>` + [...ps].reverse().map((x) => ttRow(x.color, `${(x.value ?? 0).toFixed(2)}/s`, x.seriesName)).join('') },
    xAxis: { type: 'category', data: t.map(String), boundaryGap: false, axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false }, axisLabel: { color: p.muted, fontSize: 10, interval: (i: number) => t[i] % 120 === 0 }, name: 'time (s)', nameLocation: 'middle', nameGap: 22, nameTextStyle: { color: p.ink2, fontSize: 11 } },
    yAxis: valueAxis(p, { min: 0, scale: false, name: 'sessions/s', nameLocation: 'end', nameGap: 6, nameTextStyle: { align: 'left', color: p.muted, fontSize: 10 } }),
    series: sessions.map((k, i) => ({
      name: names[k] ?? k, type: 'line', stack: 'load', step: 'end', showSymbol: false, data: t.map((x) => profileRate(pr, k, x)),
      lineStyle: { width: 0 }, areaStyle: { color: p.series[i % 8], opacity: 0.85 }, itemStyle: { color: p.series[i % 8] },
      markArea: i === 0 ? areas : undefined,
    })),
  };
};

/** the workload: request types and their expansion with C1's budgets per profile, session classes, the models' load profiles */
export function WorkloadTab({ model, domain, target, ctx, narrow }: { model: InputModel; domain?: Domain; target: ModelTarget | null; ctx: DesignContext | null; narrow: boolean }) {
  const req = target?.kind === 'req' ? model.requests.find((r) => r.id === target.id) : undefined;
  const sess = target?.kind === 'session' ? model.sessions.find((s) => s.id === target.id) : undefined;
  const reqs = useMemo(() => [...model.requests].sort((a, b) => b.rate - a.rate), [model]);
  void domain;
  const profiles = model.profiles ?? [];
  const names = Object.fromEntries(model.sessions.map((s) => [s.id, s.name]));
  const usedBy = (r: string) => model.sessions.filter((s) => s.visits.some((v) => v.request === r));
  const timing = timingLabel(model);
  const t = useT();
  const ext = t('model.workload.external.label');

  let detail: React.ReactNode;
  if (req) {
    const total = req.work.gateway + req.work.app + req.work.db;
    detail = (
      <div className="space-y-4 p-3 text-xs">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{req.id}</h2><Badge variant="outline" className="h-5 text-[10.5px]">request type</Badge>{req.msa && req.msa !== req.id && <span className="text-muted-foreground">msa: {req.msa}</span>}</div>
          {req.document && <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1 font-mono text-[10.5px]">{req.document}</pre>}
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-muted-foreground">rate</dt><dd className="tabular">{fmtRate(req.rate)} <span className="text-muted-foreground">at the design load</span></dd>
            <dt className="text-muted-foreground">gateway plan</dt><dd>{req.plan.map((p) => {
              // the plan as a tree: a field indented under the entry whose objects it is resolved on
              let d = 0;
              for (let q = p.parent; q !== undefined && q > 0 && d < 8; q = req.plan[q]?.parent) d++;
              return <div key={p.op} style={{ paddingLeft: p.via === 'root' ? 0 : 12 * (d + 1) }}><ModelLink target={`op:${p.op}`}>{p.op}</ModelLink> <span className="text-muted-foreground" title={PLAN_VIA_ABOUT[planVia(p.via) ?? ''] ?? p.via}>({PLAN_VIA_LABEL[planVia(p.via) ?? ''] ?? p.via})</span></div>;
            })}</dd>
            {profiles.map((pr) => {
              const b = req.budgets?.find((x) => x.profile === pr.id);
              return (
                <div key={pr.id} className="contents">
                  <dt className="text-muted-foreground">C1, {pr.id} profile</dt>
                  <dd className="tabular">{!b ? <span className="text-muted-foreground">today's run completed none in its window: no budget</span> : <>
                    {b.budgetMs !== undefined ? <><b className="font-medium">{fmtN(b.budgetMs, 2)} ms</b> = {pr.latency.factor ?? '?'} × </> : <span className="text-muted-foreground">no budget: </span>}
                    today's simulated {b.statistic} {fmtN(b.referenceMs, 2)} ms <span className="text-muted-foreground">({fmtN(b.referenceCount, 0)} completions{b.budgetMs === undefined && pr.latency.minCompletions ? `, fewer than the policy's ${pr.latency.minCompletions}` : ''})</span>
                  </>}</dd>
                </div>
              );
            })}
            <dt className="text-muted-foreground">work per request</dt>
            <dd className="tabular">{fmtN(total, 2)} ms <span className="text-muted-foreground">= gateway {fmtN(req.work.gateway, 2)} + application {fmtN(req.work.app, 2)}{req.work.map ? ` (of it mapping ${fmtN(req.work.map, 2)})` : ''} + database {fmtN(req.work.db, 2)}: every demand the request causes, synchronous or not, without middleware and queueing ({timing})</span></dd>
            {!!req.work.wait && <><dt className="text-muted-foreground">latency-only waits</dt><dd className="tabular">{fmtN(req.work.wait, 2)} ms <span className="text-muted-foreground">{t('model.workload.wait', 'database round trips and commits (DELAY, no CPU), not in the work above; the broker publish waits come with the realisation')}</span></dd></>}
            <dt className="text-muted-foreground">sessions</dt><dd>{usedBy(req.id).map((s, i) => <span key={s.id}>{i ? ', ' : ''}<ModelLink target={`session:${s.id}`}>{s.name}</ModelLink> <span className="text-muted-foreground tabular">× {fmtN(s.visits.find((v) => v.request === req.id)!.visits, 3)}</span></span>)}</dd>
          </dl>
        </div>
        <Section title="How one request expands" right="request type → operations → accesses → classes">
          <p className="text-[10.5px] text-muted-foreground">The gateway calls the root resolver (the entry point); below it every link is a call site of a SEFF, as in the Operations tab: accesses to other classes, the request's further fields (plan: resolved in the parent's service or a gateway fetch today), events (one site per raise and reaction, p: raise probability), provider callbacks, calls. Chips: the allowed mechanisms, {ctx ? `design A's (${ctx.label})` : "today's"} highlighted; no hop / remote → service: caller and callee in one container or not {ctx ? 'in A' : 'today'} (the placement, not a mechanism); own data: the home class's own schema (fixed: a read sync, a write in transaction); Σ: CPU / database per execution below a node (no middleware).</p>
          <div className="rounded-md border p-2"><CallTree model={model} roots={[req.seff]} ctx={ctx} entry={req.plan.find((p) => p.via === 'root')?.op} openDepth={2} /></div>
          <details>
            <summary className="cursor-pointer text-[10.5px] text-muted-foreground hover:text-foreground">the SEFFs part by part with demands</summary>
            <div className="mt-1.5 rounded-md border p-2"><SeffTree model={model} seff={req.seff} ctx={ctx} /></div>
          </details>
        </Section>
      </div>
    );
  } else if (sess) {
    detail = (
      <div className="space-y-3 p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{sess.name}</h2><Badge variant="outline" className="h-5 text-[10.5px]">session class</Badge></div>
        {sess.description && <p>{sess.description}</p>}
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted-foreground">share of the mix</dt><dd className="tabular">{sess.share ? `${(sess.share * 100).toFixed(0)} %` : t('model.workload.constantRate', 'constant rate')}</dd>
          <dt className="text-muted-foreground">sessions</dt><dd className="tabular">{fmtRate(sess.sessionsPerS)}</dd>
          <dt className="text-muted-foreground">mean think time</dt><dd className="tabular">{fmtN(sess.thinkTimeS, 2)} s per step</dd>
        </dl>
        <Section title="Requests per session" right="expected visits">
          <table className="w-full">
            <tbody>
              {sess.visits.map((v) => (
                <tr key={v.request} className="border-t border-border/50">
                  <td className="py-0.5">{model.requests.some((r) => r.id === v.request) ? <ModelLink target={`req:${v.request}`}>{v.request}</ModelLink> : <span title={t('model.workload.external.title', 'no SEFF of the system')}>{v.request}{ext && <> <span className="text-muted-foreground">({ext})</span></>}</span>}</td>
                  <td className="text-right tabular">{fmtN(v.visits, 3)}</td>
                  <td className="text-right tabular text-muted-foreground">{fmtRate(v.visits * sess.sessionsPerS)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    );
  } else {
    const timingNote = model.timing?.note ?? t('model.workload.timingNote');
    // the mapping CPU is a part of its own (campaign v2 and later: per access its mapping CPU)
    const mapping = !!model.timing && model.operations.some((o) => o.accesses.some((a) => a.cpuMs > 0));
    const source = t('model.workload.source');
    detail = (
      <div className="space-y-3 p-3 text-xs">
        <Section title={t('model.workload.sessionsTitle', 'Users are sessions')}>
          <p>{t('model.workload.sessions', 'Each session class is one usage scenario with open arrivals (Poisson) and a closed loop inside: requests, think times, branches and loops. The design load is {{designLoad}} sessions/s. Mixes change through per-class load steps.', { designLoad: fmtN(model.designSessionsPerS, 1) })}</p>
        </Section>
        <Section title={`Demands: ${timing}`} right={t(`model.workload.timingRef.${model.timing?.source}`) || t('model.workload.timingRef')}>
          {timingNote && <p>{timingNote}</p>}
          {mapping && <p className="text-[10.5px] text-muted-foreground">Mapping CPU (app-side persistence) is a part of its own: for another class's data the <code className="font-mono">map</code> action of that class's access SEFF (it runs where the class runs, and a copy read skips it), for the home class's own data part of the operation's work (shown split, from the trace's Access.cpuMs).{model.timing?.mapShare !== undefined ? ` At the design load it is ${fmtN(model.timing.mapShare * 100, 1)} % of the application CPU (rate-weighted over the request types).` : ''}</p>}
        </Section>
        <Section title="Load profiles: what every design is simulated with" right={t('model.workload.profilesRef', 'LoadProfile, LoadStep')}>
          <p className="text-[10.5px] text-muted-foreground">Each model variant carries one load profile; the search simulates every design once under it (SimOxide, the HPA scaling every application container and the gateway) and measures in the window after the warm-up. A step sets a session class's arrival rate to factor × the model's rate from its time on.</p>
          {profiles.map((pr) => (
            <div key={pr.id} className="space-y-1">
              <ChartCard title={`${pr.id} profile: sessions per second by session class`} subtitle={`${pr.steps.length} steps · measured ${pr.warmUpS}–${pr.endS} s · seed ${pr.seed ?? '?'}${pr.usageStreams ? ', usage streams' : ''} · pod limit ${pr.maxPods ?? '?'} · C1: ${pr.latency.statistic} ≤ ${pr.latency.factor ?? '?'} × today's`} build={profileBuild(pr, names)} exportName={`workload-${pr.id}-profile`} height={200} />
              {pr.about && <p className="text-[10.5px] text-muted-foreground">{pr.about}</p>}
              <p className="text-[10.5px] text-muted-foreground">model: <code className="font-mono">{pr.model}</code></p>
            </div>
          ))}
          {!profiles.length && <p className="text-muted-foreground">{t('model.workload.noProfile', 'No load profile in the exported model.')}</p>}
        </Section>
        {source && <p className="text-[10.5px] text-muted-foreground"><MText code="font-mono" text={source} /></p>}
      </div>
    );
  }

  return (
    <ResizablePanelGroup key={narrow ? 'v' : 'h'} orientation={narrow ? 'vertical' : 'horizontal'} className="h-full">
      <ResizablePanel defaultSize={narrow ? '40%' : '36%'} minSize="22%">
        <ScrollArea className="h-full">
          <div className="space-y-3 p-2">
            <table className="w-full text-xs">
              <thead className="text-left text-[10.5px] text-muted-foreground"><tr><th className="px-1 font-medium">request type</th><th className="text-right font-medium">rate</th>{profiles.map((pr) => <th key={pr.id} className="pr-1 text-right font-medium" title={`C1 budget under the ${pr.id} profile: ${pr.latency.factor ?? '?'} × today's simulated ${pr.latency.statistic}, ms`}>{pr.id}</th>)}</tr></thead>
              <tbody>
                {reqs.map((r) => (
                  <tr key={r.id} onClick={() => workspaceActions.openModel(`req:${r.id}`)} className={cn('cursor-pointer border-t border-border/50 hover:bg-accent/60', req?.id === r.id && 'bg-accent')}>
                    <td className="max-w-0 truncate px-1 py-1" title={r.id}>{r.id}</td>
                    <td className="text-right tabular text-muted-foreground">{fmtRate(r.rate)}</td>
                    {profiles.map((pr) => <td key={pr.id} className="pr-1 text-right tabular text-muted-foreground">{fmtN(r.budgets?.find((b) => b.profile === pr.id)?.budgetMs, 1)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="w-full text-xs">
              <thead className="text-left text-[10.5px] text-muted-foreground"><tr><th className="px-1 font-medium">session class</th><th className="text-right font-medium">share</th><th className="text-right font-medium">sessions</th><th className="pr-1 text-right font-medium">think</th></tr></thead>
              <tbody>
                {model.sessions.map((s) => (
                  <tr key={s.id} onClick={() => workspaceActions.openModel(`session:${s.id}`)} className={cn('cursor-pointer border-t border-border/50 hover:bg-accent/60', sess?.id === s.id && 'bg-accent')}>
                    <td className="px-1 py-1">{s.name}</td>
                    <td className="text-right tabular text-muted-foreground">{s.share ? `${(s.share * 100).toFixed(0)} %` : '–'}</td>
                    <td className="text-right tabular text-muted-foreground">{fmtRate(s.sessionsPerS)}</td>
                    <td className="pr-1 text-right tabular text-muted-foreground">{fmtN(s.thinkTimeS, 1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={() => workspaceActions.openModel('workload')} className={cn('w-full cursor-pointer rounded-md border px-2 py-1 text-left text-xs hover:bg-accent/60', !req && !sess && 'bg-accent')}>the load profiles and the session model</button>
          </div>
        </ScrollArea>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={narrow ? '60%' : '64%'} minSize="30%">
        <ScrollArea className="h-full">{detail}</ScrollArea>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
