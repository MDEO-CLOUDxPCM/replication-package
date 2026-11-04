/**
 * elkjs layouter for grouped class diagrams (the Model panel's domain diagram by service or aggregate): groups laid
 * out inside (layered) and rect-packed, edges between them routed around the nodes (layout/route.ts). TALA spreads
 * such diagrams of many small groups over an area several times larger, so they keep this packed layout. Runs inside
 * the layout worker; elkjs's own engine runs in a nested worker of its own (its bundled build cannot run inside a
 * module worker).
 */
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { fixGroupEdges, fromElkTwoLevel, toElkTwoLevel } from './elk-graph';
import { routeEdges } from './route';
import type { LayoutGraph, LayoutResult, Layouter } from './types';

export class ElkPackedLayouter implements Layouter {
  readonly id = 'elk-packed';
  readonly label = 'ELK packed groups';
  private elk = new ELK({ workerFactory: () => new Worker(elkWorkerUrl) as never, workerUrl: elkWorkerUrl });

  async layout(graph: LayoutGraph): Promise<LayoutResult> {
    const t0 = performance.now();
    const { root, cross } = toElkTwoLevel(graph);
    const out = await this.elk.layout(root);
    const r = fromElkTwoLevel(out, cross, Math.round(performance.now() - t0), this.id);
    fixGroupEdges(out, r);
    return routeEdges(graph, r);
  }
}
