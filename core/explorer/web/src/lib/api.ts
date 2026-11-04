import { useRef } from 'react';
import { useQuery, useQueries, keepPreviousData } from '@tanstack/react-query';
import type { Design, DesignDetail, DesignList, Domain, InputModel, Run, RunIndex } from '@contract/types';

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error ?? msg; } catch { /* not json */ }
    const e = new Error(msg) as Error & { status?: number };
    e.status = r.status;
    throw e;
  }
  return r.json() as Promise<T>;
}

export const useIndex = () => useQuery({ queryKey: ['index'], queryFn: () => get<RunIndex>('/api/index'), staleTime: 30_000 });
export const useRun = (id?: string) => useQuery({ queryKey: ['run', id], queryFn: () => get<Run>(`/api/runs/${id}`), enabled: !!id, staleTime: Infinity });
export const useDesigns = (runId?: string) =>
  useQuery({ queryKey: ['designs', runId], queryFn: () => get<DesignList>(`/api/runs/${runId}/designs`), enabled: !!runId, staleTime: Infinity, placeholderData: keepPreviousData });
export const useDesign = (runId?: string, id?: string) =>
  useQuery({ queryKey: ['design', runId, id], queryFn: () => get<Design>(`/api/runs/${runId}/designs/${id}`), enabled: !!runId && !!id, staleTime: Infinity });
export const useDomain = (id?: string) =>
  useQuery({ queryKey: ['domain', id], queryFn: () => get<Domain>(`/api/domains/${id}`), enabled: !!id, staleTime: Infinity, retry: false });

/**
 * the optimisation's input model of a domain (the case packet's export-model.ts), with the backend's freshness
 * (server/model-sync.ts): asked again on focus, and every few seconds while the backend exports it again
 */
export const useInputModel = (domainId?: string) =>
  useQuery({ queryKey: ['inputModel', domainId], queryFn: () => get<InputModel>(`/api/domains/${domainId}/model`), enabled: !!domainId, staleTime: 15_000, retry: false,
    refetchInterval: (q) => (q.state.data?.freshness?.state === 'updating' ? 3000 : false) });

/** a packet's Verify file (packet.json `verify`: parts, causes, chains; contract/verify.ts), by the packet's id (lib/packet.tsx usePacketId) */
export const usePacketVerify = <T,>(packet: string | undefined, name: 'parts' | 'causes' | 'chains') =>
  useQuery({ queryKey: ['packet', packet, 'verify', name], queryFn: () => get<T>(`/api/packets/${encodeURIComponent(packet!)}/verify/${name}`), enabled: !!packet, staleTime: Infinity, retry: false });

/** the file lists of a packet's source trees (packet.json `sources`), by tree name: the trees loaded so far */
export function usePacketSourceTrees(packet: string | undefined, trees: string[]): Record<string, Set<string>> {
  const qs = useQueries({
    queries: trees.map((t) => ({
      queryKey: ['packet', packet, 'sources', t],
      queryFn: () => get<{ files: string[] }>(`/api/packets/${encodeURIComponent(packet!)}/sources/${encodeURIComponent(t)}`).then((r) => new Set(r.files)),
      enabled: !!packet, staleTime: Infinity, retry: false,
    })),
  });
  // the same object while no list changed
  const last = useRef<{ names: string[]; sets: (Set<string> | undefined)[]; out: Record<string, Set<string>> } | null>(null);
  const sets = qs.map((q) => q.data);
  const l = last.current;
  if (l && l.names.join('\0') === trees.join('\0') && l.sets.every((x, i) => x === sets[i])) return l.out;
  const out: Record<string, Set<string>> = {};
  trees.forEach((t, i) => { if (sets[i]) out[t] = sets[i]!; });
  last.current = { names: trees, sets, out };
  return out;
}

/** one file of a packet's source tree (git: at the tree's ref; dir: the working tree) */
export const usePacketSourceFile = (packet: string | undefined, tree?: string, path?: string) =>
  useQuery({
    queryKey: ['packet', packet, 'source', tree, path],
    queryFn: () => get<{ tree: string; path: string; commit?: string; text: string }>(`/api/packets/${encodeURIComponent(packet!)}/sources/${encodeURIComponent(tree!)}/file?path=${encodeURIComponent(path!)}`),
    enabled: !!packet && !!tree && !!path, staleTime: Infinity, retry: false,
  });

/** detail: precomputed or cached first; `simulate` asks the backend to simulate (cached afterwards) */
export const useDetail = (runId?: string, id?: string, simulate = false) =>
  useQuery({
    queryKey: ['detail', runId, id, simulate],
    queryFn: () => get<DesignDetail>(`/api/runs/${runId}/designs/${id}/detail${simulate ? '?simulate=1' : ''}`),
    enabled: !!runId && !!id,
    staleTime: Infinity,
    retry: false,
  });

/** "run~design" references in URLs */
export { ref, parseRef } from './workspace';
