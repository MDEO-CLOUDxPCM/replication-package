# The optimisation model

One model file holds a whole design: the domain of the system, the architecture decisions, and the plain PCM that
realises those decisions. The search changes decisions only; model transformations realise them in PCM inside the
same model after every operator; SimOxide simulates the PCM ([quality.md](quality.md)). This file describes the
layers, what a design decides, how the models are derived from the case, and how the realisation is kept
consistent. [search.md](search.md) describes the operators and the two runs.

File names use `today` for the as-built cut of MiSArch (the paper's *as-built* design) and `perclass` for one
service per class (the paper's *per-class* design).

## 1. Layers

| layer | metamodel | contents |
| --- | --- | --- |
| 1 | `core/mdeo/metamodel/palladio.mm` (+ `pcm/repository.mm`) | Plain PCM 5.2, the subset SimOxide reads (generated from the PCM Ecore metamodel by `palladio-sim-service gen-metamodel`). The base PCM written by the derivation, edited in place by the realisation, plus the PCM the realisation derives. |
| 2 | `core/mdeo/metamodel/architecture.mm` | The architecture decisions and their fixed option objects: `Placement`, `CallSite` with `Mechanism`s, `Home` with `HomeOption`s, `Workflow` with `Coordination`s, `Deployable` with `Autoscaling`. The platform's parameters (`RemoteCalls`, `ReceivingEnvelope`, `Latency`), hints for the group operators (`UnitGroup`, `Coupling`), the quality model (`LoadProfile`, `CostModel`, `Reliability`, `ChangeUnit`, `ChangeCoupling`, `Consistency`, `OperationLatencyBudget`, `LatencyBudgetPolicy`, `PeakCapacity`, `ObjectiveBound`) and the realisation trace. |
| 3 | `core/mdeo/metamodel/architecture.mm` (section "Local copies") | Local copies: the `LocalCopy` mechanism, `CopyFeed` (which writes feed the copy a site reads, and where it is stored), `CopyStore`, and the completions the copy sync maintains (`Colocation`, `Redirect`, `Notification`, `Delivery`). |
| domain | `core/mdeo/metamodel/domain.mm` | What the system does, independent of any cut: `DomainClass`es and `Reference`s, `Operation`s (query, command, reaction) with their `Access`es (mode, shape, consistency level), `Call`s, `DomainEvent`s and `Raise`s, `Process`es (sagas, with a business criticality), `Feature`s and `Binding`s (classes tied by a transaction, a cross-class statement or a composition). Plus the derivation trace from classes, operations and accesses to the PCM elements and call sites that realise them. Imports `architecture.mm`, which imports `palladio.mm`; the models are instances of `domain.mm`. |

Rules that hold for every model:

- Decisions only point at PCM elements; they never change PCM classes.
- Option objects (the seven mechanisms `sync`, `async`, `inTx`, `cache`, `join`, `joinCache`, `copy`; the styles
  `choreography` and `orchestration`; the `HomeOption`s) are fixed. An operator re-points a decision to another
  allowed option; it never creates or edits behaviour.
- Placement needs no realisation: the allocation is PCM and the operators change it directly. Everything else is
  realised by `core/mdeo/transform/realise.mt` (section 5).

## 2. What a design decides

The derivation turns every domain class into one **class component** (the SEFFs of the operations whose home it
is) and one **schema component** (`<Class>Db`). Only a class's own component calls its schema, so no service reads
another service's schema by construction. A design is:

- **The partition of the classes into services.** Each class component sits in one application container of the
  pool: `<Class>Service` per class plus `MonolithService` (`Placement.candidates`: all of them). A service is the
  set of classes in one container, so a design ranges from one service to one per class. The containers in use
  are those that hold a component.
- **The database placement.** Each schema component sits on one database server of the pool: `<Class>Database`
  per class plus `SharedDatabase`.
- **The mechanism of every call site** among the options its data allows (table below).
- **The home of every operation with a choice** (`Home`).
- **The coordination style of every workflow** (`Workflow.style`: choreography or orchestration).

Fixed, not decided: the gateway (`GatewayServer`), the broker (`BrokerServer`) and the identity provider
(`KeycloakServer`), named by the case's adapter. Autoscaling is not a decision either: every application container
and the gateway are scaled by the same simulated Kubernetes HPA (target CPU utilisation 0.7, 2 to 50 pods, 2 at
the start, a new pod ready after 30 s; `Autoscaling` in the model). Database servers do not scale; cost provisions
them for their busiest bin ([quality.md](quality.md#o1-cost)).

### Call sites and their mechanisms

Every call that may cross a container boundary and allows more than a synchronous call is a `CallSite` with its
allowed and its current mechanism (`core/generator/derive.py`, function `generate`). The allowed options follow
from the data, so no design weakens what the data needs:

| call | allowed mechanisms |
| --- | --- |
| read of another class, consistency level `strict` | sync only (no site) |
| read of another class, `stale-ok` or `immutable` | sync, cache, local copy (`immutable`: a stale answer cannot be wrong; C5 counts no staleness for it) |
| read at an alternative home (not the default) | sync, cache (no copy: a copy of a home not chosen would still be maintained) |
| write of another class (an effect step) | sync step, async step, in the caller's transaction |
| reaction to a domain event (an effect step) | async step, sync step, and in the caller's transaction when the reaction lives on another class |
| callback of an external provider | async only |
| call of another operation, `stale-ok` | sync, cache (strict calls and effect calls: sync only, no site) |
| field of a request (resolved after its entry point) | sync (resolved by the entry point), gateway join, cache at the caller, gateway join with the provider's entity cache (`joinCache`) |
| request field at an alternative home | sync, cache (no gateway join) |

What the mechanisms mean:

- **Sync**: the caller waits; across containers the call pays middleware ([section 5](#5-realisation)).
- **Async**: fire and forget through the broker, in an asynchronous fork.
- **In transaction** (`InTransaction`): while caller and callee share a container and their schemas a database
  server, the callee's work runs inside the caller's transaction (no envelope, no commit of its own); otherwise it
  is a synchronous step.
- **Effect step forms.** A sync or async effect step goes to the callee's *step form*: its receiving envelope, its
  work and its own commit.
- **Cache** (`CachedCall`): a probabilistic branch: hit = CPU on the caller, miss = the call. The hit ratio and the
  share of stale hits are per site (`CallSite.hitRatio`, `staleShare`), from replaying the workload's key streams
  through a 60-s TTL cache (`cases/misarch/generator/cache_hits.py`, Zipf popularity of products).
- **Gateway join** (`ComposedCall`): across containers the gateway makes the call right after its call into the
  caller's operation and spends its compose CPU, so the caller no longer waits; within one container the caller
  resolves the field itself. Across containers the provider pays its federation fetch (the glue that finds the
  entity the gateway hands it, `CallSite.fetchService`). `joinCache` is the join with the provider-side entity
  cache MiSArch has built (`CallSite.cachedService`): a hit saves only the provider's work.
- **Local copy** (`LocalCopy`): the read is redirected to a copy store of the reader, fed by events from the writes
  of the copied data (section 6). A copy read across containers may be stale.

**Rationale.** Bindings (transactions, joined statements, compositions) are priced, not forbidden: separating two
classes bound by a transaction turns its writes into saga steps; separating a joined statement costs a second
query and an application-side join.

### Homes

An operation's SEFF lies on its **default home**, a class chosen from the domain model alone
(`Domain.home` in `core/generator/derive.py`): the first class it writes; else the class it reads most (statements
per execution; ties: the strictest consistency level, then the class whose rows hold the reference it navigates,
then the first listed); its own columns in another class's copy table do not count (they are its home's). A
resolver without accesses takes the home of its neighbour in the invocation (the field it is resolved on, else its
first field); else its trigger's type. Under the as-built placement every operation the workload reaches lies in
its as-built service.

An operation that writes several classes in one transaction has a `Home` decision: each class it writes in that
transaction is a `HomeOption`, with its own SEFFs built from the same parts. The realisation re-targets every call
into the operation (the gateway's root call, event steps, other operations' calls) to the chosen option before it
realises the call's mechanism, so home and mechanism are independent. The SEFFs of options not chosen are never
reached; the metrics skip them (`inactiveSeffs` in `metrics.fn`).

### Workflows

There is one saga notion. Each saga of the domain (MiSArch: Buy, Return, Registration) is a `Workflow` whose steps
are the event calls into its step reactions. Each operation's writes that a transaction binds to its home class
are the steps of a workflow too (`tx_<SEFF>`, `Workflow.transactional`): co-located they stay one transaction, and
separated each is a saga step that commits on its own. Every workflow allows choreography (each component makes its
own steps, the model as written) and orchestration (the trigger's component makes every step at the end of its
SEFF, with the orchestrator's step CPU; an asynchronous step is a request and a reply through the broker; the whole
orchestration runs in the background when its first step is an asynchronous call to another container).

## 3. Deriving the models from the case

The inputs a case provides are specified in [case-interface.md](case-interface.md); for MiSArch they are
named in `cases/misarch/case.json`.

1. **Domain model.** `cases/misarch/extract/build.py` reads misarch-kotlin's `main` through git (migrations,
   GraphQL SDL and federation, persistence code and its SQL, event subscriptions, a call-graph reachability) and
   the curated facts `cases/misarch/extract/curated/*.yaml`, which name their code by anchors that must resolve on
   the recorded commit, and writes `cases/misarch/domain/misarch-domain.json` (format
   `core/generator/schema/domain.schema.json`; report `cases/misarch/domain/REPORT.md`). An own table gives a class,
   a join table a reference; local copies of foreign data are mechanisms, not classes, and the columns a service
   keeps of its own in a copy table are its own data. Entity resolvers that only find the entity the gateway hands
   them are federation glue (the cost of the gateway's fetch), not operations. Handlers that only maintain a copy
   are the as-built realisation of a copy. Every strict, stale-ok or immutable level of a read or call is curated
   with a reason. The as-built facts (owner services, copies, gateway joins, request plans) are recorded beside the
   domain, not in it; the derivation reads them for the as-built start and the request types.
2. **Workload.** `cases/misarch/workload/sessions.json` (described in `cases/misarch/workload/WORKLOAD.md`) is a
   partly-open session model: session classes arrive as Poisson streams; within a session, requests follow with
   think times, fragments, loops and branches. `core/generator/sessions.py` interprets it, with MiSArch's
   calibration `cases/misarch/generator/gen_sessions.py` (design load, the admin class, the login). Its `day` profile
   (a compressed day: night, morning ramp, midday with a short burst, a sale with the ordering mix, evening peak,
   decline; 1320 s, the first 120 s not measured) becomes the model's `LoadProfile` with one `LoadStep` per session
   class and phase.
3. **Timing parts.** Every SEFF is assembled from timed parts that move with the classes: an operation's own CPU,
   per accessed class the mapping CPU and database time, and the middleware of each remote interaction.
   `cases/misarch/timing/parts.json` (written by `cases/misarch/timing/analysis/parts.py` from the timing campaign,
   `cases/misarch/timing/README.md`) holds the parts per execution of each operation, the at-load scale k_c per
   container, the order path's cardinality terms, the request overhead, the receiving envelopes and the mechanism
   parameters. An operation measured in several request types has one SEFF, with its values weighted by executions
   × request rates. `cases/misarch/timing/latency_fit.json` holds the waits without CPU (statement round trip,
   commit delay, publish wait), which enter the SEFFs as DELAY demands on the database server or the publisher's
   path. `cases/misarch/generator/platform.json` (from `cases/misarch/generator/platform.py`) holds the platform's
   parameters: sidecar, gateway and broker costs, copy and cache costs, cores per pod and per database server,
   cost rules. An operation without parts gets the seed demand of the domain's `msaMapping`.
4. **Derivation.** `core/generator/derive.py` with MiSArch's adapter `cases/misarch/generator/misarch.py` (gateway,
   broker, Keycloak, federation and login rules, business criticality per saga, releases a year, cache TTL; see
   [case-interface.md](case-interface.md#the-adapter)) writes `cases/misarch/mdeo/models/domain-{today,neutral,monolith}.m`:
   - base PCM: one class and one schema component per class, the gateway with one SEFF per request type, the
     broker, Keycloak, the container pool, the usage model;
   - per operation and home option a SEFF: own work, per accessed class one call (into its own schema, or into
     the other class's access operation and from there into its schema), then one call per invocation of another
     operation (the callee resolves the invocation's nested fields), the fields the request's plan resolves after
     its entry point, and the raised events;
   - the call sites with their options (section 2), the `Home`s, the `Workflow`s, the `CopyFeed`s of every site that
     allows a copy;
   - a `ReceivingEnvelope` per component: a synchronous call across containers pays the callee's receiving envelope
     in the callee's container; within a container it is not paid;
   - `RemoteCalls` with the measured hop costs plus a one-way network delay of 0.10 ms per message
     (`NETWORK_MS`), which single-host measurements do not contain;
   - the quality model ([quality.md](quality.md)): one `ChangeUnit` per class (its class and schema component),
     the system's 832 releases a year shared in proportion to the domain operations each class is the home of (at
     least one; copy maintenance, trivial resolvers and federation glue not counted), `Reliability`, `CostModel`,
     `Consistency`, `PeakCapacity`, `LatencyBudgetPolicy`, an `OperationLatencyBudget` per gateway request type
     and the two `ObjectiveBound`s;
   - `UnitGroup`s (the classes of each binding and of each feature) and `Coupling`s between class components
     (strength: operations accessing both + 2 per transaction and per joined statement over both + 1 for a
     composition), read by the group operators;
   - the copy sync is applied (`core/tools/sync_model.py`, section 6), then the domain section and its trace are
     added and the model switches to `domain.mm`.

   Each model's header records the size of the model and, as `// Input:` lines, the repository path and content
   hash of every input it was made from.
5. **Cache hits.** `cases/misarch/generator/cache_hits.py` reads the call sites of the derived model and writes
   `cases/misarch/mdeo/models/domain-cache-hits.json`. After the call sites change, derive.py runs once with
   `GEN_HITS_BOOTSTRAP=1`, then `cache_hits.py --all`, then derive.py again.
6. **Per-class model.** `core/generator/perclass_seed.py` writes `domain-perclass.m` from `domain-neutral.m`: every
   class component on its own `<Class>Service`, every schema on its own `<Class>Database`; the in-transaction steps
   become synchronous steps (no two classes share a container); nothing else changes.
7. **References and budgets.** `SEEDS="1 2 3 4 5" core/tools/gen_domain_budgets.sh` simulates today's model with the
   evaluation's request under seeds 1–5 and writes the means per request type
   (`cases/misarch/mdeo/models/domain-today-p95-day.json`: mean, p50, p90, p95, p99, completions) and today's
   change coupling and inconsistency (`domain-today-objectives-day.json`). derive.py then writes them into every
   model as the budgets' references and the bounds' references; it stops when the references were not measured over
   as many seeds as its `REPLICATIONS` (5). Run derive.py and perclass_seed.py again afterwards.
8. **Realised seeds.** `core/tools/realise-seeds.sh` realises each base model whose content hash changed (whole
   realisation in the headless harness, section 5) and writes `cases/misarch/mdeo/seeds/domain-<seed>-realised.m`
   (five simulations per evaluation, the configs' start models) and `-realised-1sim.m` (one simulation, for the
   platform and quick checks; not for the monolith). Realising again renames the derived elements, so the
   committed seeds are realised again only when their base model changed; after a regeneration that changed only
   the inputs' paths, `core/tools/seed_headers.py` rewrites the seeds' headers instead. `core/tools/check_case.py`
   checks the manifest, the inputs against their schemas and the adapter.

### The four models

| model | placement | mechanisms | role |
| --- | --- | --- | --- |
| `today` (as-built) | the 16 services of misarch-kotlin `main`: classes by owner service, one database server per service | as built: copies where the code reads a copy, gateway joins where the gateway fetches, events asynchronous, transaction-bound writes in transaction, everything else sync; workflows choreographed | start of the run **Built**; the reference design of C1, O3, C4, C5 |
| `perclass` | every class on its own container and its own database server | every site sync (callbacks async), every workflow choreographed | start of the run **PerClass**; needs nothing but the domain model |
| `monolith` | every class in `MonolithService`, every schema on one database server | as built without the network: events asynchronous in the process, request fields resolved locally | reference design reported beside the runs |
| `neutral` | every class in `MonolithService`, every schema on `SharedDatabase` | every site sync (also events), every workflow choreographed | intermediate only: perclass_seed.py derives from it; `core/tools/measure-costs.sh` checks the operators on it |

The four differ only in their decisions (and in what the copy sync derives from them); their base PCM, call
sites and options are the same, so the objects of any two designs correspond by name.

## 4. Running the derivation

```
core/harness/setup-worktree.sh                    # once: the mdeo worktree the harness runs in
GEN_HITS_BOOTSTRAP=1 core/generator/derive.py     # only after the call sites changed
cases/misarch/generator/cache_hits.py --all       # idem
core/generator/derive.py                          # today, neutral, monolith
core/generator/perclass_seed.py
SEEDS="1 2 3 4 5" core/tools/gen_domain_budgets.sh
core/generator/derive.py && core/generator/perclass_seed.py
core/tools/realise-seeds.sh
core/tools/check_case.py
```

derive.py stages the project (`core/tools/stage_project.py` → `build/project/misarch-gen/`) and needs the harness
(for the copy sync and the formatter). `ARCH_CASE` selects the case (default `misarch`).

## 5. Realisation

`core/mdeo/transform/realise.mt` is the whole realisation of layer 2. It edits the base PCM in place and adds
derived PCM, under three rules that keep the logical architecture readable for operators and metrics:

1. No base connector, assembly or allocation changes its owner or target, except the allocation links the
   operators change.
2. Base actions keep their identity: the realisation may move a call into a derived behaviour (the fork of an
   asynchronous call, the miss branch of a cache, an orchestration) or re-point it, but never deletes or copies it;
   the trace records what is needed to undo the change.
3. Every derived object is reachable from a trace that only the realisation or the copy sync writes (derived
   elements carry the entity name `realised`; the operators skip them).

Order of `realise.mt`:

1. The fixed parts, once (`realise/fixed.mt`: base rates, sidecars, middleware components, the `RealisedCall` of
   every base call, the workflow plans), then the colocations and the placement trace (`RealisedPlacement`).
2. Homes: a call whose applied home option is not the chosen one is taken apart and re-targeted
   (`realise/homes.mt`, `homes-retarget.mt`). Then the plan (`realise/plan.mt`): each call's shape (`gone`, `step`,
   `joined`, `redirect`, `composed`, `composedCache`, `cache`, `async`, `plain`) and middleware kind (`published`,
   `reply`, `async`, `sync`).
3. Removals: middleware blocks of a changed shape or kind or of a call no longer remote, then every structure a
   call has but should not have, orchestrations of workflows no longer orchestrated, notifications without their
   `Notification`, calls of removed deliveries, unused derived roles and middleware links.
4. Additions: notifications, derived roles, the structures of redirects, composed calls, caches, asynchronous calls
   and orchestrations, deliveries, `Work` demands, the rates of derived demands, middleware links, publishes,
   middleware blocks, deployables.

A section that can change something only under a cheap condition runs behind an `if match` on it, so a run with
nothing to do costs one match per section. The realisation is idempotent: a second run changes nothing.

| decision | realised as |
| --- | --- |
| remote call (caller and provider on different containers) | middleware blocks: calls into a middleware component of each container (on its sidecar) for send, transit and receive, or publish, broker, transit and deliver; for a synchronous call into a service with a `ReceivingEnvelope` also the callee's envelope in its own container |
| async (step) | an asynchronous fork; the publish on the caller's path, broker and delivery in the fork |
| in transaction | in one container and on one database server: the call re-pointed to the step's work, without envelope and commit; otherwise the step form |
| cache | a probabilistic branch: hit = CPU on the caller, miss = the call |
| gateway join | across containers the call moves behind the gateway's call into the caller's operation (with compose CPU, and the provider's fetch or entity cache re-pointed) |
| local copy | the read redirected to the copy store's read operation (the copy sync's `Redirect`) |
| home | every call into the operation re-targeted to the chosen option before its mechanism is realised |
| orchestration | the steps move into the trigger's SEFF and are called through the orchestrator, level by level |
| autoscaled container | the realised container is one pod (⌈q⌉ cores; the gateway's quota: full speed); SimOxide's HPA scales it |

The trace (`Realisation`, `RealisedCall`, `RealisedPlacement`, `RealisedContainer`, `MiddlewareBlock`,
`MiddlewareLink`, `RealisedRole`, `WorkflowPlan`, `MovedUnit`, ... in the "Realisation trace" section of
`architecture.mm`) lets the realisation find again what it made and lets the metrics read the logical caller and
provider of every call.

`core/mdeo/transform/realise-domain.mt` wraps `realise.mt` for a standalone run on a model of `domain.mm` (the
platform compiles a transformation for the metamodel of its `using` line).

## 6. Copy sync (layer 3)

`core/mdeo/optimize/sync-microservices.mt` realises the local copies in the completions, which the realisation then
treats like any other:

- every consumer that keeps copies has a copy store (a PCM component with a read and a write operation per copy);
  while one of its copies is read, an assembly of it sits with the consumer (`Colocation`);
- a call whose site has the `LocalCopy` mechanism gets a `Redirect` to its copy's read operation;
- every write that feeds a read copy gets a published `Notification` with one `Delivery` of the copy's write
  operation per copy it feeds (one publish, one message per copy, through the broker when the copy is in another
  container). A writer in the store's own container sends nothing: there the copy is its own data. A copy whose
  data comes with a message the consumer receives anyway (event-carried state) has no writers.

Removals come before additions, so the sync is idempotent. Each statement is a transformation of its own in
`core/mdeo/optimize/sync/`, so an operator runs only those its change can affect: after a placement change the
statements that depend on whether a writer and its copy's consumer sit together (`sync/moves.mt`, whole-model);
after a mechanism change of one site the additions or removals pinned to that site and its copy stores
(`sync/site.mt`; nothing when neither the old nor the new mechanism is a copy).

## 7. Incremental repair

Running the whole copy sync and realisation after every operator would be correct, but slower than repairing only
what a change can affect. Every operator of the configs is therefore a wrapper: the generic operator (decisions
only, `core/mdeo/optimize/generic/`), the layer-3 repair, then the layer-2 repair (`core/mdeo/transform/repair/`).

| change | layer-3 repair | layer-2 repair |
| --- | --- | --- |
| placement (every move, swap, merge, split, consolidation, group and unit move, `take-service`, `agree-colocation`) | `sync/moves.mt` | `repair/placement.mt`: one scan of the `RealisedPlacement`s marks the moved allocations and the calls with an end in one; plan, block removal, teardown, build, rates, links and blocks look only at them |
| one site's mechanism (`change-mechanism`) | `sync/site.mt` | `repair/call-site.mt`: the site's calls planned and repaired one by one with the pinned statements; with a copy involved `repair/site-pinned.mt` (per-call sections plus the deliveries whose `Delivery` went) |
| the sites of a pair, a class or an operation (`change-*-mechanisms`, `take-mechanisms`) | `sync/site.mt` per changed site | `optimize/domain/repair-sites.mt`: all changed sites' calls marked dirty, planned once, then repaired per call (or by the per-call sections when a copy is involved) |
| a workflow's steps and style (`change-workflow-mechanisms`, `take-workflow`) | `sync/site.mt` per changed step | `repair/site.mt`: the whole plan and sections (cheaper than per call for up to 15 steps; also realises a new style) |
| a workflow's style (`change-coordination`) | none (copies do not depend on it) | `repair/coordination.mt`: the whole plan, the orchestration taken apart or built, stale and new blocks per call |
| a home (`change-home`, `take-home`) | none (alternative homes allow no copy) | the whole realisation (`optimize/realised/home-repair.mt`) |

The **pinned statements** in `core/mdeo/transform/pinned/` are the whole realisation's statements about one call,
bound to an input `pc: RealisedCall`, generated by `core/tools/pin.py` from `core/mdeo/transform/realise/` (do not
edit them; edit the source and regenerate). The whole-model files stay the source of truth.

`core/mdeo/optimize/realised/sync-all.mt` (copy sync, then whole realisation) is the reference of every local
repair.

## 8. History independence and checks

The realised model is a function of the decisions, not of the search path: whatever the realisation creates is
removed exactly when the condition that created it no longer holds. In particular a derived middleware link exists
only while `links-add.mt` would make it, and a derived role only while a call is re-pointed to it or it is a
re-pointed call's original role (`realise/links-teardown.mt`); every repair that can make a link or role unused
runs this teardown. So a design reached by any sequence of operators is structurally identical to the same
decisions realised from scratch, and simulates identically.

Consistency is checked in the harness's check mode (`ARCH_CHECK_SYNC=/optimize/realised/sync-all.mt`): after each
operator application, the complete copy sync and the whole realisation must change nothing, and every multiplicity
must hold; crossovers must also leave their donors unchanged. `core/tools/measure-costs.sh` (steps `operators` and
`crossovers`) runs every mutation operator on the four realised models and every crossover on every ordered pair
of them and of a descendant of each, with these checks.

Generated files that are committed: the models and seeds (`cases/misarch/mdeo/`), `core/mdeo/transform/pinned/*`
(`core/tools/pin.py`) and `core/mdeo/optimize/domain/detail.fn` (the evaluation request of `metrics.fn` for the
explorer's design detail, `core/tools/gen_detail_fn.sh`).
