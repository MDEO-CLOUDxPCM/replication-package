import { useCallback, useMemo, useRef, useState, memo } from 'react';
import { ArrowLeftRight, ArrowDown, ArrowUp, Equal, Gauge, ChevronDown, LayoutGrid, X } from 'lucide-react';
import type { Design, Domain, Id, Run } from '@contract/types';
import { diffDesigns, type DesignDiff } from '@contract/diff';
import { effectRealised, effectShort } from '@contract/effects';
import type { LayoutResult } from '@layout/types';
import { bounds, type PinReference } from '@layout/pin';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Loading, Problem, Empty } from '@/components/States';
import { ExportMenu } from '@/components/ExportMenu';
import { MechanismBadge } from '@/components/MechanismBadge';
import { DesignGraphView, ViewportSync, type DesignGraphHandle, type Highlight } from '@/graph/DesignGraph';
import { GraphLegend } from '@/graph/Legend';
import { edgeVisible, opFootprint, svcNode, type DesignGraph as DG, type EdgeLayer } from '@/graph/build';
import { collapsedOf, GraphTools, useGraphUrlState } from './DesignView';
import { useDesign, useDetail, useDomain, useRun } from '@/lib/api';
import { PALETTES, serviceAccent } from '@/lib/palette';
import { useHover } from '@/lib/store';
import { useMaySimulate, usePanelAvailable, usePanelOpen, workspaceActions as ws } from '@/lib/useWorkspace';
import { useElementWidth } from '@/lib/useWidth';
import type { DesignRef } from '@/lib/workspace';
import { useTheme } from '@/lib/theme';
import { fmt, fmtDelta } from '@/lib/format';
import { useVocab } from '@/lib/packet';
import { PlacementBadge } from '@/components/PlacementBadge';
import { cn } from '@/lib/utils';
import { MetricHelp } from '@/help/MetricHelp';
import { ModelJump } from '@/help/ModelJump';
import { ModelLink } from '@/model/shared';

function useSide(r: DesignRef) {
  const run = useRun(r?.runId);
  const design = useDesign(r?.runId, r?.designId);
  return { r, run: run.data, design: design.data, error: run.error ?? design.error };
}

function Delta({ a, b, dir, digits, unit, compact }: { a: number; b: number; dir: 'minimize' | 'maximize'; digits: number; unit?: string; compact?: boolean }) {
  const eq = Math.abs(a - b) <= Math.abs(a) * 1e-6 + 1e-12;
  const better = eq ? null : dir === 'minimize' ? b < a : b > a;
  const Icon = eq ? Equal : b > a ? ArrowUp : ArrowDown;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', better === true && 'text-[var(--status-good)]', better === false && 'text-[var(--status-critical)]', better === null && 'text-muted-foreground')}>
      <Icon className="size-3" />
      {eq ? 'same' : `${fmtDelta(a, b)}`}
      <span className="sr-only">{better ? 'better' : better === false ? 'worse' : ''}</span>
      {!compact && <span className="ml-1 font-normal text-muted-foreground">({b - a >= 0 ? '+' : '−'}{fmt(Math.abs(b - a), digits)}{unit ? ` ${unit}` : ''})</span>}
    </span>
  );
}

function ObjectiveDeltas({ run, A, B }: { run: Run; A: Design; B: Design }) {
  return (
    <div className="grid grid-cols-2 gap-2 @5xl:grid-cols-4">
      {run.objectives.map((o, k) => (
        <div key={o.key} className="rounded-lg border bg-card px-3 py-2">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">{o.label}{o.unit ? ` (${o.unit})` : ''} {o.direction === 'minimize' ? '↓' : '↑'}<MetricHelp k={o.key} className="ml-auto" /></div>
          <div className="mt-0.5 flex items-baseline gap-2 text-sm">
            <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-select-a" />{fmt(A.objectives[k], o.digits ?? 2)}</span>
            <span className="text-muted-foreground">→</span>
            <span className="flex items-center gap-1 font-semibold"><span className="size-2 rounded-full bg-select-b" />{fmt(B.objectives[k], o.digits ?? 2)}</span>
          </div>
          <Delta a={A.objectives[k]} b={B.objectives[k]} dir={o.direction} digits={o.digits ?? 2} unit={o.unit} />
        </div>
      ))}
    </div>
  );
}

function DiffList({ domain, diff, A, B }: { domain: Domain; diff: DesignDiff; A: Design; B: Design }) {
  const nameA = (s: Id) => A.decisions!.services.find((x) => x.id === s)?.name ?? s;
  const nameB = (s: Id) => B.decisions!.services.find((x) => x.id === s)?.name ?? s;
  const opName = new Map(domain.operations.map((o) => [o.id, o.name]));
  const setHoveredOp = useHover((s) => s.setHoveredOp);
  const vocab = useVocab();
  // a process within one service is no saga: no coordination to style
  const style = (s: string | undefined | null) => (s ? vocab.label('styles', s) : 'no saga (one service)');
  const sections: { title: string; n: number; body: React.ReactNode }[] = [
    { title: 'Moved classes', n: diff.movedClasses.length, body: diff.movedClasses.map((m) => <li key={m.cls}><ModelLink target={`class:${m.cls}`} className="font-semibold">{m.cls}</ModelLink> <span className="text-muted-foreground">{nameA(m.fromA)} → {nameB(m.toB)}</span></li>) },
    { title: 'Mechanism changes', n: diff.mechanismChanges.length, body: diff.mechanismChanges.map((c) => <li key={c.key} onMouseEnter={() => setHoveredOp(c.op)} onMouseLeave={() => setHoveredOp(null)} className="flex flex-wrap items-center gap-1 rounded hover:bg-accent/60"><span className="truncate"><ModelLink target={`op:${c.op}`}>{opName.get(c.op)}</ModelLink> → <ModelLink target={`class:${c.cls}`}>{c.cls}</ModelLink></span>{c.a ? <MechanismBadge m={c.a} /> : <PlacementBadge together />}<span>→</span>{c.b ? <MechanismBadge m={c.b} /> : <PlacementBadge together />}</li>) },
    // (1.4.0) effect steps: mechanism or joining changed
    ...(diff.effectChanges.length || A.decisions!.effects ? [{ title: 'Effect steps', n: diff.effectChanges.length, body: diff.effectChanges.map((c) => <li key={c.site} onMouseEnter={() => setHoveredOp(c.op)} onMouseLeave={() => setHoveredOp(null)} className="flex flex-wrap items-center gap-1 rounded hover:bg-accent/60" title={`A: ${effectRealised(c.a)}\nB: ${effectRealised(c.b)}`}><span className="truncate"><ModelLink target={`op:${c.op}`}>{opName.get(c.op) ?? c.op}</ModelLink> → <ModelLink target={`class:${c.cls}`}>{c.cls}</ModelLink></span><span className="text-muted-foreground">{effectShort(c.a)} → {effectShort(c.b)}</span></li>) }] : []),
    // homes as a decision
    ...(A.decisions!.homes ? [{ title: 'Homes', n: diff.homeChanges.length, body: diff.homeChanges.map((c) => <li key={c.op} onMouseEnter={() => setHoveredOp(c.op)} onMouseLeave={() => setHoveredOp(null)} className="rounded hover:bg-accent/60"><ModelLink target={`op:${c.op}`}>{opName.get(c.op) ?? c.op}</ModelLink> <span className="text-muted-foreground">enters at {c.a} → {c.b}</span></li>) }] : []),
    { title: 'Saga styles', n: diff.sagaChanges.length, body: diff.sagaChanges.map((c) => <li key={c.process}><b>{domain.processes.find((p) => p.id === c.process)?.name ?? c.process}</b> <span className="text-muted-foreground">{style(c.a)} → {style(c.b)}</span></li>) },
    { title: 'Replicas', n: diff.replicaChanges.length, body: diff.replicaChanges.map((c) => <li key={c.a}>{nameA(c.a)} <span className="text-muted-foreground">{c.ra.mode === 'fixed' ? c.ra.count : `HPA ≤${c.ra.max}`} → {c.rb.mode === 'fixed' ? c.rb.count : `HPA ≤${c.rb.max}`}</span></li>) },
    { title: 'Database placement', n: diff.databaseChanges.length, body: diff.databaseChanges.map((c) => <li key={c.a}>{nameA(c.a)} <span className="text-muted-foreground">{c.placementA} → {c.placementB}</span></li>) },
  ];
  return (
    <div className="divide-y text-xs">
      <div className="px-3 py-2 text-muted-foreground">Services: {A.decisions!.services.length} → {B.decisions!.services.length} · {diff.matches.filter((m) => m.a && m.b && m.overlap === 1).length} unchanged, {diff.matches.filter((m) => m.a && m.b && m.overlap < 1).length} changed, {diff.matches.filter((m) => !m.b).length} only in A, {diff.matches.filter((m) => !m.a).length} only in B</div>
      {sections.map((s) => (
        <Collapsible key={s.title} defaultOpen={s.n > 0 && s.n < 12}>
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left font-medium hover:bg-accent/50">
            <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />{s.title}<Badge variant={s.n ? 'secondary' : 'outline'} className="ml-auto h-5">{s.n}</Badge>
          </CollapsibleTrigger>
          <CollapsibleContent><ul className="space-y-1 px-3 pb-2 pl-8">{s.n ? s.body : <li className="text-muted-foreground">none</li>}</ul></CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

function PerfDeltas({ domain, a, b }: { domain: Domain; a: { runId: string; designId: string }; b: { runId: string; designId: string } }) {
  const sim = useMaySimulate();
  const da = useDetail(a.runId, a.designId, sim), db = useDetail(b.runId, b.designId, sim);
  if (da.isLoading || db.isLoading) return <Loading label="Simulating / loading detail" />;
  if (!da.data || !db.data) return <Empty>Performance detail not available ({String(da.error ?? db.error)}).</Empty>;
  const B = new Map(db.data.requests.map((r) => [r.key, r]));
  const rows = da.data.requests.filter((r) => B.has(r.key)).map((r) => ({ key: r.key, a: r.statisticMs ?? r.p95Ms, b: B.get(r.key)!.statisticMs ?? B.get(r.key)!.p95Ms, ma: r.meanMs, mb: B.get(r.key)!.meanMs }))
    .sort((x, y) => Math.abs(y.b - y.a) / y.a - Math.abs(x.b - x.a) / x.a);
  void domain;
  return (
    <table className="w-full table-fixed text-xs">
      <colgroup><col /><col className="w-14" /><col className="w-14" /><col className="w-[4.75rem]" /></colgroup>
      <thead className="text-left text-[11px] text-muted-foreground"><tr><th className="px-3 py-1.5 font-medium">request type</th><th className="whitespace-nowrap text-right font-medium">A ms</th><th className="whitespace-nowrap text-right font-medium">B ms</th><th className="pr-3 text-right font-medium">Δ</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="group border-t border-border/50">
            <td className="truncate px-3 py-1" title={r.key}><span className="inline-flex max-w-full items-center gap-1"><span className="truncate">{r.key}</span><ModelJump target={`req:${r.key}`} title={`${r.key} in the Model panel: how the request expands`} /></span></td>
            <td className="text-right tabular">{fmt(r.a, 1)}</td>
            <td className="text-right tabular">{fmt(r.b, 1)}</td>
            <td className="whitespace-nowrap pr-3 text-right"><Delta a={r.a} b={r.b} dir="minimize" digits={1} compact /></td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><td colSpan={4} className="px-3 pt-2 text-[11px] text-muted-foreground">{da.data.constraints && db.data.constraints ? <>C1 of the simulations: A {fmt(da.data.constraints.latencyBudget, 2)} · B {fmt(db.data.constraints.latencyBudget, 2)} ({da.data.constraints.statistic} vs budget) </> : null}({da.data.origin} / {db.data.origin})</td></tr></tfoot>
    </table>
  );
}

/** the architecture panel with two designs: A and B side by side, B pinned to A's layout */
export default memo(function CompareView({ a, b }: { a: DesignRef; b: DesignRef }) {
  const perfOpen = usePanelOpen('perf'), perfOffered = usePanelAvailable('perf');
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root) ?? 1200;
  const narrow = width < 980, stacked = width < 460;
  const { set, hidden, isCollapsed, detailed, setDetailed, selectService, collapseAll, toggleLayer, toggleCollapse, layouter, bundle, merge } = useGraphUrlState();
  const A = useSide(a);
  const B = useSide(b);
  const { data: domain } = useDomain(A.run?.domainId);
  const { theme } = useTheme();
  const hoveredOp = useHover((s) => s.hoveredOp);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [layoutA, setLayoutA] = useState<{ r: LayoutResult; g: DG } | null>(null);
  const [layoutB, setLayoutB] = useState<{ r: LayoutResult; g: DG } | null>(null);
  const graphA = layoutA?.g ?? null, graphB = layoutB?.g ?? null;
  const sync = useMemo(() => new ViewportSync(), []);
  const refA = useRef<DesignGraphHandle>(null), refB = useRef<DesignGraphHandle>(null);

  const dA = A.design?.decisions, dB = B.design?.decisions;
  const diff = useMemo(() => (domain && dA && dB ? diffDesigns(domain, dA, dB) : null), [domain, dA, dB]);
  const moved = useMemo(() => new Set(diff?.movedClasses.map((m) => m.cls) ?? []), [diff]);
  // the URL state speaks A's service ids; B's services follow the A service they match
  const collapsed = useMemo(() => collapsedOf(dA?.services ?? [], isCollapsed), [dA, isCollapsed]);
  const collapsedB = useMemo(() => collapsedOf(dB?.services ?? [], isCollapsed, (s) => diff?.bToA.get(s) ?? s), [dB, isCollapsed, diff]);

  const accentA = useCallback((s: Id) => { const i = dA?.services.findIndex((x) => x.id === s) ?? -1; return serviceAccent(PALETTES[theme], i, Math.max(dA?.services.length ?? 0, dB?.services.length ?? 0)); }, [dA, dB, theme]);
  // colour follows the entity: B's services take the colour of the A service they match
  const accentB = useCallback((s: Id) => { const a = diff?.bToA.get(s); return a ? accentA(a) : null; }, [diff, accentA]);

  const onLayoutA = useCallback((r: LayoutResult, g: DG) => setLayoutA({ r, g }), []);
  const onLayoutB = useCallback((r: LayoutResult, g: DG) => setLayoutB({ r, g }), []);
  // B is placed at A's positions: matched services where A has them, its classes where A had them
  const pinB: PinReference | null = useMemo(() => (layoutA && diff ? {
    graph: layoutA.g.layout, result: layoutA.r,
    match: (n: string) => { const a = diff.bToA.get(n.replace(/^svc:/, '')); return a ? svcNode(a) : undefined; },
  } : null), [layoutA, diff]);
  // both panes show the same region (the union of both layouts), pan and zoom together
  const union = useMemo(() => {
    if (!layoutA || !layoutB) return null;
    const a = bounds(layoutA.r), b = bounds(layoutB.r);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
  }, [layoutA, layoutB]);

  const changedB = useMemo(() => {
    if (!diff || !graphB) return new Set<string>();
    return new Set(graphB.edges.filter((e) => diff.mechanismChanges.some((c) => e.parts.some((pt) => pt.layer === c.b && pt.ops.includes(c.op)))).map((e) => e.id));
  }, [diff, graphB]);
  const changedA = useMemo(() => {
    if (!diff || !graphA) return new Set<string>();
    return new Set(graphA.edges.filter((e) => diff.mechanismChanges.some((c) => e.parts.some((pt) => pt.layer === c.a && pt.ops.includes(c.op)))).map((e) => e.id));
  }, [diff, graphA]);

  const hl = (g: DG | null): Highlight | null => {
    if (!g || !domain) return null;
    if (hoveredOp) return opFootprint(domain, g, hoveredOp);
    if (hoverNode?.startsWith('cls:')) {
      const edges = new Set(g.edges.filter((e) => edgeVisible(e, hidden) && (e.source === hoverNode || e.target === hoverNode)).map((e) => e.id));
      const nodes = new Set<string>([hoverNode]);
      for (const e of g.edges) if (edges.has(e.id)) { nodes.add(e.source); nodes.add(e.target); }
      // the hovered class also lights up in the other design's graph
      if (!g.nodes.has(hoverNode)) { const svc = [...g.nodes.values()].find((n) => n.classes?.includes(hoverNode.slice(4))); if (svc) nodes.add(svc.id); }
      return { nodes, edges };
    }
    return null;
  };

  if (A.error || B.error) return <Problem title="Design not available">{String(A.error ?? B.error)}</Problem>;
  if (!A.run || !B.run || !A.design || !B.design) return <Loading label="Loading designs" />;
  if (A.run.domainId !== B.run.domainId) return <Problem title="Different domains">A and B come from runs over different domains ({A.run.domainId}, {B.run.domainId}).</Problem>;
  if (!domain || !dA || !dB || !diff) return <Problem title="Nothing to draw">These designs carry no decisions in the domain form (e.g. runs that record only a layer-2 link map).</Problem>;
  const sameRun = A.run.id === B.run.id;
  const label = (d: Design) => d.label ?? d.id.slice(0, 10);
  const counts: Partial<Record<EdgeLayer, number>> = {};
  for (const e of graphB?.edges ?? []) for (const pt of e.parts) counts[pt.layer] = (counts[pt.layer] ?? 0) + 1;
  const pane = (side: 'a' | 'b') => {
    const S = side === 'a' ? A : B;
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-sm">
          <span className={cn('grid size-5 place-items-center rounded-full text-[10px] font-bold text-white', side === 'a' ? 'bg-select-a' : 'bg-select-b')}>{side.toUpperCase()}</span>
          <span className="font-medium">{label(S.design!)}</span>
          <span className="text-xs text-muted-foreground">{S.design!.decisions!.services.length} services{!sameRun ? ` · ${S.run!.name}` : ''}</span>
          <div className="ml-auto flex items-center">
            {side === 'a' && <Button variant="outline" size="sm" className="mr-1 h-7 text-xs" onClick={() => { refA.current?.resetPositions(); refB.current?.resetPositions(); }} title="Lay A and B out again: expanding or collapsing a service and moving nodes by hand keep the positions until then"><LayoutGrid className="size-3.5" /> Auto-layout</Button>}
            <ExportMenu name={`compare-${side}-${S.run!.id}-${label(S.design!)}`} getSvg={() => (side === 'a' ? refA : refB).current?.toSvg(`${side.toUpperCase()}: ${S.run!.name} — ${label(S.design!)}`, side === 'b' ? `${diff.movedClasses.length} classes moved, ${diff.mechanismChanges.length} mechanisms changed vs A` : undefined) ?? ''} />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {side === 'a' ? (
            <DesignGraphView ref={refA} domain={domain} decisions={dA} collapsed={collapsed} onToggleCollapse={toggleCollapse} onSelectService={detailed ? undefined : selectService} hidden={hidden} highlight={hl(graphA)} accent={accentA}
              moved={moved} changedEdges={changedA} onLayout={onLayoutA} onHoverNode={setHoverNode} layouter={layouter} bundle={bundle} merge={merge} fitBounds={union} viewportSync={sync} />
          ) : pinB ? (
            <DesignGraphView ref={refB} domain={domain} decisions={dB} collapsed={collapsedB} onToggleCollapse={(s) => toggleCollapse(diff.bToA.get(s) ?? s)}
              onSelectService={detailed ? undefined : (s) => selectService(s && (diff.bToA.get(s) ?? s))} hidden={hidden}
              highlight={hl(graphB)} accent={accentB} moved={moved} changedEdges={changedB} pinTo={pinB} onLayout={onLayoutB} onHoverNode={setHoverNode} layouter={layouter} bundle={bundle} merge={merge} fitBounds={union} viewportSync={sync} />
          ) : <Loading label="Waiting for A's layout" />}
        </div>
      </div>
    );
  };

  const deltas = <ObjectiveDeltas run={A.run} A={A.design} B={B.design} />;
  const legend = <GraphLegend hidden={hidden} counts={counts} onToggle={toggleLayer} />;
  return (
    <div ref={root} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        {!narrow && <>
          <h1 className="text-sm font-semibold">Compare</h1>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{label(A.design)} vs {label(B.design)}{sameRun ? ` · ${A.run.name}` : ''}</span>
        </>}
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={ws.swap} title="Swap A and B"><ArrowLeftRight className="size-3.5" />{!narrow && ' Swap'}</Button>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => ws.clear('b')} title="Clear B: A alone"><X className="size-3.5" />{!narrow && ' Clear B'}</Button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {width >= 1500 && legend}
          <GraphTools set={set} services={dA.services.map((s) => s.id)} bundle={bundle} merge={merge} detailed={detailed} setDetailed={setDetailed} collapseAll={collapseAll} />
          {!perfOpen && perfOffered && <Button variant="outline" size="sm" className="h-7" onClick={() => ws.openPanel('perf')}><Gauge className="size-3.5" /> Performance</Button>}
        </div>
      </div>
      <ResizablePanelGroup key={narrow ? 'v' : 'h'} orientation={narrow ? 'vertical' : 'horizontal'} className="min-h-0 flex-1">
        <ResizablePanel defaultSize={narrow ? '64%' : '74%'} minSize="35%">
          <div className="flex h-full flex-col">
            {!narrow && <div className="border-b p-3">{deltas}</div>}
            {!narrow && width < 1500 && <div className="border-b px-3 py-1.5">{legend}</div>}
            <ResizablePanelGroup key={stacked ? 'v' : 'h'} orientation={stacked ? 'vertical' : 'horizontal'} className="min-h-0 flex-1">
              <ResizablePanel defaultSize="50%" minSize="25%">{pane('a')}</ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="50%" minSize="25%">{pane('b')}</ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={narrow ? '36%' : '26%'} minSize="18%">
          <ScrollArea className="h-full">
            {/* narrow: the objective deltas and the legend move here, the graphs keep the height */}
            {narrow && <div className="space-y-2 border-b p-3">{deltas}{legend}</div>}
            <div className="px-3 pb-1 pt-3 text-sm font-semibold">Differences <span className="font-normal text-muted-foreground">B relative to A</span></div>
            <DiffList domain={domain} diff={diff} A={A.design} B={B.design} />
            <div className="border-t px-3 pb-1 pt-3 text-sm font-semibold">Performance <span className="font-normal text-muted-foreground">C1's statistic per request type (simulated)</span></div>
            <Card className="m-3 mt-1 gap-0 py-1"><PerfDeltas domain={domain} a={a} b={b} /></Card>
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
});
