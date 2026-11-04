/**
 * LayoutGraph <-> ELK JSON for the packed layout of grouped class diagrams (layout/elk.ts; pure, shared by the worker
 * and the tests).
 */
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { Box, LayoutGraph, LayoutResult } from './types';

export function fromElk(root: ElkNode, ms: number, layouter = 'elk'): LayoutResult {
  const nodes: Record<string, Box> = {};
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0), y = oy + (c.y ?? 0);
      nodes[c.id] = { x, y, width: c.width ?? 0, height: c.height ?? 0 };
      walk(c, x, y);
    }
  };
  walk(root, 0, 0);
  const edges: LayoutResult['edges'] = {};
  for (const e of root.edges ?? []) {
    const s = e.sections?.[0];
    if (!s) { edges[e.id] = { points: [] }; continue; }
    edges[e.id] = { points: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y })) };
  }
  return { nodes, edges, width: root.width ?? 0, height: root.height ?? 0, layouter, ms };
}

// ---------------------------------------------------------------------------------------------
// Two-level ("packed") layout: each group is laid out on its own (layered, top-down, with the
// edges inside it), then the groups are rect-packed, ordered by the aggregated edges between them.
// Edges between groups are routed orthogonally around the nodes (route.ts).

/** order groups so that strongly connected ones are neighbours (greedy, deterministic) */
export function connectivityOrder(groups: string[], links: Map<string, number>): string[] {
  if (groups.length < 3) return groups;
  const w = (a: string, b: string) => (links.get(`${a}>${b}`) ?? 0) + (links.get(`${b}>${a}`) ?? 0);
  const deg = new Map(groups.map((g) => [g, groups.reduce((s, h) => s + w(g, h), 0)]));
  const out = [groups.reduce((a, b) => ((deg.get(b) ?? 0) > (deg.get(a) ?? 0) ? b : a))];
  const left = new Set(groups.filter((g) => g !== out[0]));
  while (left.size) {
    let best: string | null = null, bw = -1;
    for (const g of left) { const s = out.reduce((acc, h) => acc + w(g, h), 0); if (s > bw) { bw = s; best = g; } }
    out.push(best!);
    left.delete(best!);
  }
  return out;
}

export function toElkTwoLevel(g: LayoutGraph): { root: ElkNode; cross: LayoutGraph['edges'] } {
  const parentOf = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const order = new Map((g.order ?? []).map((id, i) => [id, i]));
  const elk = new Map<string, ElkNode>();
  const topIds: string[] = [];
  for (const n of g.nodes) {
    if (n.parent) continue;
    const p = n.padding;
    elk.set(n.id, {
      id: n.id, width: n.width, height: n.height,
      children: n.group ? [] : undefined, edges: n.group ? [] : undefined,
      layoutOptions: n.group ? {
        'elk.algorithm': 'layered', 'elk.direction': 'DOWN',
        'elk.padding': `[top=${p?.top ?? 36},left=${p?.left ?? 14},bottom=${p?.bottom ?? 14},right=${p?.right ?? 14}]`,
        'elk.spacing.nodeNode': '14', 'elk.layered.spacing.nodeNodeBetweenLayers': '26', 'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${n.width}, ${n.height})`,
      } : undefined,
    });
    topIds.push(n.id);
  }
  const kids = g.nodes.filter((n) => n.parent).sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  for (const n of kids) elk.get(n.parent!)!.children!.push({ id: n.id, width: n.width, height: n.height });
  const links = new Map<string, number>();
  const cross: LayoutGraph['edges'] = [];
  for (const e of g.edges) {
    if (e.source === e.target) continue;
    const ps = parentOf.get(e.source) ?? e.source, pt = parentOf.get(e.target) ?? e.target;
    if (ps === pt && parentOf.get(e.source)) {
      elk.get(ps)!.edges!.push({ id: e.id, sources: [e.source], targets: [e.target] });
    } else {
      cross.push(e);
      if (ps !== pt) links.set(`${ps}>${pt}`, (links.get(`${ps}>${pt}`) ?? 0) + (e.weight ?? 1));
    }
  }
  const hinted = topIds.some((id) => order.has(id));
  const ordered = hinted ? [...topIds].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9)) : connectivityOrder(topIds, links);
  const root: ElkNode = {
    id: '__root',
    layoutOptions: { 'elk.algorithm': 'rectpacking', 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.aspectRatio': '1.7', 'elk.spacing.nodeNode': '84', 'elk.padding': '[top=16,left=16,bottom=16,right=16]', 'elk.rectpacking.trybox': 'false', 'org.eclipse.elk.json.edgeCoords': 'ROOT' },
    children: ordered.map((id) => elk.get(id)!),
    edges: [...links.keys()].map((k, i) => { const [s, t] = k.split('>'); return { id: `__top${i}`, sources: [s], targets: [t] }; }),
  };
  return { root, cross };
}

export function fromElkTwoLevel(root: ElkNode, cross: LayoutGraph['edges'], ms: number, layouter: string): LayoutResult {
  const r = fromElk(root, ms, layouter);
  for (const k of Object.keys(r.edges)) if (k.startsWith('__top')) delete r.edges[k];
  // the edges between services stay unrouted here: the layouter routes them around the placed
  // nodes (layout/route.ts) once the groups' inner edges are in place
  for (const e of cross) delete r.edges[e.id];
  return r;
}

/** child-level edge sections come relative to their group unless edgeCoords=ROOT took effect: normalise */
export function fixGroupEdges(root: ElkNode, r: LayoutResult) {
  for (const gnode of root.children ?? []) {
    for (const e of gnode.edges ?? []) {
      const s = e.sections?.[0];
      if (!s) continue;
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      const box = r.nodes[gnode.id];
      // if the points lie inside the group's local frame, shift them
      const local = pts.every((p) => p.x <= (gnode.width ?? 0) + 1 && p.y <= (gnode.height ?? 0) + 1);
      const absInside = pts.every((p) => p.x >= box.x - 1 && p.y >= box.y - 1 && p.x <= box.x + box.width + 1 && p.y <= box.y + box.height + 1);
      r.edges[e.id] = { points: pts.map((p) => (local && !absInside ? { x: p.x + box.x, y: p.y + box.y } : { x: p.x, y: p.y })) };
    }
  }
}
