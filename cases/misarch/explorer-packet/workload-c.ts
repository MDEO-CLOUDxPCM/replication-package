/**
 * Adapter: package C's session model (workload/sessions.json) -> the contract's request types,
 * session types and load profiles.
 *
 * A session class's steps (call, think, delay, loop, branch, use) are reduced to expected visits per
 * request type and the expected think time per step; the design mix is the realistic workload's
 * base mix; the design session rate is the one at which that mix sends as many client requests as
 * round 2 at its design load (C's definition); admin requests stay at their round-2 rate.
 */
import type { Id, LoadProfile, RequestType, SessionType } from '../../../core/explorer/contract/types';
import { files, rel } from './config';

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = any;

/** mean of a StoEx-like expression: numbers, IntPMF[(v;p)...], UniDouble(a, b), Exp(rate) */
export function stoexMean(x: unknown): number {
  if (typeof x === 'number') return x;
  const s = String(x ?? '').trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
  const pmf = /^(?:Int|Double)PMF\[(.*)\]$/.exec(s);
  if (pmf) return [...pmf[1].matchAll(/\(\s*([-\d.]+)\s*;\s*([\d.]+)\s*\)/g)].reduce((a, m) => a + +m[1] * +m[2], 0);
  const uni = /^Uni(?:Double|Int)\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(s);
  if (uni) return (+uni[1] + +uni[2]) / 2;
  const exp = /^Exp\(\s*([\d.]+)\s*\)$/.exec(s);
  if (exp) return 1 / +exp[1];
  return 0;
}

interface Walk { visits: Map<Id, number>; order: Id[]; think: number; calls: number }

function walk(w: W, steps: W[], weight: number, acc: Walk, depth = 0) {
  if (depth > 20) return;
  for (const st of steps ?? []) {
    if (st.call) {
      if (!acc.visits.has(st.call)) acc.order.push(st.call);
      acc.visits.set(st.call, (acc.visits.get(st.call) ?? 0) + weight);
      acc.calls += weight;
    } else if (st.think) {
      acc.think += weight * stoexMean(w.think?.[st.think]?.dist ?? 0);
    } else if (st.delay) {
      acc.think += weight * stoexMean(st.delay);
    } else if (st.loop !== undefined) {
      walk(w, st.body, weight * stoexMean(st.loop), acc, depth + 1);
    } else if (st.branch) {
      for (const b of st.branch) walk(w, b.body, weight * (b.p ?? 0), acc, depth + 1);
    } else if (st.use) {
      walk(w, w.fragments?.[st.use]?.steps ?? [], weight, acc, depth + 1);
    }
  }
}

export interface Workload {
  requests: RequestType[];
  sessions: SessionType[];
  /** sessions per second at the design load */
  designSessions: number;
  profiles: LoadProfile[];
  source: string;
}

const NAMES: Record<string, string> = { browser: 'Browser', cartAbandoner: 'Cart abandoner', buyer: 'Buyer', account: 'Account', admin: 'Admin' };

/**
 * @param r2RequestRates round 2's client request rates at its design load (A's msa mapping), for
 *   the design session rate and the admin requests
 * @param opIds the domain's operation ids (plans are filtered to them)
 */
export function fromWorkload(w: W, r2RequestRates: Map<Id, number>, opIds: Set<Id>, documents: Map<Id, string>, dt = 10): Workload {
  const real = w.workloads?.realistic ?? {};
  const baseMix: string = real.baseMix ?? 'shopping';
  const mixes: Record<string, { shares: Record<string, number> }> = real.mixes ?? {};
  const shares = mixes[baseMix]?.shares ?? {};
  const classes = Object.keys(shares);
  const walks = new Map<string, Walk>();
  for (const c of [...classes, 'admin']) {
    const acc: Walk = { visits: new Map(), order: [], think: 0, calls: 0 };
    walk(w, w.classes?.[c]?.steps ?? [], 1, acc);
    walks.set(c, acc);
  }
  // design sessions: the base mix sends as many client requests as round 2 (logins included, admin excluded)
  const adminReqs = new Set(walks.get('admin')!.visits.keys());
  const r2Client = [...r2RequestRates.entries()].filter(([k]) => !adminReqs.has(k)).reduce((s, [, v]) => s + v, 0) + (r2RequestRates.has('login') ? 0 : 64.2);
  const perSession = classes.reduce((s, c) => s + shares[c] * walks.get(c)!.calls, 0) || 1;
  const designSessions = r2Client / perSession;
  const rate = new Map<Id, number>();
  for (const c of classes) for (const [r, v] of walks.get(c)!.visits) rate.set(r, (rate.get(r) ?? 0) + designSessions * shares[c] * v);
  for (const r of adminReqs) rate.set(r, (rate.get(r) ?? 0) + (r2RequestRates.get(r) ?? 0.01));
  const requests: RequestType[] = Object.entries(w.requests ?? {}).map(([id, r]: [string, W]) => ({
    id, name: id, document: documents.get(id), operations: (r.operations ?? []).filter((o: Id) => opIds.has(o)),
    rate: Math.round((rate.get(id) ?? 0) * 1e4) / 1e4,
  }));
  const sessions: SessionType[] = [...classes, 'admin'].map((c) => {
    const acc = walks.get(c)!;
    return {
      id: c, name: NAMES[c] ?? c, description: w.classes?.[c]?.about,
      share: c === 'admin' ? 0 : shares[c],
      thinkTimeS: Math.round((acc.think / Math.max(1, acc.calls)) * 100) / 100,
      steps: acc.order.map((r) => ({ request: r, repeat: Math.round(acc.visits.get(r)! * 1000) / 1000 })),
    };
  });
  // load profiles: phases -> sessions/s and mix over time
  const profiles: LoadProfile[] = Object.entries(w.profiles ?? {}).map(([id, p]: [string, W]) => {
    const end = p.endSeconds ?? 720;
    const t = Array.from({ length: Math.floor(end / dt) + 1 }, (_, i) => i * dt);
    const phaseAt = (x: number) => [...p.phases].reverse().find((ph: W) => x >= ph.from) ?? p.phases[0];
    const mix: Record<Id, number[]> = Object.fromEntries(classes.map((c) => [c, t.map((x) => mixes[phaseAt(x).mix]?.shares?.[c] ?? 0)]));
    return {
      id, label: `${id}: ${p.phases.map((ph: W) => `${ph.name} ${ph.volume}×`).join(', ')}`,
      t, sessionsPerSecond: t.map((x) => Math.round(designSessions * phaseAt(x).volume * 100) / 100), mix,
    };
  });
  return { requests, sessions, designSessions, profiles, source: `${rel(files.workload)} (package C, version ${w.version})` };
}

export { visitsOf } from '../../../core/explorer/contract/derive';
