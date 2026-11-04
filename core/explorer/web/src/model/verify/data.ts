/**
 * The Verify tab's data (contract/verify.ts): the packet's precomputed parts, causes and chains and the file lists of
 * its source trees, read from the backend (/api/packets/:id/verify/*, /api/packets/:id/sources/*), and what the
 * viewer derives from them: the case's kinds, scopes and document kinds, the source trees' labels (packet.json
 * `sources`). The viewer knows no case: the parts file defines its kinds of parts, its groups and its scopes.
 */
import { createContext, useContext, useMemo } from 'react';
import type { SourceTree } from '@contract/packet';
import type { Loc, PartKindDef, ScopeDef, VerifyCauses, VerifyChains, VerifyParts } from '@contract/verify';
import { usePacketSourceTrees, usePacketVerify } from '@/lib/api';
import { usePacket, usePacketId } from '@/lib/packet';

/** the file lists of the source trees, by name (a tree not loaded yet is absent) */
export type Trees = Record<string, Set<string>>;

/** what the viewer shows of the parts file besides the parts, and of the packet's source trees */
export interface VerifyInfo {
  kinds: PartKindDef[];
  kind: (id: string) => PartKindDef;
  lateGroups: string[];
  scopes: Record<string, ScopeDef>;
  docKinds: Record<string, string>;
  leadFacts: Record<string, string[]>;
  /** the tree the code evidence and the chains point into, and its commit */
  tree?: string;
  commit?: string;
  /** a tree's label (packet.json `sources[tree].label`; the name without one) */
  label: (tree: string | undefined) => string;
  /** a tree's definition */
  source: (tree: string | undefined) => SourceTree | undefined;
}

export function verifyInfo(vp: Omit<VerifyParts, 'parts' | 'contract'> | undefined, sources: Record<string, SourceTree> | undefined): VerifyInfo {
  const kinds = vp?.kinds ?? [];
  const byId = new Map(kinds.map((k) => [k.id, k]));
  return {
    kinds,
    kind: (id) => byId.get(id) ?? { id, label: id, plural: id, short: id.slice(0, 1).toUpperCase() },
    lateGroups: vp?.lateGroups ?? [],
    scopes: vp?.scopes ?? {},
    docKinds: vp?.docKinds ?? {},
    leadFacts: vp?.leadFacts ?? {},
    tree: vp?.tree,
    commit: vp?.commit,
    label: (t) => (t ? sources?.[t]?.label ?? t : ''),
    source: (t) => (t ? sources?.[t] : undefined),
  };
}

const EMPTY = verifyInfo(undefined, undefined);
/** the info of the parts shown (VerifyTab provides it; a part rendered alone gets the empty one) */
export const VerifyInfoContext = createContext<VerifyInfo>(EMPTY);
export const useVerifyInfo = () => useContext(VerifyInfoContext);

/** an operation's part */
export const opKey = (id: string) => `op:${id}`;

/** a location in a tree whose file list is known and lacks it: shown, not opened */
export const isExternal = (l: Pick<Loc, 'repo' | 'path'>, trees: Trees | undefined) => { const t = trees?.[l.repo]; return !!t && !t.has(l.path); };

/** the packet's Verify files and source trees */
export function useVerifyData() {
  const id = usePacketId();
  const packet = usePacket();
  const sources = packet?.manifest.sources;
  const names = useMemo(() => Object.keys(sources ?? {}), [sources]);
  const parts = usePacketVerify<VerifyParts>(id, 'parts');
  const causes = usePacketVerify<VerifyCauses>(id, 'causes');
  const chains = usePacketVerify<VerifyChains>(id, 'chains');
  const trees = usePacketSourceTrees(id, names);
  const info = useMemo(() => verifyInfo(parts.data, sources), [parts.data, sources]);
  return { id, setup: packet?.manifest.verify, parts, causes, chains, trees, info };
}

/** the chains (SourcePane): the packet's, loaded once */
export function useChains() {
  return usePacketVerify<VerifyChains>(usePacketId(), 'chains');
}
