/**
 * Orthogonal edge routing on fixed node positions: every edge starts and ends on a
 * port on its nodes' borders (ports spread along the side that faces the other end) and runs
 * around the other nodes on an orthogonal visibility grid (A*, length + bends + shared channels).
 * Used for the edges a layouter leaves unrouted (the compact layout's edges between services, the
 * compare's pinned layout) and after a node was dragged. Pure; runs in the layout worker and on the
 * main thread.
 */
import type { Box, LayoutGraph, LayoutResult } from './types';

type Pt = { x: number; y: number };
type Side = 'left' | 'right' | 'top' | 'bottom';
interface Port { p: Pt; side: Side }

/** distance of the first and last bend from a node */
const MARGIN = 12;
const BEND = 24;
const SHARE = 10;

const center = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const normal = (s: Side): Pt => (s === 'left' ? { x: -1, y: 0 } : s === 'right' ? { x: 1, y: 0 } : s === 'top' ? { x: 0, y: -1 } : { x: 0, y: 1 });
const opposite: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

/** the sides an edge leaves its source and enters its target by */
export function sidesFor(a: Box, b: Box): [Side, Side] {
  const ca = center(a), cb = center(b);
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  // horizontal when the boxes do not overlap horizontally and are further apart that way
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  const horizontal = gapX > 0 && (gapY <= 0 || gapX * 1.2 >= gapY) ? true : gapY > 0 ? false : Math.abs(dx) / (a.width + b.width) > Math.abs(dy) / (a.height + b.height);
  if (horizontal) { const s: Side = dx >= 0 ? 'right' : 'left'; return [s, opposite[s]]; }
  const s: Side = dy >= 0 ? 'bottom' : 'top';
  return [s, opposite[s]];
}

/** ports for the given edges: per node side, spread in the order of the other ends */
export function assignPorts(g: LayoutGraph, nodes: Record<string, Box>, ids: string[]): Map<string, { s: Port; t: Port }> {
  const ends = new Map<string, { edge: string; end: 's' | 't'; other: Pt }[]>();
  const sides = new Map<string, [Side, Side]>();
  const byId = new Map(g.edges.map((e) => [e.id, e]));
  for (const id of ids) {
    const e = byId.get(id)!;
    const a = nodes[e.source], b = nodes[e.target];
    const sd = sidesFor(a, b);
    sides.set(id, sd);
    const k1 = `${e.source}|${sd[0]}`, k2 = `${e.target}|${sd[1]}`;
    (ends.get(k1) ?? ends.set(k1, []).get(k1)!).push({ edge: id, end: 's', other: center(b) });
    (ends.get(k2) ?? ends.set(k2, []).get(k2)!).push({ edge: id, end: 't', other: center(a) });
  }
  const out = new Map<string, { s: Port; t: Port }>();
  for (const [k, list] of ends) {
    const [node, side] = k.split('|') as [string, Side];
    const b = nodes[node];
    const along = side === 'left' || side === 'right';
    list.sort((p, q) => (along ? p.other.y - q.other.y : p.other.x - q.other.x) || (p.edge < q.edge ? -1 : 1));
    const len = along ? b.height : b.width;
    const inset = Math.min(10, len / 4);
    list.forEach((it, i) => {
      const f = inset + ((len - 2 * inset) * (i + 1)) / (list.length + 1);
      const p = side === 'left' ? { x: b.x, y: b.y + f } : side === 'right' ? { x: b.x + b.width, y: b.y + f } : side === 'top' ? { x: b.x + f, y: b.y } : { x: b.x + f, y: b.y + b.height };
      const cur = out.get(it.edge) ?? ({} as { s: Port; t: Port });
      cur[it.end] = { p, side };
      out.set(it.edge, cur);
    });
  }
  return out;
}

/** a quick orthogonal route between two ports (no obstacle avoidance; while dragging) */
export function elbowRoute(s: Port, t: Port): Pt[] {
  const ns = normal(s.side), nt = normal(t.side);
  const a = { x: s.p.x + ns.x * MARGIN, y: s.p.y + ns.y * MARGIN };
  const b = { x: t.p.x + nt.x * MARGIN, y: t.p.y + nt.y * MARGIN };
  const horizontal = s.side === 'left' || s.side === 'right';
  const mid = horizontal ? [{ x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }] : [{ x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }];
  return simplify([s.p, a, ...mid, b, t.p]);
}

/** drop repeated and collinear points */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const col = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
      if (!col) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v; const top = v[0]; const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * Route `ids` (default: every edge without points) on the result's node positions, writing
 * `r.edges`. Obstacles for an edge: every node except its ends and their ancestors.
 */
export function routeEdges(g: LayoutGraph, r: LayoutResult, ids?: string[]): LayoutResult {
  const parent = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const ancestors = (id: string) => { const s = new Set<string>(); let p = parent.get(id); while (p) { s.add(p); p = parent.get(p); } return s; };
  const todo = (ids ?? g.edges.filter((e) => !r.edges[e.id]?.points.length).map((e) => e.id))
    .filter((id) => { const e = g.edges.find((x) => x.id === id); return !!e && e.source !== e.target && r.nodes[e.source] && r.nodes[e.target]; });
  if (!todo.length) return r;
  const ports = assignPorts(g, r.nodes, todo);
  const boxes = Object.entries(r.nodes);

  // the visibility grid: node borders ± MARGIN, ports and their exits
  const xs = new Set<number>(), ys = new Set<number>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [, b] of boxes) {
    xs.add(b.x - MARGIN); xs.add(b.x + b.width + MARGIN); ys.add(b.y - MARGIN); ys.add(b.y + b.height + MARGIN);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  xs.add(x0 - 3 * MARGIN); xs.add(x1 + 3 * MARGIN); ys.add(y0 - 3 * MARGIN); ys.add(y1 + 3 * MARGIN);
  const exitOf = (pt: Port) => { const n = normal(pt.side); return { x: pt.p.x + n.x * MARGIN, y: pt.p.y + n.y * MARGIN }; };
  for (const { s, t } of ports.values()) for (const pt of [s, t]) { const e = exitOf(pt); xs.add(e.x); ys.add(e.y); }
  const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b);
  const xi = new Map(X.map((v, i) => [v, i])), yi = new Map(Y.map((v, i) => [v, i]));
  const W = X.length, H = Y.length;
  const used = new Map<number, number>();   // segment key -> edges using it
  const segKey = (a: number, b: number) => (a < b ? a * W * H + b : b * W * H + a);

  const dist = new Float64Array(W * H * 5), from = new Int32Array(W * H * 5);
  for (const id of todo) {
    const e = g.edges.find((x) => x.id === id)!;
    const { s, t } = ports.get(id)!;
    const allowed = new Set([e.source, e.target, ...ancestors(e.source), ...ancestors(e.target)]);
    const obst: Box[] = [];
    for (const [nid, b] of boxes) if (!allowed.has(nid)) obst.push({ x: b.x - MARGIN + 0.5, y: b.y - MARGIN + 0.5, width: b.width + 2 * MARGIN - 1, height: b.height + 2 * MARGIN - 1 });
    const blocked = (x: number, y: number) => { for (const o of obst) if (x > o.x && x < o.x + o.width && y > o.y && y < o.y + o.height) return true; return false; };
    const es = exitOf(s), et = exitOf(t);
    const si = xi.get(es.x)! + yi.get(es.y)! * W, ti = xi.get(et.x)! + yi.get(et.y)! * W;
    // A* over (point, direction); direction 0..3 = +x, -x, +y, -y; 4 = start
    dist.fill(Infinity); from.fill(-1);
    const heap = new Heap();
    const sDir = s.side === 'right' ? 0 : s.side === 'left' ? 1 : s.side === 'bottom' ? 2 : 3;
    const tDir = t.side === 'left' ? 0 : t.side === 'right' ? 1 : t.side === 'top' ? 2 : 3; // arriving direction into the target
    const h = (c: number) => Math.abs(X[c % W] - et.x) + Math.abs(Y[(c / W) | 0] - et.y);
    dist[si * 5 + sDir] = 0; heap.push(h(si), si * 5 + sDir);
    let goal = -1;
    while (heap.size) {
      const st = heap.pop();
      const c = (st / 5) | 0, d = st % 5;
      if (c === ti) { goal = st; break; }
      const cx = c % W, cy = (c / W) | 0;
      const base = dist[st];
      for (let nd = 0; nd < 4; nd++) {
        const nx = cx + (nd === 0 ? 1 : nd === 1 ? -1 : 0), ny = cy + (nd === 2 ? 1 : nd === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if ((d === 0 && nd === 1) || (d === 1 && nd === 0) || (d === 2 && nd === 3) || (d === 3 && nd === 2)) continue;
        const mx = (X[cx] + X[nx]) / 2, my = (Y[cy] + Y[ny]) / 2;
        if (blocked(mx, my) || blocked(X[nx], Y[ny])) continue;
        const nc = nx + ny * W;
        const len = Math.abs(X[nx] - X[cx]) + Math.abs(Y[ny] - Y[cy]);
        let cost = base + len + (d !== 4 && d !== nd ? BEND : 0) + (used.get(segKey(c, nc)) ?? 0) * SHARE;
        if (nc === ti && nd !== tDir) cost += BEND;   // arrive straight into the port
        const ns = nc * 5 + nd;
        if (cost < dist[ns]) { dist[ns] = cost; from[ns] = st; heap.push(cost + h(nc), ns); }
      }
    }
    let pts: Pt[];
    if (goal < 0) pts = elbowRoute(s, t);
    else {
      const cells: number[] = [];
      for (let st = goal; st >= 0; st = from[st]) cells.push((st / 5) | 0);
      cells.reverse();
      for (let i = 1; i < cells.length; i++) { const k = segKey(cells[i - 1], cells[i]); used.set(k, (used.get(k) ?? 0) + 1); }
      pts = simplify([s.p, ...cells.map((c) => ({ x: X[c % W], y: Y[(c / W) | 0] })), t.p]);
    }
    r.edges[id] = { points: pts };
  }
  return r;
}

/** for tests and dev checks: does a point lie on a box's border (within `tol`)? */
export function onBorder(p: Pt, b: Box, tol = 1.5): boolean {
  const inX = p.x >= b.x - tol && p.x <= b.x + b.width + tol, inY = p.y >= b.y - tol && p.y <= b.y + b.height + tol;
  return (inY && (Math.abs(p.x - b.x) <= tol || Math.abs(p.x - b.x - b.width) <= tol)) || (inX && (Math.abs(p.y - b.y) <= tol || Math.abs(p.y - b.y - b.height) <= tol));
}
