/**
 * Explorer data contract (see CONTRACT.md).
 *
 * The format the project's exporters write ("explorer bundle") and the explorer's backend serves.
 * Everything is plain JSON. Times are seconds unless a field says `Ms`; rates are per second.
 * Bump CONTRACT_VERSION on every change: minor for additive changes, major for breaking ones.
 */

export const CONTRACT_VERSION = '1.14.0';

export type Id = string;

import type { PacketSummary } from './packet';
export type * from './packet';

// ---------------------------------------------------------------- shared enums

/**
 * How one access of an operation to a class in another service is realised in a design (a decision). An access within
 * the operation's own service has no mechanism (1.12.0: `local` is gone; its placement is "no hop", `DerivedAccess`).
 */
export type Mechanism =
  | 'sync' // synchronous call to the owning service
  | 'copy' // a local copy of the class, fed by the owner's events
  | 'cache' // a cache in front of a synchronous call
  | 'join' // gateway join (federation): the gateway fetches the class from its owner
  | 'saga'; // a write in another service, done as a saga step

export const MECHANISMS: readonly Mechanism[] = ['sync', 'copy', 'cache', 'join', 'saga'];

/**
 * (1.13.0) how current a read (or a call's answer) must be, curated per read by the case:
 * `strict` current data only (sync only; a copy only where today's code reads its own store), `stale-ok` a cache or a
 * copy may serve it (priced by O4), `immutable` as stale-ok, but a stale answer cannot be wrong (O4 counts no staleness).
 * Replaces the flag `strong` (contract/consistency.ts `levelOf` accepts the older spelling `strong`).
 */
export type ConsistencyLevel = 'strict' | 'stale-ok' | 'immutable';

export const CONSISTENCY_LEVELS: readonly ConsistencyLevel[] = ['strict', 'stale-ok', 'immutable'];

/**
 * (1.13.0) a read's or a call's curated consistency: its level, the rule ids that decide it (the case's
 * `InputModel.consistency.rules`, e.g. S2, R1, I1) and the reason in the case's words; `lock` a statement that only
 * locks (a strict read of the locked class)
 */
export interface Consistency {
  level: ConsistencyLevel;
  rules?: string[];
  reason?: string;
  lock?: boolean;
}

/**
 * (1.12.0) where the two sides of a call run, as the UI names it (never a mechanism): `noHop` caller and callee in one
 * container (a direct call: no middleware, no network, no receiving envelope), `remote` in different containers (the
 * hop: both sidecars' middleware and the network; a synchronous call also pays the callee's receiving envelope).
 */
export type Placement = 'noHop' | 'remote';

/**
 * (1.12.0) a request plan entry's `via` (`ModelRequest.plan[].via`, `ModelSite.planVia`): `root` the root resolver,
 * `service` resolved in the service that resolves its parent (the root's service for a field on the root's objects),
 * `gateway` a federation fetch by the gateway. Readers accept the older spelling `local` for `service` (`contract/plan.ts` planVia).
 */
export type PlanVia = 'root' | 'service' | 'gateway';

export type SagaStyle = 'choreography' | 'orchestration';
export type DbPlacement = 'own' | 'shared';
export type AccessMode = 'read' | 'write';
/** query/mutation: GraphQL entry points; handler: event handler; internal: lookups and resolvers no client calls. */
export type OperationKind = 'query' | 'mutation' | 'handler' | 'internal';
export type Direction = 'minimize' | 'maximize';
export type SourceKind = 'bundle' | 'headless' | 'mdeo';
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// ---------------------------------------------------------------- index

export interface RunIndex {
  contract: string;
  generatedAt: string;
  runs: RunSummary[];
  domains: DomainRef[];
  /** sources the backend read, with errors (e.g. "mdeo: dev instance not reachable, recorded responses used"). */
  sources: SourceStatus[];
  /** (1.10.0) the data packets (contract/packet.ts): every run belongs to the packet of its domain */
  packets?: PacketSummary[];
}

export interface DomainRef {
  id: Id;
  name: string;
  version: string;
}

export interface SourceStatus {
  id: Id;
  kind: SourceKind;
  location: string;
  ok: boolean;
  runs: number;
  /** "live", "recorded" (mdeo answered from recorded responses), "files". */
  mode: string;
  message?: string;
}

export interface SourceRef {
  kind: SourceKind;
  /** run directory, bundle path or base URL */
  location: string;
  /** mdeo execution id */
  executionId?: string;
  /** true when the data is synthetic (dummy generator) */
  synthetic?: boolean;
}

export interface ObjectiveDef {
  key: string;
  label: string;
  unit?: string;
  direction: Direction;
  description?: string;
  /** decimals to show */
  digits?: number;
}

/** A constraint value is its violation: 0 = satisfied, > 0 = by how much it is violated. */
export interface ConstraintDef {
  key: string;
  label: string;
  unit?: string;
  description?: string;
}

/** Further per-design scalars (reported, not optimised), e.g. services, sync calls, mean response time. */
export interface MetricDef {
  key: string;
  label: string;
  unit?: string;
  digits?: number;
  /** "lower" when lower is better, "higher", or "none" (descriptive) */
  better?: 'lower' | 'higher' | 'none';
}

export interface RunSummary {
  id: Id;
  name: string;
  /** (1.10.0) the packet the run belongs to (set by the backend) */
  packet?: Id;
  description?: string;
  source: SourceRef;
  /** e.g. "static", "hpa" */
  problem: string;
  domainId: Id;
  algorithm: string;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  populationSize: number;
  generations: number;
  evaluated: number;
  /** designs whose decisions are known (archive, final population, references, or all evaluated) */
  designCount: number;
  archiveSize?: number;
  objectives: ObjectiveDef[];
  constraints: ConstraintDef[];
  finalHypervolume?: number;
  tags?: string[];
  /**
   * (1.5.0) the fingerprint of the seed the run started from (contract/hash.ts modelFingerprint): a run whose seed is
   * none of the input model's seeds was made with an earlier model
   */
  modelFingerprint?: string;
}

// ---------------------------------------------------------------- run

export interface Run extends RunSummary {
  contract: string;
  config: RunConfig;
  metrics: MetricDef[];
  /** per generation (index 0 = initial population); empty when the source does not report them */
  history: Generation[];
  hypervolume?: HypervolumeSeries;
  /** design ids of the external archive at the end (headless runs) */
  archive?: Id[];
  /** design ids of the final population (dev-instance executions: its reported front) */
  finalPopulation?: Id[];
  /** reference designs evaluated with the same evaluator (today's cut, knee, monolith, ...) */
  references?: { designId: Id; label: string }[];
}

export interface RunConfig {
  populationSize: number;
  generations: number;
  batches?: number;
  operators: { name: string; weight?: number; description?: string }[];
  /** e.g. "interval(1, 3)" operators per mutation */
  mutationSteps?: string;
  crossover?: string | null;
  initialisation?: string;
  randomSeed?: number;
  threads?: number;
  /** (1.0.0) how every design of the run was evaluated: one simulation per design (docs/quality.md, Simulation of a design) */
  evaluation?: EvaluationSetup;
  notes?: string;
  /** the source's config as is (mdeo .config fields, harness env) */
  raw?: Record<string, unknown>;
}

/**
 * (1.0.0) The evaluation of a run's designs (docs/quality.md, Simulation of a design): one SimOxide simulation of the realised
 * model per design (the plugin's pcmEvaluate) with the model's load profile; read from the run's
 * seed model and its build by the case packet's export-run.ts.
 */
export interface EvaluationSetup {
  /** the load profile variant: `day` (C4's compressed day) or `steady` (the design load) */
  profile: string;
  /** measured window [warmUpS, endS] and the per-bin series' bin width, s */
  warmUpS: number;
  endS: number;
  binS: number;
  seed: number;
  usageStreams: boolean;
  /** pods the HPA may create in one simulation (beyond: capped, infeasible) */
  maxPods: number;
  /** the profile's phases (C's `profiles.<id>.phases`): name and start, s */
  phases: { name: string; fromS: number; volume?: number; mix?: string }[];
  /** C1's policy: the statistic per request type (mean, p50, p90, p95), the factor on the reference's statistic, the reference completions a budget needs */
  latency: { statistic: string; factor?: number; minCompletions?: number; source: string };
  /** C1's budget per request type (RequestType ids) under this profile, ms; request types without one are not checked */
  budgets: Record<Id, { budgetMs: number; referenceMs?: number; referenceCount?: number }>;
  /** C2: the containers (model entity names) whose per-bin utilisation must stay at most at `limit` */
  peakCapacity: { limit: number; binS: number; containers: string[] };
  /** the plugin build the run's build directory serves (`<date>+<git hash>`) */
  pluginVersion?: string;
}

export interface Generation {
  index: number;
  evaluated: number;
  timeMs?: number;
  executedTransformations?: number;
  skippedOperatorSlots?: number;
  /** the population after this generation; `d` only when the design's decisions are known */
  population: PopulationPoint[];
}

/** One individual: objective values (order of Run.objectives), constraint violations, optional design id. */
export interface PopulationPoint {
  o: number[];
  c: number[];
  d?: Id;
}

export interface HypervolumeSeries {
  /** e.g. "Monte Carlo, 200 000 Halton samples, normalised box" */
  method: string;
  /**
   * normalisation box in the objectives' own units, per objective; minimisation form; (1.5.0) absent when the source
   * computed the values with a box it does not report (the platform's own hypervolume)
   */
  ideal?: number[];
  nadir?: number[];
  /** per generation: hypervolume of the feasible non-dominated points of the population (null: not computed) */
  population: (number | null)[];
  /** per generation: of the archive at that generation (headless runs); may be sampled (null between) */
  archive?: (number | null)[];
}

// ---------------------------------------------------------------- designs

export interface DesignSummary {
  id: Id;
  runId: Id;
  /** hash of the canonical decisions (contract/hash.ts); the cache key for details */
  hash: string;
  label?: string;
  objectives: number[];
  constraints: number[];
  feasible: boolean;
  /** non-domination rank among the run's feasible designs (0 = front); null if infeasible */
  rank?: number | null;
  /** generation the design was first seen / left the archive */
  born?: number;
  died?: number | null;
  inArchive?: boolean;
  inFinalPopulation?: boolean;
  reference?: boolean;
  /** values of Run.metrics */
  metrics: Record<string, number>;
  /** precomputed detail available without simulation */
  hasDetail?: boolean;
  /** decisions known (false for designs only known by objective values) */
  hasDecisions: boolean;
}

export interface Design extends DesignSummary {
  decisions?: Decisions;
  /** the source's decisions as is, when they cannot be mapped (e.g. layer-2 link maps of older runs) */
  rawDecisions?: Record<string, string>;
}

export interface Decisions {
  services: ServiceDecision[];
  /**
   * Mechanism per access whose class lives in another service than the operation runs in.
   * Key `${operationId}|${classId}|${mode}`. Accesses within one service have no mechanism and are not listed.
   */
  mechanisms: Record<string, Mechanism>;
  /** saga style per business process whose steps span several services */
  sagas: SagaDecision[];
  databases: DatabaseServer[];
  /** where an operation runs, if not in the service of its home class */
  operationPlacement?: Record<Id, Id>;
  /**
   * (1.4.0) per effect step (call site, `Domain.effectSites`): its mechanism and whether it joins the
   * caller's transaction in this design
   */
  effects?: Record<Id, EffectState>;
  /** (1.4.0) the chosen home class per operation whose home is a decision (`Domain.homes`) */
  homes?: Record<Id, Id>;
}

/** (1.4.0) an effect step's mechanism: in the caller's transaction, a synchronous step, an asynchronous message */
export type EffectMechanism = 'inTx' | 'sync' | 'async';

/**
 * (1.4.0) why an effect step does not join the caller's transaction (core/mdeo/transform/realise/plan-placement.mt `pj`):
 * `apart` caller and provider in different containers, `servers` the two schemas on different database servers,
 * `orchestrated` a step of an orchestrated workflow (a saga step), `external` the trigger is outside the system (a
 * provider callback: async only), `chosen` the design chose another mechanism (sync or async)
 */
export type JoinBlocker = 'apart' | 'servers' | 'orchestrated' | 'external' | 'chosen';

/** (1.4.0) an effect step in one design */
export interface EffectState {
  m: EffectMechanism;
  /** in the caller's transaction (realisation shape `joined`): a local call, no envelope, no commit, no message */
  joined?: true;
  /** not joined: why (the first that holds, in the order apart, servers, orchestrated; external, chosen) */
  why?: JoinBlocker;
  /** caller and provider share a container */
  together?: true;
}

/** (1.4.0) an effect step of the model (docs/model.md, Call sites): operation A causes a change at class B */
export interface EffectSite {
  /** the call site */
  id: Id;
  /** the trigger operation (A) */
  op: Id;
  /** how today's code implements it: a write of another class, an event reaction, a provider callback */
  kind: 'write' | 'event' | 'callback';
  /** the class whose work it is (B: the written class, the reaction's or callback's home class) */
  class: Id;
  /** the reaction or callback operation (events, callbacks) */
  callee?: Id;
  /** the event raised (events) */
  event?: Id;
  allowed: EffectMechanism[];
  /** the step sits in a home option's SEFF: the option's class (inert unless chosen) */
  home?: Id;
  /** the schemas that must share a database server to join (CallSite.callerSchema, providerSchema) */
  callerSchema?: Id;
  providerSchema?: Id;
  /** the class whose component makes the call (the caller's container decides `together`) */
  callerClass?: Id;
}

export interface ServiceDecision {
  id: Id;
  name: string;
  classes: Id[];
  replicas: ReplicaDecision;
  /** database server id */
  database: Id;
}

export type ReplicaDecision =
  | { mode: 'fixed'; count: number }
  | { mode: 'hpa'; min: number; max: number; targetUtilisation: number };

export interface SagaDecision {
  process: Id;
  style: SagaStyle;
  /** orchestrating service (orchestration only) */
  orchestrator?: Id;
}

export interface DatabaseServer {
  id: Id;
  name: string;
  placement: DbPlacement;
  services: Id[];
}

/** GET /api/runs/:id/designs: the summaries (no decisions) */
export interface DesignList {
  contract: string;
  runId: Id;
  designs: DesignSummary[];
}

/** runs/<run>/designs.json in a bundle: every design with its decisions */
export interface DesignFile {
  contract: string;
  runId: Id;
  designs: Design[];
}

/**
 * runs/<run>/designs.jsonl in a bundle (since 0.2.0, preferred over designs.json when present):
 * line 1 is this header, then one `Design` per line (JSON, no line breaks inside a line).
 */
export interface DesignStreamHeader {
  contract: string;
  runId: Id;
}

// ---------------------------------------------------------------- domain

export interface Domain {
  contract: string;
  id: Id;
  name: string;
  version: string;
  /** where it was extracted from (commit, files) */
  source: string;
  classes: DomainClass[];
  references: Reference[];
  aggregates: Aggregate[];
  operations: Operation[];
  events: DomainEvent[];
  features: Feature[];
  processes: BusinessProcess[];
  /** client request types (GraphQL documents); the gateway plan runs their operations */
  requests: RequestType[];
  sessions: SessionType[];
  /** load profiles over time (sessions/s and mix), e.g. package C's "day" and "steady" */
  loadProfiles?: LoadProfile[];
  /** named reference cuts: today's 16 services, a monolith, ... */
  cuts?: { id: Id; name: string; services: { name: string; classes: Id[] }[] }[];
  /** (1.4.0) the model's effect steps; a design's `Decisions.effects` holds their state */
  effectSites?: EffectSite[];
  /** (1.4.0) operations whose home (entry point) is a decision among the classes they write in their transaction */
  homes?: { op: Id; options: Id[]; written: Id }[];
}

export interface DomainClass {
  id: Id;
  name: string;
  aggregate?: Id;
  sizeKb?: number;
  attributes?: string[];
  description?: string;
}

export interface Reference {
  id: Id;
  from: Id;
  to: Id;
  name?: string;
  kind: 'composition' | 'association' | 'snapshot';
  multiplicity?: string;
}

export interface Aggregate {
  id: Id;
  name: string;
  root: Id;
  classes: Id[];
}

export interface Operation {
  id: Id;
  name: string;
  kind: OperationKind;
  feature?: Id;
  /** the class the operation is anchored on; it runs in this class's service unless placed otherwise */
  homeClass: Id;
  /** event the handler reacts to */
  trigger?: Id;
  publishes?: Id[];
  /** requests per second at the reference load */
  rate?: number;
  cpuMs?: number;
  dbMs?: number;
  /** latency budget, ms (the dummy bundles only) */
  budgetMs?: number;
  accesses: Access[];
  description?: string;
}

export interface Access {
  class: Id;
  mode: AccessMode;
  /** accesses per execution */
  perExecution?: number;
  /**
   * (1.13.0) reads: how current the data must be (strict: no copy or cache), with the curated rules and reason of its
   * statements at that level; absent: stale-ok
   */
  level?: ConsistencyLevel;
  rules?: string[];
  reason?: string;
  /** (1.13.0) one of its statements only locks (a strict read of the locked class) */
  lock?: boolean;
  /** the older spelling of `level` (needs fresh data: no copy or cache allowed), read by `levelOf` */
  strong?: boolean;
  /** part of a cross-class join or transaction with the operation's other accesses */
  joined?: boolean;
}

export interface DomainEvent {
  id: Id;
  name: string;
  publishers: Id[];
  subscribers: Id[];
  /** the class whose changes the event carries */
  class?: Id;
}

export interface Feature {
  id: Id;
  code: string;
  name: string;
  operations: Id[];
}

export interface BusinessProcess {
  id: Id;
  name: string;
  trigger: Id;
  /** operations in order; a step's writes in another service than the trigger's make the process a saga */
  steps: Id[];
  /**
   * (1.3.0) a transaction workflow (`tx_<SEFF>`, layer 2's `Workflow.transactional`, docs/model.md Workflows): no business
   * process but the transaction of the trigger, whose transaction-bound writes of other classes are the steps (`steps`
   * stays empty); a saga while one of these classes sits in another service than the trigger
   */
  transaction?: { writes: Id[]; home?: Id };
}

export interface RequestType {
  id: Id;
  name: string;
  /** the GraphQL document */
  document?: string;
  /** operations the gateway plan runs, root first */
  operations: Id[];
  /** requests per second at the reference load */
  rate?: number;
  /** latency budget, ms (the dummy bundles; a run's budgets are in its `config.evaluation.budgets`) */
  budgetMs?: number;
}

export interface SessionType {
  id: Id;
  name: string;
  description?: string;
  /** share of the sessions at the reference mix */
  share: number;
  thinkTimeS: number;
  /** request types in order of first use; repeat: expected visits per session (may be fractional); probability: optional step */
  steps: { request: Id; probability?: number; repeat?: number }[];
}

// ---------------------------------------------------------------- design detail (performance)

/**
 * (1.0.0) The simulation of one design: the plugin's `detail` run of the design's realised model with
 * exactly the request the search evaluated it with (core/tools/design_detail.sh), so its `evaluation`
 * is the search's pcmEvaluate result. Statistics cover the measured window; the per-bin series
 * cover the window in `binS` bins (`t` = bin starts, s).
 */
export interface DesignDetail {
  contract: string;
  designHash: string;
  designId?: Id;
  runId?: Id;
  /** precomputed (exported with the run), simulated (on demand), synthetic (dummy) */
  origin: 'precomputed' | 'simulated' | 'synthetic';
  simulator: {
    name: string;
    /** the plugin build that simulated it (`<date>+<git hash>`) */
    version?: string;
    seed?: number;
    /** end of the run and start of the measured window, s */
    durationS: number;
    warmupS?: number;
    binS: number;
    /** the load profile variant (EvaluationSetup.profile) */
    profile?: string;
    events?: number;
    simulatedS?: number;
    wallMs?: number;
  };
  /** a failed simulation, or one stopped at the pod or event limit, makes the design infeasible (C1 1000, C2 1) */
  status: { failed: boolean; capped: boolean; timedOut: boolean; message?: string };
  computedAt: string;
  computeMs?: number;
  /** the load profile simulated: sessions started per second and the session mix per bin */
  load: LoadProfile;
  /** the profile's phases, for shading (EvaluationSetup.phases) */
  phases?: { name: string; fromS: number; toS: number }[];
  operations: ResponseStats[];
  requests: ResponseStats[];
  sessions: ResponseStats[];
  services: ServiceTimeline[];
  resources: ResourceStats[];
  /** the HPA over all scaling groups */
  hpa: HpaStats;
  /** the simulated model: the one the search evaluated (a reference, a saved solution) or rebuilt from the seed and the design's decision links */
  model?: 'as evaluated' | 'rebuilt';
  /** C1 and C2 recomputed from this simulation with the run's budgets and limit (compare with the design's values) */
  constraints?: { latencyBudget: number; peakCapacity: number; statistic: string };
}

export interface LoadProfile {
  id: Id;
  label: string;
  /** sample times, s */
  t: number[];
  sessionsPerSecond: number[];
  /** share of each session type over time (keys: SessionType ids) */
  mix: Record<Id, number[]>;
}

export interface ResponseStats {
  /** operation, request type or session type id */
  key: Id;
  count: number;
  failed?: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** C1's budget of a request type (the run's EvaluationSetup.budgets) */
  budgetMs?: number;
  /** C1's statistic of this series (EvaluationSetup.latency.statistic), ms */
  statisticMs?: number;
  /** log-spaced bins: counts[i] in [edgesMs[i], edgesMs[i+1]) */
  histogram: { edgesMs: number[]; counts: number[] };
  /** per bin (completion time): mean, p95, completions per second */
  overTime?: { t: number[]; meanMs: number[]; p95Ms: number[]; throughput: number[] };
}

export interface ServiceTimeline {
  /** a scaling group's container (a service's container, the gateway) */
  service: Id;
  label?: string;
  autoscaled: boolean;
  /** cores per pod */
  cores?: number;
  t: number[];
  /** CPU utilisation per ready pod, 0..1 */
  utilisation: number[];
  /** pods (ready + starting), time mean per bin */
  replicas: number[];
  /** ready pods, time mean per bin */
  ready?: number[];
  meanReady?: number;
  peakReady?: number;
  rescales?: number;
  createdPods?: number;
}

export interface ResourceStats {
  id: Id;
  kind: 'cpu' | 'db' | 'broker' | 'gateway';
  label: string;
  service?: Id;
  database?: Id;
  /** mean utilisation over the window, 0..1 */
  utilisation: number;
  /** the largest per-bin utilisation (C2's quantity for a PeakCapacity container) */
  maxBinUtilisation?: number;
  /** a container C2 checks (database servers, broker) */
  peakCapacity?: boolean;
  waitMs?: number;
  queueLength?: number;
  t?: number[];
  utilisationOverTime?: number[];
  queueOverTime?: number[];
}

export interface HpaStats {
  t: number[];
  /** pods of all groups per bin (ready + starting), and ready */
  pods: number[];
  ready: number[];
  peakPods: number;
  createdPods: number;
  rescales: number;
  reversals: number;
  maxPods?: number;
}

// ---------------------------------------------------------------- input model (0.3.0, call-site links 0.4.0)

/**
 * The optimisation's input model (family palladio-architecture): how the system enters the optimisation
 * (models/<domainId>.json in a packet, written by the case's exporter, served at
 * GET /api/domains/:id/model). Everything is read from the derived model (its realised seeds), the case's extraction
 * and workload and the metamodel files at export time.
 */
export interface InputModel {
  contract: string;
  domainId: Id;
  generatedAt: string;
  /** the commit of the system's repository the extraction was read at */
  commit?: string;
  /** (1.1.0) where the model's demands come from, detected from the data (absent: the seed's timings) */
  timing?: ModelTiming;
  /**
   * the files the export read, as repo paths of this project; (1.5.0) with their content hash (sha256) and, for a
   * realised seed, the model it was realised from with that model's hash at the time (its `// Source:` line)
   */
  inputs: ModelInput[];
  /** (1.5.0) the exporter's arguments, to export again with the same inputs */
  exportArgs?: string[];
  /** (1.5.0) set by the backend when it serves the model: whether the inputs are still the exported ones */
  freshness?: ModelFreshness;
  /** the files the model comes from (origin), as repo paths */
  origin: ModelOrigin[];
  classes: ModelClass[];
  references: ModelReference[];
  operations: ModelOperation[];
  events: ModelEvent[];
  bindings: ModelBinding[];
  processes: ModelProcess[];
  /** request types of the usage model (login excluded: the identity provider's token, no SEFF of the system) */
  requests: ModelRequest[];
  sessions: ModelSession[];
  /** design load: sessions per second of the realistic workload's base mix */
  designSessionsPerS: number;
  /** (1.0.0) the load profiles of the model variants (LoadProfile, LoadStep): what every design is simulated with */
  profiles?: ModelProfile[];
  /** the SEFFs of the derived model as timed parts (the base model, before the realisation adds middleware) */
  seffs: ModelSeff[];
  /** call sites (decisions: the mechanism of one call) */
  sites: ModelSite[];
  /** (1.2.0) package A's topics with their roles (domain/REPORT.md §5) */
  topics?: ModelTopic[];
  /**
   * (1.4.0) the operations whose home is a decision (layer 2's Home): the candidate classes (each with
   * its SEFF), the class the gateway's call is written to, and the seeds' choices
   */
  homes?: { op: Id; decision: Id; options: { class: Id; seff?: Id; seffs?: Id[] }[]; written: Id; today?: Id; neutral?: Id; monolith?: Id }[];
  /**
   * (1.11.0) the receiving envelopes (ReceivingEnvelope): per class component and callee service the envelope a
   * synchronous call across containers into one of `services` (signature names) pays there; `seff` its SEFF (kind envelope)
   */
  envelopes?: ModelEnvelope[];
  /** the decision layer's parameters (cost model, reliability, middleware costs, mechanism options, ...) */
  parameters: ModelParameter[];
  /**
   * (1.13.0) the case's texts of the consistency levels and of the rule ids the reads' and calls'
   * `rules` name (e.g. S2: "invariant guard not re-checked …"), and where they are curated
   */
  consistency?: { levels: Partial<Record<ConsistencyLevel, string>>; rules: Record<string, string>; source?: string };
  metamodels: Metamodel[];
  /** inconsistencies the exporter noticed in its inputs */
  notes?: string[];
}

/**
 * (1.1.0) the timing source of a model family (the case's timing campaign): `campaign-v3` the timing campaign's parts of
 * schema version 3 (own CPU by counters, database CPU and mapping CPU per access, × k_c of today's container, with the request
 * overhead and the measured envelope).
 */
export interface ModelTiming {
  /** (1.4.0) the effect steps' envelope: `measured-v3` the parts' measured `envelope` */
  envelope?: { source: 'measured-v3'; file: string; note: string };
  source: 'campaign-v3';
  /** e.g. "campaign v3, k_c applied" */
  label: string;
  /** the demands carry the at-load factor k_c of the container that ran them today */
  kApplied: boolean;
  /** the mapping CPU's share of the application CPU, weighted by the request rates (campaign only) */
  mapShare?: number;
  note?: string;
}

export interface ModelOrigin {
  step: string;
  path: string;
  what: string;
  /** the documentation section that describes it */
  design?: string;
}

export interface ModelClass {
  id: Id;
  /** today's service (package A) */
  service: string;
  table?: string;
  storage?: string;
  attributes: string[];
  rowBytes?: number;
  /** path:line of its table in the system's repository */
  evidence?: string;
  note?: string;
  /** the PCM assemblies of the class component and of its schema */
  component?: string;
  schema?: string;
  /** the seeds' placement: the class component's container and the schema's database server */
  placement?: Record<string, { container: string; server: string }>;
}

export interface ModelReference {
  id: Id;
  from: Id;
  to: Id;
  name: string;
  kind: 'composition' | 'association';
  /** upper bound of the target end: 1 or -1 (many) */
  upper: number;
  snapshot: boolean;
  /** fk, join table, id array, ... (package A) */
  storage?: string;
  /** (1.6.0) held in a join table of its own: its links are the source's data, not its rows */
  table?: boolean;
  /** (1.6.0) the other end's field (Category.products for Product.categories) */
  inverse?: string;
  crossServiceToday?: boolean;
  evidence?: string;
}

export type ModelOperationKind = 'query' | 'mutation' | 'resolver' | 'reaction' | 'callback' | 'job';

export interface ModelAccess {
  class: Id;
  mode: AccessMode;
  /** ONE, OPTIONAL, LIST, BATCH, PER_ITEM (A7) */
  shape: string;
  /** statements per execution (expected) */
  count: number;
  rows: number;
  /**
   * (1.13.0) reads: the model's Access.level (the strictest of the statements it stands for; the derivation
   * decides its mechanisms by it), with the curated rules and reasons of its statements at that level (none for a read
   * that is not strong: stale-ok without a rule); writes: none
   */
  level?: ConsistencyLevel;
  rules?: string[];
  reason?: string;
  /** (1.13.0) one of its statements only locks the class (a strict read: the lock is taken on the current row) */
  lock?: boolean;
  /** the older spelling of `level`: the extraction's flag that the read decides a write or check (read by `levelOf`) */
  strong?: boolean;
  /**
   * mapping CPU (app-side persistence) per execution, ms; 0 under the seed's timings. For another class an
   * InternalAction `map` in that class's access SEFF, for the home class's own data part of the operation's `work`
   */
  cpuMs: number;
  /** database time per execution, ms (the campaign's database CPU, or the seed's timings split) */
  dbMs: number;
  /** the home class's own data (a call into its schema) or another class (through that class's component) */
  local: boolean;
  /** how today's code reaches it (local, copy, call, payload) */
  today?: string[];
  /**
   * the reference it reads or writes (its id, e.g. Product.categories); (1.6.0) every access of an
   * association has one: with `class` the reference's source and the reference in a join table, the access touches only
   * the links, not the class's rows. An operation has one access per class, mode and reference; the SEFF's call per
   * class and mode is shared by them
   */
  via?: Id;
}

export interface ModelOperation {
  id: Id;
  name: string;
  /** today's service */
  service: string;
  kind: ModelOperationKind;
  /** domain.mm's kind: QUERY, COMMAND, REACTION */
  modelKind: string;
  /** GraphQL field, topic or HTTP route */
  trigger?: string;
  /** path:line of its entry point in the system's repository */
  entry?: string;
  feature?: Id;
  /** its home class: it runs in this class's component, so in the service the cut puts the class in */
  homeClass: Id;
  /** own work, ms (the campaign: own CPU × k_c, without the mapping; else the seed's timings) */
  cpuMs: number;
  /**
   * (1.11.0) the part of cpuMs that is the callee's receiving envelope of today's invocation across services
   * (measured inside it): its SEFFs' work is cpuMs - envelopeMs; the envelope block pays it where the call has its hop
   */
  envelopeMs?: number;
  /**
   * (1.1.0) mapping CPU of the home class's own accesses per execution, ms (Σ of their Access.cpuMs): the model folds it
   * into the SEFF's `work` action (work = cpuMs + mapCpuMs); the export shows it as a part `map` (split)
   */
  mapCpuMs?: number;
  accesses: ModelAccess[];
  calls: ModelCall[];
  /**
   * (1.13.0) its effect calls: a change outside the system (a registration with an external provider,
   * `to` the provider's endpoint), which reads nothing: sync only, never cached or copied (rule E1); the provider's
   * callback is a call site of its own (kind callback)
   */
  effectCalls?: { to: string; rules: string[]; reason?: string }[];
  raises: { event: Id; probability: number }[];
  /** the event it reacts to */
  reactsTo?: Id;
  bindings: Id[];
  /** process (saga) it belongs to, with its role */
  process?: { id: Id; role: 'trigger' | 'step' | 'compensation' };
  /** its SEFFs: its own, and one per request type whose root resolver it is */
  seffs: Id[];
  /** per request type: executions per request (through plans, calls and events) */
  reach: { request: Id; visits: number }[];
  /** executions per second at the design load */
  rate: number;
  note?: string;
}

/** a call of another operation's logic */
export interface ModelCall {
  callee: Id;
  count: number;
  /**
   * (1.13.0) the model's Call.level: strict is sync only (no call site, nor its nested fields'
   * calls), stale-ok a call site sync / cache; with the curated rules and reason
   */
  level?: ConsistencyLevel;
  rules?: string[];
  reason?: string;
  /**
   * (1.13.0) a field resolved on this operation's objects in that operation's invocation (one invocation into
   * nested fields): its level, rules and reason are that call's
   */
  nestedIn?: Id;
  /** the older spelling of `level` (strong: sync only), read by `levelOf` */
  strong?: boolean;
}

export interface ModelEvent {
  id: Id;
  name: string;
  payload: Id[];
  publishers: Id[];
  reactions: Id[];
}

export interface ModelBinding {
  id: Id;
  kind: 'JOIN' | 'TRANSACTION' | 'COMPOSITION';
  classes: Id[];
  operations: Id[];
}

export interface ModelProcess {
  id: Id;
  trigger: Id;
  steps: Id[];
  compensations: Id[];
  /** the Workflow decision: allowed coordination styles and the seeds' choices */
  styles: string[];
  today?: string;
  neutral?: string;
  /** (1.3.0) the layer-2 Workflow: `saga_<Process>`, or `tx_<SEFF>` (= id) for a transaction workflow */
  workflow?: Id;
  /**
   * (1.3.0) a transaction workflow (`Workflow.transactional`; `steps` and `compensations` stay empty):
   * the trigger operation's SEFF (and its request), the steps as call sites (its transaction-bound writes) and their
   * classes. Co-located with the trigger a step is a local call in its transaction (orchestrated: no coordination, no
   * commit of its own); separated it commits on its own, orchestrated after the orchestrator's coordination
   */
  transaction?: { seff: Id; request?: Id; sites: Id[]; writes: Id[]; home?: HomeRef };
}

export interface ModelRequest {
  id: Id;
  /** msa's request name */
  msa?: string;
  document?: string;
  /**
   * the gateway plan: root resolver first, then the further fields (`via`: PlanVia, root, service, gateway; accepts the
   * older spelling `local`); (1.8.0) a tree in the document's order: `parent` is the index of the entry whose objects the
   * field is resolved on (0: the root's)
   */
  plan: { op: Id; via: string; parent?: number }[];
  /** requests per second at the design load */
  rate: number;
  /** (1.0.0) C1 per load profile: today's simulated statistic (the reference) and the budget (factor × it) */
  budgets?: { profile: string; statistic: string; referenceMs?: number; referenceCount?: number; budgetMs?: number }[];
  /** the gateway's SEFF for this request type */
  seff: Id;
  /**
   * sum of the demands one request makes (no middleware, no queueing), ms of one full core; (1.1.0) `map` the mapping
   * CPU within `app`, `wait` the latency-only waits (DELAY demands; not CPU, in none of the others); (1.4.0) as the neutral seed realises it: a joined effect step without its envelope and commit
   */
  work: { gateway: number; app: number; db: number; map?: number; wait?: number };
}

/** (1.0.0) a model variant's load profile (architecture.mm LoadProfile with its LoadSteps, C's phases) */
export interface ModelProfile {
  id: string;
  /** the realised model it was read from */
  model: string;
  warmUpS: number;
  endS: number;
  seed?: number;
  usageStreams?: boolean;
  maxPods?: number;
  /** C's description of the profile */
  about?: string;
  phases: { name: string; fromS: number; volume?: number; mix?: string }[];
  /** per session type (null: every scenario) from `timeS` on its arrival rate is `factor` × the model's */
  steps: { session: Id | null; timeS: number; factor: number }[];
  /** the model's arrival rate per session type, sessions/s */
  baseRates: Record<Id, number>;
  /** C1's policy in this model (LatencyBudgetPolicy; absent: the p95 against OperationLatencyBudget.ms) */
  latency: { statistic: string; factor?: number; minCompletions?: number };
}

export interface ModelSession {
  id: Id;
  name: string;
  description?: string;
  share: number;
  sessionsPerS: number;
  thinkTimeS: number;
  /** expected visits per session per request type */
  visits: { request: Id; visits: number }[];
}

/** one part of a SEFF: own work (an InternalAction's demand) or a call (with its multiplicity) */
export interface SeffPart {
  t: 'work' | 'call';
  /** the action's entity name (work, sql, readOrder, eventX, fieldX, root, db, ...) */
  name: string;
  /** work: mean demand, ms of one full core (a DELAY: ms of waiting) */
  ms?: number;
  resource?: string;
  /**
   * call: db (own schema), access (another class's component), call, event, callback, field, root; (1.4.0) work and
   * commit: a step form's call into the step's work and into its commit
   */
  kind?: 'db' | 'access' | 'call' | 'event' | 'callback' | 'field' | 'root' | 'work' | 'commit' | 'other';
  /** call: the callee SEFF */
  to?: Id;
  /** expected executions per execution of the SEFF (branch probability, loop count) */
  p?: number;
  /** inside an asynchronous fork (the neutral seed's provider callbacks) */
  async?: boolean;
  /** the call site deciding its mechanism */
  site?: Id;
  /** (1.1.0) work split by the exporter from the action's demand (the home class's mapping CPU out of `work`), not an action of its own */
  split?: boolean;
  /**
   * (1.4.0) a step form's envelope whose value is an estimate (the model's ReceivingEnvelope.estimate);
   * (1.11.0) on a call part with `envelopeMs`: that value is an estimate
   */
  estimate?: boolean;
  /**
   * (1.11.0) call: a call into an operation of a ReceivingEnvelope: the callee's receiving envelope (ms CPU, k_c
   * applied) that the call pays in the callee's container when it crosses containers synchronously (with its hop); none within a
   * container. The callee's work in the base model is without it.
   */
  envelopeMs?: number;
}

export interface ModelSeff {
  id: Id;
  /** the PCM component (a class, `<Class>Db`, Gateway, ...) */
  component: string;
  signature: string;
  /**
   * (1.1.0) cache: a provider's cache as built (CallSite.cachedService), reached only when a design uses it;
   * (1.4.0) step: an effect step's step form `I<B>.<x>_step` (envelope, the work, the commit), commit: its
   * commit `<B>Db.<x>_commit` (the commit wait); (1.7.0) fetch: a federation fetch (CallSite.fetchService), the
   * subgraph's glue resolver's work and then the field, reached only when a design composes the field across containers;
   * (1.11.0) envelope: a component's receiving envelope (ReceivingEnvelope.envelope), called by the realisation after a
   * synchronous call with its hop
   */
  kind: 'gateway' | 'request' | 'operation' | 'access' | 'db' | 'cache' | 'step' | 'commit' | 'fetch' | 'envelope' | 'other';
  op?: Id;
  request?: Id;
  class?: Id;
  parts: SeffPart[];
  /** (1.4.0) the SEFF of a home option (`<Cls>_req<Request>`): the operation, the candidate class, whether it is the written (today's) one */
  home?: HomeRef;
}

/** (1.11.0) a receiving envelope: what `service`'s application spends on a synchronous request it receives across containers */
export interface ModelEnvelope {
  id: Id;
  /** the class component it runs in */
  component: string;
  service?: string;
  ms: number;
  estimate: boolean;
  seff?: Id;
  /** the signatures (entity names) whose synchronous calls across containers pay it */
  services: string[];
}

/** (1.4.0) a home option of an operation; its SEFF and its sites are inert while another option is chosen */
export interface HomeRef { op: Id; class: Id; written: boolean }

/** (1.5.0) a file the input model was exported from */
export interface ModelInput {
  label: string; path: string; note?: string; hash?: string;
  /** a seed: its fingerprint as model data (contract/hash.ts modelFingerprint), to match runs made from it */
  fingerprint?: string;
  /** a realised seed: the model it was realised from, and what that model was generated from (`// Input:` lines); hashes may be prefixes */
  source?: { path: string; hash: string };
  generatedFrom?: { path: string; hash: string }[];
}

/**
 * (1.5.0) the input model against its inputs now: `current` every input as exported; `updating` an input changed and
 * the backend exports again (ask again shortly); `failed` that export failed (`error`). `unrealised`: realised seeds
 * older than the model they were realised from (core/tools/realise-seeds.sh realises them again); `ungenerated`: the
 * models older than what core/generator/derive.py generated them from (the generator, the extraction, the workload, the
 * timings: generate them again, then realise).
 */
export interface ModelFreshness {
  /** (1.10.0) `stale`: an input changed and the backend may not rebuild the packet (its local configuration allows no `rebuild`) */
  state: 'current' | 'updating' | 'failed' | 'stale';
  changed: string[];
  unrealised: { seed: string; source: string }[];
  ungenerated: { model: string; inputs: string[] }[];
  error?: string;
}

export interface ModelSite {
  id: Id;
  /** the operation whose SEFF makes the call, and the request for a request's SEFF */
  op?: Id;
  request?: Id;
  /** the call's kind (as SeffPart.kind) and target: a class (accesses) or an operation */
  kind: string;
  class?: Id;
  callee?: Id;
  mode?: AccessMode;
  /** allowed mechanisms: sync, async, cache, copy, join, joinCache */
  allowed: string[];
  neutral?: string;
  today?: string;
  monolith?: string;
  writes?: boolean;
  /** (0.4.0) event sites: the domain event the caller raises, whose reaction `callee` is (one site per raise and reaction) */
  event?: Id;
  /**
   * (0.4.0) field sites: today's gateway plan entry of the field (PlanVia: `service` the service that resolves its
   * parent resolves it, `gateway` a federation fetch; accepts the older spelling `local`)
   */
  planVia?: string;
  /**
   * (0.4.0) sites that allow a LocalCopy: who feeds the copy (the copy sync's CopyFeed.writers, as the operations whose writes
   * they are, with the request for a request's SEFF); no writers: the copy comes with the saga message (event-carried)
   */
  copyFeed?: { writers: { op: Id; request?: Id }[] };
  /** (1.4.0) a site in a home option's SEFF: inert (no objective changes) while another option is chosen */
  home?: HomeRef;
  /** (1.1.0) the site's own cache hit ratio (TTL-60 s cache over its key stream); replaces the mechanism's */
  hitRatio?: number;
  /** (1.1.0) the share of its hits whose key was written after the entry was stored; O4 uses it instead of min(1, w·TTL) */
  staleShare?: number;
  /** (1.1.0) the provider's cached operation (CallSite.cachedService): joinCache is the provider's entity cache */
  cachedService?: string;
  /** (1.1.0) its SEFF (kind cache): hit = the provider's hit CPU, miss = the call's own operation */
  cachedSeff?: Id;
  /**
   * (1.7.0) the provider's federation fetch (CallSite.fetchService): across containers the gateway's join calls it
   * instead of the field (the subgraph finds the entity it contributes the field to: its `_entities` glue resolver's work)
   */
  fetchService?: string;
  /** (1.7.0) its SEFF (kind fetch) */
  fetchSeff?: Id;
  /**
   * (1.2.0) what the interaction is for: `fetch` gets data of another class, the caller needs the answer
   * (reads of another class, request fields; 1.13.0: calls of another operation with a site); `effect` runs a step
   * of the work in another class, the caller does not
   * (writes of another class, process events, provider callbacks)
   */
  family?: 'fetch' | 'effect';
  /** (1.2.0) effect sites: the attributes the allowed mechanisms and today's follow from */
  effect?: SiteEffect;
  /**
   * (1.2.0) sites that allow a LocalCopy: the topics of package A (domain/REPORT.md §5) that feed the reader's copy today
   * (`today`), else the topics that carry the class (what would feed a copy)
   */
  copyTopics?: { topic: Id; role: TopicRole; today: boolean }[];
}

/** (1.2.0) an effect site's attributes (docs/model.md, Call sites) */
export interface SiteEffect {
  /** a write in the operation's transaction with its home class: a saga step when the cut separates them */
  bound: boolean;
  /** expected executions per execution of the caller (a raise's outcome probability; 1 for writes) */
  p: number;
  /** what follows on the other side: the reaction's own call sites and the events it raises (none for a write) */
  cascades?: { sites: number; raises: Id[] };
  /** the trigger is outside the system (a provider's callback): async only */
  external: boolean;
  /**
   * (1.4.0) the step as built: the step form's SEFF (envelope, work, commit; what the call reaches unless it
   * joins), the work's SEFF (what a joined call reaches), the commit's SEFF, the envelope's CPU per execution (ms, its
   * container's base rate) and whether that value is an estimate; the schemas that must share a database server
   */
  step?: { seff: Id; work: Id; commit?: Id; envelopeMs: number; commitMs?: number; estimate: boolean; callerSchema?: Id; providerSchema?: Id; callerClass?: Id; providerClass?: Id };
  /** (1.4.0) whether the step joins its caller's transaction in the seeds, and else why not */
  joined?: Partial<Record<'today' | 'neutral' | 'monolith', true | JoinBlocker>>;
}

/** (1.2.0) the role of a topic in package A (domain/REPORT.md §5) */
export type TopicRole = 'replication' | 'process' | 'mixed' | 'unsubscribed';

/** (1.2.0) a topic of package A: replication topics feed copies (part of fetch), process topics are effects */
export interface ModelTopic {
  id: Id;
  role: TopicRole;
  publishers: Id[];
  payload: Id[];
  /** `copy`: the subscriber only maintains a copy (not an operation of the model, A2) */
  subscribers: { op: Id; service: string; copy: boolean }[];
}

export interface ModelParameter {
  /** the metamodel class (Reliability, CostModel, CachedCall, ...) */
  class: string;
  name: string;
  properties: Record<string, string | number | boolean | null>;
  /** links to other objects (names), e.g. a ContainerPrice's containers */
  links?: Record<string, string[]>;
}

export interface Metamodel {
  /** domain, architecture, palladio (the microservices layer is part of architecture) */
  id: Id;
  title: string;
  /** layer 1, layer 2, ... */
  layer: string;
  /** repo paths of the parsed files */
  files: string[];
  description: string;
  imports: Id[];
  enums: MmEnum[];
  classes: MmClass[];
  references: MmReference[];
  views: MmView[];
  sections: string[];
}

export interface MmEnum { name: string; literals: string[]; doc?: string; section?: string }

export interface MmAttribute { name: string; type: string; multiplicity: string; doc?: string }

export interface MmClass {
  name: string;
  abstract: boolean;
  supers: string[];
  attributes: MmAttribute[];
  doc?: string;
  section?: string;
  /** instances of the class or its subclasses in today's realised seed model */
  used?: number;
}

export interface MmReference {
  source: string;
  name: string;
  multiplicity: string;
  kind: 'containment' | 'reference' | 'bidirectional';
  target: string;
  opposite?: string;
  oppositeMultiplicity?: string;
  doc?: string;
  section?: string;
}

export interface MmView { name: string; classes: string[] }
