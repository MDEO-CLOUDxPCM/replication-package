/**
 * A small NSGA-II over domain cuts with group operators, run on the analytic dummy model, so the
 * synthetic runs have a real convergence history, archive and Pareto structure.
 */
import type { Decisions, Domain, Id, Mechanism, ReplicaDecision, SagaStyle } from '../contract/types';
import { levelOf } from '../contract/consistency';
import { accessKey } from '../contract/derive';
import { designHash } from '../contract/hash';
import { dominates } from '../contract/pareto';
import { demands, evaluate, needed, type Evaluation, type ProblemId } from './model';

export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

/** working form: class -> group number, plus the other decisions keyed by group */
export interface Genome {
  assign: Record<Id, number>;
  mechanisms: Record<string, Mechanism>;
  sagas: Record<Id, SagaStyle>;
  /** group -> group whose database it shares (absent: own database) */
  sharedDb: Record<number, number>;
  replicas: Record<number, number>;
}

export interface Individual {
  genome: Genome;
  decisions: Decisions;
  hash: string;
  eval: Evaluation;
  born: number;
}

export class Search {
  private procOps: Set<Id>;
  constructor(readonly domain: Domain, readonly problem: ProblemId, readonly rng: Rng) {
    this.procOps = new Set(domain.processes.flatMap((p) => p.steps));
  }

  // ------------------------------------------------------------ genomes

  fromCut(cut: { name: string; classes: Id[] }[]): Genome {
    const assign: Record<Id, number> = {};
    cut.forEach((s, i) => s.classes.forEach((c) => (assign[c] = i)));
    const replicas: Record<number, number> = {};
    cut.forEach((_, i) => (replicas[i] = 0));
    return { assign, mechanisms: {}, sagas: {}, sharedDb: {}, replicas };
  }

  random(): Genome {
    const aggs = this.domain.aggregates;
    const k = int(this.rng, 2, Math.min(20, aggs.length + 3));
    const assign: Record<Id, number> = {};
    for (const a of aggs) {
      const g = int(this.rng, 0, k - 1);
      for (const c of a.classes) assign[c] = g;
    }
    for (const c of this.domain.classes) if (this.rng() < 0.12) assign[c.id] = int(this.rng, 0, k);
    const g: Genome = { assign, mechanisms: {}, sagas: {}, sharedDb: {}, replicas: {} };
    for (const grp of new Set(Object.values(assign))) if (this.rng() < 0.25) g.sharedDb[grp] = pick(this.rng, [...new Set(Object.values(assign))]);
    return g;
  }

  /** valid mechanisms of a cross-service access */
  options(opId: Id, cls: Id, mode: 'read' | 'write'): Mechanism[] {
    const op = this.domain.operations.find((o) => o.id === opId)!;
    if (mode === 'write') return this.procOps.has(opId) ? ['saga', 'sync'] : ['sync', 'saga'];
    // (contract 1.13.0) a strict read needs current data: no copy or cache (levelOf reads `strong` of older domains)
    const acc = op.accesses.find((a) => a.class === cls && a.mode === mode);
    const opts: Mechanism[] = ['sync'];
    if (!acc || levelOf(acc) !== 'strict') opts.push('copy', 'cache');
    if (op.kind === 'query') opts.push('join');
    return opts;
  }

  /** normalise groups, fill missing decisions, drop stale ones; returns the contract decisions */
  repair(g: Genome): Decisions {
    // renumber groups by first class in domain order
    const order = new Map<number, number>();
    for (const c of this.domain.classes) {
      const grp = g.assign[c.id];
      if (!order.has(grp)) order.set(grp, order.size);
    }
    const assign: Record<Id, number> = {};
    for (const c of this.domain.classes) assign[c.id] = order.get(g.assign[c.id])!;
    const sharedDb: Record<number, number> = {};
    for (const [k, v] of Object.entries(g.sharedDb)) {
      const a = order.get(+k), b = order.get(v);
      if (a !== undefined && b !== undefined && a !== b) sharedDb[a] = b;
    }
    const replicas: Record<number, number> = {};
    for (const [k, v] of Object.entries(g.replicas)) { const a = order.get(+k); if (a !== undefined) replicas[a] = v; }
    g.assign = assign; g.sharedDb = sharedDb; g.replicas = replicas;
    const n = order.size;
    // services
    const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`);
    const classesOf: Id[][] = ids.map(() => []);
    for (const c of this.domain.classes) classesOf[assign[c.id]].push(c.id);
    // databases: resolve chains, the root holds the database
    const root = (i: number, seen = new Set<number>()): number => {
      const nx = sharedDb[i];
      if (nx === undefined || seen.has(i)) return i;
      seen.add(i);
      return root(nx, seen);
    };
    const dbMembers = new Map<number, number[]>();
    for (let i = 0; i < n; i++) dbMembers.set(root(i), [...(dbMembers.get(root(i)) ?? []), i]);
    // mechanisms for cross accesses
    const mechanisms: Record<string, Mechanism> = {};
    for (const op of this.domain.operations) {
      const from = assign[op.homeClass];
      for (const a of op.accesses) {
        if (assign[a.class] === from) continue;
        const key = accessKey(op.id, a.class, a.mode);
        const opts = this.options(op.id, a.class, a.mode);
        const cur = g.mechanisms[key];
        mechanisms[key] = cur && opts.includes(cur) ? cur : this.rng() < 0.55 ? opts[0] : pick(this.rng, opts);
      }
    }
    g.mechanisms = mechanisms;
    const names = classesOf.map((cs) => this.serviceName(cs));
    const dedup = new Map<string, number>();
    names.forEach((nm, i) => { const k = (dedup.get(nm) ?? 0) + 1; dedup.set(nm, k); if (k > 1) names[i] = `${nm} ${k}`; });
    const services = ids.map((id, i) => ({
      id, name: names[i], classes: classesOf[i], database: `db${root(i) + 1}`,
      replicas: { mode: 'fixed', count: 1 } as ReplicaDecision,
    }));
    const databases = [...dbMembers.entries()].map(([r, ms]) => ({
      id: `db${r + 1}`, name: ms.length > 1 ? `shared db (${names[r]})` : `${names[r]} db`,
      placement: ms.length > 1 ? ('shared' as const) : ('own' as const), services: ms.map((m) => ids[m]),
    }));
    const decisions: Decisions = { services, mechanisms, sagas: [], databases };
    // sagas for processes spanning services
    const dem = demands(this.domain, decisions);
    for (const s of dem.derived.sagas) {
      const style = g.sagas[s.process] ?? (this.rng() < 0.6 ? 'choreography' : 'orchestration');
      g.sagas[s.process] = style;
      decisions.sagas.push({ process: s.process, style, orchestrator: style === 'orchestration' ? s.services[0] : undefined });
    }
    // replicas: sized from the load, the genome keeps an offset
    services.forEach((s, i) => {
      const c = dem.cpu.get(s.id) ?? 0;
      const off = (g.replicas[i] ??= this.rng() < 0.7 ? 0 : int(this.rng, -1, 2));
      s.replicas = { mode: 'fixed', count: Math.max(1, needed(c * 4, 0.85) + off) };
    });
    return decisions;
  }

  serviceName(classes: Id[]): string {
    const count = new Map<string, number>();
    for (const c of classes) {
      const a = this.domain.classes.find((x) => x.id === c)?.aggregate ?? c;
      count.set(a, (count.get(a) ?? 0) + 1);
    }
    const aggs = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((x) => x[0]);
    if (aggs.length === 1) {
      const full = this.domain.aggregates.find((a) => a.id === aggs[0]);
      return full && full.classes.length !== classes.length ? `${aggs[0]} (${classes[0]})` : aggs[0];
    }
    if (aggs.length <= 3) return aggs.join(' + ');
    return `${aggs.slice(0, 2).join(' + ')} +${aggs.length - 2}`;
  }

  // ------------------------------------------------------------ operators

  static readonly OPERATORS = [
    'move-class', 'move-aggregate', 'move-feature', 'merge-services', 'split-service', 'change-mechanism',
    'change-saga-style', 'change-replicas', 'change-database',
  ] as const;

  mutate(src: Genome): Genome {
    const g: Genome = structuredClone(src);
    const steps = int(this.rng, 1, 3);
    const groups = () => [...new Set(Object.values(g.assign))];
    for (let s = 0; s < steps; s++) {
      const op = pick(this.rng, Search.OPERATORS);
      const grs = groups();
      const fresh = grs.reduce((a, b) => Math.max(a, b), -Infinity) + 1;
      switch (op) {
        case 'move-class': {
          const c = pick(this.rng, this.domain.classes).id;
          g.assign[c] = this.rng() < 0.15 ? fresh : pick(this.rng, grs);
          break;
        }
        case 'move-aggregate': {
          const a = pick(this.rng, this.domain.aggregates);
          const to = this.rng() < 0.15 ? fresh : pick(this.rng, grs);
          for (const c of a.classes) g.assign[c] = to;
          break;
        }
        case 'move-feature': {
          const f = pick(this.rng, this.domain.features);
          const cls = new Set<Id>();
          for (const o of f.operations) {
            const op2 = this.domain.operations.find((x) => x.id === o);
            if (!op2) continue;
            cls.add(op2.homeClass);
            for (const a of op2.accesses) if (a.mode === 'write') cls.add(a.class);
          }
          const to = g.assign[pick(this.rng, [...cls])];
          for (const c of cls) g.assign[c] = to;
          break;
        }
        case 'merge-services': {
          if (grs.length < 2) break;
          const a = pick(this.rng, grs), b = pick(this.rng, grs.filter((x) => x !== a));
          for (const c of Object.keys(g.assign)) if (g.assign[c] === b) g.assign[c] = a;
          break;
        }
        case 'split-service': {
          const a = pick(this.rng, grs);
          const aggs = [...new Set(Object.keys(g.assign).filter((c) => g.assign[c] === a).map((c) => this.domain.classes.find((x) => x.id === c)!.aggregate!))];
          if (aggs.length < 2) break;
          const half = new Set(aggs.filter(() => this.rng() < 0.5));
          for (const c of Object.keys(g.assign)) if (g.assign[c] === a && half.has(this.domain.classes.find((x) => x.id === c)!.aggregate!)) g.assign[c] = fresh;
          break;
        }
        case 'change-mechanism': {
          const keys = Object.keys(g.mechanisms);
          for (let i = 0; i < Math.min(keys.length, int(this.rng, 1, 4)); i++) {
            const k = pick(this.rng, keys);
            const [opId, cls, mode] = k.split('|');
            g.mechanisms[k] = pick(this.rng, this.options(opId, cls, mode as 'read' | 'write'));
          }
          break;
        }
        case 'change-saga-style': {
          const p = pick(this.rng, this.domain.processes).id;
          g.sagas[p] = g.sagas[p] === 'orchestration' ? 'choreography' : 'orchestration';
          break;
        }
        case 'change-replicas': {
          const a = pick(this.rng, grs);
          g.replicas[a] = Math.max(-2, Math.min(4, (g.replicas[a] ?? 0) + (this.rng() < 0.5 ? -1 : 1)));
          break;
        }
        case 'change-database': {
          const a = pick(this.rng, grs);
          if (g.sharedDb[a] !== undefined) delete g.sharedDb[a];
          else if (grs.length > 1) g.sharedDb[a] = pick(this.rng, grs.filter((x) => x !== a));
          break;
        }
      }
    }
    return g;
  }

  evaluate(g: Genome, born: number): Individual {
    const decisions = this.repair(g);
    return { genome: g, decisions, hash: designHash(decisions), eval: evaluate(this.domain, decisions, this.problem), born };
  }
}

// ------------------------------------------------------------ NSGA-II

const violation = (i: Individual) => i.eval.constraints.reduce((s, c) => s + Math.max(0, c), 0);
export const feasible = (i: Individual) => violation(i) <= 1e-12;

/** Deb's constrained domination */
function cdominates(a: Individual, b: Individual): boolean {
  const va = violation(a), vb = violation(b);
  if (va <= 1e-12 && vb > 1e-12) return true;
  if (va > 1e-12 && vb <= 1e-12) return false;
  if (va > 1e-12) return va < vb;
  return dominates(a.eval.objectives, b.eval.objectives);
}

function sortFronts(pop: Individual[]): Individual[][] {
  const n = pop.length;
  const S: number[][] = Array.from({ length: n }, () => []);
  const cnt = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (cdominates(pop[i], pop[j])) { S[i].push(j); cnt[j]++; }
    else if (cdominates(pop[j], pop[i])) { S[j].push(i); cnt[i]++; }
  }
  const fronts: Individual[][] = [];
  let cur = pop.map((_, i) => i).filter((i) => cnt[i] === 0);
  while (cur.length) {
    fronts.push(cur.map((i) => pop[i]));
    const nx: number[] = [];
    for (const i of cur) for (const j of S[i]) if (--cnt[j] === 0) nx.push(j);
    cur = nx;
  }
  return fronts;
}

function crowding(front: Individual[]): Map<Individual, number> {
  const d = new Map(front.map((i) => [i, 0]));
  const m = front[0]?.eval.objectives.length ?? 0;
  for (let k = 0; k < m; k++) {
    const s = [...front].sort((a, b) => a.eval.objectives[k] - b.eval.objectives[k]);
    const lo = s[0].eval.objectives[k], hi = s[s.length - 1].eval.objectives[k];
    d.set(s[0], Infinity); d.set(s[s.length - 1], Infinity);
    for (let i = 1; i < s.length - 1; i++) d.set(s[i], d.get(s[i])! + (s[i + 1].eval.objectives[k] - s[i - 1].eval.objectives[k]) / (hi - lo || 1));
  }
  return d;
}

export interface ArchiveEntry { ind: Individual; born: number; died: number | null }

export interface RunResult {
  generations: { population: Individual[]; evaluated: number; timeMs: number }[];
  evaluated: Individual[];
  archive: ArchiveEntry[];
}

export function nsga2(search: Search, popSize: number, gens: number, init: Individual[] = []): RunResult {
  const evaluated: Individual[] = [];
  const archive: ArchiveEntry[] = [];
  // the live archive (died === null) is kept as its own list instead of filtering the whole archive
  let live: ArchiveEntry[] = [];
  const updateArchive = (ind: Individual, gen: number) => {
    if (!feasible(ind)) return;
    if (live.some((a) => a.ind.hash === ind.hash || dominates(a.ind.eval.objectives, ind.eval.objectives))) return;
    let removed = false;
    for (const a of live) if (dominates(ind.eval.objectives, a.ind.eval.objectives)) { a.died = gen; removed = true; }
    if (removed) live = live.filter((a) => a.died === null);
    const e: ArchiveEntry = { ind, born: gen, died: null };
    archive.push(e);
    live.push(e);
  };
  let pop: Individual[] = [...init];
  while (pop.length < popSize) pop.push(search.evaluate(search.random(), 0));
  for (const i of pop) { evaluated.push(i); updateArchive(i, 0); }
  const generations = [{ population: pop, evaluated: pop.length, timeMs: 0 }];
  for (let gen = 1; gen < gens; gen++) {
    const t0 = performance.now();
    const rank = new Map<Individual, number>();
    const crowd = new Map<Individual, number>();
    sortFronts(pop).forEach((f, r) => { const c = crowding(f); for (const i of f) { rank.set(i, r); crowd.set(i, c.get(i)!); } });
    const tour = () => {
      const a = pick(search.rng, pop), b = pick(search.rng, pop);
      return rank.get(a)! < rank.get(b)! || (rank.get(a) === rank.get(b) && crowd.get(a)! > crowd.get(b)!) ? a : b;
    };
    const kids: Individual[] = [];
    for (let i = 0; i < popSize; i++) {
      const k = search.evaluate(search.mutate(tour().genome), gen);
      kids.push(k); evaluated.push(k); updateArchive(k, gen);
    }
    const merged = [...pop, ...kids];
    const next: Individual[] = [];
    for (const f of sortFronts(merged)) {
      if (next.length + f.length <= popSize) { next.push(...f); continue; }
      const c = crowding(f);
      next.push(...[...f].sort((a, b) => c.get(b)! - c.get(a)!).slice(0, popSize - next.length));
      break;
    }
    pop = next;
    generations.push({ population: pop, evaluated: (gen + 1) * popSize, timeMs: Math.round((performance.now() - t0) * 40 + 30000 + search.rng() * 8000) });
  }
  return { generations, evaluated, archive };
}

export { violation, int, pick };
