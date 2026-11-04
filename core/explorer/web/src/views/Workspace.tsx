import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronsLeft, List, Network, ScatterChart, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Loading } from '@/components/States';
import { useIndex, useRun } from '@/lib/api';
import { useDesignLabel } from '@/components/WorkspaceToolbar';
import { PANEL_ICON } from '@/lib/panelIcons';
import { useFocusPanel, useSelection } from '@/lib/store';
import { setAvailablePanels, storePanels, useAvailablePanels, usePanelAvailable, useSelectionState, useWorkspace, workspaceActions } from '@/lib/useWorkspace';
import { useElementWidth } from '@/lib/useWidth';
import { useTexts } from '@/lib/packet';
import { cn } from '@/lib/utils';
import { defaultRun, fitPanels, HANDLE_WIDTH, PANEL_IDS, PANEL_MIN, PANEL_TITLE, PANEL_WEIGHT, RAIL_WIDTH, ref as mkRef, type DesignRef, type PanelId } from '@/lib/workspace';

const RunsView = lazy(() => import('@/views/RunsView'));
const ExplorerView = lazy(() => import('@/views/ExplorerView'));
const DesignView = lazy(() => import('@/views/DesignView'));
const CompareView = lazy(() => import('@/views/CompareView'));
const PerformanceView = lazy(() => import('@/views/PerformanceView'));
const ModelView = lazy(() => import('@/views/ModelView'));

const ICON = PANEL_ICON;
/** dragging a divider this far below a panel's minimum width collapses the panel to its rail */
const COLLAPSE_SLACK = 56;
const WEIGHTS_KEY = 'explorer.panelWeights';

function loadWeights(): Record<PanelId, number> {
  try {
    const w = JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? 'null');
    // a panel added later (Model) takes its default share next to the stored ones
    if (w && typeof w === 'object') return Object.fromEntries(PANEL_IDS.map((p) => [p, typeof w[p] === 'number' && w[p] > 0 ? w[p] : PANEL_WEIGHT[p]])) as Record<PanelId, number>;
  } catch { /* none or blocked */ }
  return { ...PANEL_WEIGHT };
}
function saveWeights(w: Record<PanelId, number>) {
  try { localStorage.setItem(WEIGHTS_KEY, JSON.stringify(w)); } catch { /* blocked */ }
}

function Hint({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center p-6">
      <div className="flex max-w-xs flex-col items-center gap-2 text-center text-sm text-muted-foreground">
        <Icon className="size-6 opacity-50" />
        {children}
      </div>
    </div>
  );
}

/** what a panel shows next to its title */
export const PanelContext = memo(function PanelContext({ id }: { id: PanelId }) {
  const ws = useSelectionState();
  const { data: run } = useRun(ws.run ?? undefined);
  const la = useDesignLabel(ws.a), lb = useDesignLabel(ws.b);
  const tx = useTexts();
  if (id === 'designs') return run ? <>{run.name}</> : null;
  if (id === 'arch' || id === 'perf') return la ? <>{la}{lb ? <> <span className="opacity-70">vs</span> {lb}</> : null}</> : null;
  // the packet's words for the input model
  if (id === 'model') { const t = tx('workspace.panel.model.context'); return t ? <>{t}</> : null; }
  return null;
});

/** a panel's content; subscribes to run, A and B only (the panels' own parameters inside) */
const PanelBody = memo(function PanelBody({ id }: { id: PanelId }) {
  const ws = useSelectionState();
  const local = (r: DesignRef | null) => (r && r.runId === ws.run ? r.designId : null);
  let body: ReactNode;
  if (id === 'runs') body = <RunsView runId={ws.run} />;
  else if (id === 'designs') body = ws.run ? <ExplorerView key={ws.run} runId={ws.run} a={local(ws.a)} b={local(ws.b)} /> : <Hint icon={List}>Pick a run in <b>Runs</b>.</Hint>;
  else if (id === 'arch') {
    body = !ws.a ? <Hint icon={ScatterChart}>Click a design in <b>Designs</b> to see its architecture; shift-click a second one (B) to compare the two.</Hint>
      : ws.b ? <CompareView a={ws.a} b={ws.b} /> : <DesignView key={mkRef(ws.a.runId, ws.a.designId)} runId={ws.a.runId} designId={ws.a.designId} />;
  } else if (id === 'model') body = <ModelView />;
  else body = !ws.a ? <Hint icon={ScatterChart}>Click a design in <b>Designs</b> (A) to see its performance; shift-click a second one (B) to compare.</Hint>
    : <PerformanceView a={ws.a} b={ws.b} />;
  return <Suspense fallback={<Loading label="Loading panel" />}>{body}</Suspense>;
});

/** an open panel: header (title, context, collapse, close) and body; hidden while it is a rail */
const PanelSection = memo(function PanelSection({ id, hidden, flex, minWidth, sectionRef }: { id: PanelId; hidden: boolean; flex: string; minWidth: number; sectionRef: (el: HTMLElement | null) => void }) {
  const Icon = ICON[id];
  const ws = workspaceActions;
  const model = usePanelAvailable('model');
  return (
    <section ref={sectionRef} aria-label={PANEL_TITLE[id]} data-panel={id} hidden={hidden}
      className={cn('h-full min-w-0 flex-col overflow-hidden', hidden ? 'hidden' : 'flex')} style={hidden ? undefined : { flex, minWidth }}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/30 pl-3 pr-1">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <h2 className="shrink-0 text-[13px] font-semibold">{PANEL_TITLE[id]}</h2>
        <span className="min-w-0 truncate text-xs text-muted-foreground"><PanelContext id={id} /></span>
        <div className="ml-auto flex shrink-0 items-center">
          <Tooltip><TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => ws.collapsePanel(id, true)} aria-label={`Collapse ${PANEL_TITLE[id]}`}><ChevronsLeft className="size-3.5" /></Button>
          </TooltipTrigger><TooltipContent>Collapse to a rail</TooltipContent></Tooltip>
          {id !== 'runs' && (
            <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => ws.closePanel(id)} aria-label={`Close ${PANEL_TITLE[id]}`}><X className="size-3.5" /></Button>
            </TooltipTrigger><TooltipContent>{id === 'perf' || id === 'model' ? 'Close' : model ? 'Close (and the panels to its right but Model)' : 'Close (and the panels to its right)'}</TooltipContent></Tooltip>
          )}
        </div>
      </div>
      <div className="@container relative min-h-0 flex-1">
        <PanelBody id={id} />
      </div>
    </section>
  );
});

function Rail({ id, onExpand, onClose }: { id: PanelId; onExpand: () => void; onClose?: () => void }) {
  const Icon = ICON[id];
  const start = useRef<number | null>(null);
  // a click expands; so does dragging the rail open (outwards by a few pixels)
  return (
    <div className="group flex h-full shrink-0 flex-col items-center border-r bg-muted/30" style={{ width: RAIL_WIDTH }} data-rail={id}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="flex w-full flex-1 touch-none flex-col items-center gap-2 pt-2.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
            onClick={onExpand}
            onPointerDown={(e) => { start.current = e.clientX; e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { if (start.current !== null && Math.abs(e.clientX - start.current) > 12) { start.current = null; onExpand(); } }}
            onPointerUp={() => { start.current = null; }}
            aria-label={`Expand ${PANEL_TITLE[id]}`}>
            <Icon className="size-4 shrink-0" />
            <span className="text-xs font-medium tracking-wide [writing-mode:vertical-rl]">{PANEL_TITLE[id]}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Expand {PANEL_TITLE[id]}</TooltipContent>
      </Tooltip>
      {onClose && <Button variant="ghost" size="icon" className="mb-1.5 size-7 text-muted-foreground" onClick={onClose} aria-label={`Close ${PANEL_TITLE[id]}`}><X className="size-3.5" /></Button>}
    </div>
  );
}

function Divider({ onDown }: { onDown: (e: React.PointerEvent<HTMLDivElement>) => void }) {
  return (
    <div role="separator" aria-orientation="vertical" onPointerDown={onDown}
      className="group relative flex h-full shrink-0 cursor-col-resize touch-none items-center justify-center" style={{ width: HANDLE_WIDTH }}>
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-ring group-active:bg-ring" />
      <span className="relative z-10 h-6 w-1 rounded-full bg-border transition-colors group-hover:bg-ring" />
    </div>
  );
}

/** the open panels left to right; when they do not fit, the leftmost collapse to rails */
function PanelStrip() {
  const ws = useWorkspace();
  const focus = useFocusPanel((s) => s.focus);
  const strip = useRef<HTMLDivElement>(null);
  const width = useElementWidth(strip);
  const [weights, setWeights] = useState(loadWeights);
  const sections = useRef(new Map<PanelId, HTMLElement>());
  const shown = useRef(new Set<PanelId>());
  const refFns = useRef(new Map<PanelId, (el: HTMLElement | null) => void>());
  const sectionRef = (id: PanelId) => {
    let f = refFns.current.get(id);
    if (!f) refFns.current.set(id, f = (el) => { if (el) sections.current.set(id, el); else sections.current.delete(id); });
    return f;
  };
  // the open panels the packet offers (a URL may name the Model or Performance panel of another packet)
  const avail = useAvailablePanels();
  const open = useMemo(() => ws.panels.filter((p) => avail.includes(p)), [ws.panels, avail]);
  const expanded = useMemo(() => (width ? fitPanels(open, width, focus, ws.rails) : []), [open, width, focus, ws.rails]);
  const setExpanded = useFocusPanel((s) => s.setExpanded);
  useEffect(() => { setExpanded(expanded); }, [expanded, setExpanded]);

  const startDrag = useCallback((e: React.PointerEvent<HTMLDivElement>, left: PanelId, right: PanelId) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const px = new Map(expanded.map((p) => [p, sections.current.get(p)?.getBoundingClientRect().width ?? PANEL_MIN[p]]));
    const totalPx = [...px.values()].reduce((s, v) => s + v, 0);
    const totalW = expanded.reduce((s, p) => s + weights[p], 0);
    const toW = (v: number) => (v / totalPx) * totalW;
    const x0 = e.clientX, wl = px.get(left)!, wr = px.get(right)!;
    let latest = weights;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const nl = wl + dx, nr = wr - dx;
      if (nl < PANEL_MIN[left] - COLLAPSE_SLACK) { stop(); ws.collapsePanel(left, true); return; }
      if (nr < PANEL_MIN[right] - COLLAPSE_SLACK) { stop(); ws.collapsePanel(right, true); return; }
      const l = Math.max(PANEL_MIN[left], Math.min(wl + wr - PANEL_MIN[right], nl));
      const next = { ...weights };
      for (const [p, v] of px) next[p] = toW(v);
      next[left] = toW(l); next[right] = toW(wl + wr - l);
      latest = next;
      setWeights(next);
    };
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointercancel', stop);
      saveWeights(latest);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }, [expanded, weights, ws]);

  const items: ReactNode[] = [];
  let prev: PanelId | null = null;
  for (const id of open) {
    const isRail = !expanded.includes(id);
    if (isRail) items.push(<Rail key={`rail-${id}`} id={id} onExpand={() => ws.collapsePanel(id, false)} onClose={id === 'runs' ? undefined : () => ws.closePanel(id)} />);
    else {
      if (prev) { const l = prev; items.push(<Divider key={`div-${id}`} onDown={(e) => startDrag(e, l, id)} />); }
      prev = id;
      shown.current.add(id);
    }
    // a panel that was shown stays mounted while it is a rail (expanding it again is instant)
    if (shown.current.has(id)) {
      items.push(<PanelSection key={id} id={id} hidden={isRail} flex={`${weights[id]} 1 0px`} minWidth={Math.min(PANEL_MIN[id], width ?? 0)} sectionRef={sectionRef(id)} />);
    }
  }
  for (const id of [...shown.current]) if (!open.includes(id)) shown.current.delete(id);
  return (
    <div ref={strip} className="flex min-h-0 flex-1 overflow-hidden">
      {width !== null && items}
      {width !== null && !expanded.length && (
        <div className="min-w-0 flex-1"><Hint icon={Network}>Expand a panel from its rail.</Hint></div>
      )}
    </div>
  );
}

/** the one page: the panel strip (the panel toggles and A/B sit in the header, WorkspaceToolbar) */
export default function Workspace() {
  const ws = useWorkspace();
  const idx = useIndex();
  const sel = useSelection();
  const pRaw = ws.sp.get('p');
  const avail = useAvailablePanels();
  useEffect(() => { setAvailablePanels(avail); }, [avail]);

  // no run in the URL: the newest real run
  useEffect(() => {
    if (!ws.run && idx.data) { const r = defaultRun(idx.data.runs); if (r) ws.patch({ run: r }); }
  }, [ws.run, idx.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pRaw) storePanels(pRaw); }, [pRaw]);
  // the global selection mirrors the URL
  useLayoutEffect(() => {
    sel.set({ run: ws.run, a: ws.a && mkRef(ws.a.runId, ws.a.designId), b: ws.b && mkRef(ws.b.runId, ws.b.designId) });
  }, [ws.run, ws.a, ws.b]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      <PanelStrip />
    </div>
  );
}
