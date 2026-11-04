import type { Decisions, Domain, EffectState, Id, Mechanism, ReplicaDecision, SagaStyle } from './types';
import { deriveDesign } from './derive';

export interface ServiceMatch {
  a: Id | null;
  b: Id | null;
  /** Jaccard overlap of their classes */
  overlap: number;
}

export interface DesignDiff {
  /** services of A matched to services of B (greedy by class overlap); unmatched ones on their own */
  matches: ServiceMatch[];
  /** classes whose service in B is not the match of their service in A */
  movedClasses: { cls: Id; fromA: Id; toB: Id }[];
  /** an access whose mechanism differs; null: within one service in that design (no mechanism, no hop) */
  mechanismChanges: { key: string; op: Id; cls: Id; a: Mechanism | null; b: Mechanism | null }[];
  sagaChanges: { process: Id; a: SagaStyle | null; b: SagaStyle | null }[];
  /** (1.4.0) effect steps whose mechanism or joining differs */
  effectChanges: { site: Id; op: Id; cls: Id; a: EffectState; b: EffectState }[];
  /** operations whose chosen home differs */
  homeChanges: { op: Id; a: Id; b: Id }[];
  replicaChanges: { a: Id; b: Id; ra: ReplicaDecision; rb: ReplicaDecision }[];
  databaseChanges: { a: Id; b: Id; placementA: string; placementB: string }[];
  /** B service id -> A service id it corresponds to (for stable colours and layout) */
  bToA: Map<Id, Id>;
  aToB: Map<Id, Id>;
}

const jaccard = (x: Set<Id>, y: Set<Id>) => {
  let inter = 0;
  for (const v of x) if (y.has(v)) inter++;
  return inter / (x.size + y.size - inter || 1);
};

function replicaEq(a: ReplicaDecision, b: ReplicaDecision) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffDesigns(domain: Domain, A: Decisions, B: Decisions): DesignDiff {
  const setsA = new Map(A.services.map((s) => [s.id, new Set(s.classes)]));
  const setsB = new Map(B.services.map((s) => [s.id, new Set(s.classes)]));
  const pairs: { a: Id; b: Id; j: number }[] = [];
  for (const [a, sa] of setsA) for (const [b, sb] of setsB) {
    const j = jaccard(sa, sb);
    if (j > 0) pairs.push({ a, b, j });
  }
  pairs.sort((x, y) => y.j - x.j || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  const aToB = new Map<Id, Id>(), bToA = new Map<Id, Id>();
  const matches: ServiceMatch[] = [];
  for (const p of pairs) {
    if (aToB.has(p.a) || bToA.has(p.b)) continue;
    aToB.set(p.a, p.b); bToA.set(p.b, p.a);
    matches.push({ a: p.a, b: p.b, overlap: p.j });
  }
  for (const s of A.services) if (!aToB.has(s.id)) matches.push({ a: s.id, b: null, overlap: 0 });
  for (const s of B.services) if (!bToA.has(s.id)) matches.push({ a: null, b: s.id, overlap: 0 });

  const dA = deriveDesign(domain, A), dB = deriveDesign(domain, B);
  const movedClasses: DesignDiff['movedClasses'] = [];
  for (const c of domain.classes) {
    const sa = dA.serviceOf.get(c.id), sb = dB.serviceOf.get(c.id);
    if (sa && sb && aToB.get(sa) !== sb) movedClasses.push({ cls: c.id, fromA: sa, toB: sb });
  }
  const mechB = new Map(dB.accesses.map((x) => [x.key, x]));
  const mechanismChanges: DesignDiff['mechanismChanges'] = [];
  for (const x of dA.accesses) {
    const y = mechB.get(x.key);
    if (y && y.mechanism !== x.mechanism) mechanismChanges.push({ key: x.key, op: x.op, cls: x.cls, a: x.mechanism, b: y.mechanism });
  }
  const sagaA = new Map(dA.sagas.map((s) => [s.process, s.style]));
  const sagaB = new Map(dB.sagas.map((s) => [s.process, s.style]));
  const sagaChanges: DesignDiff['sagaChanges'] = [];
  for (const p of domain.processes) {
    const a = sagaA.get(p.id) ?? null, b = sagaB.get(p.id) ?? null;
    if (a !== b) sagaChanges.push({ process: p.id, a, b });
  }
  const effectChanges: DesignDiff['effectChanges'] = [];
  const effB = new Map(dB.effects.map((e) => [e.id, e]));
  for (const e of dA.effects) {
    const f = effB.get(e.id);
    if (f && (e.state.m !== f.state.m || !!e.state.joined !== !!f.state.joined)) effectChanges.push({ site: e.id, op: e.op, cls: e.class, a: e.state, b: f.state });
  }
  const homeChanges: DesignDiff['homeChanges'] = [];
  for (const [op, a] of Object.entries(A.homes ?? {})) { const b = B.homes?.[op]; if (b && b !== a) homeChanges.push({ op, a, b }); }
  const svcA = new Map(A.services.map((s) => [s.id, s]));
  const svcB = new Map(B.services.map((s) => [s.id, s]));
  const placementOf = (D: Decisions, id: Id) => D.databases.find((d) => d.services.includes(id))?.placement ?? 'own';
  const replicaChanges: DesignDiff['replicaChanges'] = [];
  const databaseChanges: DesignDiff['databaseChanges'] = [];
  for (const [a, b] of aToB) {
    const ra = svcA.get(a)!.replicas, rb = svcB.get(b)!.replicas;
    if (!replicaEq(ra, rb)) replicaChanges.push({ a, b, ra, rb });
    const pa = placementOf(A, a), pb = placementOf(B, b);
    if (pa !== pb) databaseChanges.push({ a, b, placementA: pa, placementB: pb });
  }
  return { matches, movedClasses, mechanismChanges, sagaChanges, effectChanges, homeChanges, replicaChanges, databaseChanges, aToB, bToA };
}
