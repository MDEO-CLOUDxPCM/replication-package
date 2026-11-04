/**
 * THE configuration of the MiSArch packet: every path the explorer's MiSArch side reads from the case
 * — the extraction, the inventory, the workload, the timings, the realised seeds, the metamodels, the source trees
 * of the Verify tab, the commands (a design's detail, the rebuild), the build directories — is set here and nowhere
 * else. The builder (`pnpm packet:misarch`, build.ts), the exporters (export-model.ts, export-run.ts), the Verify
 * builder (verify/) and the MiSArch tests read it; the generic explorer reads only what the builder writes into the
 * packet (packet.json: roots, sources, commands, inputs).
 *
 * This builder is the case's (cases/misarch/explorer-packet/, docs/case-interface.md), the generic explorer
 * core/explorer/; the case's files are under cases/misarch/, the core's under core/. A move changes `dirs` (and, for
 * a file that moves within the case or the core, its path below), then `pnpm packet:misarch`.
 *
 *   MISARCH_KOTLIN   the misarch-kotlin checkout (default the submodule misarch-kotlin/, else ../misarch-kotlin)
 *   ARCH_WT          the mdeo worktree of the headless harness (default build/mdeo-wt)
 *   MISARCH_PACKET   the packet directory to build into and export runs to (default build/explorer-sim)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** the repository (the inputs' paths in the input model and packet.json are relative to it: root `project`) */
const REPO = path.resolve(HERE, '../../..');
/** the generic explorer */
const EXPLORER = path.join(REPO, 'core/explorer');
/** the repository's submodule `<name>/` if it is checked out, else `../<name>` beside the repository */
const checkout = (name: string) => {
  const sub = path.join(REPO, name);
  return fs.existsSync(sub) && fs.readdirSync(sub).length > 0 ? sub : path.resolve(REPO, '..', name);
};

export const dirs = {
  /** root `project` of the packet: what the recorded inputs' paths are relative to */
  project: REPO,
  explorer: EXPLORER,
  /** this builder (cases/misarch/explorer-packet) */
  builder: HERE,
  /** the case's own files: extract/, domain/, workload/, timing/, generator/, mdeo/ */
  case: path.join(REPO, 'cases/misarch'),
  /** the generic files of the problem family: mdeo/ (metamodel/, transform/, optimize/), generator/, tools/ */
  core: path.join(REPO, 'core'),
  /** builds, caches, runs (gitignored) */
  build: path.join(REPO, 'build'),
  /** the system under study: misarch-kotlin's repository */
  sut: path.resolve(process.env.MISARCH_KOTLIN ?? checkout('misarch-kotlin')),
  /** the Palladio Simulation plugin's repository */
  plugin: checkout('palladio-sim-service'),
};

/** the path of a file relative to the project root (the form inputs and source-tree paths are recorded in) */
export const rel = (f: string) => path.relative(dirs.project, path.resolve(f)).split(path.sep).join('/');

const inCase = (p: string) => path.join(dirs.case, p);
const inCore = (p: string) => path.join(dirs.core, p);

export const packet = {
  id: 'misarch',
  name: 'MiSArch (Kotlin)',
  description: 'MiSArch in its Kotlin port: the service cut, mechanisms, sagas, homes and placement of 31 domain classes, every design simulated by SimOxide',
  family: 'palladio-architecture',
  /** the domain (and input model) id of the current model */
  domainId: 'misarch-kotlin-derived',
  domainName: 'MiSArch (Kotlin), derived model',
  /** the packet directory (runs are exported into it) */
  out: path.resolve(process.env.MISARCH_PACKET ?? path.join(dirs.build, 'explorer-sim')),
};

export const files = {
  /** package A's extraction (extract/build.py) */
  extraction: inCase('domain/misarch-domain.json'),
  /** misarch-kotlin's inventories (extract/inventory.py) */
  inventory: inCase('domain/misarch-inventory.json'),
  /** package C's session model */
  workload: inCase('workload/sessions.json'),
  /** the timing campaign's parts */
  timing: inCase('timing/parts.json'),
  /** the call graph module server-side chains use (verify/chains.py imports it) */
  callgraph: inCase('extract/callgraph.py'),
  /** the committed realised seeds of the derived model (core/tools/realise-seeds.sh) */
  seeds: {
    'domain-neutral': inCase('mdeo/seeds/domain-neutral-realised.m'),
    'domain-today': inCase('mdeo/seeds/domain-today-realised.m'),
    'domain-monolith': inCase('mdeo/seeds/domain-monolith-realised.m'),
  },
  /** the metamodels the Model panel parses */
  metamodels: [
    { id: 'domain', title: 'Domain', layer: 'layer 1', files: [inCore('mdeo/metamodel/domain.mm')] },
    { id: 'architecture', title: 'Architecture decisions', layer: 'layer 2', files: [inCore('mdeo/metamodel/architecture.mm')] },
    { id: 'palladio', title: 'Palladio (PCM)', layer: 'PCM', files: [inCore('mdeo/metamodel/palladio.mm'), inCore('mdeo/metamodel/pcm/repository.mm')] },
  ],
  /** a design's detail simulation (the packet's `simulate` command; it runs core/tools/detail_request.py) */
  designDetail: inCore('tools/design_detail.sh'),
  detailRequest: inCore('tools/detail_request.py'),
  /** the project files the Verify parts cite (their `project` tree; paths relative to the project) */
  docs: {
    curated: (svc: string) => rel(inCase(`extract/curated/${svc}.yaml`)),
    report: rel(inCase('domain/REPORT.md')),
    sessions: rel(inCase('workload/sessions.json')),
    workloadDoc: rel(inCase('workload/WORKLOAD.md')),
    sessionModel: rel(inCase('generator/gen_sessions.py')),
    derivation: rel(inCore('generator/derive.py')),
  },
};

/** the headless harness that converts the committed .m seeds into model data (export-model.ts) */
export const harness = {
  /** the staged MDEO project of the case (core/tools/stage_project.py: core/mdeo and cases/misarch/mdeo in the layout
   * mdeo reads), staged before each conversion; the harness's exporter reads it */
  stage: [path.join(dirs.core, 'tools/stage_project.py'), '--case', 'misarch'],
  dir: path.join(path.resolve(process.env.ARCH_WT ?? path.join(dirs.build, 'mdeo-wt')), 'app/arch-harness'),
  /** its arguments after `export.mjs <project> <out>` */
  args: ['--metamodel', '/metamodel/domain.mm', '--optimize', '/optimize/domain', '--only', 'models'],
  /** the converted seeds, once per content */
  cache: path.join(dirs.build, 'explorer-model-cache'),
};

/** the source trees of the Verify tab (and the Model panel's paths): their names are the evidence's `repo` */
export const sources = {
  misarch: { kind: 'git' as const, label: 'misarch-kotlin', dir: dirs.sut, about: "misarch-kotlin at the extraction's commit" },
  project: {
    kind: 'dir' as const, label: 'architecture-optimization', dir: dirs.project, about: "this project's files the parts are read against",
    /** the project files the Verify tab may read (the curated facts, the inventory, the workload, the derivation, the metamodels) */
    allow: ['cases/misarch/extract/curated/', 'cases/misarch/domain/REPORT.md', 'cases/misarch/domain/misarch-inventory.json', 'cases/misarch/workload/sessions.json', 'cases/misarch/workload/WORKLOAD.md', 'cases/misarch/generator/gen_sessions.py', 'core/generator/derive.py', 'core/mdeo/metamodel/'],
  },
};


/**
 * the origin table of the Model panel's How tab: where each step of the pipeline lives (paths relative to the
 * project; an entry whose file does not exist is left out)
 */
export const origin: { step: string; path: string; what: string; design?: string }[] = [
  { step: 'Extraction', path: 'cases/misarch/extract/build.py', what: 'reads misarch-kotlin (git, pinned commit) and the curated facts (extract/curated/*.yaml): classes, references, operations with their accesses, calls, events, transactions, joins; evidence as path:line', design: 'docs/model.md §3' },
  { step: 'Extraction', path: 'cases/misarch/domain/misarch-domain.json', what: "package A's domain: 32 classes, 59 references, 253 operations (domain, copy maintenance, trivial), events, sagas, request plans, msa mapping and seed timings", design: 'docs/model.md §3' },
  { step: 'Extraction', path: 'cases/misarch/domain/REPORT.md', what: 'counts, binding groups, coverage checks of the extraction', design: 'docs/model.md §3' },
  { step: 'Workload', path: 'cases/misarch/workload/sessions.json', what: "package C's session model: five session classes, 36 request types (C's plans), mixes, the day profile", design: 'cases/misarch/workload/WORKLOAD.md' },
  { step: 'Workload', path: 'cases/misarch/generator/gen_sessions.py', what: 'with the core\'s interpreter core/generator/sessions.py, turns the session model into usage scenarios (open session arrivals, think times, branches, loops) and load profiles', design: 'cases/misarch/workload/WORKLOAD.md' },
  { step: 'Derivation', path: 'core/generator/derive.py', what: 'with the case\'s adapter cases/misarch/generator/misarch.py, domain + workload → the optimisation model: one component per class and per schema, SEFFs from timed parts, call sites with allowed mechanisms, copy feeds, workflows, containers, decisions; the domain section as a trace', design: 'docs/model.md §3' },
  { step: 'Derivation', path: 'cases/misarch/mdeo/models/domain-neutral.m', what: 'the seed: every class in one container, every schema on one server, every site sync', design: 'docs/model.md, The four models' },
  { step: 'Derivation', path: 'cases/misarch/mdeo/models/domain-today.m', what: "today's cut: 16 services, a database server each, today's mechanisms", design: 'docs/model.md, The four models' },
  { step: 'Derivation', path: 'core/tools/gen_domain_budgets.sh', what: "today's cut simulated under each load profile (mdeo/models/domain-today-p95-<profile>.json: per request type count, mean, p50, p90, p95) → C1's reference statistics; the budget is LatencyBudgetPolicy.factor × the policy's statistic", design: 'docs/quality.md, C1' },
  { step: 'Metamodels', path: 'core/mdeo/metamodel/domain.mm', what: 'layer 1: the domain (classes, operations, accesses, events) and the derivation trace', design: 'docs/model.md §1' },
  { step: 'Metamodels', path: 'core/mdeo/metamodel/architecture.mm', what: 'layer 2: placement, call sites and mechanisms (with the local copies the copy sync realises), workflows, replicas, the quality model (cost, reliability, coupling, consistency, budgets) and the realisation trace', design: 'docs/model.md §1, §6' },
  { step: 'Metamodels', path: 'core/mdeo/metamodel/palladio.mm', what: 'plain PCM: repository, SEFFs, system, resources, allocation, usage model', design: 'docs/model.md §1' },
  { step: 'Realisation', path: 'core/mdeo/transform/realise.mt', what: 'the decisions → plain PCM in place (async forks, cache branches, composed calls, orchestrations, notifications, middleware blocks, replicas); the repairs after each operator in transform/repair/', design: 'docs/model.md §5, §7' },
  { step: 'Evaluation', path: 'core/mdeo/transform/metrics.fn', what: 'the request of the simulations per design (scaling groups, load profile, window, seeds, limits) and the objectives, the constraints C1–C5 and the reported metrics over their results', design: 'docs/quality.md' },
  { step: 'Simulation', path: rel(path.join(dirs.plugin, 'src/evaluate.rs')), what: "the plugin's pcmEvaluate: one SimOxide simulation of the realised PCM (Palladio semantics, SPD + HPA, usage streams), raw measurements", design: 'docs/quality.md, Simulation of a design' },
  { step: 'Simulation', path: rel(path.join(dirs.plugin, 'API-pcmEvaluate.md')), what: 'what pcmEvaluate measures: response times per request type and session, utilisation and pods per bin, call counts, synchronous path sets', design: 'docs/quality.md, Simulation of a design' },
  { step: 'Optimisation', path: 'cases/misarch/mdeo/configs/today-3obj-5sim.config', what: "the problem from today's cut: seed, operators (moves of units, groups, mechanism changes, crossovers), minimise O1 cost, O2 failures and O5 slow requests, constraints C1–C5 (C4, C5: O3 and O4 at most 1.1 × today's); five simulations per evaluation, 175 × 450", design: 'docs/search.md' },
  { step: 'Optimisation', path: 'cases/misarch/mdeo/configs/perclass-3obj-5sim.config', what: 'the same problem from one service per class (domain-perclass-realised.m)', design: 'docs/search.md' },
  { step: 'Optimisation', path: 'cases/misarch/mdeo/configs/smoke-3obj-5sim.config', what: "today-3obj-5sim.config for 3 generations: its time per generation", design: 'docs/search.md' },
  { step: 'Optimisation', path: 'core/tools/run-domain.sh', what: 'a headless run: exports, the realised seeds, the harness (NSGA-II), designs.jsonl', design: 'docs/search.md, Running a search' },
  { step: 'Explorer', path: 'core/tools/design_detail.sh', what: "a design's simulation for the Performance panel: the design rebuilt in its run's build and simulated with the evaluation's request (core/mdeo/optimize/domain/detail.fn)", design: 'core/explorer/README.md' },
  { step: 'Explorer', path: 'cases/misarch/explorer-packet/export-run.ts', what: "a run → the explorer bundle: designs with their decisions read from the model's decision links", design: 'core/explorer/README.md, Runs into the explorer' },
  { step: 'Explorer', path: 'cases/misarch/explorer-packet/export-model.ts', what: 'this input model: the domain section, SEFFs, sites, workload, parameters and parsed metamodels', design: 'core/explorer/contract/CONTRACT.md, InputModel' },
];
