/**
 * A UML-like class diagram: classes with their rows (attributes, references to other
 * layers, literals), grouped in packages, edges for references, containments, inheritance. Laid
 * out in the layout worker (TALA, ranked along the edges; grouped: ELK, packed groups), drawn with React
 * Flow; nodes are draggable (edges re-routed on drop, positions kept per diagram), dotted
 * background, both themes. Used for the domain model and the metamodels.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, ControlButton, Handle, Position, useReactFlow, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Loader2, Maximize } from 'lucide-react';
import { getLayouter, type LayoutResult } from '@layout/index';
import { completeRoutes } from '@layout/pin';
import type { LayoutGraph } from '@layout/types';
import { applyMoves, layoutKey, loadMoves, saveMoves, type Moves } from '@/graph/moves';
import { pathD } from '@/graph/svg';
import { contentBounds, useFit } from '@/graph/fit';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

export interface UmlRow {
  text: string;
  /** attr: an attribute; ref: a reference shown as a row (to another layer or folded); lit: an enum literal; note: muted */
  kind?: 'attr' | 'ref' | 'lit' | 'note';
  title?: string;
}

export interface UmlNode {
  id: string;
  title: string;
  /** shown above the title, e.g. «abstract», «enum», «external» */
  stereotype?: string;
  rows: UmlRow[];
  group?: string;
  /** external: a class of another layer (dashed); root: a layer's root class */
  tone?: 'normal' | 'external' | 'root';
  /** a small figure at the right of the header (e.g. instances in the model) */
  badge?: string;
  tooltip?: string;
}

export interface UmlEdge {
  id: string;
  source: string;
  target: string;
  kind: 'ref' | 'containment' | 'inherit' | 'bidir';
  /** shown near the target end (reference name and multiplicity) */
  label?: string;
  tooltip?: string;
}

export interface UmlGroup { id: string; label: string }

export interface ClassDiagramProps {
  /** identifies the diagram for kept positions */
  name: string;
  nodes: UmlNode[];
  edges: UmlEdge[];
  groups?: UmlGroup[];
  selected?: string | null;
  /** nodes to emphasise (the others are dimmed), e.g. the classes an operation touches */
  highlight?: Set<string> | null;
  onSelect?: (id: string | null) => void;
  direction?: 'DOWN' | 'RIGHT';
  /** bumping it fits the view to the selected node (a link opened it) */
  focusKey?: string | number;
  className?: string;
}

const HEADER = 30, ROW = 16, PAD = 8;
const nodeSize = (n: UmlNode) => {
  const longest = Math.max(n.title.length * 8.1 + 36 + (n.badge ? n.badge.length * 6 + 10 : 0), ...n.rows.map((r) => r.text.length * 6.25 + 22), n.stereotype ? n.stereotype.length * 6 + 20 : 0);
  return { width: Math.round(Math.max(128, Math.min(300, longest))), height: HEADER + (n.stereotype ? 12 : 0) + (n.rows.length ? n.rows.length * ROW + PAD : 0) };
};

type ClassData = { n: UmlNode; selected: boolean; dim: boolean; hl: boolean };
type GroupData = { label: string; dim: boolean };
type EdgeData = { points: { x: number; y: number }[]; kind: UmlEdge['kind']; label?: string; tooltip?: string; dim: boolean; hl: boolean; showLabel: boolean; faint: boolean };

const hiddenHandle = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0, pointerEvents: 'none' as const };

const ClassNode = memo(function ClassNode({ data }: NodeProps<Node<ClassData>>) {
  const { n } = data;
  return (
    <div title={n.tooltip}
      className={cn('h-full w-full cursor-pointer overflow-hidden rounded-[7px] border bg-card text-[11px] shadow-[0_1px_0_rgba(0,0,0,0.04)]',
        n.tone === 'external' && 'border-dashed bg-muted/40', n.tone === 'root' && 'border-[1.5px]',
        data.dim && 'opacity-40', data.hl && 'border-foreground/45', data.selected && 'ring-2 ring-ring')}
      style={n.tone === 'root' ? { borderColor: 'var(--text-secondary)' } : undefined}>
      <div className={cn('border-b px-2.5', n.rows.length ? 'bg-muted/45' : 'border-b-0')} style={{ minHeight: HEADER + (n.stereotype ? 12 : 0) - 1 }}>
        {n.stereotype && <div className="pt-1 text-center text-[9.5px] leading-none text-muted-foreground">{n.stereotype}</div>}
        <div className="flex h-[29px] items-center gap-1.5">
          <span className={cn('min-w-0 flex-1 truncate text-center text-[12px] font-semibold', n.stereotype === '«abstract»' && 'italic')}>{n.title}</span>
          {n.badge && <span className="shrink-0 rounded bg-background/80 px-1 text-[9.5px] tabular text-muted-foreground">{n.badge}</span>}
        </div>
      </div>
      {n.rows.length > 0 && (
        <div className="px-2.5 py-1">
          {n.rows.map((r, i) => (
            <div key={i} title={r.title ?? r.text} className={cn('truncate font-mono text-[10.5px] leading-4', r.kind === 'ref' && 'text-[var(--series-1)]', (r.kind === 'note' || r.kind === 'lit') && 'text-muted-foreground')}>{r.text}</div>
          ))}
        </div>
      )}
      <Handle type="target" position={Position.Left} style={hiddenHandle} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hiddenHandle} isConnectable={false} />
    </div>
  );
});

const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  return (
    <div className={cn('h-full w-full rounded-[10px] border border-dashed bg-muted/20', data.dim && 'opacity-60')} style={{ borderColor: 'var(--chart-axis)' }}>
      <div className="truncate px-3 pt-1.5 text-[11px] font-semibold text-muted-foreground">{data.label}</div>
    </div>
  );
});

/** the end decoration of an edge: angle of the segment entering the point */
function endAngle(pts: { x: number; y: number }[], atStart: boolean) {
  const [a, b] = atStart ? [pts[1], pts[0]] : [pts[pts.length - 2], pts[pts.length - 1]];
  return Math.atan2(b.y - a.y, b.x - a.x);
}
const polygon = (p: { x: number; y: number }, ang: number, shape: [number, number][]) =>
  shape.map(([dx, dy]) => `${p.x + dx * Math.cos(ang) - dy * Math.sin(ang)},${p.y + dx * Math.sin(ang) + dy * Math.cos(ang)}`).join(' ');

function UmlEdgeView({ data }: EdgeProps<Edge<EdgeData>>) {
  if (!data?.points?.length || data.points.length < 2) return null;
  const pts = data.points;
  const d = pathD(pts, 5);
  const stroke = data.kind === 'inherit' ? 'var(--text-secondary)' : 'var(--chart-axis-strong, var(--text-secondary))';
  const end = pts[pts.length - 1], start = pts[0];
  const a1 = endAngle(pts, false), a0 = endAngle(pts, true);
  // label near the target, offset to the side of the last segment
  const pre = pts[pts.length - 2];
  const seg = Math.hypot(end.x - pre.x, end.y - pre.y) || 1;
  const t = Math.min(26, seg * 0.5);
  const lx = end.x - ((end.x - pre.x) / seg) * t, ly = end.y - ((end.y - pre.y) / seg) * t;
  const vertical = Math.abs(end.x - pre.x) < Math.abs(end.y - pre.y);
  return (
    <g style={{ opacity: data.dim ? 0.12 : data.faint ? 0.5 : 1 }}>
      <path d={d} fill="none" stroke={stroke} strokeWidth={data.hl ? 1.9 : 1.15} strokeDasharray={data.kind === 'ref' || data.kind === 'bidir' ? undefined : undefined} />
      {data.kind === 'inherit' && <polygon points={polygon(end, a1, [[0, 0], [-11, -6], [-11, 6]])} fill="var(--card)" stroke={stroke} strokeWidth={1.2} />}
      {data.kind === 'ref' && <polyline points={polygon(end, a1, [[-9, -4.5], [0, 0], [-9, 4.5]])} fill="none" stroke={stroke} strokeWidth={1.2} />}
      {data.kind === 'containment' && <>
        <polygon points={polygon(start, a0 + Math.PI, [[0, 0], [7, -4.5], [14, 0], [7, 4.5]])} fill={stroke} stroke={stroke} strokeWidth={1} />
        <polyline points={polygon(end, a1, [[-9, -4.5], [0, 0], [-9, 4.5]])} fill="none" stroke={stroke} strokeWidth={1.2} />
      </>}
      {data.label && data.showLabel && (
        <text x={lx + (vertical ? 5 : 0)} y={ly + (vertical ? 3 : -5)} textAnchor={vertical ? 'start' : 'middle'} fontSize={9.5}
          className="fill-muted-foreground font-mono" style={{ paintOrder: 'stroke', stroke: 'var(--background)', strokeWidth: 3, strokeLinejoin: 'round' }}>{data.label}</text>
      )}
      <path d={d} fill="none" stroke="transparent" strokeWidth={10}>{data.tooltip && <title>{data.tooltip}</title>}</path>
    </g>
  );
}

const nodeTypes = { uml: ClassNode, pkg: GroupNode };
const edgeTypes = { uml: UmlEdgeView };

function same(a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const k of Object.keys(b)) if (a[k] !== b[k]) return false;
  return true;
}

const NO_GROUPS: UmlGroup[] = [];

function Inner({ name, nodes: umlNodes, edges: umlEdges, groups = NO_GROUPS, selected, highlight, onSelect, direction = 'DOWN', focusKey, className }: ClassDiagramProps) {
  const rf = useReactFlow();
  const { theme } = useTheme();
  const graph: LayoutGraph = useMemo(() => {
    const used = new Set(umlNodes.map((n) => n.group).filter(Boolean) as string[]);
    const gs = groups.filter((g) => used.has(g.id));
    const ids = new Set(umlNodes.map((n) => n.id));
    return {
      direction,
      directed: true,
      nodes: [
        ...gs.map((g) => ({ id: `grp:${g.id}`, group: true, width: Math.max(120, g.label.length * 7 + 30), height: 40, padding: { top: 30, left: 14, bottom: 14, right: 14 }, label: g.label })),
        ...umlNodes.map((n) => ({ id: n.id, parent: n.group && used.has(n.group) ? `grp:${n.group}` : undefined, ...nodeSize(n), label: n.title })),
      ],
      edges: umlEdges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
        .map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind, weight: e.kind === 'inherit' ? 3 : e.kind === 'containment' ? 2 : 1 })),
    };
  }, [umlNodes, umlEdges, groups, direction]);
  const [layout, setLayout] = useState<{ r: LayoutResult; g: LayoutGraph } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const box = useRef<HTMLDivElement>(null);
  // fit the nodes as drawn (moved ones included) and the edges' bends (a route may run outside the nodes' box)
  const fitter = useFit(box, () => (layoutRef.current ? contentBounds(layoutRef.current.r, true) : null), { padding: 0.07, minZoom: 0.1, maxZoom: 2.5 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keyRef = useRef('');
  const baseRef = useRef<LayoutResult | null>(null);
  const movesRef = useRef<Moves>({});
  const dragFrom = useRef<LayoutResult | null>(null);
  const [hover, setHoverNow] = useState<string | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const setHover = (v: string | null | ((h: string | null) => string | null)) => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => { hoverTimer.current = null; setHoverNow(v); }, 70);
  };
  useEffect(() => () => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); }, []);

  useEffect(() => {
    const ctl = new AbortController();
    setBusy(true);
    // ungrouped: TALA (ranked along the edges); grouped (many small groups): packed, see layout/elk.ts
    const engine = graph.nodes.some((n) => n.group) ? 'elk-packed' : 'tala';
    getLayouter(engine).layout(graph, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return;
      completeRoutes(graph, r);
      const key = layoutKey(graph, `uml-${name}-${engine}`);
      keyRef.current = key;
      baseRef.current = r;
      const m = loadMoves(key);
      movesRef.current = { ...(m ?? {}) };
      const eff = { r: m ? applyMoves(graph, r, m, 'route') : r, g: graph };
      setLayout(eff);
      layoutRef.current = eff;
      setErr(null);
      setBusy(false);
      requestAnimationFrame(() => fitter.fit(0));
    }).catch((e) => { if ((e as Error).name !== 'AbortError') { setErr(String(e)); setBusy(false); } });
    return () => ctl.abort();
  }, [graph, name]); // eslint-disable-line react-hooks/exhaustive-deps

  // a link opened a node: centre it (keeping at least a readable zoom)
  useEffect(() => {
    if (!layout || !selected || focusKey === undefined) return;
    const b = layout.r.nodes[selected];
    if (!b) return;
    fitter.userMoved();
    requestAnimationFrame(() => rf.setCenter(b.x + b.width / 2, b.y + b.height / 2, { zoom: Math.max(rf.getZoom(), 1), duration: 350 }));
  }, [focusKey, layout === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(umlNodes.map((n) => [n.id, n])), [umlNodes]);
  const groupOf = useMemo(() => new Map(umlNodes.map((n) => [n.id, n.group])), [umlNodes]);
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of umlEdges) {
      (m.get(e.source) ?? m.set(e.source, new Set()).get(e.source)!).add(e.target);
      (m.get(e.target) ?? m.set(e.target, new Set()).get(e.target)!).add(e.source);
    }
    return m;
  }, [umlEdges]);
  const focus = hover ?? selected ?? null;
  const around = (id: string | null | undefined) => (id && byId.has(id) ? new Set([id, ...(neighbours.get(id) ?? [])]) : null);
  // dimmed: everything outside an explicit highlight or the selection's neighbourhood; a hover only
  // marks its neighbours and edges (cheap: the other nodes keep their objects)
  const lit = useMemo(() => (highlight && highlight.size ? highlight : around(selected)), [highlight, selected, neighbours, byId]); // eslint-disable-line react-hooks/exhaustive-deps
  const hoverLit = useMemo(() => around(hover), [hover, neighbours, byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cache = useRef(new Map<string, Node>());
  const nodes: Node[] = useMemo(() => {
    if (!layout) return [];
    const { r, g } = layout;
    const out: Node[] = [];
    const next = new Map<string, Node>();
    const push = (n: Node) => {
      const w = n.width!, h = n.height!;
      n.handles = [
        { type: 'target', position: Position.Left, x: 0, y: h / 2, width: 1, height: 1 },
        { type: 'source', position: Position.Right, x: w - 1, y: h / 2, width: 1, height: 1 },
      ];
      const old = cache.current.get(n.id);
      const keep = old && old.position.x === n.position.x && old.position.y === n.position.y && old.width === w && old.height === h && old.parentId === n.parentId && same(old.data, n.data);
      const node = keep ? old : n;
      next.set(n.id, node);
      out.push(node);
    };
    for (const ln of g.nodes) {
      const b = r.nodes[ln.id];
      if (!b) continue;
      if (ln.group) {
        push({ id: ln.id, type: 'pkg', position: { x: b.x, y: b.y }, width: b.width, height: b.height, style: { width: b.width, height: b.height }, draggable: true, selectable: false, zIndex: 0,
          data: { label: ln.label ?? '', dim: !!highlight?.size } satisfies GroupData });
        continue;
      }
      const n = byId.get(ln.id);
      if (!n) continue; // a layout of the previous diagram, until the new one is in
      const pb = ln.parent ? r.nodes[ln.parent] : undefined;
      push({ id: ln.id, type: 'uml', parentId: ln.parent, extent: ln.parent ? 'parent' : undefined, position: pb ? { x: b.x - pb.x, y: b.y - pb.y } : { x: b.x, y: b.y },
        width: b.width, height: b.height, style: { width: b.width, height: b.height }, draggable: true, selectable: false, zIndex: 2,
        data: { n, selected: selected === ln.id, dim: !!lit && !lit.has(ln.id) && !hoverLit?.has(ln.id), hl: (hoverLit ?? lit)?.has(ln.id) === true && ln.id !== selected } satisfies ClassData });
    }
    cache.current = next;
    return out;
  }, [layout, byId, lit, hoverLit, selected, highlight]);

  const edges: Edge[] = useMemo(() => {
    if (!layout) return [];
    const { r } = layout;
    const map = new Map(umlEdges.map((e) => [e.id, e]));
    return layout.g.edges.filter((e) => r.edges[e.id]?.points.length && map.has(e.id)).map((le) => {
      const e = map.get(le.id)!;
      const set = hoverLit ?? lit;
      const on = !!set && set.has(e.source) && set.has(e.target) && (!focus || e.source === focus || e.target === focus || (!hoverLit && !!highlight?.size));
      return { id: e.id, source: e.source, target: e.target, type: 'uml', zIndex: 1,
        // labels of the highlighted edges only (all of them while the diagram is small)
        data: { points: r.edges[e.id].points, kind: e.kind, label: e.label, tooltip: e.tooltip, dim: !!set && !on, hl: on, showLabel: on || umlEdges.length <= 24,
          // between two groups: lighter while nothing is highlighted (the groups' own structure reads first)
          faint: !set && groupOf.get(e.source) !== groupOf.get(e.target) } satisfies EdgeData };
    });
  }, [layout, umlEdges, lit, hoverLit, focus, highlight, groupOf]);

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
    if (end) {
      const dragged = { ...now };
      for (const c of changes) if (c.type === 'position' && !c.position && movesRef.current[c.id]) dragged[c.id] = movesRef.current[c.id];
      const eff = applyMoves(layout.g, dragFrom.current, dragged, 'route');
      dragFrom.current = null;
      saveMoves(keyRef.current, movesRef.current);
      setLayout({ r: eff, g: layout.g });
    } else setLayout({ r: applyMoves(layout.g, dragFrom.current, now, 'elbow'), g: layout.g });
  };

  return (
    <div ref={box} className={cn('relative h-full w-full', className)}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} minZoom={0.1} maxZoom={2.5} proOptions={{ hideAttribution: true }}
        nodesDraggable nodeDragThreshold={4} onNodesChange={onNodesChange} nodesConnectable={false} elementsSelectable={false} onMove={(ev) => { if (ev) fitter.userMoved(); }}
        onNodeMouseEnter={(_, n) => { if (n.type === 'uml') setHover(n.id); }} onNodeMouseLeave={(_, n) => { if (n.type === 'uml') setHover((h) => (h === n.id ? null : h)); }}
        onNodeClick={(_, n) => { if (n.type === 'uml') onSelect?.(n.id === selected ? null : n.id); }} onPaneClick={() => onSelect?.(null)}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color={theme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.13)'} />
        <Controls showInteractive={false} showFitView={false} position="bottom-right">
          <ControlButton className="react-flow__controls-fitview" onClick={() => fitter.fit(300)} title="Fit view" aria-label="Fit view"><Maximize /></ControlButton>
        </Controls>
      </ReactFlow>
      {(busy || err) && (
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-md border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          {busy ? <><Loader2 className="size-3 animate-spin" /> laying out…</> : <span className="text-[var(--status-critical)]">layout failed: {err}</span>}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 left-3 flex items-center gap-3 rounded-md bg-background/80 px-2 py-0.5 text-[10.5px] text-muted-foreground">
        <span className="flex items-center gap-1"><svg width="26" height="8" aria-hidden><line x1="8" y1="4" x2="25" y2="4" stroke="currentColor" /><polygon points="1,4 5,1.5 9,4 5,6.5" fill="currentColor" /></svg>contains</span>
        <span className="flex items-center gap-1"><svg width="22" height="8" aria-hidden><line x1="0" y1="4" x2="20" y2="4" stroke="currentColor" /><polyline points="15,1 20,4 15,7" fill="none" stroke="currentColor" /></svg>references</span>
        <span className="flex items-center gap-1"><svg width="22" height="10" aria-hidden><line x1="0" y1="5" x2="13" y2="5" stroke="currentColor" /><polygon points="21,5 13,1 13,9" fill="none" stroke="currentColor" /></svg>extends</span>
        <span>drag to move · click for details</span>
      </div>
    </div>
  );
}

export const ClassDiagram = memo(function ClassDiagram(props: ClassDiagramProps) {
  return <ReactFlowProvider><Inner {...props} /></ReactFlowProvider>;
});
