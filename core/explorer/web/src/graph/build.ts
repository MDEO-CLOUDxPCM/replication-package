/** Domain + decisions -> the compound layout graph of the class-to-service view (pure). */
import type { Decisions, Domain, Id, Mechanism } from '@contract/types';
import { deriveDesign, type DerivedDesign, type DerivedEdge } from '@contract/derive';
import type { LayoutGraph, LayoutNode } from '@layout/types';

export type EdgeLayer = 'reference' | Mechanism | 'feed' | 'event';
export const LAYERS: EdgeLayer[] = ['reference', 'sync', 'copy', 'cache', 'join', 'saga', 'feed', 'event'];
export const DEFAULT_HIDDEN: EdgeLayer[] = ['feed', 'event'];

export interface GraphNodeMeta {
  id: string;
  kind: 'service' | 'class' | 'collapsed';
  label: string;
  service: Id;
  cls?: Id;
  /** classes in a (collapsed) service */
  classes?: Id[];
  aggregateRoot?: boolean;
  ops?: number;
}

export interface EdgePart { layer: EdgeLayer; ops: Id[]; rate: number }

export interface GraphEdgeMeta {
  id: string;
  source: string;
  target: string;
  /** the layer (merged edges: the part with the highest rate) */
  layer: EdgeLayer;
  ops: Id[];
  rate: number;
  /** class-level edges merged into this one (collapsed services) */
  count: number;
  /** every dependency type between the two ends in one edge (one per direction) */
  merged: boolean;
  /** per layer: its operations and rate (one part unless merged) */
  parts: EdgePart[];
}

/** the parts of an edge whose layer is shown */
export const visibleParts = (e: GraphEdgeMeta, hidden: Set<EdgeLayer>) => e.parts.filter((p) => !hidden.has(p.layer));
export const edgeVisible = (e: GraphEdgeMeta, hidden: Set<EdgeLayer>) => e.parts.some((p) => !hidden.has(p.layer));
/** drawn width: by rate for bundled or merged edges (rate over the shown parts) */
export function edgeWidth(e: GraphEdgeMeta, hidden: Set<EdgeLayer>, bundle: boolean): number {
  if (!e.merged && e.layer === 'reference') return 1;
  if (!bundle && !e.merged) return 1.5;
  const rate = e.merged ? visibleParts(e, hidden).reduce((s, p) => s + p.rate, 0) : e.rate;
  return Math.min(3.8, 1.2 + Math.log10(1 + rate) * 1.1);
}

export interface DesignGraph {
  layout: LayoutGraph;
  nodes: Map<string, GraphNodeMeta>;
  edges: GraphEdgeMeta[];
  derived: DerivedDesign;
}

export const svcNode = (s: Id) => `svc:${s}`;
export const clsNode = (c: Id) => `cls:${c}`;

export const CLASS_H = 34;
export const classWidth = (name: string) => Math.max(92, Math.round(name.length * 7.1 + 30));

export function layerOf(e: DerivedEdge): EdgeLayer {
  return e.kind === 'access' ? e.mechanism! : e.kind === 'reference' ? 'reference' : e.kind;
}

/**
 * bundle: accesses, copy feeds and events are drawn between services (one edge per service pair and
 * layer, carrying all its operations); references stay between classes.
 */
export function buildDesignGraph(domain: Domain, d: Decisions, opts: { collapsed?: Set<Id>; order?: string[]; bundle?: boolean; merge?: boolean } = {}): DesignGraph {
  const derived = deriveDesign(domain, d);
  const collapsed = opts.collapsed ?? new Set<Id>();
  const nodes = new Map<string, GraphNodeMeta>();
  const lnodes: LayoutNode[] = [];
  const roots = new Set(domain.aggregates.map((a) => a.root));
  const opsHome = new Map<Id, number>();
  for (const op of domain.operations) opsHome.set(op.homeClass, (opsHome.get(op.homeClass) ?? 0) + 1);
  for (const s of d.services) {
    if (collapsed.has(s.id)) {
      // room for the name (semibold), the expand button and the info line on one line
      const w = Math.max(190, Math.round(s.name.length * 7.6 + 66));
      nodes.set(svcNode(s.id), { id: svcNode(s.id), kind: 'collapsed', label: s.name, service: s.id, classes: s.classes });
      lnodes.push({ id: svcNode(s.id), width: w, height: 58, label: s.name });
      continue;
    }
    nodes.set(svcNode(s.id), { id: svcNode(s.id), kind: 'service', label: s.name, service: s.id, classes: s.classes });
    // a group's width is its minimum: room for the header (name, autoscaler, database) even with one narrow class
    lnodes.push({ id: svcNode(s.id), width: Math.max(200, classWidth(s.name) + 54), height: 10, group: true, label: s.name, padding: { top: 40, left: 14, bottom: 14, right: 14 } });
    for (const c of s.classes) {
      const cls = domain.classes.find((x) => x.id === c);
      const name = cls?.name ?? c;
      nodes.set(clsNode(c), { id: clsNode(c), kind: 'class', label: name, service: s.id, cls: c, aggregateRoot: roots.has(c), ops: opsHome.get(c) ?? 0 });
      lnodes.push({ id: clsNode(c), parent: svcNode(s.id), width: classWidth(name), height: CLASS_H, label: name });
    }
  }
  const endpoint = (c: Id) => {
    const s = derived.serviceOf.get(c);
    if (!s) return null;
    return collapsed.has(s) ? svcNode(s) : clsNode(c);
  };
  const merged = new Map<string, GraphEdgeMeta>();
  for (const e of derived.edges) {
    const bundled = opts.bundle && e.kind !== 'reference';
    const src = bundled ? svcNode(derived.serviceOf.get(e.source) ?? '') : endpoint(e.source);
    const tgt = bundled ? svcNode(derived.serviceOf.get(e.target) ?? '') : endpoint(e.target);
    if (!src || !tgt || src === tgt) continue;
    const layer = layerOf(e);
    const id = opts.merge ? `all:${src}>${tgt}` : `${layer}:${src}>${tgt}`;
    let m = merged.get(id);
    if (!m) merged.set(id, m = { id, source: src, target: tgt, layer, ops: [], rate: 0, count: 0, merged: !!opts.merge, parts: [] });
    m.count++; m.rate += e.rate;
    for (const o of e.ops) if (!m.ops.includes(o)) m.ops.push(o);
    let part = m.parts.find((p) => p.layer === layer);
    if (!part) m.parts.push(part = { layer, ops: [], rate: 0 });
    part.rate += e.rate;
    for (const o of e.ops) if (!part.ops.includes(o)) part.ops.push(o);
  }
  const edges = [...merged.values()];
  for (const e of edges) if (e.merged) { e.parts.sort((x, y) => y.rate - x.rate); e.layer = e.parts[0].layer; }
  const weight = (l: EdgeLayer) => (l === 'reference' ? 2 : l === 'sync' || l === 'saga' ? 3 : 1);
  return {
    layout: {
      nodes: lnodes,
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.layer, weight: Math.max(...e.parts.map((p) => weight(p.layer))) })),
      order: opts.order,
      direction: 'RIGHT',
    },
    nodes,
    edges,
    derived,
  };
}

/** classes and edges an operation touches (for hover highlighting) */
export function opFootprint(domain: Domain, g: DesignGraph, opId: Id): { nodes: Set<string>; edges: Set<string> } {
  const op = domain.operations.find((o) => o.id === opId);
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (!op) return { nodes, edges };
  const map = (c: Id) => (g.nodes.has(clsNode(c)) ? clsNode(c) : svcNode(g.derived.serviceOf.get(c) ?? ''));
  nodes.add(map(op.homeClass));
  for (const a of op.accesses) nodes.add(map(a.class));
  for (const e of g.edges) if (e.ops.includes(opId)) { edges.add(e.id); nodes.add(e.source); nodes.add(e.target); }
  return { nodes, edges };
}
