/**
 * What a realised domain model says about its evaluation (docs/quality.md, Simulation of a design): the load profile
 * (LoadProfile with its LoadSteps), C1's policy and budgets (LatencyBudgetPolicy,
 * OperationLatencyBudget), C2's containers and limit (PeakCapacity). Shared by export-run.ts (a
 * run's EvaluationSetup) and export-model.ts (the Workload tab's profiles and budgets). Nothing here
 * is a default of its own: every value is the model's (or C's phase names from workload/sessions.json).
 */
import type { EvaluationSetup, Id } from '../../../core/explorer/contract/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RawModel { instances: { name: string; className: string; properties: Record<string, any> }[]; links: { sourceName: string; sourceProperty: string; targetName: string }[] }

/** gen_domain.py's ident(): a model name from an operation or request id */
export const ident = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

const STAT_FIELD: Record<string, string> = { mean: 'referenceMeanMs', p50: 'referenceP50Ms', p90: 'referenceP90Ms', p95: 'referenceP95Ms' };

export interface ModelEvaluation {
  profile: string;
  warmUpS: number;
  endS: number;
  binS: number;
  seed: number;
  usageStreams: boolean;
  maxPods: number;
  /** per session type (null: every scenario) */
  steps: { session: Id | null; timeS: number; factor: number }[];
  /** the model's arrival rate per session type (OpenWorkload Exp(rate)), sessions/s */
  baseRates: Record<Id, number>;
  latency: EvaluationSetup['latency'];
  /** per request type (by the gateway signature's entity name = ident(request id)) */
  budgets: Map<string, { budgetMs?: number; referenceMs?: number; referenceCount?: number; ms: number }>;
  peakCapacity: EvaluationSetup['peakCapacity'];
}

export function modelEvaluation(m: RawModel): ModelEvaluation {
  const inst = new Map(m.instances.map((i) => [i.name, i]));
  const out = new Map<string, [string, string][]>();
  for (const l of m.links) (out.get(l.sourceName) ?? out.set(l.sourceName, []).get(l.sourceName)!).push([l.sourceProperty, l.targetName]);
  const links = (n: string, p: string) => (out.get(n) ?? []).filter(([q]) => q === p).map(([, t]) => t);
  const ent = (n: string) => (inst.get(n)?.properties?.entityName as string | undefined) ?? n;
  const all = (c: string) => m.instances.filter((i) => i.className === c);
  const session = (n: string) => ent(n).replace(/^session_/, '');

  const lp = all('LoadProfile')[0];
  const lpp = lp?.properties ?? {};
  const steps = (lp ? links(lp.name, 'steps') : all('LoadStep').map((s) => s.name)).map((s) => {
    const sc = links(s, 'scenario')[0];
    const p = inst.get(s)?.properties ?? {};
    return { session: sc ? session(sc) : null, timeS: Number(p.seconds ?? 0), factor: Number(p.factor ?? 1) };
  }).sort((a, b) => a.timeS - b.timeS || String(a.session).localeCompare(String(b.session)));
  const baseRates: Record<Id, number> = {};
  for (const u of all('UsageScenario')) {
    const w = links(u.name, 'workload')[0];
    const spec = String(inst.get(w ?? '')?.properties?.interArrivalTime ?? '');
    const e = /^Exp\(\s*([\d.eE+-]+)\s*\)$/.exec(spec.trim());
    if (e) baseRates[session(u.name)] = Number(e[1]);
  }
  const pol = all('LatencyBudgetPolicy')[0]?.properties;
  const latency: EvaluationSetup['latency'] = pol
    ? { statistic: String(pol.statistic), factor: Number(pol.factor), minCompletions: Number(pol.minCompletions), source: 'LatencyBudgetPolicy' }
    : { statistic: 'p95', source: 'OperationLatencyBudget.ms (no LatencyBudgetPolicy in the model)' };
  const budgets: ModelEvaluation['budgets'] = new Map();
  for (const b of all('OperationLatencyBudget')) {
    const sig = links(b.name, 'operation')[0];
    if (!sig) continue;
    const p = b.properties;
    let budgetMs: number | undefined = Number(p.ms);
    let referenceMs: number | undefined;
    const referenceCount = p.referenceCount !== undefined ? Number(p.referenceCount) : undefined;
    if (pol) {
      // metrics.fn budgetOf: factor × the reference's statistic, none below minCompletions (or with factor ≤ 0: ms)
      referenceMs = p[STAT_FIELD[latency.statistic] ?? 'referenceP95Ms'] !== undefined ? Number(p[STAT_FIELD[latency.statistic] ?? 'referenceP95Ms']) : undefined;
      if ((latency.factor ?? 0) > 0) {
        budgetMs = (referenceCount ?? 0) < (latency.minCompletions ?? 0) || !(referenceMs && referenceMs > 0) ? undefined : latency.factor! * referenceMs;
      }
    }
    budgets.set(ent(sig), { budgetMs, referenceMs, referenceCount, ms: Number(p.ms) });
  }
  const pc = all('PeakCapacity')[0];
  const peakCapacity = { limit: Number(pc?.properties?.limit ?? 1), binS: Number(pc?.properties?.binSeconds ?? 10), containers: pc ? links(pc.name, 'containers').map(ent) : [] };
  return {
    profile: String(lpp.name ?? 'model'), warmUpS: Number(lpp.warmUpSeconds ?? 120), endS: Number(lpp.endSeconds ?? 240), binS: peakCapacity.binS,
    seed: Number(lpp.seed ?? 1), usageStreams: lpp.usageStreams !== false, maxPods: Number(lpp.maxPods ?? 400),
    steps, baseRates, latency, budgets, peakCapacity,
  };
}

/** C's phases of a profile (workload/sessions.json `profiles.<id>.phases`) */
export function profilePhases(workload: any, profile: string): { phases: EvaluationSetup['phases']; about?: string } {
  const p = workload?.profiles?.[profile];
  if (!p) return { phases: [] };
  return { phases: (p.phases ?? []).map((x: any) => ({ name: String(x.name), fromS: Number(x.from), volume: x.volume, mix: x.mix })), about: p.about };
}
