/**
 * The layout web worker: hosts the engines of layout/engines.ts. Protocol:
 *   in  { id, engine, graph }          out { id, result } | { id, error }
 * Engines are created once per worker, on first use.
 */
import { ENGINES } from './engines';
import type { LayoutGraph, LayoutResult, Layouter } from './types';

export interface LayoutRequest { id: number; engine: string; graph: LayoutGraph }
export type LayoutResponse = { id: number; result: LayoutResult } | { id: number; error: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<LayoutRequest>) => void) | null; postMessage(m: LayoutResponse): void };
const engines = new Map<string, Promise<Layouter>>();

scope.onmessage = async (e) => {
  const { id, engine, graph } = e.data;
  try {
    const info = ENGINES.find((x) => x.id === engine);
    if (!info) throw new Error(`unknown layouter ${engine}`);
    if (!engines.has(info.id)) engines.set(info.id, info.load());
    const result = await (await engines.get(info.id)!).layout(graph);
    scope.postMessage({ id, result });
  } catch (err) {
    scope.postMessage({ id, error: (err as Error)?.message ?? String(err) });
  }
};
