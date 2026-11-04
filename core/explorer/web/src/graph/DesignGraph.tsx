import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, ControlButton, type NodeChange, Handle, Position, MarkerType, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronsDownUp, ChevronsUpDown, Database, Layers, Loader2, Maximize } from 'lucide-react';
import type { Decisions, Domain, Id } from '@contract/types';
import { DEFAULT_LAYOUTER, getLayouter, type Box, type LayoutResult } from '@layout/index';
import { completeRoutes, pinLayout, type PinReference } from '@layout/pin';
import { onBorder } from '@layout/route';
import type { LayoutGraph } from '@layout/types';
import { applyMoves, keepPositions, layoutKey, loadMoves, saveMoves, type Moves } from './moves';
import { MECHANISM_STYLE, PALETTES, edgeColor } from '@/lib/palette';
import { useTheme } from '@/lib/theme';
import { useEdgeVocab } from '@/lib/edgeVocab';
import { usePanelAvailable, workspaceActions } from '@/lib/useWorkspace';
import { cn } from '@/lib/utils';
import { buildDesignGraph, edgeVisible, edgeWidth, svcNode, visibleParts, type DesignGraph as DG, type EdgeLayer } from './build';
import { graphToSvg, pathD } from './svg';
import { contentBounds, useFit } from './fit';

export interface Highlight { nodes: Set<string>; edges: Set<string> }

export interface DesignGraphProps {
  domain: Domain;
  decisions: Decisions;
  collapsed: Set<Id>;
  onToggleCollapse: (service: Id) => void;
  /** a click on a service selects it (null: on the background); set in the components mode */
  onSelectService?: (service: Id | null) => void;
  hidden: Set<EdgeLayer>;
  highlight?: Highlight | null;
  /** service -> accent colour (null: neutral) */
  accent: (service: Id) => string | null;
  /** compare: classes moved relative to the other design, edges whose mechanism differs */
  moved?: Set<Id>;
  changedEdges?: Set<string>;
  /** preferred node order (a hint for the layouter) */
  order?: string[];
  /** compare: place the graph at a reference layout's positions instead of laying it out */
  pinTo?: PinReference | null;
  /** fit this rectangle (e.g. the union of two compared layouts) instead of the own layout */
  fitBounds?: Box | null;
  /** synchronised pan and zoom between graphs */
  viewportSync?: ViewportSync;
  onLayout?: (r: LayoutResult, g: DG) => void;
  onHoverNode?: (id: string | null) => void;
  layouter?: string;
  /** draw accesses, feeds and events between services (true) or classes */
  bundle?: boolean;
  /** one edge per direction between two nodes, all dependency types merged (true) or one per type */
  merge?: boolean;
  className?: string;
}

/** pan/zoom shared by several graphs (compare): user moves in one are applied to the others */
export class ViewportSync {
  private fns = new Map<string, (v: Viewport, fit: boolean) => void>();
  subscribe(id: string, fn: (v: Viewport, fit: boolean) => void) { this.fns.set(id, fn); return () => { this.fns.delete(id); }; }
  /** `fit`: the viewport of a fit (the other pane counts as fitted too), else a pan or zoom by the user */
  publish(from: string, v: Viewport, fit = false) { for (const [id, fn] of this.fns) if (id !== from) fn(v, fit); }
}

export interface DesignGraphHandle {
  toSvg(title?: string, subtitle?: string): string | null;
  fit(): void;
  /** drop the positions of nodes moved by hand (the layouter's layout again) */
  resetPositions(): void;
}

/** dev check: every edge starts and ends on its nodes' borders */
function checkEndpoints(g: LayoutGraph, r: LayoutResult) {
  for (const e of g.edges) {
    const pts = r.edges[e.id]?.points;
    const a = r.nodes[e.source], b = r.nodes[e.target];
    if (!pts?.length || !a || !b) continue;
    if (!onBorder(pts[0], a, 2) || !onBorder(pts[pts.length - 1], b, 2)) console.warn(`edge ${e.id}: endpoints off the node borders`, pts[0], a, pts[pts.length - 1], b);
  }
}

type ServiceData = { label: string; info: string; db: string; accent: string | null; collapsed: boolean; onToggle: () => void; dim: boolean; hl: boolean; count: number; ops: number };
type ClassData = { label: string; root: boolean; dim: boolean; hl: boolean; moved: boolean; ops: number; model: boolean };
type EdgeData = { points: { x: number; y: number }[]; curve: boolean; width: number; color: string; dash: string; dim: boolean; hl: boolean; changed: boolean; layer: EdgeLayer; merged: boolean; title: string };

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0, pointerEvents: 'none' as const };

const ServiceNode = memo(function ServiceNode({ data }: NodeProps<Node<ServiceData>>) {
  return (
    <div className={cn('h-full w-full rounded-[10px] border bg-background/70 transition-opacity duration-200 dark:bg-white/[0.025]', data.dim && 'opacity-60', data.hl && 'ring-2 ring-ring/50')}
      style={{ borderColor: 'var(--chart-axis)' }}>
      {data.accent && <div className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-full" style={{ background: data.accent }} />}
      <div className="flex items-start gap-1.5 px-3.5 pt-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold leading-tight">{data.label}</div>
          <div className="mt-0.5 flex items-center gap-2 overflow-hidden whitespace-nowrap text-[10px] text-muted-foreground">
            <span className="truncate">{data.info}</span><span className="flex shrink-0 items-center gap-0.5"><Database className="size-2.5" />{data.db}</span>
          </div>
        </div>
        <button className="nodrag nopan -mr-1.5 grid size-7 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground" onClick={(e) => { e.stopPropagation(); data.onToggle(); }} title="Collapse service" aria-label={`Collapse ${data.label}`}>
          <ChevronsDownUp className="size-4" />
        </button>
      </div>
      <Handle type="target" position={Position.Left} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hidden} isConnectable={false} />
    </div>
  );
});

const CollapsedNode = memo(function CollapsedNode({ data }: NodeProps<Node<ServiceData>>) {
  return (
    <div className={cn('relative h-full w-full rounded-[10px] border-[1.5px] bg-card px-3.5 py-2 shadow-sm transition-opacity duration-200', data.dim && 'opacity-50', data.hl && 'ring-2 ring-ring/60')} style={{ borderColor: 'var(--text-secondary)' }}>
      {data.accent && <div className="absolute bottom-2 left-0 top-2 w-[3px] rounded-full" style={{ background: data.accent }} />}
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{data.label}</div>
        <button className="nodrag nopan -mr-1.5 grid size-7 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground" onClick={(e) => { e.stopPropagation(); data.onToggle(); }} title="Expand service" aria-label={`Expand ${data.label}`}>
          <ChevronsUpDown className="size-4" />
        </button>
      </div>
      <div className="mt-0.5 flex items-center gap-1 overflow-hidden whitespace-nowrap text-[10px] text-muted-foreground" title={`${data.count} classes · ${data.info}`}><Layers className="size-2.5 shrink-0" /><span className="truncate">{data.count} {data.count === 1 ? 'class' : 'classes'} · {data.info}</span></div>
      <Handle type="target" position={Position.Left} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hidden} isConnectable={false} />
    </div>
  );
});

const ClassNode = memo(function ClassNode({ data }: NodeProps<Node<ClassData>>) {
  return (
    <div className={cn('flex h-full w-full items-center gap-1.5 rounded-[7px] border bg-card px-2.5 text-[11.5px] shadow-[0_1px_0_rgba(0,0,0,0.03)] transition-[opacity,box-shadow] duration-200',
      data.dim && 'opacity-50 shadow-none', data.hl && 'ring-2 ring-ring', data.moved && 'border-2 border-select-b')}
      title={`${data.label}${data.root ? ' (aggregate root)' : ''} · ${data.ops} operations anchored here${data.model ? ' · right-click or alt-click: the class in the Model panel' : ''}`}>
      <span className={cn('truncate', data.root && 'font-semibold')}>{data.label}</span>
      {data.moved && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-select-b" aria-label="moved" />}
      <Handle type="target" position={Position.Left} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hidden} isConnectable={false} />
    </div>
  );
});

function RoutedEdge({ id, data, markerEnd }: EdgeProps<Edge<EdgeData>>) {
  if (!data?.points?.length) return null;
  const d = pathD(data.points, 6, data.curve);
  const w = data.changed ? Math.max(3, data.width + 1) : data.hl ? data.width + 0.8 : data.width;
  return (
    <g className="transition-opacity duration-200" style={{ opacity: data.dim ? 0.13 : data.merged ? 0.85 : data.layer === 'reference' ? 0.75 : 0.95 }}>
      {data.changed && <path d={d} fill="none" stroke={data.color} strokeWidth={9} strokeOpacity={0.18} strokeLinecap="round" />}
      <path id={id} d={d} fill="none" stroke={data.color} strokeWidth={w} strokeDasharray={data.dash || undefined} markerEnd={markerEnd} strokeLinejoin="round" />
      <path d={d} fill="none" stroke="transparent" strokeWidth={12}><title>{data.title}</title></path>
    </g>
  );
}

/** node data equal apart from functions (the toggles go through a ref) */
function sameData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k of Object.keys(b)) if (typeof b[k] !== 'function' && a[k] !== b[k]) return false;
  return true;
}

const nodeTypes = { service: ServiceNode, collapsed: CollapsedNode, cls: ClassNode };
const edgeTypes = { routed: RoutedEdge };

function replicaText(r: Decisions['services'][number]['replicas']) {
  return r.mode === 'fixed' ? `${r.count} replica${r.count === 1 ? '' : 's'}` : `HPA ${r.min}–${r.max} @ ${Math.round(r.targetUtilisation * 100)} %`;
}

const Inner = forwardRef<DesignGraphHandle, DesignGraphProps>(function Inner(props, ref) {
  const { domain, decisions, collapsed, onToggleCollapse, onSelectService, highlight, accent, moved, changedEdges, order, onLayout, onHoverNode, layouter = DEFAULT_LAYOUTER, bundle = true, merge = false, pinTo, fitBounds, viewportSync } = props;
  const { theme } = useTheme();
  const p = PALETTES[theme];
  const words = useEdgeVocab();
  const model = usePanelAvailable('model');
  const rf = useReactFlow();
  const graph = useMemo(() => buildDesignGraph(domain, decisions, { collapsed, order, bundle, merge }), [domain, decisions, collapsed, order, bundle, merge]);
  const [layout, setLayout] = useState<{ r: LayoutResult; g: DG } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fitted = useRef(false);

  const fitBoundsRef = useRef(fitBounds);
  fitBoundsRef.current = fitBounds;
  const box = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const sourceRef = useRef<{ domain?: Domain; decisions?: Decisions; layouter?: string }>({});
  const selfId = useRef(Math.random().toString(36).slice(2));
  // fit: the compare's shared bounds (A and B), else this layout as drawn (moved nodes and edge routes included); a small design
  // should not fill a wide panel with giant boxes (max zoom 1.25), a large TALA layout may need a small zoom; the compare's other pane follows (graph/fit.ts)
  const fitter = useFit(box, () => fitBoundsRef.current ?? (layoutRef.current ? contentBounds(layoutRef.current.r, true) : null), {
    minZoom: 0.05, maxZoom: 1.25, onFitted: (v) => viewportSync?.publish(selfId.current, v, true),
  });
  const fit = (duration: number) => fitter.fit(duration);

  useEffect(() => {
    const ctl = new AbortController();
    setBusy(true);
    const job = pinTo ? Promise.resolve(pinLayout(graph.layout, pinTo, `${layouter} (pinned to A)`)) : getLayouter(layouter).layout(graph.layout, ctl.signal);
    // the same design and layouter (a service expanded or collapsed, the edge detail changed): no new layout, the
    // nodes keep their places (graph/moves.ts keepPositions); the Auto-layout button lays it out again
    const prev = layoutRef.current;
    const keep = !pinTo && !!prev && sourceRef.current.domain === domain && sourceRef.current.decisions === decisions && sourceRef.current.layouter === layouter;
    sourceRef.current = { domain, decisions, layouter };
    job.then((r) => {
      if (ctl.signal.aborted) return;
      completeRoutes(graph.layout, r);
      // nodes the user moved in this layout before keep their place
      const key = layoutKey(graph.layout, pinTo ? `${layouter}-pinned` : layouter);
      keyRef.current = key;
      baseRef.current = r;
      let eff: LayoutResult;
      if (keep) {
        const k = keepPositions(prev!.g.layout, prev!.r, graph.layout, r);
        movesRef.current = k.moves;
        saveMoves(key, k.moves);
        eff = k.r;
      } else {
        const m = loadMoves(key);
        movesRef.current = { ...(m ?? {}) };
        eff = m ? applyMoves(graph.layout, r, m, 'route') : r;
      }
      if (import.meta.env.DEV) checkEndpoints(graph.layout, eff);
      setLayout({ r: eff, g: graph });
      layoutRef.current = { r: eff, g: graph };
      setErr(null);
      setBusy(false);
      onLayout?.(eff, graph);
      if (!keep) requestAnimationFrame(() => fit(fitted.current ? 350 : 0));
      fitted.current = true;
    }).catch((e) => { if ((e as Error).name !== 'AbortError') { setErr(String(e)); setBusy(false); } });
    return () => ctl.abort();
  }, [graph, layouter, pinTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // compare: refit when the shared bounds change
  const fbKey = fitBounds ? `${Math.round(fitBounds.x)},${Math.round(fitBounds.y)},${Math.round(fitBounds.width)},${Math.round(fitBounds.height)}` : '';
  useEffect(() => { if (fitBounds && layout) requestAnimationFrame(() => fit(0)); }, [fbKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => viewportSync?.subscribe(selfId.current, (v, fitted) => { fitter.userMoved(!fitted); void rf.setViewport(v); }), [viewportSync, rf]); // eslint-disable-line react-hooks/exhaustive-deps

  const svcById = useMemo(() => new Map(decisions.services.map((s) => [s.id, s])), [decisions]);
  const dbOf = (s: Id) => decisions.databases.find((d) => d.services.includes(s));
  const opsBySvc = layout?.g.derived.opsByService;

  // hover flicker: React Flow hides a node (visibility) and drops its handle bounds (its edges)
  // until it is measured again whenever it gets a new node object without `measured`. Every node
  // therefore carries its size and handles, and keeps its object while nothing about it changes.
  const toggleRef = useRef(onToggleCollapse);
  toggleRef.current = onToggleCollapse;
  const nodeCache = useRef(new Map<string, Node>());
  const nodes: Node[] = useMemo(() => {
    if (!layout) return [];
    const { r, g } = layout;
    const out: Node[] = [];
    const prev = nodeCache.current;
    const next = new Map<string, Node>();
    const push = (n: Node) => {
      const w = n.width!, h = n.height!;
      n.handles = [
        { type: 'target', position: Position.Left, x: 0, y: h / 2, width: 1, height: 1 },
        { type: 'source', position: Position.Right, x: w - 1, y: h / 2, width: 1, height: 1 },
      ];
      const old = prev.get(n.id);
      const same = old && old.type === n.type && old.parentId === n.parentId && old.position.x === n.position.x && old.position.y === n.position.y
        && old.width === w && old.height === h && old.zIndex === n.zIndex && sameData(old.data, n.data);
      const node = same ? old : n;
      next.set(n.id, node);
      out.push(node);
    };
    const hl = highlight;
    for (const n of g.nodes.values()) {
      const b = r.nodes[n.id];
      if (!b) continue;
      const svc = svcById.get(n.service)!;
      if (n.kind === 'service' || n.kind === 'collapsed') {
        const db = dbOf(n.service);
        const service = n.service;
        push({
          id: n.id, type: n.kind === 'service' ? 'service' : 'collapsed', position: { x: b.x, y: b.y }, draggable: true, selectable: false,
          width: b.width, height: b.height, style: { width: b.width, height: b.height }, zIndex: n.kind === 'service' ? 0 : 2,
          data: {
            label: n.label, info: replicaText(svc.replicas), db: db?.placement === 'shared' ? `shared (${db.services.length})` : 'own db', accent: accent(n.service),
            collapsed: n.kind === 'collapsed', onToggle: () => toggleRef.current(service), count: n.classes?.length ?? 0, ops: opsBySvc?.get(n.service)?.length ?? 0,
            dim: !!hl && n.kind === 'collapsed' && !hl.nodes.has(n.id), hl: !!hl && hl.nodes.has(n.id),
          } satisfies ServiceData,
        });
      } else {
        const parent = r.nodes[svcNode(n.service)];
        push({
          id: n.id, type: 'cls', parentId: svcNode(n.service), extent: 'parent', position: { x: b.x - parent.x, y: b.y - parent.y }, draggable: true, selectable: false,
          width: b.width, height: b.height, style: { width: b.width, height: b.height }, zIndex: 3,
          data: { label: n.label, root: !!n.aggregateRoot, ops: n.ops ?? 0, moved: !!moved?.has(n.cls!), dim: !!hl && !hl.nodes.has(n.id), hl: !!hl && hl.nodes.has(n.id), model } satisfies ClassData,
        });
      }
    }
    nodeCache.current = next;
    return out;
  }, [layout, highlight, accent, moved, svcById, opsBySvc, model]); // eslint-disable-line react-hooks/exhaustive-deps

  const edges: Edge[] = useMemo(() => {
    if (!layout) return [];
    const { r, g } = layout;
    const opName = new Map(domain.operations.map((o) => [o.id, o.name]));
    const opList = (ops: Id[]) => `${ops.slice(0, 8).map((o) => opName.get(o) ?? o).join(', ')}${ops.length > 8 ? ` +${ops.length - 8}` : ''}`;
    return g.edges.filter((e) => edgeVisible(e, props.hidden) && r.edges[e.id]?.points.length).map((e) => {
      const color = e.merged ? p.ink2 : edgeColor(p, e.layer);
      const st = MECHANISM_STYLE[e.layer];
      const hl = !!highlight && highlight.edges.has(e.id);
      const ends = `${g.nodes.get(e.source)?.label} → ${g.nodes.get(e.target)?.label}`;
      const label = e.merged
        ? `${ends}\n${visibleParts(e, props.hidden).map((pt) => `${words.label(pt.layer)}${pt.rate ? ` (${pt.rate < 1 ? pt.rate.toFixed(2) : pt.rate.toFixed(1)}/s)` : ''}${pt.ops.length ? `: ${opList(pt.ops)}` : ''}`).join('\n')}`
        : `${words.label(e.layer)}: ${ends}${e.ops.length ? `\n${opList(e.ops)}` : ''}`;
      const reference = !e.merged && e.layer === 'reference';
      // a constant z-index: raising highlighted edges above the nodes would put their hit paths
      // over the hovered node, which then loses the pointer (hover flicker)
      return {
        id: e.id, source: e.source, target: e.target, type: 'routed', zIndex: 1,
        markerEnd: { type: reference ? MarkerType.Arrow : MarkerType.ArrowClosed, color, width: 12, height: 12 },
        data: { points: r.edges[e.id].points, curve: !!r.edges[e.id].curve, width: edgeWidth(e, props.hidden, bundle), color, dash: e.merged ? '' : st.dash, dim: !!highlight && !hl, hl, changed: !!changedEdges?.has(e.id), layer: e.layer, merged: e.merged, title: label } satisfies EdgeData,
      };
    });
  }, [layout, props.hidden, highlight, changedEdges, p, domain, bundle, words]);

  // hover: classes and collapsed services only. A service container holds its classes, so the
  // pointer moving between them would toggle the hover (and the highlight) on every border.
  const hoverRef = useRef<string | null>(null);

  // dragging: services (with their classes) and classes inside their service; the edges they
  // touch follow as elbows while dragging and are routed around the nodes on drop
  const keyRef = useRef('');
  const baseRef = useRef<LayoutResult | null>(null);
  const movesRef = useRef<Moves>({});
  const dragFrom = useRef<LayoutResult | null>(null);
  const onNodesChange = (changes: NodeChange[]) => {
    if (!layout) return;
    const now: Moves = {};
    let end = false;
    for (const c of changes) {
      if (c.type !== 'position') continue;
      if (c.position) now[c.id] = c.position;
      if (c.dragging === false) end = true;
    }
    if (!Object.keys(now).length && !end) return;
    if (!dragFrom.current) dragFrom.current = layout.r;
    Object.assign(movesRef.current, now);
    const g = layout.g;
    if (end) {
      const dragged = { ...now };
      for (const c of changes) if (c.type === 'position' && !c.position && movesRef.current[c.id]) dragged[c.id] = movesRef.current[c.id];
      const eff = applyMoves(g.layout, dragFrom.current, dragged, 'route');
      dragFrom.current = null;
      saveMoves(keyRef.current, movesRef.current);
      if (import.meta.env.DEV) checkEndpoints(g.layout, eff);
      setLayout({ r: eff, g });
      onLayout?.(eff, g);
    } else setLayout({ r: applyMoves(g.layout, dragFrom.current, now, 'elbow'), g });
  };
  const resetPositions = () => {
    if (!layout || !baseRef.current) return;
    movesRef.current = {};
    saveMoves(keyRef.current, null);
    setLayout({ r: baseRef.current, g: layout.g });
    layoutRef.current = { r: baseRef.current, g: layout.g };
    onLayout?.(baseRef.current, layout.g);
    requestAnimationFrame(() => fit(300));
  };
  const onNodeEnter = (_: unknown, n: Node) => {
    if (n.type === 'service') return;
    hoverRef.current = n.id;
    onHoverNode?.(n.id);
  };
  const onNodeLeave = (_: unknown, n: Node) => {
    if (hoverRef.current !== n.id) return;
    hoverRef.current = null;
    onHoverNode?.(null);
  };

  useImperativeHandle(ref, () => ({
    fit: () => fit(300),
    resetPositions,
    toSvg: (title, subtitle) => layout && graphToSvg(layout.g, layout.r, PALETTES.light, {
      title, subtitle, hidden: props.hidden, bundle, merge, words, accent: (s) => accent(s) && PALETTES.light.series[PALETTES[theme].series.indexOf(accent(s)!)] || accent(s), moved, changedEdges,
      serviceInfo: (s) => { const sv = svcById.get(s)!; const db = dbOf(s); return `${replicaText(sv.replicas)} · ${db?.placement === 'shared' ? 'shared db' : 'own db'}`; },
    }),
  }));

  return (
    <div ref={box} className={cn('relative h-full w-full', props.className)}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} minZoom={0.05} maxZoom={2.5} proOptions={{ hideAttribution: true }}
        nodesDraggable nodeDragThreshold={4} onNodesChange={onNodesChange} nodesConnectable={false} elementsSelectable={false} onlyRenderVisibleElements={false}
        onMove={(ev, v) => { if (!ev) return; fitter.userMoved(); viewportSync?.publish(selfId.current, v); }}
        onNodeMouseEnter={onNodeEnter} onNodeMouseLeave={onNodeLeave}
        onNodeClick={(e, n) => {
          const m = layout?.g.nodes.get(n.id);
          // alt- / ctrl- / cmd-click on a class: the class in the Model panel
          if (model && m?.kind === 'class' && m.cls && (e.altKey || e.ctrlKey || e.metaKey)) { workspaceActions.openModel(`class:${m.cls}`); return; }
          if (onSelectService && m && m.kind !== 'class') onSelectService(m.service);
          // detailed: a click on a collapsed service opens it (the button is small when the whole graph is in view)
          else if (!onSelectService && m?.kind === 'collapsed') onToggleCollapse(m.service);
        }}
        onNodeContextMenu={(e, n) => { const m = layout?.g.nodes.get(n.id); if (model && m?.kind === 'class' && m.cls) { e.preventDefault(); workspaceActions.openModel(`class:${m.cls}`); } }}
        onPaneClick={onSelectService && (() => onSelectService(null))}
        onNodeDoubleClick={onSelectService ? undefined : (_, n) => { const m = layout?.g.nodes.get(n.id); if (m?.kind === 'service') onToggleCollapse(m.service); }}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color={theme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.13)'} />
        <Controls showInteractive={false} showFitView={false} position="bottom-right">
          <ControlButton className="react-flow__controls-fitview" onClick={() => fit(300)} title="Fit view" aria-label="Fit view"><Maximize /></ControlButton>
        </Controls>
      </ReactFlow>
      {(busy || err) && (
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-md border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          {busy ? <><Loader2 className="size-3 animate-spin" /> laying out…</> : <span className="text-[var(--status-critical)]">layout failed: {err}</span>}
        </div>
      )}
    </div>
  );
});

export const DesignGraphView = forwardRef<DesignGraphHandle, DesignGraphProps>(function DesignGraphView(props, ref) {
  return (
    <ReactFlowProvider>
      <Inner ref={ref} {...props} />
    </ReactFlowProvider>
  );
});
