/**
 * Nodes moved by hand: a moved node takes its descendants along; the edges touching
 * any of them are drawn as quick elbows while dragging and routed around the nodes on drop.
 * Positions are kept per layout (graph + layouter) for the session and in localStorage.
 */
import { assignPorts, elbowRoute, routeEdges } from '@layout/route';
import type { Box, LayoutGraph, LayoutResult } from '@layout/types';

/** top-level nodes: absolute position; nodes inside a group: relative to the group */
export type Moves = Record<string, { x: number; y: number }>;

const children = (g: LayoutGraph) => {
  const m = new Map<string, string[]>();
  for (const n of g.nodes) if (n.parent) (m.get(n.parent) ?? m.set(n.parent, []).get(n.parent)!).push(n.id);
  return m;
};

/** move nodes (in the order given) and redraw the edges they touch; returns a new result */
export function applyMoves(g: LayoutGraph, base: LayoutResult, moves: Moves, mode: 'elbow' | 'route'): LayoutResult {
  const parent = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const kids = children(g);
  const nodes = { ...base.nodes };
  const touched = new Set<string>();
  const shift = (id: string, dx: number, dy: number) => {
    const b = nodes[id];
    if (!b) return;
    nodes[id] = { ...b, x: b.x + dx, y: b.y + dy };
    touched.add(id);
    for (const c of kids.get(id) ?? []) shift(c, dx, dy);
  };
  // groups first, so a class's position relative to its group applies to the moved group
  const ids = Object.keys(moves).sort((a, b) => Number(!!parent.get(a)) - Number(!!parent.get(b)));
  for (const id of ids) {
    const b = nodes[id];
    if (!b) continue;
    const p = parent.get(id);
    const pb = p ? nodes[p] : undefined;
    if (p && !pb) continue;
    const to = pb ? { x: pb.x + moves[id].x, y: pb.y + moves[id].y } : moves[id];
    const dx = to.x - b.x, dy = to.y - b.y;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) shift(id, dx, dy);
  }
  const edges = { ...base.edges };
  const out: LayoutResult = { ...base, nodes, edges };
  const redo = g.edges.filter((e) => touched.has(e.source) || touched.has(e.target)).map((e) => e.id);
  if (!redo.length) return out;
  if (mode === 'route') return routeEdges(g, out, redo);
  const ports = assignPorts(g, nodes, redo);
  for (const id of redo) { const p = ports.get(id); if (p) edges[id] = { points: elbowRoute(p.s, p.t) }; }
  return out;
}

/**
 * a service expanded or collapsed (or the edge detail changed) without a new layout: every top-level node of the
 * previous layout keeps its place; a service whose classes are unchanged keeps its box and their places, a service that
 * opens (or closes) keeps its corner and gets the layouter's box and arrangement. Every edge is routed again. Returns
 * the result and the top-level positions (to save as moves).
 */
export function keepPositions(prevG: LayoutGraph, prev: LayoutResult, g: LayoutGraph, r: LayoutResult): { r: LayoutResult; moves: Moves } {
  const kids = children(g), prevKids = children(prevG);
  const nodes = { ...r.nodes };
  const shift = (id: string, dx: number, dy: number) => {
    for (const k of [id, ...(kids.get(id) ?? [])]) nodes[k] = { ...nodes[k], x: nodes[k].x + dx, y: nodes[k].y + dy };
  };
  const top = g.nodes.filter((n) => !n.parent && prev.nodes[n.id] && nodes[n.id]).map((n) => n.id);
  const resized: { id: string; old: Box }[] = [];
  for (const id of top) {
    const old = prev.nodes[id], b = nodes[id];
    const ks = kids.get(id) ?? [], pk = prevKids.get(id) ?? [];
    if (ks.length === pk.length && ks.every((k) => pk.includes(k) && prev.nodes[k])) {
      nodes[id] = old;
      for (const k of ks) nodes[k] = prev.nodes[k];
    } else {
      shift(id, old.x - b.x, old.y - b.y);
      resized.push({ id, old });
    }
  }
  // room for a service that opens: the nodes right of its old box move right by its growth, the nodes below it down
  // (a service that closes: back again, so opening and closing it restores the picture)
  for (const { id, old } of resized) {
    const dw = nodes[id].width - old.width, dh = nodes[id].height - old.height;
    for (const o of top) {
      if (o === id) continue;
      const b = nodes[o];
      shift(o, b.x >= old.x + old.width - 0.5 ? dw : 0, b.y >= old.y + old.height - 0.5 ? dh : 0);
    }
  }
  const moves: Moves = Object.fromEntries(top.map((id) => [id, { x: nodes[id].x, y: nodes[id].y }]));
  const bs = Object.values(nodes);
  const out: LayoutResult = { ...r, nodes, edges: {}, width: Math.max(...bs.map((b) => b.x + b.width)), height: Math.max(...bs.map((b) => b.y + b.height)) };
  return { r: routeEdges(g, out, g.edges.map((e) => e.id)), moves };
}

const KEY = 'explorer.graphPositions';
const memory = new Map<string, Moves>();

export function layoutKey(g: LayoutGraph, layouter: string): string {
  let h = 0;
  const s = `${layouter}|${g.nodes.map((n) => `${n.id}:${n.parent ?? ''}:${n.width}x${n.height}`).join(',')}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${layouter}:${(h >>> 0).toString(36)}`;
}

export function loadMoves(key: string): Moves | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return all[key] ?? null;
  } catch { return null; }
}

export function saveMoves(key: string, m: Moves | null) {
  if (m && Object.keys(m).length) memory.set(key, m); else memory.delete(key);
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (m && Object.keys(m).length) all[key] = m; else delete all[key];
    // keep the 40 most recent layouts
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* blocked or full */ }
}
