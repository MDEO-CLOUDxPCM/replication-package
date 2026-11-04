/**
 * LayoutGraph <-> TALA graphjson (orthoflow, the WebAssembly port of D2's TALA engine). Pure; shared by the layout
 * worker (layout/tala-engine.ts) and the tests.
 *
 * Groups become TALA containers whose label (pinned to INSIDE_TOP_LEFT) reserves the group's header; leaves keep
 * their size. TALA grows a node when its ports need room: such a node is drawn at its own size, centred in the
 * grown box, and the ends of its routes are continued to its real border.
 */
import type { Graph } from 'orthoflow';
import type { Box, LayoutGraph, LayoutResult } from './types';

type Pt = { x: number; y: number };

/** graph size (nodes + edges) up to which three seeds are tried (the best is kept); above: one seed */
export const TALA_SEEDS_UP_TO = 80;
export const seedsFor = (g: LayoutGraph): number[] => (g.nodes.length + g.edges.length <= TALA_SEEDS_UP_TO ? [1, 2, 3] : [1]);

export interface TalaInput {
  graph: Graph;
  /** TALA id -> node id / edge id */
  nodeIds: Map<number, string>;
  edgeIds: Map<number, string>;
}

export function toTala(g: LayoutGraph): TalaInput {
  const num = new Map<string, number>();
  const nodeIds = new Map<number, string>();
  g.nodes.forEach((n, i) => { num.set(n.id, i + 1); nodeIds.set(i + 1, n.id); });
  const containers: Record<string, number[]> = { 0: [] };
  for (const n of g.nodes) {
    const p = n.parent && num.has(n.parent) ? num.get(n.parent)! : 0;
    (containers[p] ??= []).push(num.get(n.id)!);
  }
  const nodes: Graph['nodes'] = g.nodes.map((n) => ({
    id: num.get(n.id)!,
    width: Math.max(1, Math.ceil(n.width)),
    height: Math.max(1, Math.ceil(n.group ? (n.padding?.top ?? 36) : n.height)),
    topLeft: null,
    shapeType: 'Square',
    // a group's header: TALA keeps the room for its label inside the container, at the top left
    ...(n.group ? { label: { Text: n.label ?? n.id, Position: 'INSIDE_TOP_LEFT', Width: Math.max(1, Math.ceil(n.width - 20)), Height: Math.ceil(n.padding?.top ?? 36) } } : {}),
  }));
  const edgeIds = new Map<number, string>();
  const edges: Graph['edges'] = [];
  g.edges.forEach((e, i) => {
    const from = num.get(e.source), to = num.get(e.target);
    if (from === undefined || to === undefined || from === to) return;
    const id = g.nodes.length + i + 1;
    edgeIds.set(id, e.id);
    // arrowheads make TALA keep room for them. With one-way arrowheads it arranges the graph in ranks along the edges
    // (good for a class diagram, but it spreads a dense design graph over a sparse grid several times larger);
    // arrowheads at both ends leave the graph undirected
    const source = !g.directed ? 'triangle' : e.kind === 'containment' ? 'filled-diamond' : '';
    edges.push({ id, from, to, points: [], sourceArrowhead: source, targetArrowhead: 'triangle' });
  });
  return { graph: { nodes, edges, containers }, nodeIds, edgeIds };
}

/** what a TALA run returns (`layout(..., { unsafeIntegers: 'number' }).graph`), the parts used here */
export interface TalaGraphOut {
  nodes: { id: number | bigint; width: number; height: number; topLeft: Pt | null }[];
  edges: { id: number | bigint; points: Pt[] | null }[];
}

const INSET = 8;
const EPS = 0.5;
/** shortest last segment that still shows an arrowhead (marker ~12 px) */
const MIN_END = 14;

const flip = (p: Pt): Pt => ({ x: p.y, y: p.x });
const flipBox = (b: Box): Box => ({ x: b.y, y: b.x, width: b.height, height: b.width });

/**
 * The end of a route on TALA's (grown) box, continued to the real node centred in it: straight on when the end lies
 * within the real node's span along that side. Otherwise a jog inside the grown box (which holds nothing else):
 * into the adjacent side of the real node, or, when that would leave too short a last segment for the arrowhead,
 * along the band beside the node into the span and then straight in. Ends further from the node turn in further
 * along the side, so the routes of one side do not cross. Returns the replacement points from the end to the border.
 */
function toReal(end: Pt, next: Pt, real: Box, box: Box): Pt[] {
  // solved for an end on the left or right side (a horizontal last segment); a vertical one is transposed
  if (Math.abs(end.x - next.x) < EPS && Math.abs(end.y - next.y) >= EPS) return toReal(flip(end), flip(next), flipBox(real), flipBox(box)).map(flip);
  const ix = Math.min(INSET, real.width / 2), iy = Math.min(INSET, real.height / 2);
  const left = Math.abs(end.x - box.x) <= Math.abs(end.x - (box.x + box.width));
  const x = left ? real.x : real.x + real.width;
  if (end.y >= real.y + iy - EPS && end.y <= real.y + real.height - iy + EPS) return [end, { x, y: end.y }];
  const top = end.y < real.y + iy;
  const d = Math.max(0, Math.min(1, top ? (real.y - end.y) / Math.max(1, real.y - box.y) : (end.y - real.y - real.height) / Math.max(1, box.y + box.height - real.y - real.height)));
  // a: turn into the top or bottom side
  const turn = Math.max(0, top ? real.y - end.y : end.y - real.y - real.height);
  const xIn = left ? real.x + ix + d * (real.width / 2 - ix) : real.x + real.width - ix - d * (real.width / 2 - ix);
  // b: down (up) the band beside the node into its span, then straight in
  const band = left ? real.x - box.x : box.x + box.width - real.x - real.width;
  if (turn >= MIN_END || turn >= band / 2) return [end, { x: xIn, y: end.y }, { x: xIn, y: top ? real.y : real.y + real.height }];
  const xm = left ? real.x - band / 2 : real.x + real.width + band / 2;
  const yIn = top ? real.y + iy + d * (real.height / 2 - iy) : real.y + real.height - iy - d * (real.height / 2 - iy);
  return [end, { x: xm, y: end.y }, { x: xm, y: yIn }, { x, y: yIn }];
}

/** drop repeated and collinear points */
function clean(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      if (!((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01))) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

export function fromTala(g: LayoutGraph, input: TalaInput, out: TalaGraphOut, layouter: string, ms: number): LayoutResult {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const grown: Record<string, Box> = {};
  const nodes: Record<string, Box> = {};
  let x0 = Infinity, y0 = Infinity;
  for (const n of out.nodes) {
    const id = input.nodeIds.get(Number(n.id));
    if (id === undefined) continue;
    const tl = n.topLeft ?? { x: 0, y: 0 };
    grown[id] = { x: tl.x, y: tl.y, width: n.width, height: n.height };
    x0 = Math.min(x0, tl.x); y0 = Math.min(y0, tl.y);
  }
  for (const [id, b] of Object.entries(grown)) {
    const n = byId.get(id)!;
    // a leaf keeps its own size, centred in the box TALA grew for its ports; a group is TALA's container
    nodes[id] = n.group ? b : { x: b.x + (b.width - n.width) / 2, y: b.y + (b.height - n.height) / 2, width: n.width, height: n.height };
  }
  const edges: LayoutResult['edges'] = {};
  const byEdge = new Map(g.edges.map((e) => [e.id, e]));
  for (const e of out.edges) {
    const id = input.edgeIds.get(Number(e.id));
    const le = id !== undefined ? byEdge.get(id) : undefined;
    if (!le || !e.points || e.points.length < 2) continue;
    // TALA draws an edge it could not route as a straight (diagonal) line: leave it to layout/route.ts (completeRoutes)
    if (e.points.some((p, i) => i > 0 && Math.abs(p.x - e.points![i - 1].x) > 0.01 && Math.abs(p.y - e.points![i - 1].y) > 0.01)) continue;
    const pts = e.points.map((p) => ({ x: p.x, y: p.y }));
    const s = nodes[le.source], t = nodes[le.target], sb = grown[le.source], tb = grown[le.target];
    let route = pts;
    if (s && sb && !byId.get(le.source)!.group) route = [...toReal(pts[0], pts[1], s, sb).reverse(), ...route.slice(1)];
    if (t && tb && !byId.get(le.target)!.group) { const k = route.length - 1; route = [...route.slice(0, k), ...toReal(route[k], route[k - 1], t, tb)]; }
    edges[id!] = { points: clean(route) };
  }
  // origin at (0, 0)
  if (Number.isFinite(x0)) {
    for (const b of Object.values(nodes)) { b.x -= x0; b.y -= y0; }
    for (const r of Object.values(edges)) for (const p of r.points) { p.x -= x0; p.y -= y0; }
  }
  let w = 0, h = 0;
  for (const b of Object.values(nodes)) { w = Math.max(w, b.x + b.width); h = Math.max(h, b.y + b.height); }
  return { nodes, edges, width: w, height: h, layouter, ms };
}
