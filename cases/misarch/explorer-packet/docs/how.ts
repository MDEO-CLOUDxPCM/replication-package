/**
 * The MiSArch packet's How tab (the Model panel's overview, web/src/model/HowTab.tsx): the pipeline from misarch-kotlin
 * to a simulated design, how each decision becomes PCM, the parameter groups. Doc `how`.
 *
 * Templates (lib/packet.tsx renderTemplate): the How tab computes the flags and variables from the input model —
 *   realise rows:  latency, networkMs, homes, steps, tx, readCpu, siteHits, asBuilt (flags); a row whose decision
 *                  renders empty is left out
 *   decides:       classes, byKind, steps (flag), effectSteps, sagaList, txs, txStyles, txToday, txList, homes,
 *                  homeOptions; an item that renders empty is left out
 * Inline markup (model/text.tsx MText): `code`, **bold**, [label](model target).
 */

export interface HowDoc {
  /** the pipeline: one card per step; `origin` names the step of the input model's origin table whose files it shows */
  steps: { title: string; ref?: string; origin: string; text: string; links?: [string, string][] }[];
  /** "What a design decides": the list items */
  decides: string[];
  /** "How the decisions become PCM": [decision, realised as, parameters] */
  realise: { ref?: string; rows: [string, string, string][] };
  /** "Parameters of the decision layer": groups of the parameter classes */
  paramGroups: { title: string; classes: string[]; note: string }[];
}

const how: HowDoc = {
  steps: [
    { title: '1 · Extraction', ref: 'docs/model.md §3', origin: 'Extraction', text: 'misarch-kotlin\'s code, schemas and GraphQL subgraphs (pinned commit) plus curated facts become the domain: 31 persisted classes, their references, the operations with what they read and write (shape, statement count; for a read that decides a write or check its curated consistency level: strict, stale-ok or immutable), calls, domain events, transactions and joins, every fact with its path:line.', links: [['the domain model', 'domain'], ['the operations', 'ops']] },
    { title: '2 · Workload', ref: 'cases/misarch/workload/WORKLOAD.md', origin: 'Workload', text: 'Gatling\'s scenarios and round 2\'s measurements become five session classes (open arrivals, think times, branches and loops) over 35 request types; a request type is a GraphQL document whose gateway plan runs a root resolver and further fields. A load profile (the compressed day) varies volume and mix per session class over time.', links: [['request types, sessions, load profiles', 'workload']] },
    { title: '3 · Derivation', ref: 'docs/model.md §3', origin: 'Derivation', text: 'core/generator/derive.py turns domain + workload into the optimisation model: one PCM component per class (its operations\' SEFFs) and one per schema (`<Class>Db`); a SEFF per operation from timed parts (own work, one call per accessed class and mode, calls, fields, events); a call site wherever a mechanism may vary; a container per class and a database server per class to place them on; the quality model (cost, reliability, coupling, consistency, budgets), the HPA of every application container and the load profile with its window. The domain stays in the model as a trace (domain.mm).', links: [['domain.mm', 'mm:domain'], ['architecture.mm', 'mm:architecture']] },
    { title: '4 · Search', ref: 'docs/search.md', origin: 'Optimisation', text: 'NSGA-II changes only decision links: which container a class component or schema is allocated to (moves of classes, groups, whole units), which allowed mechanism a call site uses, whether a saga is choreographed or orchestrated. A design is the seed plus these links.', links: [['decision parameters', 'param:RemoteCalls']] },
    { title: '5 · Realisation', ref: 'docs/model.md §5–§7', origin: 'Realisation', text: 'After every change, model transformations rewrite the PCM in place so that it means the decisions: middleware blocks for remote calls (sidecars), asynchronous forks, cache branches, gateway joins, copy stores fed by notifications (the copy sync), orchestrations. The realised model is plain PCM; a trace records what was made.', links: [['the realisation trace', 'mm:architecture'], ['local copies', 'mm:architecture']] },
    { title: '6 · Simulation', ref: 'docs/quality.md, Simulation of a design', origin: 'Simulation', text: 'The Palladio plugin\'s `pcmEvaluate` simulates the realised PCM (SimOxide, Palladio semantics) under the model\'s load profile, `LoadProfile.replications` times with seeds seed, seed + 1, …: every application container and the gateway is a scaling group of SimOxide\'s HPA (Kubernetes\' controller), usage streams make designs see the same users. It returns what it measured in the window: response times per request type and session, utilisation and pods per time bin, call counts, the containers on each session\'s synchronous path. A failed simulation, or one stopped at the pod or event limit, makes the design infeasible.', links: [['PCM', 'mm:palladio'], ['load profiles', 'workload']] },
    { title: '7 · Objectives', ref: 'docs/quality.md', origin: 'Evaluation', text: 'core/mdeo/transform/metrics.fn turns these simulations into the values. Minimised: O1 cost (prices × the pods the HPA ran), O2 failures (the failure sources over the measured synchronous paths), O5 slow requests (the share of requests over their latency budget; metrics.fn `performance`). Constraints: C1 latency budgets (the simulated statistic per request type against today\'s), C2 peak capacity (the busiest bin of databases and broker), C3 cohesion (every service and shared database server connected in the domain), C4 and C5 O3 change coupling (a query over calls and placement) and O4 inconsistency (over the simulated call counts) at most the model\'s bound × today\'s. Each value\'s ? explains its computation. The harness records every evaluated design; the explorer exports them and simulates an opened design again with the same request (Performance panel).' },
  ],
  decides: [
    'where each class component runs (an application container) and where each schema lives (a database server): {{classes}} + {{classes}} placements; the seeds: neutral (one container, one server), today (16 services), monolith;',
    'the mechanism of each call site: {{byKind}} (allowed options per site in the Operations tab){{#steps}}; the {{effectSteps}} effect steps (writes of another class, event reactions, callbacks) in the caller\'s transaction, as a synchronous step or an asynchronous message ([Interactions › Effect step](mech:effect)){{/steps}};',
    'the coordination of the sagas: {{sagaList}};',
    '{{#txs}}the coordination of the transaction workflows (an operation\'s transaction-bound writes as steps; {{txStyles}}, today {{txToday}}): {{txList}};{{/txs}}',
    '{{#homes}}the home of {{homes}} operations: where the request or the reaction enters, among the classes it writes in its transaction ({{homeOptions}} options; [Interactions › Home of an operation](mech:home));{{/homes}}',
    'pods are not searched: SimOxide\'s HPA scales every application container and the gateway over the load profile, and cost counts the pods it ran.',
  ],
  realise: {
    ref: 'docs/model.md §5',
    rows: [
      ['placement', 'AllocationContext of the class component / schema', 'PCM itself: the operators change `resourceContainer`'],
      ['a call between two containers', 'middleware blocks: send, transit, receive (sync); publish, broker, deliver (async)', 'RemoteCalls costs, on the containers\' sidecars; none into a database server (direct){{#latency}}; Latency.publishWaitMs as a DELAY of each publish{{/latency}}{{#networkMs}}; RemoteCalls.networkMs (ASSUMED, a literature value: one way between pods on different nodes of one zone, timing/LITERATURE-NETWORK.md) per message: transit latencyMs + 2 networkMs, publish wait + 2 networkMs; none within a container or on database accesses. Not modelled: the Dapr subscriber pool as a queue{{/networkMs}}'],
      ['{{#envelopes}}a synchronous call between two containers into a read, an operation or a request field{{/envelopes}}', 'after the call (and its hop) a call of the callee component\'s `envelope` operation through the call\'s own role (a MiddlewareBlock `envelope`, core/mdeo/transform/realise/blocks.mt `bv`): the callee application\'s receiving envelope (receiving and parsing the request, dispatch, decoding, the answer) in the callee\'s container, also after the gateway\'s fetch of a joined field; none within a container (the caller calls the work directly), none for a step form (its envelope is in it), a commit, a joined call or the gateway\'s call of a request\'s root', 'ReceivingEnvelope.cpuMs per callee service (timing/parts.json); the campaign measures the callee\'s work without it; taken out of a provider cache\'s measured hit'],
      ['{{#homes}}Home{{/homes}}', 'the operation\'s SEFFs on the chosen class (one set per candidate, from the same per-class parts); every call of the operation (the gateway\'s root call, a reaction\'s effect steps) re-targeted to it before its mechanism is realised (core/mdeo/transform/realise/homes.mt); the other candidates\' SEFFs are not reached', 'none of its own'],
      ['SyncCall', 'the call as modelled', ''],
      ['AsyncCall', 'an asynchronous fork around the call', 'the publish on the caller\'s path, the rest in the background'],
      ['{{#steps}}an effect step (write of another class, event reaction){{/steps}}', 'the call goes, as written, to B\'s step form `I<B>.<x>_step`: an InternalAction `envelope`, a direct call into B\'s work `I<B>.<x>`, a call into `<B>Db.<x>_commit` (none without a measured write); SyncCall waits for it, AsyncCall forks it', 'the envelope\'s CPU per step form (timing/parts.json; a reaction\'s is its handler\'s counter remainder on top of its work), Latency.commitDelayMs'],
      ['{{#steps}}InTransaction{{/steps}}', 'joined (shape `joined`, plan-placement.mt `pj`, build.mt `bj`): while caller and provider share a container and `callerSchema` and `providerSchema` one database server, and the call is no orchestrated workflow step, the call is re-pointed to `joinedService` (the work only: no envelope, no commit, no message); otherwise a synchronous step (shape plain). A move that breaks the condition repairs it (teardown-calls.mt `tj`, plan-moved.mt, mark-dirty.mt for schema moves)', 'none: the step\'s work joins the caller\'s commit'],
      ['CachedCall', 'a branch: hit = CPU on the caller, miss = the call', '{{#siteHits}}hitCpuMs; hitRatio per site (`CallSite.hitRatio`, below), else the mechanism\'s{{/siteHits}}{{^siteHits}}hitRatio, hitCpuMs{{/siteHits}}'],
      ['{{#asBuilt}}ComposedCall (join, joinCache){{/asBuilt}}', 'across containers the gateway fetches the field (federation); joinCache as built: the fetch goes through the middleware to the provider\'s cached operation (`CallSite.cachedService`), whose SEFF is a branch: a hit costs the provider hitCpuMs and no database, a miss missCpuMs and then the field\'s own operation. A field a subgraph contributes to another service\'s entity: the fetch goes to the provider\'s fetch operation (`CallSite.fetchService`), the subgraph\'s `_entities` resolver finding the entity (its measured CPU and statement), then the field; within one container nothing to find', 'composeCpuMs (kept on a hit, as the middleware is); joinCache: hitCpuMs, missCpuMs at the provider, the site\'s hit ratio'],
      ['{{^asBuilt}}ComposedCall (join){{/asBuilt}}', 'across containers the gateway fetches the field (federation)', 'composeCpuMs; with a cache: joinCache (hit = hitCpuMs on the gateway, no call)'],
      ['LocalCopy', 'the call re-pointed to a copy store with the reader; every write of the class notifies the copy', 'readDbMs{{#readCpu}}, readCpuMs (CPU of the reader per copy read){{/readCpu}}, writeCpuMs, writeDbMs; stale reads count in O4'],
      ['Workflow orchestrated', 'the steps move behind the trigger, coordinated by its component{{#tx}}; a transaction workflow\'s step is coordinated only while its provider sits in another container{{#steps}}; an orchestrated step is a saga step: its step form, never joined{{/steps}}{{^steps}}, co-located (no hop) it is a direct call in the trigger\'s transaction{{/steps}}{{/tx}}', 'stepCpuMs per step (an assumption, not measured: MiSArch has no orchestrator){{#tx}}; a transaction workflow\'s only across containers{{/tx}}'],
      ['Deployable + Autoscaling', 'cores and speed per pod; in the simulation a scaling group of SimOxide\'s HPA (SPD), starting at its initial pods', 'min, max, target utilisation, start-up; a sidecar gets the cores of maxReplicas pods (not scaled)'],
      ['{{#latency}}Latency (waits without CPU){{/latency}}', 'a `wait` DELAY in each database access SEFF (statements × stmtRoundTripMs + commits × commitDelayMs, on the server\'s DELAY resource); a DELAY of publishWaitMs in each middleware publish', 'response times only (O5, C1), no CPU'],
    ],
  },
  paramGroups: [
    { title: 'Cost (O1)', classes: ['CostModel', 'ContainerPrice', 'Autoscaling', 'Deployable'], note: 'cores per pod, prices, the HPA\'s limits and target' },
    { title: 'Failures and coupling (O2, O3)', classes: ['Reliability', 'ChangeUnit', 'ChangeCoupling'], note: 'one change unit per class (its component and schema), 26 releases a year' },
    { title: 'Consistency (O4) and mechanisms', classes: ['Consistency', 'SyncCall', 'AsyncCall', 'InTransaction', 'CachedCall', 'ComposedCall', 'LocalCopy', 'Choreographed', 'Orchestrated'], note: 'the options call sites and workflows can point to' },
    { title: 'Middleware, latency and capacity (C1, C2)', classes: ['RemoteCalls', 'Latency', 'LatencyBudgetPolicy', 'PeakCapacity', 'ArchitectureDecisions', 'ReplicaOption'], note: 'costs of a remote call; waits without CPU (Latency); C1\'s statistic and factor; the per-bin check of servers and broker' },
    { title: 'Load profile', classes: ['LoadProfile'], note: 'the simulation\'s window, seed, usage streams and pod limit (steps: Workload tab)' },
  ],
};

export const docs = { how };

/** the How tab's other texts (vars: commit, date; design; …) */
export const texts: Record<string, string> = {
  'model.how.title': 'How MiSArch becomes the optimisation\'s input, and how a design is built',
  'model.how.intro': 'MiSArch (16 Kotlin services) is not optimised as code: it is extracted into a domain model, a workload is laid over it, and both are derived into a Palladio model with decision layers. The search changes decisions only; transformations realise them in the PCM; every candidate is evaluated by one simulation (SimOxide, Palladio semantics) of that PCM, and metrics.fn turns what it measured into the objectives.',
  /** the cache section's right side when the sites have their own hit ratios */
  'model.how.cache.own': ' · per-site values',
  'model.how.cache.ownNote': 'Hit ratio: a TTL-60 s cache over the site\'s key stream in the session model (cases/misarch/generator/cache_hits.py); it replaces the mechanism\'s. Stale: the share of hits whose key was written after the entry was stored; O4 weighs the site\'s hits with it instead of min(1, w × TTL). As built: joinCache is the provider\'s entity cache behind its sidecar — the gateway still fetches (compose CPU, middleware), a hit saves only the provider\'s work (Interactions tab, Field of a request).',
  /** an origin row's documentation reference (vars: design) */
  'model.how.originRef': ' ({{design}})',
  /** vars: commit (12 characters), date */
  'model.how.exported': '{{#commit}}Extraction pinned at misarch-kotlin `{{commit}}`; this{{/commit}}{{^commit}}This{{/commit}} input model was exported {{date}} from:',
};
