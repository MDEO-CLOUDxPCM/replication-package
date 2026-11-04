/**
 * The layouter catalogue. Every entry is an in-browser async `Layouter` (layout/types.ts) that runs inside the layout
 * web worker (layout/worker.ts); the main thread only sees ids and labels, so an engine's code (the orthoflow
 * WebAssembly module, elkjs) is loaded lazily, in the worker, on first use. Another engine: implement `Layouter` in a module
 * of its own and add an entry here; with more than one visible entry the architecture panel offers a layouter menu
 * (?layouter=<id>).
 */
import type { Layouter } from './types';

export interface EngineInfo {
  id: string;
  label: string;
  /** not offered in the layouter menu */
  hidden?: boolean;
  /** creates the engine (called once per worker, lazily) */
  load: () => Promise<Layouter>;
}

/** bump when an engine's output changes, so cached layouts (layout/index.ts) are not reused */
export const ENGINES_VERSION = 'orthoflow-0.1.0+elkjs-0.11.1/1';

export const ENGINES: EngineInfo[] = [
  // the architecture graph and the Model panel's ungrouped class diagrams: TALA (D2's orthogonal engine) via orthoflow
  { id: 'tala', label: 'TALA (orthogonal)', load: () => import('./tala-engine').then((m) => new m.TalaLayouter()) },
  // grouped class diagrams (many small groups): packed, which TALA is not
  { id: 'elk-packed', label: 'ELK packed groups', hidden: true, load: () => import('./elk').then((m) => new m.ElkPackedLayouter()) },
];
