import fs from 'node:fs';
import { createRequire } from 'node:module';
import { initSync, layout } from 'orthoflow';
import { beforeAll, describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { connectivityOrder, fixGroupEdges, fromElkTwoLevel, toElkTwoLevel } from '../layout/elk-graph';
import { fromTala, seedsFor, toTala, type TalaGraphOut } from '../layout/tala';
import { completeRoutes, pinLayout } from '../layout/pin';
import { onBorder, routeEdges } from '../layout/route';
import type { LayoutResult } from '../layout/types';
import type { LayoutGraph } from '../layout/types';

const require = createRequire(import.meta.url);

const graph: LayoutGraph = {
  nodes: [
    { id: 'g1', width: 10, height: 10, group: true, label: 'order' },
    { id: 'g2', width: 10, height: 10, group: true, label: 'catalog' },
    { id: 'Order', parent: 'g1', width: 100, height: 34 },
    { id: 'OrderItem', parent: 'g1', width: 110, height: 34 },
    { id: 'Product', parent: 'g2', width: 100, height: 34 },
    { id: 'Variant', parent: 'g2', width: 100, height: 34 },
    { id: 'Lonely', width: 120, height: 50 },
  ],
  edges: [
    { id: 'e1', source: 'Order', target: 'OrderItem' },
    { id: 'e2', source: 'OrderItem', target: 'Variant' },
    { id: 'e3', source: 'Product', target: 'Variant' },
    { id: 'e4', source: 'g1', target: 'Lonely' },
  ],
};

const inside = (c: { x: number; y: number; width: number; height: number }, p: { x: number; y: number; width: number; height: number }) =>
  c.x >= p.x - 0.5 && c.y >= p.y - 0.5 && c.x + c.width <= p.x + p.width + 0.5 && c.y + c.height <= p.y + p.height + 0.5;
const overlap = (a: any, b: any) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** every edge starts and ends on its nodes' borders, runs orthogonally and through no other node */
function checkRoutes(g: LayoutGraph, r: LayoutResult) {
  const parent = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const anc = (id: string) => { const s = new Set<string>(); let p = parent.get(id); while (p) { s.add(p); p = parent.get(p); } return s; };
  for (const e of g.edges) {
    const pts = r.edges[e.id]?.points;
    expect(pts?.length, e.id).toBeGreaterThanOrEqual(2);
    expect(r.edges[e.id].curve, e.id).toBeFalsy();
    expect(onBorder(pts[0], r.nodes[e.source]), `${e.id} starts on ${e.source}`).toBe(true);
    expect(onBorder(pts[pts.length - 1], r.nodes[e.target]), `${e.id} ends on ${e.target}`).toBe(true);
    const allowed = new Set([e.source, e.target, ...anc(e.source), ...anc(e.target)]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      expect(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, `${e.id} orthogonal`).toBe(true);
      for (const [id, box] of Object.entries(r.nodes)) {
        if (allowed.has(id)) continue;
        const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
        const hit = lo.x < box.x + box.width - 0.5 && hi.x > box.x + 0.5 && lo.y < box.y + box.height - 0.5 && hi.y > box.y + 0.5;
        expect(hit, `${e.id} crosses ${id}`).toBe(false);
      }
    }
  }
}

describe('TALA layouter adapter (orthoflow)', () => {
  beforeAll(() => { initSync(fs.readFileSync(require.resolve('orthoflow/orthoflow.wasm'))); });
  const run = (g: LayoutGraph) => {
    const input = toTala(g);
    const out = layout(input.graph, { seeds: seedsFor(g), unsafeIntegers: 'number' });
    return fromTala(g, input, out.graph as TalaGraphOut, 'tala', 0);
  };

  it('groups become containers with their header; leaves keep their size; every edge routed from border to border, orthogonally, around the other nodes', () => {
    const input = toTala(graph);
    expect(input.graph.containers![0]).toHaveLength(3);
    expect(input.graph.nodes[0].label?.Position).toBe('INSIDE_TOP_LEFT');
    const r = run(graph);
    for (const n of graph.nodes) expect(r.nodes[n.id]).toBeDefined();
    for (const n of graph.nodes.filter((x) => !x.group)) expect(r.nodes[n.id]).toMatchObject({ width: n.width, height: n.height });
    expect(inside(r.nodes.Order, r.nodes.g1)).toBe(true);
    expect(inside(r.nodes.Variant, r.nodes.g2)).toBe(true);
    expect(overlap(r.nodes.g1, r.nodes.g2)).toBe(false);
    // the header (padding top) stays free of children
    for (const c of ['Order', 'OrderItem']) expect(r.nodes[c].y).toBeGreaterThanOrEqual(r.nodes.g1.y + 36 - 0.5);
    checkRoutes(graph, r);
  });

  it('grouped class diagrams (ELK packed): groups do not overlap, inner edges by ELK, edges between groups routed around the nodes', async () => {
    const { root, cross } = toElkTwoLevel(graph);
    const out = await new ELK().layout(root);
    const r = fromElkTwoLevel(out, cross, 0, 'elk-packed');
    fixGroupEdges(out, r);
    expect(r.edges.e2).toBeUndefined();
    routeEdges(graph, r);
    checkRoutes(graph, r);
    expect(overlap(r.nodes.g1, r.nodes.g2)).toBe(false);
    expect(inside(r.nodes.OrderItem, r.nodes.g1)).toBe(true);
  });

  it('connectivity order puts linked groups next to each other', () => {
    const links = new Map([['a>c', 5], ['c>b', 1]]);
    expect(connectivityOrder(['a', 'b', 'c'], links)).toEqual(['c', 'a', 'b']);
  });

  it('pins a compared design to the reference layout: unmoved classes keep their place, moved ones move', async () => {
    const A = run(graph);
    // B: Variant moved from catalog (g2) into order (g1); B's own group ids; a new group with a new class
    const B: LayoutGraph = {
      nodes: [
        { id: 'h1', width: 10, height: 10, group: true }, { id: 'h2', width: 10, height: 10, group: true }, { id: 'h3', width: 10, height: 10, group: true },
        { id: 'Order', parent: 'h1', width: 100, height: 34 }, { id: 'OrderItem', parent: 'h1', width: 110, height: 34 }, { id: 'Variant', parent: 'h1', width: 100, height: 34 },
        { id: 'Product', parent: 'h2', width: 100, height: 34 },
        { id: 'Fresh', parent: 'h3', width: 90, height: 34 },
        { id: 'Lonely', width: 120, height: 50 },
      ],
      edges: [{ id: 'e1', source: 'Order', target: 'OrderItem' }, { id: 'e2', source: 'OrderItem', target: 'Variant' }, { id: 'e3', source: 'Product', target: 'Variant' }],
    };
    const match = (n: string) => ({ h1: 'g1', h2: 'g2', Lonely: 'Lonely' } as Record<string, string>)[n];
    const r = pinLayout(B, { graph, result: A, match });
    // (Lonely sat right below the order group, which grew: it gives way, the group stays)
    for (const id of ['g1', 'Order', 'OrderItem', 'Product']) expect(r.nodes[id === 'g1' ? 'h1' : id]).toMatchObject(id === 'g1' ? { x: A.nodes.g1.x, y: A.nodes.g1.y } : A.nodes[id]);
    expect(r.nodes.Variant).not.toEqual(A.nodes.Variant);
    expect(inside(r.nodes.Variant, r.nodes.h1)).toBe(true);
    expect(inside(r.nodes.Fresh, r.nodes.h3)).toBe(true);
    for (const [x, y] of [['h1', 'h2'], ['h1', 'h3'], ['h2', 'h3'], ['h3', 'Lonely'], ['h1', 'Lonely']]) expect(overlap(r.nodes[x], r.nodes[y])).toBe(false);
    // the unchanged inner edge keeps A's route; the others are routed again
    expect(r.edges.e1.points).toEqual(A.edges.e1.points);
    expect(r.edges.e2.points.length).toBeGreaterThanOrEqual(2);
    checkRoutes(B, r);
  });

  it('completes the routes of a layouter that returns boxes only', () => {
    const r = completeRoutes(graph, {
      nodes: { g1: { x: 0, y: 0, width: 300, height: 200 }, g2: { x: 400, y: 0, width: 200, height: 200 }, Order: { x: 10, y: 40, width: 100, height: 34 }, OrderItem: { x: 10, y: 120, width: 110, height: 34 }, Product: { x: 410, y: 40, width: 100, height: 34 }, Variant: { x: 410, y: 120, width: 100, height: 34 }, Lonely: { x: 0, y: 300, width: 120, height: 50 } },
      edges: {}, width: 600, height: 350, layouter: 'boxes', ms: 0,
    });
    checkRoutes(graph, r);
    // Order above OrderItem: leaves at the bottom, enters at the top
    expect(r.edges.e1.points[0].y).toBe(74);
    expect(r.edges.e1.points.at(-1)!.y).toBe(120);
  });

  it('routes around nodes in the way and spreads the ports of one side', () => {
    const g: LayoutGraph = {
      nodes: [{ id: 'a', width: 100, height: 50 }, { id: 'b', width: 100, height: 50 }, { id: 'wall', width: 60, height: 300 }, { id: 'c', width: 100, height: 50 }],
      edges: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'ac', source: 'a', target: 'c' }, { id: 'ba', source: 'b', target: 'a' }],
    };
    const r = routeEdges(g, {
      nodes: { a: { x: 0, y: 125, width: 100, height: 50 }, wall: { x: 200, y: 0, width: 60, height: 300 }, b: { x: 360, y: 125, width: 100, height: 50 }, c: { x: 360, y: 260, width: 100, height: 50 } },
      edges: {}, width: 460, height: 310, layouter: 't', ms: 0,
    });
    checkRoutes(g, r);
    // two edges leave a's right side at different points
    expect(r.edges.ab.points[0]).not.toEqual(r.edges.ac.points[0]);
  });
});
