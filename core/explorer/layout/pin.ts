/**
 * Layouter-independent helpers on layout results:
 *  - `completeRoutes`: every edge a layouter left unrouted gets a route (inside a group: an elbow,
 *    between groups: a curve), so any engine may return boxes only;
 *  - `pinLayout`: lays out a graph B at the positions of a reference layout A (compare view): a
 *    group matched to one of A's groups is anchored at A's group position, its classes that were in
 *    that group keep A's positions, classes that moved in are placed in a row below them, groups only
 *    in B go to the nearest free place; overlaps are resolved by moving the later (less pinned)
 *    group, never the ones placed before. So moved classes visibly move and the rest stays put.
 */
import { routeEdges } from './route';
import type { Box, LayoutGraph, LayoutNode, LayoutResult } from './types';

type Pt = { x: number; y: number };

/** an orthogonal route between two boxes of one group (top-down like the layered inner layout) */
export function elbow(a: Box, b: Box): Pt[] {
  const acx = a.x + a.width / 2, bcx = b.x + b.width / 2;
  if (b.y >= a.y + a.height + 4) {
    const mid = (a.y + a.height + b.y) / 2;
    return [{ x: acx, y: a.y + a.height }, { x: acx, y: mid }, { x: bcx, y: mid }, { x: bcx, y: b.y }];
  }
  if (a.y >= b.y + b.height + 4) {
    const mid = (b.y + b.height + a.y) / 2;
    return [{ x: acx, y: a.y }, { x: acx, y: mid }, { x: bcx, y: mid }, { x: bcx, y: b.y + b.height }];
  }
  const right = bcx >= acx;
  const sx = right ? a.x + a.width : a.x, tx = right ? b.x : b.x + b.width;
  const sy = a.y + a.height / 2, ty = b.y + b.height / 2;
  const mx = (sx + tx) / 2;
  return [{ x: sx, y: sy }, { x: mx, y: sy }, { x: mx, y: ty }, { x: tx, y: ty }];
}

/** every edge the layouter left unrouted gets an orthogonal route around the nodes (layout/route.ts) */
export function completeRoutes(g: LayoutGraph, r: LayoutResult): LayoutResult {
  return routeEdges(g, r);
}

const PAD = { top: 40, left: 14, bottom: 14, right: 14 };
const GAP_X = 14, GAP_Y = 26, MARGIN = 28;

const overlaps = (a: Box, b: Box, m = MARGIN) => a.x < b.x + b.width + m && b.x < a.x + a.width + m && a.y < b.y + b.height + m && b.y < a.y + a.height + m;

/** a free position for box (w, h) nearest to `want`, not overlapping `placed` */
function nearestFree(want: Pt, w: number, h: number, placed: Box[]): Pt {
  const free = (p: Pt) => !placed.some((q) => overlaps({ x: p.x, y: p.y, width: w, height: h }, q));
  if (free(want)) return want;
  const cands: Pt[] = [];
  for (const q of placed) {
    const xs = [q.x + q.width + MARGIN + 0.5, q.x - w - MARGIN - 0.5, want.x, q.x];
    const ys = [q.y + q.height + MARGIN + 0.5, q.y - h - MARGIN - 0.5, want.y, q.y];
    for (const x of xs) for (const y of ys) cands.push({ x, y });
  }
  cands.sort((p, q) => Math.hypot(p.x - want.x, p.y - want.y) - Math.hypot(q.x - want.x, q.y - want.y));
  for (const c of cands) if (free(c)) return c;
  const right = Math.max(0, ...placed.map((q) => q.x + q.width));
  return { x: right + MARGIN + 1, y: want.y };
}

/** rows of boxes, left to right, wrapping at `width` */
function rowsOf(nodes: LayoutNode[], width: number, x0: number, y0: number): { pos: Map<string, Pt>; right: number; bottom: number } {
  const pos = new Map<string, Pt>();
  let x = x0, y = y0, rowH = 0, right = x0, bottom = y0;
  for (const n of nodes) {
    if (x > x0 && x + n.width > x0 + width) { x = x0; y += rowH + GAP_Y; rowH = 0; }
    pos.set(n.id, { x, y });
    right = Math.max(right, x + n.width);
    bottom = Math.max(bottom, y + n.height);
    x += n.width + GAP_X;
    rowH = Math.max(rowH, n.height);
  }
  return { pos, right, bottom };
}

export interface PinReference {
  graph: LayoutGraph;
  result: LayoutResult;
  /** top-level node of B (group or collapsed group) -> the matching top-level node of A */
  match: (bNode: string) => string | undefined;
}

export function pinLayout(g: LayoutGraph, ref: PinReference, layouter = 'pinned'): LayoutResult {
  const t0 = performance.now();
  const refParent = new Map(ref.graph.nodes.map((n) => [n.id, n.parent]));
  const kids = new Map<string, LayoutNode[]>();
  for (const n of g.nodes) if (n.parent) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
  const refPos = (id: string) => ref.result.nodes[id];
  const byRefOrder = (a: LayoutNode, b: LayoutNode) => {
    const pa = refPos(a.id), pb = refPos(b.id);
    return (pa ? pa.y * 1e4 + pa.x : 1e12) - (pb ? pb.y * 1e4 + pb.x : 1e12);
  };

  // 1. every top-level node as a block: size, children relative to the block origin, wanted origin
  interface Block { id: string; w: number; h: number; want: Pt; rel: Map<string, Pt>; pinned: number; matched: boolean }
  const blocks: Block[] = [];
  let refRight = 0;
  for (const b of Object.values(ref.result.nodes)) refRight = Math.max(refRight, b.x + b.width);
  for (const n of g.nodes.filter((x) => !x.parent)) {
    const a = ref.match(n.id);
    const ab = a ? refPos(a) : undefined;
    const pad = { ...PAD, ...n.padding };
    if (!n.group) {
      blocks.push({ id: n.id, w: n.width, h: n.height, want: ab ? { x: ab.x, y: ab.y } : { x: refRight + MARGIN, y: 0 }, rel: new Map(), pinned: ab ? 1 : 0, matched: !!ab });
      continue;
    }
    const children = [...(kids.get(n.id) ?? [])].sort(byRefOrder);
    const rel = new Map<string, Pt>();
    if (ab) {
      // stayers keep their offset inside the matched group; classes that came in go below them
      const stay = children.filter((c) => refPos(c.id) && refParent.get(c.id) === a);
      const come = children.filter((c) => !stay.includes(c));
      let bottom = pad.top - GAP_Y, right = pad.left;
      for (const c of stay) {
        const p = refPos(c.id)!;
        rel.set(c.id, { x: p.x - ab.x, y: p.y - ab.y });
        bottom = Math.max(bottom, p.y - ab.y + c.height);
        right = Math.max(right, p.x - ab.x + c.width);
      }
      const width = Math.max(ab.width - pad.left - pad.right, right - pad.left, 120);
      const rows = rowsOf(come, width, pad.left, bottom + GAP_Y);
      for (const [id, p] of rows.pos) rel.set(id, p);
      const w = Math.max(come.length ? rows.right : 0, right, 150) + pad.right;
      const h = Math.max(come.length ? rows.bottom : 0, bottom, pad.top) + pad.bottom;
      blocks.push({ id: n.id, w, h, want: { x: ab.x, y: ab.y }, rel, pinned: stay.length + 0.5, matched: true });
    } else {
      // a group only in B: rows in A's order, placed near where its classes were in A
      const width = Math.max(160, Math.sqrt(children.reduce((s, c) => s + (c.width + GAP_X) * (c.height + GAP_Y), 0)) * 1.6);
      const rows = rowsOf(children, width, pad.left, pad.top);
      for (const [id, p] of rows.pos) rel.set(id, p);
      const w = Math.max(rows.right, 150) + pad.right, h = Math.max(rows.bottom, pad.top) + pad.bottom;
      const known = children.map((c) => refPos(c.id)).filter(Boolean) as Box[];
      const want = known.length
        ? { x: known.reduce((s, b) => s + b.x + b.width / 2, 0) / known.length - w / 2, y: known.reduce((s, b) => s + b.y + b.height / 2, 0) / known.length - h / 2 }
        : { x: refRight + MARGIN, y: 0 };
      blocks.push({ id: n.id, w, h, want, rel, pinned: 0, matched: false });
    }
  }

  // 2. place: the most pinned blocks first, each at its wanted origin or the nearest free spot
  const order = [...blocks].sort((x, y) => (Number(y.matched) - Number(x.matched)) || (y.pinned - x.pinned));
  const placed: Box[] = [];
  const nodes: Record<string, Box> = {};
  for (const b of order) {
    const at = nearestFree(b.want, b.w, b.h, placed);
    const box = { x: at.x, y: at.y, width: b.w, height: b.h };
    placed.push(box);
    nodes[b.id] = box;
    for (const c of kids.get(b.id) ?? []) {
      const p = b.rel.get(c.id)!;
      nodes[c.id] = { x: at.x + p.x, y: at.y + p.y, width: c.width, height: c.height };
    }
  }

  // 3. routes: an inner edge whose ends kept their place in A reuses A's route, others are recomputed
  const parent = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const edges: LayoutResult['edges'] = {};
  g.edges.forEach((e) => {
    const a = nodes[e.source], b = nodes[e.target];
    if (!a || !b || e.source === e.target) return;
    const ps = parent.get(e.source), pt = parent.get(e.target);
    if (ps && ps === pt) {
      const old = ref.result.edges[e.id], ra = refPos(e.source), rb = refPos(e.target);
      const dx = ra ? a.x - ra.x : NaN, dy = ra ? a.y - ra.y : NaN;
      if (old?.points.length && !old.curve && ra && rb && Math.abs(b.x - rb.x - dx) < 0.5 && Math.abs(b.y - rb.y - dy) < 0.5) {
        edges[e.id] = { points: old.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      }
    }
    // every other edge is routed around the placed nodes (completeRoutes)
  });
  const out = { nodes, edges, width: 0, height: 0, layouter, ms: 0 };
  routeEdges(g, out);
  let w = 0, h = 0;
  for (const b of Object.values(nodes)) { w = Math.max(w, b.x + b.width); h = Math.max(h, b.y + b.height); }
  return { ...out, width: w + 16, height: h + 16, ms: Math.round(performance.now() - t0) };
}

/** bounds of all boxes and edge routes of a result (a route may run outside the boxes; for exports and synchronised viewports) */
export function bounds(r: LayoutResult): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of Object.values(r.nodes)) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
  for (const e of Object.values(r.edges)) for (const p of e.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 };
}
