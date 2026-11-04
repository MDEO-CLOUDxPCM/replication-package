/**
 * The data packet of the workspace (contract/packet.ts): the run's packet (RunSummary.packet), else
 * the first packet of the index. Everything case-specific the UI shows comes from it — texts, metric docs, the How
 * pipeline, the Interactions examples, the vocabulary, the capabilities that turn tabs on and off. Missing texts
 * are empty: the generic explorer shows nothing case-specific without a packet.
 *
 *   usePacket()          the loaded packet (manifest, docs, summary) or undefined while loading
 *   useTexts()           tx(key, vars?) -> the packet's text `texts[key]` with {{var}} filled ('' when missing)
 *   useDoc(name)         one of the packet's docs (docs/*.json)
 *   useCapabilities()    what the packet turns on (with its family)
 *   useVocab()           labels and explanations of mechanisms, styles, operation kinds
 *
 * Texts are templates: `{{name}}` inserts a variable, `{{#name}}…{{/name}}` keeps its body when the variable is
 * truthy (a non-empty array, a number other than 0, true, a non-empty string), `{{^name}}…{{/name}}` when it is not.
 * Inline markup (help/Rich.tsx): `code`, **bold**, [label](model target).
 */
import { createContext, useCallback, useContext, useMemo } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import type { Capabilities, PacketBody, VocabEntry, Vocabulary } from '@contract/packet';
import { useIndex } from './api';
import { useSelection } from './store';

export type TextVars = Record<string, string | number | boolean | null | undefined | unknown[]>;
export type Tx = (key: string, vars?: TextVars) => string;

/** a packet given directly (tests; a page that renders without the backend); wins over the fetched one */
export const PacketContext = createContext<PacketBody | null>(null);

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json() as Promise<T>;
}

/** the id of the workspace's packet: the run's, else the first loaded */
export function usePacketId(): string | undefined {
  const given = useContext(PacketContext);
  // a packet given directly needs no backend (and no QueryClient: whether there is one never changes for a tree)
  if (given) return given.manifest.id;
  return useFetchedPacketId();
}

function useFetchedPacketId(): string | undefined {
  const run = useSelection((s) => s.run);
  const { data: idx } = useIndex();
  const own = run ? idx?.runs.find((r) => r.id === run)?.packet : undefined;
  return own ?? idx?.packets?.[0]?.id;
}

export function usePacket(): PacketBody | undefined {
  const given = useContext(PacketContext);
  const client = useContext(QueryClientContext);
  // given directly (tests, a page without the backend), or nothing to fetch with: the hooks below are never called
  // for this tree, so the order of hooks stays the same on every render
  if (given || !client) return given ?? undefined;
  return useFetchedPacket();
}

function useFetchedPacket(): PacketBody | undefined {
  const id = useFetchedPacketId();
  const q = useQuery({ queryKey: ['packet', id], queryFn: () => getJson<PacketBody>(`/api/packets/${encodeURIComponent(id!)}`), enabled: !!id, staleTime: Infinity, retry: false });
  return q.data;
}

const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : !!v);

/** fill a template (see the header); unknown variables are empty */
export function renderTemplate(tpl: string, vars: TextVars = {}): string {
  // sections first (innermost out), then variables
  let s = tpl;
  const sec = /\{\{([#^])(\w+)\}\}((?:(?!\{\{[#^]\w+\}\})[\s\S])*?)\{\{\/\2\}\}/;
  for (let m = sec.exec(s); m; m = sec.exec(s)) {
    const keep = m[1] === '#' ? truthy(vars[m[2]]) : !truthy(vars[m[2]]);
    s = s.slice(0, m.index) + (keep ? m[3] : '') + s.slice(m.index + m[0].length);
  }
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => { const v = vars[k]; return v === undefined || v === null || v === false ? '' : Array.isArray(v) ? v.join(', ') : String(v); });
}

/** the packet's texts as a function (stable while the packet is) */
export function useTexts(): Tx {
  const p = usePacket();
  const texts = (p?.docs.texts ?? {}) as Record<string, string>;
  return useCallback((key: string, vars?: TextVars) => { const t = texts[key]; return t === undefined ? '' : renderTemplate(t, vars); }, [texts]);
}

/** one doc of the packet (docs/<name>.json, parsed) */
export function useDoc<T>(name: string): T | undefined {
  return usePacket()?.docs[name] as T | undefined;
}

export interface PacketCaps extends Capabilities {
  family?: string;
  /** the commands the backend's local configuration allows for the packet */
  allowedCommands: string[];
  /** the packet is loaded (capabilities are known) */
  loaded: boolean;
}

export function useCapabilities(): PacketCaps {
  const p = usePacket();
  return useMemo(() => ({ ...(p?.manifest.capabilities ?? {}), family: p?.manifest.family, allowedCommands: p?.summary.allowedCommands ?? [], loaded: !!p }), [p]);
}

/** the packet's vocabulary: label (falls back to the id) and entry of a mechanism, style or operation kind */
export function useVocab() {
  const v = usePacket()?.manifest.vocabulary;
  return useMemo(() => {
    const maps = Object.fromEntries((['mechanisms', 'styles', 'operationKinds', 'edges'] as (keyof Vocabulary)[]).map((k) => [k, new Map((v?.[k] ?? []).map((e) => [e.id, e]))])) as Record<keyof Vocabulary, Map<string, VocabEntry>>;
    return {
      entry: (kind: keyof Vocabulary, id: string) => maps[kind].get(id),
      label: (kind: keyof Vocabulary, id: string) => maps[kind].get(id)?.label ?? id,
    };
  }, [v]);
}

/** a localStorage key of the packet's own (the marks of one packet are not another's) */
export const packetKey = (base: string, packet: string | undefined) => (packet ? `${base}:${packet}` : base);
