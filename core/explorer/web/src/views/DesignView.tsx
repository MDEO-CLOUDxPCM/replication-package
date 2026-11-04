import { useCallback, useMemo, useRef, useState, memo } from 'react';
import { Gauge, Maximize, ChevronsDownUp, ChevronsUpDown, LayoutGrid } from 'lucide-react';
import type { Id } from '@contract/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Loading, Problem } from '@/components/States';
import { ExportMenu } from '@/components/ExportMenu';
import { AccessesPanel, DesignTabs, EffectsPanel, OperationsPanel, Overview, RawDecisions, SagasPanel, ServicesPanel } from '@/components/DesignPanels';
import { DesignGraphView, type DesignGraphHandle, type Highlight } from '@/graph/DesignGraph';
import { GraphLegend } from '@/graph/Legend';
import { buildDesignGraph, DEFAULT_HIDDEN, edgeVisible, opFootprint, svcNode, clsNode, type EdgeLayer } from '@/graph/build';
import { DEFAULT_LAYOUTER, layouters } from '@layout/index';
import { useDesign, useDomain, useRun } from '@/lib/api';
import { PALETTES, serviceAccent } from '@/lib/palette';
import { useHover } from '@/lib/store';
import { usePanelAvailable, usePanelOpen, usePatchUrl, useUrlParams, workspaceActions } from '@/lib/useWorkspace';
import { useElementWidth } from '@/lib/useWidth';
import { useTheme } from '@/lib/theme';

/** the architecture panel's URL parameters */
const GRAPH_KEYS = ['hide', 'detail', 'collapsed', 'open', 'layouter', 'edges', 'types', 'tab', 'op'] as const;

export function useGraphUrlState() {
  const sp = useUrlParams(GRAPH_KEYS);
  const set = usePatchUrl();
  const hidden = useMemo(() => new Set((sp.get('hide') ?? DEFAULT_HIDDEN.join(',')).split(',').filter(Boolean) as EdgeLayer[]), [sp]);
  // default: components only (every service collapsed, edges between services); a clicked service
  // (`open`) shows its classes, any number at once. `detail=1`: every service expanded except the ones in `collapsed`.
  const detailed = sp.get('detail') === '1';
  const collapsedParam = useMemo(() => new Set((sp.get('collapsed') ?? '').split(',').filter(Boolean)), [sp]);
  const open = useMemo(() => new Set((sp.get('open') ?? '').split(',').filter(Boolean)), [sp]);
  const isCollapsed = useCallback((s: Id) => (detailed ? collapsedParam.has(s) : !open.has(s)), [detailed, collapsedParam, open]);
  const toggleLayer = (l: EdgeLayer) => { const h = new Set(hidden); if (h.has(l)) h.delete(l); else h.add(l); set({ hide: [...h].join(',') || ',' }); };
  const toggleIn = (key: 'collapsed' | 'open', cur: Set<string>, s: Id) => { const c = new Set(cur); if (c.has(s)) c.delete(s); else c.add(s); set({ [key]: [...c].join(',') || null }); };
  const toggleCollapse = (s: Id) => (detailed ? toggleIn('collapsed', collapsedParam, s) : toggleIn('open', open, s));
  /** components mode: show this service's classes (again: hide them); the other open services stay open */
  const selectService = (s: Id | null) => { if (!detailed && s) toggleIn('open', open, s); };
  /** every service collapsed / expanded, in either mode */
  const collapseAll = (services: Id[], on: boolean) => set(detailed ? { collapsed: on ? services.join(',') : null } : { open: on ? null : services.join(',') });
  const setDetailed = (on: boolean) => set({ detail: on ? '1' : null, open: null, collapsed: null });
  // default: one edge per direction between two nodes, every dependency type merged (`types=1`: one per type)
  return { sp, set, hidden, isCollapsed, detailed, setDetailed, selectService, collapseAll, toggleLayer, toggleCollapse, layouter: layouters().some((l) => l.id === sp.get('layouter')) ? sp.get('layouter')! : DEFAULT_LAYOUTER, bundle: sp.get('edges') !== 'classes', merge: sp.get('types') !== '1' };
}

/** services of a design that are drawn collapsed (`key` maps a service to the id the URL state uses) */
export function collapsedOf(services: { id: Id }[], isCollapsed: (s: Id) => boolean, key: (s: Id) => Id = (s) => s): Set<Id> {
  return new Set(services.filter((s) => isCollapsed(key(s.id))).map((s) => s.id));
}

/** components / detailed, edge detail, collapse / expand all */
export function GraphTools({ set, services, bundle, merge, detailed, setDetailed, collapseAll }: { set: (p: Record<string, string | null>) => void; services: Id[]; bundle: boolean; merge: boolean; detailed: boolean; setDetailed: (on: boolean) => void; collapseAll: (services: Id[], on: boolean) => void }) {
  return (
    <>
      <ToggleGroup type="single" size="sm" variant="outline" value={detailed ? 'detailed' : 'components'} onValueChange={(v) => v && setDetailed(v === 'detailed')} aria-label="Graph detail">
        <ToggleGroupItem value="components" className="h-7 px-2 text-xs" title="services only, edges between services; click a service to show its classes">components</ToggleGroupItem>
        <ToggleGroupItem value="detailed" className="h-7 px-2 text-xs" title="every service with its classes; click a collapsed service to open it">detailed</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup type="single" size="sm" variant="outline" value={merge ? 'merged' : 'types'} onValueChange={(v) => v && set({ types: v === 'types' ? '1' : null })} aria-label="Dependency types">
        <ToggleGroupItem value="merged" className="h-7 px-2 text-xs" title="one arrow per direction, all dependency types together, width by rate">merged</ToggleGroupItem>
        <ToggleGroupItem value="types" className="h-7 px-2 text-xs" title="one arrow per dependency type (colour and dash per mechanism)">by type</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup type="single" size="sm" variant="outline" value={bundle ? 'services' : 'classes'} onValueChange={(v) => v && set({ edges: v === 'classes' ? 'classes' : null })} aria-label="Edge detail">
        <ToggleGroupItem value="services" className="h-7 px-2 text-xs" title="accesses between services, width by rate">by service</ToggleGroupItem>
        <ToggleGroupItem value="classes" className="h-7 px-2 text-xs" title="accesses between classes (of expanded services)">by class</ToggleGroupItem>
      </ToggleGroup>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-7" onClick={() => collapseAll(services, true)} aria-label="Collapse all"><ChevronsDownUp className="size-4" /></Button></TooltipTrigger><TooltipContent>Collapse all services</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-7" onClick={() => collapseAll(services, false)} aria-label="Expand all"><ChevronsUpDown className="size-4" /></Button></TooltipTrigger><TooltipContent>Expand all services</TooltipContent></Tooltip>
    </>
  );
}

/** the architecture panel with one design (A): its graph and side tabs */
export default memo(function DesignView({ runId, designId }: { runId: string; designId: string }) {
  const perfOpen = usePanelOpen('perf'), perfOffered = usePanelAvailable('perf');
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root);
  const narrow = (width ?? 1200) < 1000;
  const { sp, set, hidden, isCollapsed, detailed, setDetailed, selectService, collapseAll, toggleLayer, toggleCollapse, layouter, bundle, merge } = useGraphUrlState();
  const { data: run } = useRun(runId);
  const { data: design, error } = useDesign(runId, designId);
  const { data: domain, isLoading: domLoading } = useDomain(run?.domainId);
  const { theme } = useTheme();
  const hoveredOp = useHover((s) => s.hoveredOp);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverSvc, setHoverSvc] = useState<Id | null>(null);
  const graphRef = useRef<DesignGraphHandle>(null);
  const tab = sp.get('tab') ?? 'overview';
  const pinned = sp.get('op');

  const decisions = design?.decisions;
  const collapsed = useMemo(() => collapsedOf(decisions?.services ?? [], isCollapsed), [decisions, isCollapsed]);
  const graph =useMemo(() => (domain && decisions ? buildDesignGraph(domain, decisions, { collapsed, bundle, merge }) : null), [domain, decisions, collapsed, bundle, merge]);
  const accent = useCallback((s: Id) => {
    if (!decisions) return null;
    const i = decisions.services.findIndex((x) => x.id === s);
    return serviceAccent(PALETTES[theme], i, decisions.services.length);
  }, [decisions, theme]);

  const highlight: Highlight | null = useMemo(() => {
    if (!graph || !domain) return null;
    const op = hoveredOp ?? pinned;
    if (op) return opFootprint(domain, graph, op);
    if (hoverSvc) {
      const nodes = new Set<string>([svcNode(hoverSvc), ...(decisions?.services.find((s) => s.id === hoverSvc)?.classes.map(clsNode) ?? [])]);
      const edges = new Set(graph.edges.filter((e) => nodes.has(e.source) || nodes.has(e.target)).map((e) => e.id));
      return { nodes, edges };
    }
    if (hoverNode && graph.nodes.get(hoverNode)?.kind !== 'service') {
      const edges = new Set(graph.edges.filter((e) => edgeVisible(e, hidden) && (e.source === hoverNode || e.target === hoverNode)).map((e) => e.id));
      const nodes = new Set<string>([hoverNode]);
      for (const e of graph.edges) if (edges.has(e.id)) { nodes.add(e.source); nodes.add(e.target); }
      return { nodes, edges };
    }
    return null;
  }, [graph, domain, hoveredOp, pinned, hoverNode, hoverSvc, decisions, hidden]);

  const counts = useMemo(() => {
    const c: Partial<Record<EdgeLayer, number>> = {};
    for (const e of graph?.edges ?? []) for (const pt of e.parts) c[pt.layer] = (c[pt.layer] ?? 0) + 1;
    return c;
  }, [graph]);

  if (error) return <Problem title="Design not available">{String(error)}</Problem>;
  if (!run || !design || domLoading) return <Loading label="Loading design" />;
  const title = design.label ?? design.id.slice(0, 10);
  const rankBadge = !design.feasible ? <Badge variant="destructive">infeasible</Badge> : design.rank === 0 ? <Badge>non-dominated</Badge> : <Badge variant="secondary">rank {design.rank}</Badge>;
  const canDraw = !!(domain && decisions && graph);

  return (
    <div ref={root} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          {rankBadge}
          {decisions && <span className="text-xs text-muted-foreground">{decisions.services.length} services · {decisions.databases.length} databases</span>}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {!perfOpen && perfOffered && <Button variant="outline" size="sm" className="h-7" onClick={() => workspaceActions.openPanel('perf')}><Gauge className="size-3.5" /> Performance</Button>}
          {canDraw && <ExportMenu name={`${run.id}-${design.label ?? design.id}-cut`} getSvg={() => graphRef.current?.toSvg(`${run.name} — ${title}`, `${decisions!.services.length} services · ${run.objectives.map((o, k) => `${o.label} ${design.objectives[k].toFixed(o.digits ?? 2)}`).join(' · ')}`) ?? ''} />}
        </div>
      </div>
      <ResizablePanelGroup key={narrow ? 'v' : 'h'} orientation={narrow ? 'vertical' : 'horizontal'} className="min-h-0 flex-1">
        <ResizablePanel defaultSize={narrow ? '62%' : '70%'} minSize="30%">
          {canDraw ? (
            <div className="flex h-full flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
                <GraphLegend hidden={hidden} counts={counts} onToggle={toggleLayer} />
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                  <GraphTools set={set} services={decisions!.services.map((s) => s.id)} bundle={bundle} merge={merge} detailed={detailed} setDetailed={setDetailed} collapseAll={collapseAll} />
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => graphRef.current?.fit()} aria-label="Fit" title="Fit"><Maximize className="size-3.5" /></Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => graphRef.current?.resetPositions()} title="Lay the graph out again: expanding or collapsing a service and moving nodes by hand keep the positions until then"><LayoutGrid className="size-3.5" /> Auto-layout</Button>
                  {layouters().length > 1 && (
                    <Select value={layouter} onValueChange={(v) => set({ layouter: v === DEFAULT_LAYOUTER ? null : v })}>
                      <SelectTrigger size="sm" className="h-7 w-[170px] text-xs" aria-label="Layouter"><SelectValue /></SelectTrigger>
                      <SelectContent>{layouters().map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <DesignGraphView ref={graphRef} domain={domain!} decisions={decisions!} collapsed={collapsed} onToggleCollapse={toggleCollapse} hidden={hidden}
                  onSelectService={detailed ? undefined : selectService}
                  highlight={highlight} accent={accent} onHoverNode={setHoverNode} layouter={layouter} bundle={bundle} merge={merge} />
              </div>
            </div>
          ) : (
            <Card className="m-4"><RawDecisions design={design} /></Card>
          )}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={narrow ? '38%' : '30%'} minSize="20%">
          <DesignTabs tab={tab} onTab={(t) => set({ tab: t === 'overview' ? null : t })} tabs={[
            { id: 'overview', label: 'Overview', content: <Overview run={run} design={design} /> },
            ...(canDraw ? [
              { id: 'services', label: 'Services', content: <ServicesPanel domain={domain!} design={design} derived={graph!.derived} accent={accent} onHover={setHoverSvc} /> },
              { id: 'operations', label: 'Operations', ownScroll: true, content: <OperationsPanel domain={domain!} derived={graph!.derived} pinned={pinned} onPin={(o) => set({ op: o })} /> },
              { id: 'accesses', label: 'Accesses', ownScroll: true, content: <AccessesPanel domain={domain!} design={design} derived={graph!.derived} /> },
              ...(graph!.derived.effects.length ? [{ id: 'effects', label: 'Effects', ownScroll: true, content: <EffectsPanel domain={domain!} design={design} derived={graph!.derived} /> }] : []),
              { id: 'sagas', label: 'Sagas', content: <SagasPanel domain={domain!} design={design} derived={graph!.derived} /> },
            ] : []),
          ]} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
});
