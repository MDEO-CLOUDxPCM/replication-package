/**
 * Writes a synthetic explorer bundle (contract format; tests/contract.test.ts validates one):
 *   domains/<id>.json, runs/<run>/run.json, runs/<run>/designs.json, runs/<run>/details/<hash>.json
 * The domain is a contract `Domain` (domains/<id>.json of a bundle; it needs `cuts`, the first is the reference
 * for the latency budgets), by default the test fixture's small shop (tests/fixtures/packet-tiny); runs, designs
 * and performance detail are synthetic (analytic model + a small NSGA-II).
 *
 *   tsx dummy/generate.ts [--domain <Domain json>] [--out data/dummy] [--small]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Design, Domain, Generation, Id, Run, RunConfig } from '../contract/types';
import { CONTRACT_VERSION } from '../contract/types';
import { bounds, hypervolume, ranks } from '../contract/pareto';
import { writeDesignsJsonl } from '../contract/jsonl';
import { demands, PROBLEMS, requestNoLoad, type ProblemId } from './model';
import { feasible, mulberry32, nsga2, Search, type Individual, type RunResult } from './search';
import { simulate } from './simulate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const OUT = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'data/dummy');
const SMALL = args.includes('--small');
const DOMAIN_FILE = path.resolve(args.includes('--domain') ? args[args.indexOf('--domain') + 1] : path.join(ROOT, 'tests/fixtures/packet-tiny/domains/bookshop.json'));

const domain: Domain = JSON.parse(fs.readFileSync(DOMAIN_FILE, 'utf8'));
if (!domain.cuts?.length) throw new Error(`${DOMAIN_FILE}: the domain has no reference cuts (Domain.cuts)`);
// dummy latency budgets: 1.5 x the first reference cut's no-load time per request type
{
  const s = new Search(domain, 'static', mulberry32(9));
  const today = s.evaluate(s.fromCut(domain.cuts![0].services), 0);
  const dem = demands(domain, today.decisions);
  for (const rq of domain.requests) rq.budgetMs = Math.max(5, Math.round(1.5 * requestNoLoad(rq, dem)));
  domain.source += '; latency budgets: dummy (1.5 x the no-load time of the first reference cut in the dummy model)';
}

interface Spec {
  id: Id; name: string; description: string; problem: ProblemId; pop: number; gens: number; seed: number;
  source: 'headless' | 'mdeo'; keepAll: boolean; createdAt: string;
  /** designs file format (default designs.json) */
  format?: 'json' | 'jsonl';
  /** Halton samples per hypervolume (default 6 000) */
  hvSamples?: number;
  /** archive hypervolume every k-th generation (default 1) */
  archiveHvStep?: number;
}
const SPECS: Spec[] = [
  { id: 'static-a', name: 'Static cut search A', description: 'headless NSGA-II, static problem, every evaluated design kept (stress test: ~5 000 designs)',
    problem: 'static', pop: SMALL ? 40 : 100, gens: SMALL ? 10 : 50, seed: 11, source: 'headless', keepAll: true, createdAt: '2026-10-18T09:12:00Z' },
  { id: 'static-b', name: 'Static cut search B', description: 'headless NSGA-II, static problem; archive and final population',
    problem: 'static', pop: SMALL ? 30 : 80, gens: SMALL ? 8 : 40, seed: 23, source: 'headless', keepAll: false, format: 'jsonl', createdAt: '2026-10-18T14:40:00Z' },
  { id: 'static-platform-40x20', name: 'Static cut search (dev instance)', description: 'dev-instance execution 40 x 20; the platform reports the final front only',
    problem: 'static', pop: 40, gens: SMALL ? 6 : 20, seed: 37, source: 'mdeo', keepAll: false, createdAt: '2026-10-19T08:05:00Z' },
];

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

const OPERATOR_TEXT: Record<string, string> = {
  'move-class': 'one class to another or a new service',
  'move-aggregate': 'a composition aggregate as a group',
  'move-feature': "the classes a feature's operations write, together",
  'merge-services': 'two services into one',
  'split-service': 'a service into two along its aggregates',
  'change-mechanism': 'the mechanism of one to four cross-service accesses',
  'change-saga-style': 'choreography <-> orchestration of a process',
  'change-replicas': 'replica count by one',
  'change-database': 'own database <-> shared with another service',
};

fs.rmSync(OUT, { recursive: true, force: true });
writeJson(path.join(OUT, 'domains', `${domain.id}.json`), domain);

const results: { spec: Spec; res: RunResult; search: Search; refs: { ind: Individual; label: string }[]; ms: number }[] = [];
for (const spec of SPECS) {
  const t0 = performance.now();
  const search = new Search(domain, spec.problem, mulberry32(spec.seed));
  const refs = domain.cuts!.map((c) => ({ ind: search.evaluate(search.fromCut(c.services), 0), label: c.name }));
  const res = nsga2(search, spec.pop, spec.gens);
  results.push({ spec, res, search, refs, ms: performance.now() - t0 });
  console.log(`${spec.id}: ${res.evaluated.length} evaluated in ${Math.round(performance.now() - t0)} ms`);
}

// hypervolume box per problem from all feasible points of its runs
const boxes = new Map<ProblemId, { ideal: number[]; nadir: number[] }>();
for (const p of ['static'] as ProblemId[]) {
  const pts = results.filter((r) => r.spec.problem === p).flatMap((r) => r.res.evaluated.filter(feasible).map((i) => i.eval.objectives));
  if (!pts.length) continue;
  boxes.set(p, bounds(pts, pts[0].length));
}

for (const { spec, res, refs, ms } of results) {
  const prob = PROBLEMS[spec.problem];
  const box = boxes.get(spec.problem)!;
  const dir = path.join(OUT, 'runs', spec.id);
  const live = res.archive.filter((a) => a.died === null);
  const finalPop = res.generations[res.generations.length - 1].population;
  // designs with known decisions
  const chosen = new Map<string, Individual>();
  const add = (i: Individual) => { if (!chosen.has(i.hash)) chosen.set(i.hash, i); };
  refs.forEach((r) => add(r.ind));
  if (spec.source === 'mdeo') finalPop.forEach(add);
  else {
    live.forEach((a) => add(a.ind));
    finalPop.forEach(add);
    if (spec.keepAll) res.evaluated.forEach(add);
  }
  const arch = new Map(res.archive.map((a) => [a.ind.hash, a]));
  const finalSet = new Set(finalPop.map((i) => i.hash));
  const liveSet = new Set(live.map((a) => a.ind.hash));
  const refSet = new Map(refs.map((r) => [r.ind.hash, r.label]));
  const list = [...chosen.values()];
  const feas = list.filter(feasible);
  const rk = ranks(feas.map((i) => i.eval.objectives));
  const rankOf = new Map(feas.map((i, k) => [i.hash, rk[k]]));
  const designs: Design[] = list.map((i) => ({
    id: i.hash, runId: spec.id, hash: i.hash,
    label: refSet.get(i.hash),
    objectives: i.eval.objectives.map((v) => +v.toPrecision(6)),
    constraints: i.eval.constraints.map((v) => +v.toPrecision(4)),
    feasible: feasible(i),
    rank: rankOf.get(i.hash) ?? null,
    born: arch.get(i.hash)?.born ?? i.born,
    died: spec.source === 'mdeo' ? undefined : arch.get(i.hash)?.died ?? undefined,
    inArchive: spec.source === 'mdeo' ? undefined : liveSet.has(i.hash),
    inFinalPopulation: finalSet.has(i.hash),
    reference: refSet.has(i.hash) || undefined,
    metrics: Object.fromEntries(Object.entries(i.eval.metrics).map(([k, v]) => [k, +v.toPrecision(5)])),
    hasDetail: false,
    hasDecisions: true,
    decisions: i.decisions,
  }));
  // precomputed details: references, the extremes per objective, the knee, a few others
  const front = designs.filter((x) => x.rank === 0 && !x.reference);
  const pickIds = new Set<string>(designs.filter((x) => x.reference).map((x) => x.id));
  for (let k = 0; k < prob.objectives.length; k++) {
    const best = [...front].sort((a, b) => a.objectives[k] - b.objectives[k])[0];
    if (best) pickIds.add(best.id);
  }
  const norm = (x: Design) => Math.hypot(...x.objectives.map((v, k) => (v - box.ideal[k]) / (box.nadir[k] - box.ideal[k])));
  const knee = [...front].sort((a, b) => norm(a) - norm(b))[0];
  if (knee) { pickIds.add(knee.id); knee.label ??= 'knee'; }
  const rng = mulberry32(spec.seed + 1);
  for (let n = 0; n < 4 && front.length; n++) pickIds.add(front[Math.floor(rng() * front.length)].id);
  for (const x of designs) if (pickIds.has(x.id)) {
    writeJson(path.join(dir, 'details', `${x.hash}.json`), simulate(domain, x.decisions!, spec.problem, { designId: x.id, runId: spec.id, origin: 'precomputed' }));
    x.hasDetail = true;
  }
  // history
  const archAt = (g: number) => res.archive.filter((a) => a.born <= g && (a.died === null || a.died > g)).map((a) => a.ind.eval.objectives);
  const hvSamples = spec.hvSamples ?? 6000;
  const G = res.generations.length;
  // 0: about 60 points over the run
  const hvStep = spec.archiveHvStep === 0 ? Math.max(1, Math.ceil(G / 60)) : spec.archiveHvStep ?? 1;
  const history: Generation[] = res.generations.map((g, idx) => ({
    index: idx,
    evaluated: g.evaluated,
    timeMs: g.timeMs,
    executedTransformations: idx === 0 ? 0 : Math.round(spec.pop * (1.8 + rng() * 0.6)),
    skippedOperatorSlots: idx === 0 ? 0 : Math.floor(rng() * 4),
    population: spec.source === 'mdeo' ? [] : g.population.map((i) => ({
      o: i.eval.objectives.map((v) => +v.toPrecision(6)), c: i.eval.constraints.map((v) => +v.toPrecision(4)), d: chosen.has(i.hash) ? i.hash : undefined,
    })),
  }));
  const hvPop = res.generations.map((g) => hypervolume(g.population.filter(feasible).map((i) => i.eval.objectives), box.ideal, box.nadir, hvSamples));
  const hvArch = spec.source === 'mdeo' ? undefined : res.generations.map((_, g) => (g % hvStep === 0 || g === G - 1 ? hypervolume(archAt(g), box.ideal, box.nadir, hvSamples) : null));
  const config: RunConfig = {
    populationSize: spec.pop, generations: G, batches: 1,
    operators: Object.entries(OPERATOR_TEXT).map(([name, description]) => ({ name, weight: 1, description })),
    mutationSteps: 'interval(1, 3)', crossover: null,
    initialisation: spec.source === 'mdeo' ? "the platform mutates the seed once per individual" : 'random cuts by aggregate, 12 % single-class moves',
    randomSeed: spec.seed, threads: spec.source === 'mdeo' ? 6 : 8,
    notes: 'synthetic: analytic dummy model, not a Palladio evaluation',
    raw: spec.source === 'mdeo' ? { configFile: 'platform.config', nodes: 3, threadsPerNode: 2 } : { ARCH_THREADS: 8, ARCH_INIT_RANDOM: 1 },
  };
  const totalMs = res.generations.reduce((s, g) => s + g.timeMs, 0) + Math.round(ms);
  const run: Run = {
    contract: CONTRACT_VERSION,
    id: spec.id, name: spec.name, description: spec.description,
    source: spec.source === 'mdeo'
      ? { kind: 'mdeo', location: 'http://localhost:8080 (recorded)', executionId: '5f0c2e7a-dummy', synthetic: true }
      : { kind: 'headless', location: `build/runs/${spec.id}`, synthetic: true },
    problem: spec.problem, domainId: domain.id, algorithm: 'NSGA-II', status: 'completed',
    createdAt: spec.createdAt, finishedAt: new Date(Date.parse(spec.createdAt) + totalMs).toISOString(), durationMs: totalMs,
    populationSize: spec.pop, generations: G, evaluated: res.evaluated.length,
    designCount: designs.length, archiveSize: spec.source === 'mdeo' ? undefined : live.length,
    objectives: prob.objectives, constraints: prob.constraints, metrics: prob.metrics,
    finalHypervolume: (hvArch ?? hvPop)[hvPop.length - 1] ?? undefined,
    tags: ['synthetic', spec.problem, spec.source],
    config,
    history,
    hypervolume: { method: `Monte Carlo, ${hvSamples} Halton samples${hvStep > 1 ? `, archive every ${hvStep}th generation` : ''}, box per problem from all runs`, ideal: box.ideal, nadir: box.nadir, population: hvPop, archive: hvArch },
    archive: spec.source === 'mdeo' ? undefined : live.map((a) => a.ind.hash),
    finalPopulation: finalPop.map((i) => i.hash),
    references: refs.map((r) => ({ designId: r.ind.hash, label: r.label })),
  };
  writeJson(path.join(dir, 'run.json'), run);
  if (spec.format === 'jsonl') writeDesignsJsonl(path.join(dir, 'designs.jsonl'), { contract: CONTRACT_VERSION, runId: spec.id }, designs);
  else writeJson(path.join(dir, 'designs.json'), { contract: CONTRACT_VERSION, runId: spec.id, designs });
  console.log(`${spec.id}: ${designs.length} designs, archive ${live.length}, details ${pickIds.size}, hv ${run.finalHypervolume?.toFixed(3)}`);
}
console.log(`bundle written to ${OUT}`);
