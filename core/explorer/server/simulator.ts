/**
 * On-demand detail for an opened design.
 *
 * - DummySimulator: the synthetic sketch of the dummy bundles (dummy/simulate.ts; tests only).
 * - PalladioPluginSimulator: a design of a run of the family palladio-architecture (its
 *   `rawDecisions` are the model's decision links that differ from the run's realised seed,
 *   `run.config.raw.modelSeed`). The packet's `simulate` command rebuilds the design's model in the
 *   run's build (`run.config.raw.buildDir`: seed + links, realisation), takes the build's evaluation
 *   request and runs the plugin's `detail`: the same simulation the search ran (its `evaluation` is
 *   pcmEvaluate's result), with more monitors. The request file sent here holds only the detail's own
 *   fields; nothing of the evaluation is overridden.
 *   The result is mapped to the contract (requests, sessions, scaling groups, resources from the
 *   evaluation; operations from the detail's assembly operations), and C1/C2 are recomputed from it
 *   with the run's budgets and limit, so the panel can show that they equal the design's values.
 *   One simulation at a time (the harness JVM and the plugin use fixed ports).
 * - AutoSimulator (default): the plugin for designs that carry a model seed, the dummy otherwise.
 *
 * EXPLORER_SIMULATOR = auto (default) | dummy | palladio-plugin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Design, DesignDetail, Domain, EvaluationSetup, HpaStats, ResourceStats, ResponseStats, Run, ServiceTimeline } from '../contract/types';
import { CONTRACT_VERSION } from '../contract/types';
import { simulate } from '../dummy/simulate';
import type { Packet } from './packets';

export interface Simulator {
  readonly name: string;
  /** `packet`: the run's packet (its `simulate` command, if the local configuration allows it) */
  simulate(domain: Domain, run: Run, design: Design, packet?: Packet): Promise<DesignDetail>;
}

export class DummySimulator implements Simulator {
  readonly name = 'dummy';
  constructor(private delayMs = 700) {}
  async simulate(domain: Domain, run: Run, design: Design) {
    if (!design.decisions) throw new Error('design has no decisions in the contract form');
    await new Promise((r) => setTimeout(r, this.delayMs));
    return simulate(domain, design.decisions, 'static', { designId: design.id, runId: run.id, origin: 'simulated' });
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** the derivation's names: `[^A-Za-z0-9]` -> `_` (runs collapsed, trimmed) */
export const sanitise = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

/** the plugin build a run's build directory serves (its plugin-manifest.json), the detail cache's version key */
export function buildPluginVersion(run: Run): string | undefined {
  const b = run.config.raw?.buildDir as string | undefined;
  const f = b ? path.join(b, 'plugin-manifest.json') : undefined;
  try { return f && fs.existsSync(f) ? String(JSON.parse(fs.readFileSync(f, 'utf8')).version ?? '') || undefined : undefined; } catch { return undefined; }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type P = any;

/** a PcmResponseStat (evaluation, ms) -> ResponseStats; bins from the window's start */
function fromEvaluation(key: string, s: P, pct: number[], t: number[], binS: number, statistic: string, budgetMs?: number): ResponseStats {
  const at = (q: number) => { const i = pct.indexOf(q); return i >= 0 ? (s.percentilesMs[i] ?? 0) : NaN; };
  const P_ = pct.length;
  const i95 = pct.indexOf(95);
  const st: ResponseStats = {
    key, count: s.count, meanMs: s.meanMs, p50Ms: at(50), p90Ms: at(90), p95Ms: at(95), p99Ms: at(99), maxMs: s.maxMs,
    histogram: { edgesMs: s.histogramEdgesMs ?? [], counts: s.histogramCounts ?? [] },
    overTime: s.binCounts?.length ? {
      t, meanMs: s.binMeanMs, throughput: (s.binCounts as number[]).map((c) => c / binS),
      p95Ms: i95 >= 0 ? t.map((_, b) => s.binPercentilesMs?.[b * P_ + i95] ?? 0) : t.map(() => 0),
    } : undefined,
  };
  st.statisticMs = statOf(st, statistic);
  if (budgetMs !== undefined) st.budgetMs = budgetMs;
  return st;
}

export const statOf = (s: Pick<ResponseStats, 'meanMs' | 'p50Ms' | 'p90Ms' | 'p95Ms'>, stat: string) =>
  stat === 'mean' ? s.meanMs : stat === 'p50' ? s.p50Ms : stat === 'p90' ? s.p90Ms : s.p95Ms;

/** the detail's own statistics of the assembly operations (pooled per operation; count-weighted mean, percentiles of the largest series) */
function pool(key: string, xs: P[]): ResponseStats {
  const n = xs.reduce((s, x) => s + x.count, 0);
  const big = [...xs].sort((a, b) => b.count - a.count)[0];
  return {
    key, count: n,
    meanMs: n ? xs.reduce((s, x) => s + x.meanMs * x.count, 0) / n : 0,
    p50Ms: big.p50Ms, p90Ms: big.p90Ms, p95Ms: big.p95Ms, p99Ms: big.p99Ms, maxMs: Math.max(...xs.map((x) => x.maxMs)),
    histogram: big.histogram, overTime: big.overTime && { ...big.overTime, meanMs: big.overTime.meanMs.map((v: number | null) => v ?? 0), p95Ms: big.overTime.p95Ms.map((v: number | null) => v ?? 0) },
  };
}

/** C1 and C2 of one simulation, as metrics.fn computes them (latencyBudget, peakCapacity) */
export function constraintsOf(failed: boolean, requests: ResponseStats[], resources: ResourceStats[], ev: EvaluationSetup | undefined) {
  const statistic = ev?.latency.statistic ?? 'p95';
  if (failed) return { latencyBudget: 1000, peakCapacity: 1, statistic };
  let c1 = 0;
  for (const r of requests) if (r.budgetMs && r.count > 0) c1 += Math.max(0, (r.statisticMs ?? statOf(r, statistic)) / r.budgetMs - 1);
  const peak = Math.max(0, ...resources.filter((r) => r.peakCapacity).map((r) => r.maxBinUtilisation ?? 0));
  return { latencyBudget: c1, peakCapacity: Math.max(0, peak - (ev?.peakCapacity.limit ?? 1)), statistic };
}

/** the plugin's `detail` JSON (kind pcm-detail, with `evaluation`) -> the contract's DesignDetail */
export function mapPluginDetail(p: P, domain: Domain, run: Run, design: Design, computeMs: number): DesignDetail {
  const ev = run.config.evaluation;
  const e = p.evaluation ?? {};
  // metrics.fn failed(): failed, capped or timed out
  const failed = !!(e.failed ?? p.failed) || !!e.capped || !!e.timedOut;
  const statistic = ev?.latency.statistic ?? 'p95';
  const pct: number[] = e.percentiles ?? [];
  const warm: number = p.simulator?.warmUpS ?? ev?.warmUpS ?? 0;
  const end: number = p.simulator?.durationS ?? ev?.endS ?? 0;
  const binS: number = e.binSeconds ?? p.binS ?? 10;
  const bins: number = e.bins ?? 0;
  const tw = Array.from({ length: bins }, (_, b) => warm + b * binS);
  // instance names -> entity names (the detail's own lists carry both)
  const sigName = new Map<string, string>();
  for (const s of (p.systemOperations ?? []) as P[]) if (s.signature) sigName.set(s.signature, s.name);
  const contName = new Map<string, string>();
  for (const c of (p.containers ?? []) as P[]) contName.set(c.container, c.name);
  for (const r of (p.resources ?? []) as P[]) contName.set(r.container, r.containerName);
  const scName = new Map<string, string>();
  for (const s of (p.scenarios ?? []) as P[]) if (s.scenario) scName.set(s.scenario, s.name);
  const cname = (c: string) => contName.get(c) ?? c;

  // request types: the gateway's system operations (C1's statistic of a request type: the largest over its system operations)
  const reqBy = new Map(domain.requests.map((r) => [sanitise(r.id), r.id]));
  const reqStats = new Map<string, ResponseStats>();
  for (const o of (e.operations ?? []) as P[]) {
    const id = reqBy.get(sigName.get(o.signature) ?? '');
    if (!id || !o.count) continue;
    const st = fromEvaluation(id, o, pct, tw, binS, statistic, ev?.budgets[id]?.budgetMs);
    const ex = reqStats.get(id);
    if (!ex || (st.statisticMs ?? 0) > (ex.statisticMs ?? 0)) reqStats.set(id, st);
  }
  const requests = [...reqStats.values()];
  const sessions = ((e.sessions ?? []) as P[]).filter((s) => s.count > 0).map((s) => fromEvaluation(String(scName.get(s.scenario) ?? s.scenario).replace(/^session_/, ''), s, pct, tw, binS, statistic));
  const opsBy = new Map<string, P[]>();
  for (const a of (p.assemblyOperations ?? []) as P[]) opsBy.set(a.name, [...(opsBy.get(a.name) ?? []), a]);
  const operations = domain.operations.flatMap((o) => {
    const xs = opsBy.get(sanitise(o.id))?.filter((x) => x.count > 0);
    return xs?.length ? [pool(o.id, xs)] : [];
  });

  // scaling groups (SimOxide's HPA): the autoscaled containers' CPUs
  const services: ServiceTimeline[] = ((e.resources ?? []) as P[]).filter((r) => r.autoscaled && r.kind === 'CPU').map((r) => ({
    service: cname(r.container), label: cname(r.container), autoscaled: true, cores: r.cores, t: tw,
    utilisation: r.binUtilisation, replicas: r.binReplicas, ready: r.binReadyReplicas,
    meanReady: r.meanReadyReplicas, peakReady: r.peakReadyReplicas, rescales: r.rescales, createdPods: r.createdPods,
  }));
  const hpa: HpaStats = {
    t: tw, pods: tw.map((_, b) => services.reduce((s, x) => s + (x.replicas[b] ?? 0), 0)), ready: tw.map((_, b) => services.reduce((s, x) => s + (x.ready?.[b] ?? 0), 0)),
    peakPods: e.peakPods ?? 0, createdPods: e.createdPods ?? 0, rescales: e.rescales ?? 0, reversals: e.reversals ?? 0, maxPods: ev?.maxPods,
  };

  // resources that do not scale: C2's (database servers, broker) and the rest of the model's in use
  const peakSet = new Set(ev?.peakCapacity.containers ?? []);
  const queue = new Map<string, P>(((p.resources ?? []) as P[]).map((r) => [r.resource, r]));
  const used = new Set([...(design.decisions?.services.map((s) => s.id) ?? []), ...(design.decisions?.databases.map((d) => d.id) ?? [])]);
  const resources: ResourceStats[] = ((e.resources ?? []) as P[]).filter((r) => !r.autoscaled && r.kind !== 'DELAY').flatMap((r) => {
    const c = cname(r.container);
    const pk = peakSet.has(c);
    const kind: ResourceStats['kind'] = /broker/i.test(c) ? 'broker' : /gateway/i.test(c) ? 'gateway' : pk || /Database$/.test(c) ? 'db' : 'cpu';
    // sidecars, identity providers, unused containers: only when the design uses them (their utilisation is 0 otherwise)
    if (!pk && !used.has(c) && !(r.meanUtilisation > 0)) return [];
    const q = queue.get(r.resource);
    return [{
      id: r.resource, kind, label: `${c} ${r.kind}`, database: kind === 'db' ? c : undefined, service: used.has(c) && kind === 'cpu' ? c : undefined,
      utilisation: r.meanUtilisation, maxBinUtilisation: r.maxBinUtilisation, peakCapacity: pk || undefined,
      waitMs: q?.waitMs, queueLength: q?.queueLength, t: tw, utilisationOverTime: r.binUtilisation,
    }];
  });

  // the load profile simulated (the detail's per-scenario factors over the whole run)
  const sessionScen = Object.keys(p.load?.baseRatePerS ?? {});
  const t: number[] = p.load?.t ?? p.t ?? [];
  const rateAt = (k: string, i: number) => (p.load.baseRatePerS[k] ?? 0) * (p.load.factor?.[k]?.[i] ?? 1);
  const total = t.map((_, i) => sessionScen.reduce((s, k) => s + rateAt(k, i), 0));
  const mix = Object.fromEntries(sessionScen.map((k) => [k.replace(/^session_/, ''), t.map((_, i) => (total[i] ? rateAt(k, i) / total[i] : 0))]));
  const ph = ev?.phases ?? [];
  const phases = ph.map((x, i) => ({ name: x.name, fromS: x.fromS, toS: ph[i + 1]?.fromS ?? end })).filter((x) => x.toS > x.fromS);
  const profile = ev?.profile ?? 'model';
  return {
    contract: CONTRACT_VERSION, designHash: design.hash, designId: design.id, runId: run.id, origin: 'simulated',
    simulator: {
      name: `palladio-sim-service detail (${p.simulator?.name ?? 'SimOxide'}, Palladio semantics)`, version: e.version != null ? String(e.version) : undefined,
      seed: p.simulator?.seed, durationS: end, warmupS: warm, binS, profile, events: e.events, simulatedS: e.simulatedSeconds, wallMs: e.wallMs,
    },
    status: { failed, capped: !!e.capped, timedOut: !!e.timedOut, message: e.message || p.message || undefined },
    computedAt: new Date().toISOString(), computeMs,
    load: { id: profile, label: `${profile} profile`, t, sessionsPerSecond: total, mix },
    phases, operations, requests, sessions, services, resources, hpa,
    constraints: constraintsOf(failed, requests, resources, ev),
  };
}

/**
 * The packet's `simulate` command (family palladio-architecture): argv placeholders {model} {diff} {out} {request}
 * {build}; the command writes the plugin's detail JSON to {out}. It runs only when the backend's local configuration
 * allows it for the packet (server/local-config.ts).
 */
export class PalladioPluginSimulator implements Simulator {
  readonly name = 'palladio-plugin';
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private work = path.resolve(ROOT, '../../build/explorer-cache/work')) {}

  simulate(domain: Domain, run: Run, design: Design, packet?: Packet): Promise<DesignDetail> {
    const next = this.queue.then(() => this.run(domain, run, design, packet));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(domain: Domain, run: Run, design: Design, packet?: Packet): Promise<DesignDetail> {
    if (!packet?.manifest.commands?.simulate) throw new Error(`the run's packet${packet ? ` ${packet.id}` : ''} has no simulate command`);
    // checked before any file is written: a packet whose simulate the local configuration does not allow fails here
    if (!packet.command('simulate')) throw new Error(`the local configuration does not allow the packet ${packet.id} to simulate (server.local.json allowCommands)`);
    const seed = run.config.raw?.modelSeed as string | undefined;
    if (!seed || !fs.existsSync(seed)) throw new Error(`the run has no realised seed model (config.raw.modelSeed) to rebuild designs from`);
    if (!design.rawDecisions) throw new Error('the design has no model decisions (rawDecisions) to rebuild its model from');
    const build = run.config.raw?.buildDir as string | undefined;
    if (!build || !fs.existsSync(build)) throw new Error(`the run's build directory (config.raw.buildDir) is missing: ${build}`);
    fs.mkdirSync(this.work, { recursive: true });
    const stem = `${run.id}-${design.hash}`;
    const diff = path.join(this.work, `${stem}.diff.json`);
    const req = path.join(this.work, `${stem}.request.json`);
    const out = path.join(this.work, `${stem}.plugin.json`);
    // a reference (today's cut, the monolith) and a saved solution of the final population are simulated on the
    // model the search evaluated, as it is; any other design is rebuilt from the seed and its decision links
    const asIs = (run.config.raw?.referenceModels as Record<string, string> | undefined)?.[design.id]
      ?? (run.config.raw?.solutionModels as Record<string, string> | undefined)?.[design.id];
    const model = asIs && fs.existsSync(asIs) ? asIs : seed;
    fs.writeFileSync(diff, JSON.stringify(model === seed ? design.rawDecisions : {}));
    // only the detail's own fields: the evaluation's request comes from the build's metrics (the command's business)
    fs.writeFileSync(req, JSON.stringify({ assemblyOperations: true }));
    const t0 = Date.now();
    await packet.run('simulate', { model, diff, out, request: req, build });
    const p = JSON.parse(fs.readFileSync(out, 'utf8'));
    const d = mapPluginDetail(p, domain, run, design, Date.now() - t0);
    d.model = model === seed ? 'rebuilt' : 'as evaluated';
    return d;
  }
}

export class AutoSimulator implements Simulator {
  readonly name = "auto (the packet's simulate command for runs with a model seed, dummy otherwise)";
  private plugin: PalladioPluginSimulator;
  private dummy = new DummySimulator();
  constructor(work?: string) { this.plugin = new PalladioPluginSimulator(work); }
  simulate(domain: Domain, run: Run, design: Design, packet?: Packet) {
    return run.config.raw?.modelSeed && design.rawDecisions ? this.plugin.simulate(domain, run, design, packet) : this.dummy.simulate(domain, run, design);
  }
}

/** `cacheDir`: the detail cache; the simulations' work files go to its `work/` */
export function makeSimulator(cacheDir?: string): Simulator {
  const work = cacheDir ? path.join(cacheDir, 'work') : undefined;
  switch (process.env.EXPLORER_SIMULATOR) {
    case 'dummy': return new DummySimulator();
    case 'palladio-plugin': return new PalladioPluginSimulator(work);
    default: return new AutoSimulator(work);
  }
}
