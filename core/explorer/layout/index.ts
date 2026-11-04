/**
 * Main-thread side of the layouters: every engine of layout/engines.ts runs in a layout worker behind a proxy with
 * the same `Layouter` shape. `registerLayouter` adds a layouter that runs on the main thread instead (tests,
 * experiments).
 *
 * A TALA layout takes up to a few seconds on the largest designs, so:
 *  - results are cached by graph (in memory and in IndexedDB, across reloads), and a graph that is being laid out
 *    is laid out once however often it is asked for;
 *  - the worker gets one job at a time; a job nobody waits for any more is dropped before it starts, and a running
 *    one is cut short by terminating the worker when another graph is asked for meanwhile.
 */
import { ENGINES, ENGINES_VERSION } from './engines';
import type { LayoutGraph, LayoutResult, Layouter } from './types';
import type { LayoutRequest, LayoutResponse } from './worker';

export * from './types';

// --- cache --------------------------------------------------------------------------------------

/** two 32-bit FNV-1a hashes of a string, as one key */
function hash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

export function cacheKey(engine: string, graph: LayoutGraph): string {
  return `${ENGINES_VERSION}|${engine}|${hash(JSON.stringify([graph.nodes, graph.edges, graph.direction, !!graph.directed]))}`;
}

const MEMORY_MAX = 60;
const memory = new Map<string, LayoutResult>();
const remember = (k: string, r: LayoutResult) => {
  memory.delete(k);
  memory.set(k, r);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
};

const DB = 'explorer-layouts', STORE = 'layouts', DB_MAX = 400;
let db: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  db ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return db;
}
async function dbGet(k: string): Promise<LayoutResult | null> {
  const d = await openDb();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE).objectStore(STORE).get(k);
      req.onsuccess = () => resolve((req.result as { r: LayoutResult } | undefined)?.r ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
let writes = 0;
async function dbPut(k: string, r: LayoutResult) {
  const d = await openDb();
  if (!d) return;
  try {
    const st = d.transaction(STORE, 'readwrite').objectStore(STORE);
    st.put({ r, t: Date.now() }, k);
    // now and then: keep the most recent DB_MAX layouts
    if (++writes % 20 === 1) {
      const all = st.getAll(), keys = st.getAllKeys();
      keys.onsuccess = () => {
        if (keys.result.length <= DB_MAX) return;
        const rows = keys.result.map((key, i) => ({ key, t: (all.result?.[i] as { t: number } | undefined)?.t ?? 0 })).sort((x, y) => x.t - y.t);
        for (const row of rows.slice(0, rows.length - DB_MAX)) st.delete(row.key);
      };
    }
  } catch { /* blocked or full */ }
}

// --- worker -------------------------------------------------------------------------------------

interface Job { id: number; key: string; engine: string; graph: LayoutGraph; waiters: number; done: Promise<LayoutResult>; resolve: (r: LayoutResult) => void; reject: (e: Error) => void }

let worker: Worker | null = null;
let seq = 0;
let running: Job | null = null;
const queue: Job[] = [];
const jobs = new Map<string, Job>();

function finish(job: Job) {
  jobs.delete(job.key);
  if (running === job) running = null;
  pump();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'layout' });
  w.onmessage = (e: MessageEvent<LayoutResponse>) => {
    const job = running;
    if (!job || job.id !== e.data.id) return;
    if ('error' in e.data) job.reject(new Error(e.data.error));
    else { remember(job.key, e.data.result); void dbPut(job.key, e.data.result); job.resolve(e.data.result); }
    finish(job);
  };
  w.onerror = (e) => {
    const job = running;
    w.terminate();
    if (worker === w) worker = null;
    if (job) { job.reject(new Error(`layout worker failed: ${e.message}`)); finish(job); }
  };
  worker = w;
  return w;
}

function pump() {
  if (running) return;
  // jobs nobody waits for any more are dropped before they start
  let job: Job | undefined;
  while ((job = queue.shift())) {
    if (job.waiters > 0) break;
    job.reject(new DOMException('aborted', 'AbortError'));
    jobs.delete(job.key);
  }
  if (!job) return;
  running = job;
  getWorker().postMessage({ id: job.id, engine: job.engine, graph: job.graph } satisfies LayoutRequest);
}

/** a running job nobody waits for: stop it (terminate the worker) when another one is waiting */
function preempt() {
  if (!running || running.waiters > 0 || !queue.some((j) => j.waiters > 0)) return;
  const job = running;
  worker?.terminate();
  worker = null;
  job.reject(new DOMException('aborted', 'AbortError'));
  finish(job);
}

const copy = (r: LayoutResult): LayoutResult => structuredClone(r);

/** a layouter that runs in the layout worker; results are cached */
class WorkerLayouter implements Layouter {
  constructor(readonly id: string, readonly label: string) {}
  async layout(graph: LayoutGraph, signal?: AbortSignal): Promise<LayoutResult> {
    const aborted = () => new DOMException('aborted', 'AbortError');
    if (signal?.aborted) throw aborted();
    const key = cacheKey(this.id, graph);
    const hit = memory.get(key);
    if (hit) { remember(key, hit); return copy(hit); }
    let job = jobs.get(key);
    if (!job) {
      const stored = await dbGet(key);
      if (signal?.aborted) throw aborted();
      if (stored) { remember(key, stored); return copy(stored); }
      job = jobs.get(key);
    }
    if (!job) {
      let resolve!: (r: LayoutResult) => void, reject!: (e: Error) => void;
      const done = new Promise<LayoutResult>((res, rej) => { resolve = res; reject = rej; });
      done.catch(() => {});
      job = { id: ++seq, key, engine: this.id, graph, waiters: 0, done, resolve, reject };
      jobs.set(key, job);
      queue.push(job);
    }
    const j = job;
    j.waiters++;
    preempt();
    pump();
    return new Promise<LayoutResult>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        j.waiters--;
        reject(aborted());
        // a queued job without waiters is dropped by pump(); a running one only when another job is waiting
        queueMicrotask(preempt);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      j.done.then((r) => { if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); resolve(copy(r)); } },
        (e) => { if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); reject(e); } });
    });
  }
}

const local = new Map<string, () => Layouter>();
const instances = new Map<string, Layouter>();

/** add a main-thread layouter under an id (worker engines go into layout/engines.ts) */
export function registerLayouter(id: string, make: () => Layouter) { local.set(id, make); instances.delete(id); }

export function layouters(): { id: string; label: string }[] {
  return [...ENGINES.filter((e) => !e.hidden).map((e) => ({ id: e.id, label: e.label })), ...[...local.keys()].map((id) => ({ id, label: getLayouter(id).label }))];
}

export const DEFAULT_LAYOUTER = ENGINES[0].id;

export function getLayouter(id = DEFAULT_LAYOUTER): Layouter {
  if (!instances.has(id)) {
    const make = local.get(id);
    const info = ENGINES.find((e) => e.id === id) ?? ENGINES[0];
    instances.set(id, make ? make() : new WorkerLayouter(info.id, info.label));
  }
  return instances.get(id)!;
}
