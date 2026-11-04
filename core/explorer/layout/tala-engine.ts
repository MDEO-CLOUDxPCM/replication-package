/**
 * TALA layouter (orthoflow, WebAssembly). Runs inside the layout worker (layout/worker.ts): a layout is synchronous
 * and takes from milliseconds to seconds, so it never runs on the UI thread. Several seeds are tried for small graphs
 * (the best is kept), one for large ones; a seed that fails falls back to the next.
 */
import { init, layout } from 'orthoflow';
import wasmUrl from 'orthoflow/orthoflow.wasm?url';
import { fromTala, seedsFor, toTala, type TalaGraphOut } from './tala';
import type { LayoutGraph, LayoutResult, Layouter } from './types';

export class TalaLayouter implements Layouter {
  readonly id = 'tala';
  readonly label = 'TALA (orthogonal)';
  private ready = init(wasmUrl);

  async layout(graph: LayoutGraph): Promise<LayoutResult> {
    await this.ready;
    const t0 = performance.now();
    const input = toTala(graph);
    const preferred = seedsFor(graph);
    let last: unknown = null;
    for (const seeds of [preferred, ...[[2], [3], [4]].filter((s) => !preferred.includes(s[0]))]) {
      try {
        const r = layout(input.graph, { seeds, unsafeIntegers: 'number' });
        if (!r.graph) { last = new Error(r.seeds.find((s) => s.error)?.error ?? 'TALA layout failed'); continue; }
        return fromTala(graph, input, r.graph as TalaGraphOut, this.id, Math.round(performance.now() - t0));
      } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}
