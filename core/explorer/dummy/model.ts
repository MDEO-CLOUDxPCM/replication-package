/**
 * A cheap analytic stand-in for the real evaluation (layer 2 in MT + Palladio plugin): demands per
 * service and database from the decisions, then four objectives and two constraints in plausible
 * ranges. Only for synthetic test data (tests/, the fixture packet).
 */
import type { ConstraintDef, Decisions, Domain, Id, Mechanism, MetricDef, ObjectiveDef, Operation, RequestType } from '../contract/types';
import { deriveDesign, type DerivedDesign } from '../contract/derive';

export const K = {
  hopMs: 0.2, hopCallerCpuMs: 0.766, hopCalleeCpuMs: 1.095, providerCpuMs: 0.9, providerDbMs: 0.3,
  gatewayRequestCpuMs: 2.323, gatewayFetchCpuMs: 1.099, publishCpuMs: 0.434, deliverCpuMs: 1.1,
  replicaWriteCpuMs: 1.669, replicaWriteDbMs: 0.943, replicaReadDbMs: 0.3, cacheHitCpuMs: 0.1, cacheHitRatio: 0.8,
  orchestratorStepCpuMs: 0.5, coresPerReplica: 0.5, replicaOverhead: 0.2, costPerDatabase: 1, costPerCache: 0.1,
  dbCores: 10, gatewayCores: 2, target: 0.7, uProc: 2e-4, uDb: 1e-4, releaseTerm: (52 * 0.1 * 1) / 8760, kappa: 0.25,
  breakProb: 0.25, sloFactor: 5, authCpuMs: 17.259,
};

export type ProblemId = 'static';

export interface Problem {
  id: ProblemId;
  objectives: ObjectiveDef[];
  constraints: ConstraintDef[];
  metrics: MetricDef[];
}

const common = {
  failure: { key: 'failure', label: 'Failures', unit: 'ppm', direction: 'minimize', digits: 0, description: 'failed requests per million (shared fate per container, release failures)' },
  changeCoupling: { key: 'changeCoupling', label: 'Change coupling', direction: 'minimize', digits: 3, description: 'deployables touched per change of an aggregate, incl. breaking consumers' },
  inconsistency: { key: 'inconsistency', label: 'Inconsistency', direction: 'minimize', digits: 3, description: 'stale reads and remote writes per request' },
} as const satisfies Record<string, ObjectiveDef>;

const metrics: MetricDef[] = [
  { key: 'services', label: 'Services', better: 'none', digits: 0 },
  { key: 'databases', label: 'Databases', better: 'none', digits: 0 },
  { key: 'syncCalls', label: 'Sync accesses', better: 'lower', digits: 0 },
  { key: 'copies', label: 'Local copies', better: 'none', digits: 0 },
  { key: 'caches', label: 'Caches', better: 'none', digits: 0 },
  { key: 'joins', label: 'Gateway joins', better: 'none', digits: 0 },
  { key: 'sagaSteps', label: 'Saga steps', better: 'lower', digits: 0 },
  { key: 'replicas', label: 'Replicas (max)', better: 'lower', digits: 0 },
  { key: 'noLoadMs', label: 'No-load time', unit: 'ms', better: 'lower', digits: 1 },
  { key: 'peakUtil', label: 'Peak utilisation', better: 'lower', digits: 2 },
];

const constraintsBase: ConstraintDef[] = [
  { key: 'latencyBudget', label: 'Latency budget', description: 'sum over request types of the relative excess of the no-load time over its budget' },
  { key: 'peakCapacity', label: 'Peak capacity', description: 'utilisation above 0.85 of unscaled servers at 4 x the design load' },
];

export const PROBLEMS: Record<ProblemId, Problem> = {
  static: {
    id: 'static',
    objectives: [
      { key: 'cost', label: 'Cost', unit: 'cores', direction: 'minimize', digits: 1, description: 'replicas, databases, caches and gateway at the sized replica counts' },
      common.failure, common.changeCoupling, common.inconsistency,
    ],
    constraints: constraintsBase,
    metrics,
  },
};

/** a compressed peak hour (the load when the domain has no "day" profile): load factor over time */
export function loadMultiplier(t: number): number {
  if (t < 60) return 1;
  if (t < 300) return Math.min(3, 1 + 0.25 * Math.floor((t - 60) / 30 + 1));
  if (t < 360) return 3;
  return 1;
}
export const PROFILE_T = Array.from({ length: 73 }, (_, i) => i * 10);

export interface Profile { id: string; label: string; t: number[]; mult: number[]; sps: number[]; mix: Record<string, number[]> | null }

const profileCache = new WeakMap<Domain, Profile>();
/** the load the details use: the domain's "day" load profile if it has one, else the compressed peak hour */
export function profileOf(domain: Domain): Profile {
  const hit = profileCache.get(domain);
  if (hit) return hit;
  const day = domain.loadProfiles?.find((x) => x.id === 'day');
  const steady = domain.loadProfiles?.find((x) => x.id === 'steady');
  let prof: Profile;
  if (day) {
    const base = steady?.sessionsPerSecond[0] ?? day.sessionsPerSecond.reduce((a, b) => Math.max(a, b), -Infinity) / 1.6;
    prof = { id: day.id, label: day.label, t: day.t, sps: day.sessionsPerSecond, mult: day.sessionsPerSecond.map((v) => v / base), mix: day.mix };
  } else {
    prof = { id: 'peak-hour', label: 'Compressed peak hour: 1 x → 3 x in 8 steps, back at 360 s', t: PROFILE_T, sps: PROFILE_T.map((t) => 64.2 * loadMultiplier(t)), mult: PROFILE_T.map(loadMultiplier), mix: null };
  }
  profileCache.set(domain, prof);
  return prof;
}

export interface Demands {
  derived: DerivedDesign;
  /** cores per service at the design load */
  cpu: Map<Id, number>;
  /** cores per database server at the design load */
  db: Map<Id, number>;
  gateway: number;
  /** no-load time per operation, ms, and the services on its synchronous path */
  noLoad: Map<Id, number>;
  path: Map<Id, Id[]>;
  caches: number;
}

const cross = (m: Mechanism | null): m is Mechanism => m !== null;

export function demands(domain: Domain, d: Decisions): Demands {
  const derived = deriveDesign(domain, d);
  const cpu = new Map<Id, number>(d.services.map((s) => [s.id, 0]));
  const dbOfService = new Map<Id, Id>(d.services.map((s) => [s.id, s.database]));
  const db = new Map<Id, number>(d.databases.map((x) => [x.id, 0]));
  let gateway = 0;
  const add = (m: Map<Id, number>, k: Id | undefined, v: number) => { if (k !== undefined) m.set(k, (m.get(k) ?? 0) + v); };
  const opById = new Map(domain.operations.map((o) => [o.id, o]));
  const writers = new Map<Id, Operation[]>();
  for (const op of domain.operations) for (const a of op.accesses) if (a.mode === 'write') writers.set(a.class, [...(writers.get(a.class) ?? []), op]);
  const noLoad = new Map<Id, number>();
  const path = new Map<Id, Id[]>();
  let caches = 0;
  const cacheSet = new Set<string>();
  for (const op of domain.operations) {
    const r = op.rate ?? 0;
    const home = derived.opService.get(op.id)!;
    add(cpu, home, (r * (op.cpuMs ?? 1)) / 1000);
    add(db, dbOfService.get(home), (r * (op.dbMs ?? 0.3)) / 1000);
    noLoad.set(op.id, (op.cpuMs ?? 1) + (op.dbMs ?? 0.3));
    path.set(op.id, [home]);
  }
  for (const a of derived.accesses) {
    if (!cross(a.mechanism)) continue;
    const op = opById.get(a.op)!;
    const r = a.rate;
    const sync = K.hopMs * 2 + K.hopCallerCpuMs + K.hopCalleeCpuMs + K.providerCpuMs + K.providerDbMs;
    let t = 0;
    switch (a.mechanism) {
      case 'sync':
        add(cpu, a.from, (r * K.hopCallerCpuMs) / 1000);
        add(cpu, a.to, (r * (K.hopCalleeCpuMs + K.providerCpuMs)) / 1000);
        add(db, dbOfService.get(a.to), (r * K.providerDbMs) / 1000);
        t = sync; path.get(op.id)!.push(a.to);
        break;
      case 'join':
        gateway += (r * K.gatewayFetchCpuMs) / 1000;
        add(cpu, a.to, (r * (K.hopCalleeCpuMs + K.providerCpuMs)) / 1000);
        add(db, dbOfService.get(a.to), (r * K.providerDbMs) / 1000);
        t = sync * 0.8; path.get(op.id)!.push(a.to);
        break;
      case 'cache': {
        const miss = 1 - K.cacheHitRatio;
        add(cpu, a.from, (r * (K.cacheHitCpuMs + miss * K.hopCallerCpuMs)) / 1000);
        add(cpu, a.to, (r * miss * (K.hopCalleeCpuMs + K.providerCpuMs)) / 1000);
        t = K.cacheHitCpuMs + miss * sync;
        const ck = `${a.from}>${a.cls}`;
        if (!cacheSet.has(ck)) { cacheSet.add(ck); caches++; }
        break;
      }
      case 'copy': {
        add(cpu, a.from, (r * 0.3) / 1000);
        add(db, dbOfService.get(a.from), (r * K.replicaReadDbMs) / 1000);
        t = 0.3 + K.replicaReadDbMs;
        break;
      }
      case 'saga':
        add(cpu, a.from, (r * K.publishCpuMs) / 1000);
        add(cpu, a.to, (r * (K.deliverCpuMs + K.providerCpuMs)) / 1000);
        t = K.publishCpuMs;
        break;
    }
    noLoad.set(op.id, noLoad.get(op.id)! + t * (op.accesses.find((x) => x.class === a.cls)?.perExecution ?? 1));
  }
  for (const rq of domain.requests) {
    const r = rq.rate ?? 0;
    gateway += (r * (K.gatewayRequestCpuMs + Math.max(0, rq.operations.length - 1) * K.gatewayFetchCpuMs)) / 1000;
  }
  // copy feeds: every write of a copied class publishes, each holder applies
  const holders = new Map<Id, Set<Id>>();
  for (const a of derived.accesses) if (a.mechanism === 'copy') holders.set(a.cls, new Set([...(holders.get(a.cls) ?? []), a.from]));
  for (const [cls, hs] of holders) {
    const wr = (writers.get(cls) ?? []).reduce((s, w) => s + (w.rate ?? 0), 0);
    const owner = derived.serviceOf.get(cls);
    add(cpu, owner, (wr * K.publishCpuMs) / 1000);
    for (const h of hs) {
      add(cpu, h, (wr * (K.deliverCpuMs + K.replicaWriteCpuMs)) / 1000);
      add(db, dbOfService.get(h), (wr * K.replicaWriteDbMs) / 1000);
    }
  }
  // orchestration: the orchestrator handles every step
  for (const s of derived.sagas) if (s.style === 'orchestration') {
    const p = domain.processes.find((x) => x.id === s.process)!;
    const orch = s.orchestrator ?? derived.opService.get(p.trigger)!;
    const r = opById.get(p.trigger)?.rate ?? 0;
    add(cpu, orch, (r * p.steps.length * K.orchestratorStepCpuMs) / 1000);
  }
  return { derived, cpu, db, gateway, noLoad, path, caches };
}

/** no-load time of a request type: the gateway, then its plan's operations one after the other */
export function requestNoLoad(rq: RequestType, dem: Demands): number {
  // a `login` request type is the identity provider's password grant (no domain operation)
  let t = (rq.id === 'login' ? K.authCpuMs : 0) + K.gatewayRequestCpuMs + Math.max(0, rq.operations.length - 1) * (K.gatewayFetchCpuMs + 2 * K.hopMs);
  for (const op of rq.operations) t += dem.noLoad.get(op) ?? 0;
  return t;
}

/** services a request type needs synchronously */
export function requestPath(rq: RequestType, dem: Demands): Id[] {
  return [...new Set(rq.operations.flatMap((o) => dem.path.get(o) ?? []))];
}

/** replicas an ideal autoscaler needs for `cores` of load */
export const needed = (cores: number, target = K.target) => Math.max(1, Math.ceil(cores / (K.coresPerReplica * target)));

export interface Evaluation {
  objectives: number[];
  constraints: number[];
  metrics: Record<string, number>;
}

export function evaluate(domain: Domain, d: Decisions, _problem: ProblemId, dem = demands(domain, d)): Evaluation {
  const { derived, cpu, db, gateway, path, caches } = dem;
  const totalRate = domain.operations.reduce((s, o) => s + (o.rate ?? 0), 0);

  // O1 cost
  let cost = d.databases.length * K.costPerDatabase + caches * K.costPerCache + (K.gatewayCores + needed(gateway * 4, 0.7) * 0.5) * 0.6;
  let maxReplicas = 0;
  for (const s of d.services) {
    const n = s.replicas.mode === 'fixed' ? s.replicas.count : s.replicas.max;
    maxReplicas += n;
    cost += n * (K.coresPerReplica + K.replicaOverhead);
  }

  // O2 failures: shared fate per service and database server on the synchronous path
  const aggsIn = new Map<Id, number>();
  for (const s of d.services) aggsIn.set(s.id, new Set(s.classes.map((c) => domain.classes.find((x) => x.id === c)?.aggregate)).size);
  const uSvc = (s: Id) => K.uProc + (aggsIn.get(s) ?? 1) * K.releaseTerm;
  const uDb = new Map<Id, number>();
  for (const x of d.databases) uDb.set(x.id, K.uDb + K.kappa * x.services.reduce((acc, s) => acc + (aggsIn.get(s) ?? 1) * K.releaseTerm, 0));
  let fail = 0;
  for (const op of domain.operations) {
    const services = new Set(path.get(op.id));
    let ok = 1;
    const dbs = new Set<Id>();
    for (const s of services) {
      ok *= 1 - uSvc(s);
      dbs.add(d.services.find((x) => x.id === s)!.database);
    }
    for (const x of dbs) ok *= 1 - (uDb.get(x) ?? K.uDb);
    fail += (op.rate ?? 0) * (1 - ok);
  }
  const failure = (fail / totalRate) * 1e6;

  // O3 change coupling: deployables touched per change of an aggregate
  let cc = 0;
  for (const ag of domain.aggregates) {
    const homes = new Set(ag.classes.map((c) => derived.serviceOf.get(c)));
    const consumers = new Set<Id>();
    for (const a of derived.accesses) if (cross(a.mechanism) && ag.classes.includes(a.cls) && !homes.has(a.from)) consumers.add(a.from);
    cc += homes.size + K.breakProb * consumers.size * 0.5;
  }
  const changeCoupling = cc / domain.aggregates.length;

  // O4 inconsistency: stale reads and remote writes per request
  let inc = 0;
  for (const a of derived.accesses) {
    if (a.mechanism === 'copy') inc += a.rate * 1.0;
    else if (a.mechanism === 'cache') inc += a.rate * 0.5;
    else if (a.mechanism === 'saga') inc += a.rate * 1.4;
    else if (a.mechanism === 'sync' && a.mode === 'write') inc += a.rate * 0.6;
  }
  const inconsistency = (inc / totalRate) * 2.2;

  // C1 latency budget
  let latency = 0, weighted = 0, wsum = 0;
  for (const rq of domain.requests) {
    const t = requestNoLoad(rq, dem);
    if (rq.budgetMs) latency += Math.max(0, t / rq.budgetMs - 1);
    weighted += t * (rq.rate ?? 0);
    wsum += rq.rate ?? 0;
  }
  // C2 peak capacity: databases (and fixed services) at 4 x the design load
  let peak = 0, peakUtil = 0;
  for (const [id, c] of db) {
    const u = (4 * c) / K.dbCores;
    peakUtil = Math.max(peakUtil, u);
    peak += Math.max(0, u - 0.85);
    void id;
  }
  for (const s of d.services) {
    const n = s.replicas.mode === 'fixed' ? s.replicas.count : s.replicas.max;
    const u = (4 * (cpu.get(s.id) ?? 0)) / (n * K.coresPerReplica);
    peakUtil = Math.max(peakUtil, u);
    peak += Math.max(0, u - 0.85) * 0.2;
  }
  const mc = derived.mechanismCounts;
  const objectives = [cost, failure, changeCoupling, inconsistency];
  const constraints = [latency, peak];
  return {
    objectives,
    constraints,
    metrics: {
      services: d.services.length, databases: d.databases.length, syncCalls: mc.sync, copies: mc.copy, caches: mc.cache,
      joins: mc.join, sagaSteps: mc.saga, replicas: maxReplicas, noLoadMs: weighted / (wsum || 1), peakUtil,
    },
  };
}
