/**
 * Synthetic design detail of the dummy bundles (tests only): a queueing sketch over
 * the load profile, deterministic per design hash, in the shape of the plugin's simulation detail.
 * Real runs are simulated by the Palladio plugin (server/simulator.ts).
 */
import type { Decisions, DesignDetail, Domain, Id, ResponseStats, ServiceTimeline } from '../contract/types';
import { CONTRACT_VERSION } from '../contract/types';
import { designHash } from '../contract/hash';
import { visitsOf } from '../contract/derive';
import { demands, K, needed, profileOf, requestNoLoad, requestPath, type ProblemId } from './model';
import { mulberry32 } from './search';

// ---- lognormal helpers
function erf(x: number): number {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const lnCdf = (x: number, mu: number, sigma: number) => (x <= 0 ? 0 : 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2))));

export const EDGES = Array.from({ length: 49 }, (_, i) => +(0.5 * Math.pow(10, (i * Math.log10(20000)) / 48)).toPrecision(4));

interface Component { w: number; mu: number; sigma: number }

/** statistics of a weighted lognormal mixture */
function mixtureStats(key: Id, comps: Component[], perT: { t: number[]; mean: number[]; p95: number[]; thr: number[] } | undefined, budgetMs: number | undefined, factor: number, rng: () => number): ResponseStats {
  const total = comps.reduce((s, c) => s + c.w, 0) || 1;
  const cdf = (x: number) => comps.reduce((s, c) => s + c.w * lnCdf(x, c.mu, c.sigma), 0) / total;
  const quant = (q: number) => {
    let lo = 0.01, hi = 1e6;
    for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (cdf(m) < q) lo = m; else hi = m; }
    return Math.sqrt(lo * hi);
  };
  const mean = comps.reduce((s, c) => s + c.w * Math.exp(c.mu + (c.sigma * c.sigma) / 2), 0) / total;
  const counts = EDGES.slice(0, -1).map((e, i) => Math.max(0, Math.round(total * (cdf(EDGES[i + 1]) - cdf(e)) * (1 + 0.04 * (rng() - 0.5)))));
  void factor;
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    key, count: Math.round(total), failed: Math.round(total * 2e-4 * rng()),
    meanMs: r(mean), p50Ms: r(quant(0.5)), p90Ms: r(quant(0.9)), p95Ms: r(quant(0.95)), p99Ms: r(quant(0.99)), maxMs: r(quant(0.9999)),
    budgetMs, statisticMs: r(quant(0.95)),
    histogram: { edgesMs: EDGES, counts },
    overTime: perT && { t: perT.t, meanMs: perT.mean.map(r), p95Ms: perT.p95.map(r), throughput: perT.thr.map((v) => Math.round(v * 100) / 100) },
  };
}


export function simulate(domain: Domain, d: Decisions, _problem: ProblemId, opts: { designId?: Id; runId?: Id; origin?: DesignDetail['origin'] } = {}): DesignDetail {
  const started = performance.now();
  const hash = designHash(d);
  const rng = mulberry32(parseInt(hash.slice(-8), 16));
  const dem = demands(domain, d);
  const prof = profileOf(domain);
  const T = prof.t;
  const dt = T[1] - T[0];

  // load profile and session mix: the domain's load profile if present, else the peak hour with browsing growing at the peak
  const sps = prof.sps.map((v, i) => v * (1 + 0.02 * Math.sin(T[i] / 37)));
  const mix: Record<Id, number[]> = {};
  const active = domain.sessions.filter((s) => s.share > 0);
  if (prof.mix) for (const s of active) mix[s.id] = prof.mix[s.id] ?? T.map(() => s.share);
  else {
    const peakness = prof.mult.map((m) => (m - 1) / 2);
    for (const s of active) {
      const tilt = /brows/i.test(s.id) ? 0.1 : /buy/i.test(s.id) ? -0.06 : 0;
      mix[s.id] = T.map((_, i) => Math.max(0.002, s.share + tilt * peakness[i]));
    }
    T.forEach((_, i) => { const sum = active.reduce((a, s) => a + mix[s.id][i], 0); for (const s of active) mix[s.id][i] = +(mix[s.id][i] / sum).toFixed(4); });
  }
  const mult = prof.mult;
  // request rates over time from the mix (session types' expected visits); admin and unvisited requests scale with the volume
  const visits = new Map(active.map((s) => [s.id, visitsOf(s)]));
  const design = new Map<Id, number>();
  for (const s of active) for (const [r, v] of visits.get(s.id)!) design.set(r, (design.get(r) ?? 0) + s.share * v);
  const reqMult = (rq: Id, i: number) => {
    const d = design.get(rq);
    if (!d) return mult[i];
    let x = 0;
    for (const s of active) x += (mix[s.id][i] ?? 0) * (visits.get(s.id)!.get(rq) ?? 0);
    return mult[i] * (x / d);
  };
  const orderReq = domain.requests.find((r) => r.id === 'placeOrder')?.id;
  const buyMult = T.map((_, i) => (orderReq ? reqMult(orderReq, i) : mult[i]));

  // replicas and utilisation per service; backlog when overloaded
  const services: ServiceTimeline[] = [];
  const rho = new Map<Id, number[]>();
  const repsOf = new Map<Id, number[]>();
  const reps = repsOf;
  const backlogMs = new Map<Id, number[]>();
  for (const s of d.services) {
    const c0 = dem.cpu.get(s.id) ?? 0;
    const load = T.map((_, i) => c0 * mult[i]);
    const reps: number[] = [];
    const util: number[] = [];
    const bl: number[] = [];
    let backlog = 0;
    T.forEach((t, i) => {
      let n: number;
      if (s.replicas.mode === 'fixed') n = s.replicas.count;
      else {
        const lag = Math.max(0, i - 1); // scale-up reacts after one 10-s step (HPA sync period 15 s)
        const window = T.map((_, j) => j).filter((j) => j <= lag && T[lag] - T[j] <= 300); // 300 s scale-down stabilisation
        const want = window.reduce((m, j) => Math.max(m, needed(load[j], s.replicas.mode === 'hpa' ? s.replicas.targetUtilisation : K.target)), -Infinity);
        n = Math.min(s.replicas.max, Math.max(s.replicas.min, want));
      }
      const cap = n * K.coresPerReplica;
      const u = load[i] / cap;
      backlog = Math.max(0, backlog + (load[i] - cap * 0.98) * dt);
      reps.push(n);
      util.push(+Math.min(1, u * (1 + 0.03 * (rng() - 0.5))).toFixed(4));
      bl.push((backlog / cap) * 500);
      void t;
    });
    services.push({ service: s.id, autoscaled: s.replicas.mode === 'hpa', t: T, utilisation: util, replicas: reps, ready: reps });
    repsOf.set(s.id, reps);
    rho.set(s.id, util);
    backlogMs.set(s.id, bl);
  }
  const dbRho = new Map<Id, number[]>();
  for (const x of d.databases) dbRho.set(x.id, T.map((_, i) => Math.min(0.99, ((dem.db.get(x.id) ?? 0) * mult[i]) / K.dbCores)));
  const svcDb = new Map(d.services.map((s) => [s.id, s.database]));

  const opRateAt = (op: Domain['operations'][number], i: number) => (op.rate ?? 0) * (op.kind === 'handler' ? buyMult[i] : mult[i]);
  /** response-time model at time index i for a no-load time and its synchronous path */
  const at = (base: number, path: Id[], i: number, sigma0: number) => {
    let factor = 0, extra = 0, maxRho = 0;
    for (const s of path) {
      const r = Math.min(0.97, rho.get(s)?.[i] ?? 0);
      const n = Math.max(1, reps.get(s)?.[i] ?? 1);
      const rd = dbRho.get(svcDb.get(s)!)?.[i] ?? 0;
      // M/M/c-like waiting: fewer replicas wait longer at the same utilisation
      factor += 1 + Math.pow(r, Math.sqrt(2 * (n + 1)) - 1) / (n * (1 - r)) + 0.3 / (1 - Math.min(0.97, rd));
      extra += backlogMs.get(s)?.[i] ?? 0;
      maxRho = Math.max(maxRho, r);
    }
    const f = path.length ? factor / (path.length * 1.3) : 1;

    const mean = base * f + extra;
    const sigma = sigma0 + 0.35 * maxRho;
    return { mu: Math.log(mean) - (sigma * sigma) / 2, sigma, mean };
  };

  const factor = K.sloFactor;
  // operations
  const opStats: ResponseStats[] = [];
  const opMean = new Map<Id, number[]>();
  for (const op of domain.operations) {
    if (!(op.rate ?? 0)) continue;
    const base = dem.noLoad.get(op.id) ?? 1;
    const path = dem.path.get(op.id) ?? [];
    const comps: Component[] = [];
    const per = { t: T, mean: [] as number[], p95: [] as number[], thr: [] as number[] };
    T.forEach((_, i) => {
      const x = at(base, path, i, 0.42);
      const r = opRateAt(op, i);
      comps.push({ w: r * dt, mu: x.mu, sigma: x.sigma });
      per.mean.push(x.mean); per.p95.push(Math.exp(x.mu + 1.645 * x.sigma)); per.thr.push(r);
    });
    opMean.set(op.id, per.mean);
    opStats.push(mixtureStats(op.id, comps, per, undefined, factor, rng));
  }
  // request types
  const reqStats: ResponseStats[] = [];
  const reqComps = new Map<Id, Component[]>();
  const sloT = T.map(() => ({ req: 0, viol: 0 }));
  for (const rq of domain.requests) {
    if (!(rq.rate ?? 0)) continue;
    const base = requestNoLoad(rq, dem);
    const path = requestPath(rq, dem);
    const comps: Component[] = [];
    const per = { t: T, mean: [] as number[], p95: [] as number[], thr: [] as number[] };
    T.forEach((_, i) => {
      const x = at(base, path, i, 0.38);
      const r = (rq.rate ?? 0) * reqMult(rq.id, i);
      comps.push({ w: r * dt, mu: x.mu, sigma: x.sigma });
      per.mean.push(x.mean); per.p95.push(Math.exp(x.mu + 1.645 * x.sigma)); per.thr.push(r);
      if (rq.budgetMs && rq.id !== 'login') {
        sloT[i].req += r * dt;
        sloT[i].viol += r * dt * (1 - lnCdf(factor * rq.budgetMs, x.mu, x.sigma));
      }
    });
    reqComps.set(rq.id, comps);
    reqStats.push(mixtureStats(rq.id, comps, per, rq.budgetMs, factor, rng));
  }
  // sessions: the sum of their requests' response times (think times excluded)
  const sesStats: ResponseStats[] = [];
  for (const s of active) {
    const comps: Component[] = [];
    const per = { t: T, mean: [] as number[], p95: [] as number[], thr: [] as number[] };
    T.forEach((_, i) => {
      let mean = 0;
      for (const st of s.steps) {
        const rc = reqComps.get(st.request)?.[i];
        if (!rc) continue;
        mean += (st.probability ?? 1) * (st.repeat ?? 1) * Math.exp(rc.mu + (rc.sigma * rc.sigma) / 2);
      }
      const sigma = 0.3;
      const mu = Math.log(Math.max(mean, 0.1)) - (sigma * sigma) / 2;
      const r = sps[i] * mix[s.id][i];
      comps.push({ w: r * dt, mu, sigma });
      per.mean.push(mean); per.p95.push(Math.exp(mu + 1.645 * sigma)); per.thr.push(r);
    });
    sesStats.push(mixtureStats(s.id, comps, per, undefined, factor, rng));
  }

  // resources
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const resources: DesignDetail['resources'] = [];
  for (const s of d.services) {
    const u = rho.get(s.id)!;
    const q = u.map((r) => { const rr = Math.min(0.97, r); return rr / (1 - rr); });
    resources.push({ id: `cpu:${s.id}`, kind: 'cpu', label: `${s.name} CPU`, service: s.id, utilisation: +avg(u).toFixed(4),
      waitMs: +avg(u.map((r, i) => (Math.min(0.97, r) / (1 - Math.min(0.97, r))) * 1.2 + (backlogMs.get(s.id)?.[i] ?? 0))).toFixed(3),
      queueLength: +avg(q).toFixed(3), t: T, queueOverTime: q.map((v) => +v.toFixed(3)) });
  }
  for (const x of d.databases) {
    const u = dbRho.get(x.id)!;
    const q = u.map((r) => r / (1 - r));
    resources.push({ id: `db:${x.id}`, kind: 'db', label: x.name, database: x.id, utilisation: +avg(u).toFixed(4),
      waitMs: +avg(u.map((r) => (r / (1 - r)) * 0.4)).toFixed(3), queueLength: +avg(q).toFixed(3), t: T, queueOverTime: q.map((v) => +v.toFixed(3)) });
  }
  const gw = T.map((_, i) => Math.min(0.97, (dem.gateway * mult[i]) / K.gatewayCores));
  resources.push({ id: 'gateway', kind: 'gateway', label: 'Gateway', utilisation: +avg(gw).toFixed(4), waitMs: +avg(gw.map((r) => (r / (1 - r)) * 0.8)).toFixed(3),
    queueLength: +avg(gw.map((r) => r / (1 - r))).toFixed(3), t: T, queueOverTime: gw.map((r) => +(r / (1 - r)).toFixed(3)) });
  const events = dem.derived.accesses.filter((a) => a.mechanism === 'copy' || a.mechanism === 'saga').reduce((s, a) => s + a.rate, 0);
  const br = T.map((_, i) => Math.min(0.95, (events * mult[i] * K.deliverCpuMs) / 1000 / 1));
  resources.push({ id: 'broker', kind: 'broker', label: 'Broker', utilisation: +avg(br).toFixed(4), waitMs: +avg(br.map((r) => (r / (1 - r)) * 0.5)).toFixed(3),
    queueLength: +avg(br.map((r) => r / (1 - r))).toFixed(3), t: T, queueOverTime: br.map((r) => +(r / (1 - r)).toFixed(3)) });

  void sloT;
  const pods = T.map((_, i) => services.reduce((s, x) => s + x.replicas[i], 0));
  for (const r of resources) if (r.kind === 'db' || r.kind === 'broker') { r.peakCapacity = true; r.maxBinUtilisation = r.utilisation; }
  return {
    contract: CONTRACT_VERSION,
    designHash: hash,
    designId: opts.designId,
    runId: opts.runId,
    origin: opts.origin ?? 'synthetic',
    simulator: { name: 'explorer dummy (synthetic queueing sketch)', version: '0.1', seed: parseInt(hash.slice(-8), 16), durationS: T[T.length - 1], warmupS: prof.mix ? 120 : 60, binS: dt },
    status: { failed: false, capped: false, timedOut: false },
    computedAt: new Date().toISOString(),
    computeMs: Math.round(performance.now() - started),
    load: { id: prof.id, label: prof.label, t: T, sessionsPerSecond: sps.map((v) => +v.toFixed(2)), mix },
    operations: opStats,
    requests: reqStats,
    sessions: sesStats,
    services,
    resources,
    hpa: { t: T, pods, ready: pods, peakPods: Math.max(...pods), createdPods: 0, rescales: 0, reversals: 0 },
  };
}
