import { Profiler, useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { Eraser, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { EChart, type DenseBuilder, type EChartHandle, type OptionBuilder } from '@/charts/EChart';
import { axisDefs, matrixCells, matrixDense, matrixOption, parallelDense, parallelOption, scatterDense, scatterOption, tooltipHtml, type AxisDef, type ColorBy } from '@/charts/explorerCharts';
import { DesignTable, type SortingState } from '@/components/DesignTable';
import { ExportMenu } from '@/components/ExportMenu';
import { Loading, Problem } from '@/components/States';
import { useDesigns, useRun } from '@/lib/api';
import { PALETTES } from '@/lib/palette';
import { useHover } from '@/lib/store';
import { usePatchUrl, useUrlParams, workspaceActions } from '@/lib/useWorkspace';
import { useElementWidth } from '@/lib/useWidth';
import { useTheme } from '@/lib/theme';
import { formatArea, markedBy, parseAreas, type Area } from '@/lib/areas';
import { areaLabel, ChartAreas, type AreaGrid } from '@/components/ChartAreas';
import { MetricHelp } from '@/help/MetricHelp';

type Mode = 'scatter' | 'matrix' | 'parallel';
/** dev: commits of the design table in window.__tableCommits (a hover over the chart must not commit it) */
const countCommit = () => { if (import.meta.env.DEV) (window as unknown as { __tableCommits?: number }).__tableCommits = ((window as unknown as { __tableCommits?: number }).__tableCommits ?? 0) + 1; };
/** the designs panel's URL parameters */
const DESIGNS_KEYS = ['mode', 'x', 'y', 'color', 'feas', 'front', 'arch', 'sort', 'area'] as const;

/** the chart with the transient hover subscription (a hover re-renders the chart only, not the view) */
function HoverChart({ chartRef, keyIndex, ...rest }: Omit<React.ComponentProps<typeof EChart>, 'ref' | 'highlight'> & { chartRef: React.Ref<EChartHandle>; keyIndex: Map<string, number> }) {
  const hovered = useHover((s) => s.hovered);
  return <EChart ref={chartRef} {...rest} height="100%" highlight={hovered ? keyIndex.get(hovered) ?? null : null} />;
}

/** the designs panel: a run's designs as scatter / matrix / parallel coordinates and a table; click = A, shift-click = B */
export default memo(function ExplorerView({ runId, a, b }: { runId: string; a: string | null; b: string | null }) {
  const sp = useUrlParams(DESIGNS_KEYS);
  const set = usePatchUrl();
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root);
  const narrow = (width ?? 1000) < 860;
  const { data: run, error: runErr } = useRun(runId);
  const { data: list, isLoading } = useDesigns(runId);
  const { theme } = useTheme();
  const setHovered = useHover((s) => s.setHovered);
  const chart = useRef<EChartHandle>(null);
  // marked designs: areas dragged in the scatter / matrix (URL), axis intervals in the parallel coordinates
  const [parBrushed, setParBrushed] = useState<Set<string> | null>(null);
  const intervals = useRef(new Map<number, number[][]>());

  const mode = (sp.get('mode') as Mode) ?? 'scatter';
  const colorBy = (sp.get('color') as ColorBy) ?? 'rank';
  const feasOnly = sp.get('feas') === '1';
  const frontOnly = sp.get('front') === '1';
  const archOnly = sp.get('arch') === '1';
  // keyed by their own parameters: other URL changes (mode, colour, A/B) must not re-filter or re-sort 50 000 rows
  const sortParam = sp.get('sort');
  const sorting: SortingState = useMemo(() => {
    if (!sortParam) return [{ id: 'rank', desc: false }];
    const [id, dir] = sortParam.split(':');
    return [{ id, desc: dir === 'desc' }];
  }, [sortParam]);
  const areaParam = sp.getAll('area').join('|');
  const areas = useMemo(() => parseAreas(areaParam ? areaParam.split('|') : []), [areaParam]);

  const axes = useMemo(() => (run ? axisDefs(run) : []), [run]);
  const xKey = sp.get('x') ?? run?.objectives[0]?.key;
  const yKey = sp.get('y') ?? run?.objectives[1]?.key;
  const xAxis = axes.find((q) => q.key === xKey) ?? axes[0];
  const yAxis = axes.find((q) => q.key === yKey) ?? axes[1];

  const all = list?.designs ?? [];
  const filtered = useMemo(() => {
    if (!run) return [];
    return all.filter((d) => {
      if (feasOnly && !d.feasible) return false;
      if (frontOnly && d.rank !== 0) return false;
      if (archOnly && !d.inArchive && !d.inFinalPopulation) return false;
      return true;
    });
  }, [all, run, feasOnly, frontOnly, archOnly]);
  const axisGet = useMemo(() => { const m = new Map(axes.map((q) => [q.key, q.get])); return (k: string) => m.get(k); }, [axes]);
  const areaMarked = useMemo(() => (areas.length ? markedBy(filtered, areas, axisGet) : null), [filtered, areas, axisGet]);
  const brushed = mode === 'parallel' && parBrushed ? parBrushed : areaMarked;
  const tableRows = useMemo(() => (brushed ? filtered.filter((d) => brushed.has(d.id)) : filtered), [filtered, brushed]);
  const byId = useMemo(() => new Map(all.map((d) => [d.id, d])), [all]);

  const { select } = workspaceActions;
  const pick = useCallback((id: string, slot: 'a' | 'b') => select({ runId, designId: id }, slot), [select, runId]);
  const open = useCallback((id: string) => select({ runId, designId: id }, 'a'), [select, runId]);

  const parAxes: AxisDef[] = useMemo(() => {
    if (!run) return [];
    const extra = axes.filter((q) => q.key === 'services');
    return [...axes.slice(0, run.objectives.length), ...extra];
  }, [axes, run]);

  const matAxes = useMemo(() => (run ? axes.slice(0, run.objectives.length) : []), [axes, run]);
  const build: OptionBuilder = useCallback((p, ctx) => {
    if (!run || !xAxis || !yAxis) return {};
    const sel = [a && { id: a, kind: 'a' as const }, b && { id: b, kind: 'b' as const }].filter(Boolean) as { id: string; kind: 'a' | 'b' }[];
    if (mode === 'matrix') return matrixOption(p, filtered, matAxes, sel, ctx.exporting);
    if (mode === 'parallel') return parallelOption(p, filtered, parAxes, sel);
    const overlay = [
      ...sel.map((s) => byId.get(s.id)).filter(Boolean).map((d, i) => ({ id: d!.id, x: xAxis.get(d!), y: yAxis.get(d!), label: sel[i].kind, kind: sel[i].kind })),
      ...filtered.filter((d) => d.reference).map((d) => ({ id: d.id, x: xAxis.get(d), y: yAxis.get(d), label: d.label ?? 'ref', kind: 'ref' as const })),
    ];
    return scatterOption(p, filtered, xAxis, yAxis, colorBy, overlay, ctx.exporting);
  }, [run, filtered, xAxis, yAxis, colorBy, mode, a, b, byId, matAxes, parAxes]);

  // the designs themselves: a dense canvas layer (charts/dense.ts)
  const dense: DenseBuilder = useCallback((p) => {
    if (!run || !xAxis || !yAxis) return null;
    if (mode === 'matrix') return matrixDense(p, filtered, matAxes, colorBy, brushed);
    if (mode === 'parallel') return parallelDense(p, filtered, parAxes, colorBy, brushed);
    return scatterDense(p, filtered, xAxis, yAxis, colorBy, brushed);
  }, [run, filtered, xAxis, yAxis, colorBy, mode, matAxes, parAxes, brushed]);
  const keyIndex = useMemo(() => new Map(filtered.map((d, i) => [d.id, i])), [filtered]);
  const denseHover = useCallback((k: number | null) => setHovered(k === null ? null : filtered[k]?.id ?? null), [filtered, setHovered]);
  const denseClick = useCallback((k: number, e: MouseEvent) => { const d = filtered[k]; if (d) pick(d.id, e.shiftKey || e.altKey ? 'b' : 'a'); }, [filtered, pick]);
  const denseDbl = useCallback((k: number) => { const d = filtered[k]; if (d) open(d.id); }, [filtered, open]);
  const denseTip = useCallback((k: number) => (run && filtered[k] ? tooltipHtml(run, filtered[k]) : ''), [run, filtered]);

  // parallel axis intervals: reset when the view changes
  useEffect(() => { setParBrushed(null); intervals.current.clear(); }, [mode, feasOnly, frontOnly, archOnly, runId]);

  const onEvents = useMemo(() => ({
    axisareaselected: (q: any) => {
      // the event carries the intervals of one axis (id "pa<i>"); keep all axes' intervals and filter ourselves
      const i = Number(String(q.parallelAxisId ?? '').replace(/^\D+/, ''));
      if (Number.isNaN(i)) return;
      intervals.current.set(i, q.intervals ?? []);
      const active = [...intervals.current.entries()].filter(([, iv]) => iv.length);
      if (!active.length) { setParBrushed(null); return; }
      setParBrushed(new Set(filtered.filter((d) => active.every(([k, iv]) => { const v = parAxes[k].get(d); return iv.some(([lo, hi]) => v >= lo && v <= hi); })).map((d) => d.id)));
    },
  }), [filtered, parAxes]);

  // areas: drag = this area only, shift-drag = one more; × removes one; Reset or Escape clears all
  const areaGrids: AreaGrid[] = useMemo(() => {
    if (mode === 'scatter' && xAxis && yAxis) return [{ gi: 0, x: xAxis, y: yAxis }];
    if (mode === 'matrix') return matrixCells(matAxes.length).map(({ c, r }, gi) => ({ gi, x: matAxes[c], y: matAxes[r] }));
    return [];
  }, [mode, xAxis, yAxis, matAxes]);
  const addArea = useCallback((ar: Area, additive: boolean) => set((n) => { if (!additive) n.delete('area'); n.append('area', formatArea(ar)); }), [set]);
  const removeArea = useCallback((i: number) => set((n) => { const v = n.getAll('area'); n.delete('area'); v.forEach((x, k) => k !== i && n.append('area', x)); }), [set]);
  const resetMarks = useCallback(() => {
    set((n) => n.delete('area'));
    if (intervals.current.size) {
      intervals.current.clear();
      setParBrushed(null);
      chart.current?.instance()?.setOption(build(PALETTES[theme], { exporting: false }), { notMerge: true });
    }
  }, [set, build, theme]);
  useEffect(() => {
    if (!brushed) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) resetMarks();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [brushed, resetMarks]);

  if (runErr) return <Problem title="Run not available">{String(runErr)}</Problem>;
  if (!run || isLoading) return <Loading label="Loading designs" />;
  const axisSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <div className="flex items-center gap-0.5">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-8 w-[170px]" aria-label={label}><span className="text-muted-foreground">{label}</span><SelectValue /></SelectTrigger>
        <SelectContent>{axes.map((q) => <SelectItem key={q.key} value={q.key}>{q.label}</SelectItem>)}</SelectContent>
      </Select>
      <MetricHelp k={value} />
    </div>
  );

  return (
    <div ref={root} className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="mr-1 whitespace-nowrap text-xs text-muted-foreground">{filtered.length.toLocaleString()} of {all.length.toLocaleString()} designs</div>
        <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && set({ mode: v })} aria-label="Chart">
          <ToggleGroupItem value="scatter" className="px-3">Scatter</ToggleGroupItem>
          <ToggleGroupItem value="matrix" className="px-3">Matrix</ToggleGroupItem>
          <ToggleGroupItem value="parallel" className="px-3">Parallel</ToggleGroupItem>
        </ToggleGroup>
        {mode === 'scatter' && <>{axisSelect(xAxis.key, (v) => set({ x: v }), 'x')}{axisSelect(yAxis.key, (v) => set({ y: v }), 'y')}</>}
        <Select value={colorBy} onValueChange={(v) => set({ color: v === 'rank' ? null : v })}>
          <SelectTrigger size="sm" className="h-8 w-[190px]" aria-label="Colour by"><span className="text-muted-foreground">colour</span><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="rank">front / rest</SelectItem>
            {run.metrics.some((m) => m.key === 'services') && <SelectItem value="services">services</SelectItem>}
            <SelectItem value="born">generation born</SelectItem>
          </SelectContent>
        </Select>
        <MetricHelp k={colorBy} className="-ml-1.5" />
        <div className="flex items-center gap-3 pl-1 text-xs">
          <Label className="flex items-center gap-1.5 text-xs font-normal"><Switch checked={feasOnly} onCheckedChange={(v) => set({ feas: v ? '1' : null })} /> feasible</Label>
          <Label className="flex items-center gap-1.5 text-xs font-normal"><Switch checked={frontOnly} onCheckedChange={(v) => set({ front: v ? '1' : null })} /> front</Label>
          {(run.archive || run.finalPopulation) && <Label className="flex items-center gap-1.5 text-xs font-normal"><Switch checked={archOnly} onCheckedChange={(v) => set({ arch: v ? '1' : null })} /> archive / final</Label>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ExportMenu name={`${run.id}-${mode}${mode === 'scatter' ? `-${xAxis.key}-${yAxis.key}` : ''}`} getSvg={() => chart.current!.toSvg(`${run.name}: ${mode === 'scatter' ? `${xAxis.label} vs ${yAxis.label}` : mode === 'matrix' ? 'objective matrix' : 'parallel coordinates'}`)} />
        </div>
      </div>
      <ResizablePanelGroup key={narrow ? 'v' : 'h'} orientation={narrow ? 'vertical' : 'horizontal'} className="min-h-0 flex-1">
        <ResizablePanel defaultSize={narrow ? '58%' : '62%'} minSize="30%">
          <div className={narrow ? 'flex h-full flex-col p-3 pb-1.5' : 'flex h-full flex-col p-3 pr-1.5'}>
            {brushed && (
              <div className="flex flex-wrap items-center gap-1.5 pb-2 text-xs">
                <span className="font-medium">{brushed.size.toLocaleString()} marked</span>
                {mode === 'parallel' && parBrushed ? <span className="text-muted-foreground">by axis intervals</span> : areas.map((ar, i) => (
                  <span key={i} className="flex h-6 items-center gap-1 rounded-md border bg-card pl-2 pr-0.5 text-muted-foreground">
                    {areaLabel(ar, axes)}
                    <button className="grid size-5 place-items-center rounded hover:bg-accent hover:text-foreground" onClick={() => removeArea(i)} aria-label="Remove area"><X className="size-3" /></button>
                  </span>
                ))}
                <Button variant="outline" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={resetMarks} title="Clear every marked area (Escape)"><Eraser className="size-3" /> Reset</Button>
              </div>
            )}
            <Card className="relative min-h-0 flex-1 gap-0 p-2">
              <ChartAreas chartRef={chart} grids={areaGrids} areas={areas} onAdd={addArea} onRemove={removeArea}>
                <HoverChart chartRef={chart} build={build} dense={dense} keyIndex={keyIndex} onEvents={onEvents}
                  onDenseHover={denseHover} onDenseClick={denseClick} onDenseDblClick={denseDbl} denseTooltip={denseTip} />
              </ChartAreas>
              {mode === 'scatter' && colorBy === 'rank' && (
                <div className="pointer-events-none absolute left-20 top-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-series-1" /> non-dominated</span>
                  <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-muted-foreground/40" /> dominated</span>
                  <span className="flex items-center gap-1"><span className="size-2 rounded-full border border-muted-foreground" /> infeasible</span>
                  <span className="flex items-center gap-1"><span className="size-2 rotate-45 bg-secondary-text" /> reference</span>
                </div>
              )}
              <div className="pointer-events-none absolute bottom-1 right-3 text-[10.5px] text-muted-foreground">{mode === 'parallel' ? 'drag along an axis to mark' : 'drag: mark · shift-drag: add · Esc: reset'}</div>
            </Card>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={narrow ? '42%' : '38%'} minSize="22%">
          <div className={narrow ? 'h-full p-3 pt-1.5' : 'h-full p-3 pl-1.5'}>
            <Card className="h-full gap-0 overflow-hidden p-0">
              <Profiler id="design-table" onRender={countCommit}>
                <DesignTable run={run} designs={tableRows} universe={all} a={a} b={b} onPick={pick} onOpen={open} sorting={sorting}
                onSorting={(s) => set({ sort: s[0] ? `${s[0].id}:${s[0].desc ? 'desc' : 'asc'}` : null })} />
              </Profiler>
            </Card>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
});
