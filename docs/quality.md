# Quality model

Every design is evaluated by discrete-event simulation of its realised PCM with SimOxide, called through the
Palladio Simulation plugin's script function `pcmEvaluate` (`palladio-sim-service/`). The plugin simulates plain
PCM and returns raw measurements; every interpretation of them (groups, percentiles, failure model, prices,
budgets) is in `core/mdeo/transform/metrics.fn`. No value comes from an analytic walk of the model.

The two configs of the paper (`cases/misarch/mdeo/configs/today-3obj-5sim.config`, `perclass-3obj-5sim.config`)
use the same goal:

| paper | function in `metrics.fn` | kind | what |
| --- | --- | --- | --- |
| O1 | `cost` | minimise | cores of the containers in use, from the simulated pods |
| O2 | `failure` | minimise | failed outcomes per million sessions |
| O3 | `performance` | minimise | share of requests slower than their latency budget |
| C1 | `latencyBudget` | constraint | latency statistic per request type within its budget |
| C2 | `peakCapacity` | constraint | peak utilisation of the components that do not scale |
| C3 | `cohesion` | constraint | services and shared database servers connected in the domain's affinity graph |
| C4 | `changeCouplingBound` | constraint | change coupling (`changeCoupling`) ≤ 1.1 × the as-built cut's |
| C5 | `inconsistencyBound` | constraint | inconsistency (`inconsistency`) ≤ 1.1 × the as-built cut's |

A constraint function returns its violation: 0 when it holds, otherwise a positive amount (relative excess or a
count). The comments and printed report lines inside `metrics.fn` number the measures by their own scheme
(`changeCoupling` "O3", `inconsistency` "O4", `performance` "O5"); the paper's numbering is the table above.

## Simulation of a design

`evaluationWith(seed)` in `metrics.fn` builds the request from the model; every argument is given explicitly, so
the result does not depend on the plugin's defaults.

- **Load profile** (`LoadProfile` `day`, its `LoadStep`s): per session class the arrival rate of the workload times
  the step's factor from each step on; measured from 120 s to 1320 s.
- **Scaling groups**: every used `Deployable` with an `Autoscaling` (every application container and the gateway)
  is a group of SimOxide's Kubernetes HorizontalPodAutoscaler: target CPU utilisation 0.7 against the pod's CPU
  request, 2 to 50 pods, 2 at the start, start-up 30 s, the controller's defaults (sync 15 s, tolerance 0.1,
  scale-down stabilisation 300 s, CPU initialisation 300 s). The sidecar of a group gets the cores of its maximum
  pods, so it never limits (`overrides`).
- **Replications**: `LoadProfile.replications` = 5 simulations per evaluation, with the seeds 1, …, 5
  (`evaluations()`). Usage streams are on: every design sees the same users with the same behaviour per seed
  (common random numbers). The plugin caches each simulation per model and request, so the metrics of one design
  share its five simulations.
- **Measurements**: response-time statistics (mean, p50, p90, p95, p99, a histogram with 10 bins per decade) per
  system operation, per-resource utilisation in 10-s bins, replica-core-seconds and mean ready pods per scaling
  group, simulated call counts, sessions, and per session the set of containers on its synchronous path
  (`pathSets`) and the asynchronous work it starts with its containers (`asyncPathSets`; forks that only maintain
  copies are not followed, `copyForks`).
- **Infeasible**: a simulation that fails, exceeds 2·10⁸ events, creates more than 400 pods (`LoadProfile.maxPods`)
  or runs longer than 900 s wall clock. Then C1 = 1000, C2 = 1 and O3 = 1.

SimOxide works on a canonical form of the model derived from its structure, so results do not depend on element
names or list order.

The mean over the five simulations is taken per measure (O1, O2, O3, C5 and the reporting values: the mean of the
per-simulation values; C1: the mean statistic per request type; C2: the maximum).

## O1 cost

Per simulation, summed over the containers in use:

- an application container (a `Deployable` with autoscaling): `perCore` × pods × `cpuPerReplica` +
  `perReplicaOverhead` × ready pods, where pods = replica-core-seconds / cores per pod / window (ready and
  starting pods) and ready pods = the mean ready replicas;
- a container with a flat `ContainerPrice`: the price × its pods (the gateway per pod; the broker once; Keycloak 0);
- a database server (`ContainerPrice` with `perCore`): a fixed price plus `perCore` × the cores it is sized to: its
  CPU's busiest 10-s bin at C2's limit (cores × peak bin utilisation / 0.85), at least `minCores`;

plus `perCache` × the call sites that use a cache (`CachedCall`, or a gateway join with a cache), outside the
SEFFs of home options not chosen.

**Rationale.** Database servers do not autoscale, so they are provisioned for their peak; consolidating schemas on
fewer servers saves the fixed part and the minimum, not the load.

## O2 failures

Failure sources are independent; a source s is down with probability u_s and then takes down every container of
its set S_s (sources with the same set add up):

- every application container that holds a class component and every database server in use, alone: an
  application container with `processUnavailability`, a database server with `serverUnavailability` (the fixed
  gateway, broker and Keycloak are no failure sources);
- every change unit (one per class: its class and schema component) with u = releases a year ×
  `changeFailureRate` × `restoreHours` / `periodHours`, over the containers holding its components, the database
  server included (`tenantShare` 1: a failed release takes the server down for all its tenants). A unit's releases
  count once per session, however many of its containers the session uses.

With n_P the simulated sessions whose synchronous path used the container set P, N all measured sessions, m_Q the
completed units of asynchronous work Q (an event publication, a fire-and-forget call or a background orchestration
and everything it starts, transitively) on the containers W_Q, started by a session with synchronous path P_Q:

```
O2 = 10⁶ / N · ( Σ_P n_P (1 − Π_{s: S_s ∩ P ≠ ∅} (1 − u_s))
              + w · Σ_Q c_Q m_Q (1 − Π_{s: S_s ∩ W_Q ≠ ∅, S_s ∩ P_Q = ∅} (1 − u_s)) )
```

c_Q is the business criticality of Q's process (`Process.criticality`; outside a process `Domain.defaultCriticality`),
w = `Reliability.asyncWeight`. An outage on P_Q fails the session itself, which the first term counts already.
Copy maintenance is not counted: a retrying broker only delays it, and its staleness counts in C5.

The releases a year are the case's (`CHANGES_PER_YEAR` in the adapter), shared by the classes in proportion to the
domain operations each class is the home of (at least one per class; copy maintenance, trivial resolvers and
federation glue are not counted). Commit counts are not used anywhere.

## O3 slow requests

For every gateway request type k with a reference (all request types but the login), its budget b_k is C1's (3 ×
today's p90), whether or not C1 budgets it. Per simulation f_k = (completions of k slower than b_k) / (completions
of k), from the latency histogram (a bin that straddles b_k counts linearly; a simulation without completions of k
counts 1). Then

```
O3 = Σ_k w_k · mean over the simulations of f_k,    w_k = today's completions of k / Σ today's completions
```

with fixed weights, so every design is compared on the reference design's request mix.

**Rationale.** A percentile jumps between two values depending on whether an overload episode occurs in a seed;
the share of slow requests grows with the episode's length and severity. C1 remains the hard bound.

## C1 latency budget

`LatencyBudgetPolicy` (statistic `p90`, factor 3, `minCompletions` 200) and one `OperationLatencyBudget` per gateway
request type with today's statistics as references. A request type has a budget when today's simulations completed
it at least 200 times in the window (fewer completions make the percentile noise); its budget is 3 × today's p90.

```
C1 = Σ_{k with a budget} max(0, mean over the simulations of p90_k / b_k − 1)
```

p90_k of a simulation is the largest over the system operations with k's signature (0 without completions).
C1 = 1000 when any simulation failed.

## C2 peak capacity

The components that do not autoscale, the database servers and the broker (`PeakCapacity.containers`), stay at most
at utilisation 0.85 in every 10-s bin of every simulation:

```
C2 = max(0, max over simulations, PeakCapacity containers and their CPU resources of the peak bin utilisation − 0.85)
```

C2 = 1 when any simulation failed.

## C3 cohesion

The affinity graph over the domain classes comes from the domain model only, never from a cut: two classes are
adjacent when one references the other, when a third class references both, or when at least two distinct domain
operations access both (every counted operation of the domain, reached by the workload or not). A service is the
set of classes whose components sit in one container; a database server's services are those holding a class
whose schema it hosts.

```
C3 = Σ_services (connected components of the service's classes − 1)
   + Σ_database servers with ≥ 2 services (connected components of their services' classes, each service's classes
                                            taken as connected, − 1)
```

C3 = 0 when every service and every shared database server is connected. **Rationale.** Splitting a service stays
possible, while groupings of unrelated classes are rejected; the measure needs no reference design.

## C4 change coupling bound

Change coupling is structural, a query over the base calls and the placement (no simulation). Per change unit U
with r_U releases a year:

- own_U: the application containers holding U's components;
- others_U: every other application container c that calls a component of U (a base call whose logical caller sits
  in c; an orchestrated step's caller is its orchestrator), with p_c the probability that the change breaks the
  caller's contract (`Mechanism.breakProbability`, else `ChangeCoupling.contractBreak` = 0.15 for every mechanism),
  and every application container of another unit that shares a database server with U, with
  `sharedServerCoupling` = 1; the largest p per container.

```
CC = Σ_U r_U n_U / Σ_U r_U,    n_U = max(1, |own_U|) + Σ_{c ∈ others_U} p_c
C4 = max(0, CC / (1.1 × CC_today) − 1)
```

Calls in the SEFFs of home options not chosen are skipped.

## C5 inconsistency bound

The expected number of operations per session that work on possibly stale data or write outside their own
transaction, from the simulated call counts. Per base call f with n_f simulated executions (a cached call: its
attempts, hits included):

- a cache hit (a `CachedCall`, or a gateway join with a cache across containers): n_f × hit ratio × p_f, with p_f the
  site's share of stale hits (`CallSite.staleShare`, from replaying the workload's keys through the cache), else
  min(1, w × TTL);
- a copy read across containers: n_f × `staleReads` (1) × min(1, w × `replicationLagSeconds`);
- a write to a class in another container: n_f × `syncWriteWeight` (1) for a synchronous step, `asyncWriteWeight`
  (1.5) for an asynchronous one;

w is the simulated write rate of the data the read touches (writes per second of the window: a class's rows or a
reference's links), and p = 0 for a read whose accesses are all `immutable`. The sum is divided by the measured
sessions and averaged over the simulations.

```
C5 = max(0, Inc / (1.1 × Inc_today) − 1)
```

**Rationale for C4 and C5.** These are the qualities an architect improving an existing cut is least willing to
trade for cost, so the search keeps them near the as-built cut's values instead of offering designs that give them
up.

## References, budgets and parameters

The reference design is the as-built cut (`today`). `core/tools/gen_domain_budgets.sh` simulates
`cases/misarch/mdeo/models/domain-today.m` with exactly the evaluation's request under the seeds 1–5 and writes:

- `cases/misarch/mdeo/models/domain-today-p95-day.json`: per gateway request type the mean, p50, p90, p95, p99 and
  completions, each the mean over the five seeds: the references of C1's budgets and of O3's budgets and weights;
- `cases/misarch/mdeo/models/domain-today-objectives-day.json`: today's change coupling and inconsistency (means over
  the seeds): the references of the two `ObjectiveBound`s (C4, C5).

`core/generator/derive.py` writes them into every model (`OperationLatencyBudget.reference*`,
`ObjectiveBound.reference`), so the PerClass run is bounded by the as-built system too. The settings of the quality
model are constants of `derive.py` and of the case's adapter `cases/misarch/generator/misarch.py`; the platform
prices come from `cases/misarch/generator/platform.json`:

| setting | value | where |
| --- | --- | --- |
| simulations per evaluation, seeds | 5, seeds 1–5 | `REPLICATIONS`, `SIM_SEED` |
| HPA | target 0.7, 2–50 pods, 2 initial, start-up 30 s; at most 400 pods per simulation | `HPA_*`, `MAX_PODS` |
| pod cores, overhead, per-core price, cache | 0.5 cores per pod, 0.2 per ready pod, 1.0 per core, 0.1 per cache | `platform.json` |
| database server | 0.2 + cores sized at C2's limit, at least 0.5 cores | `DB_PRICE`, `DB_MIN_CORES` |
| gateway, broker, Keycloak | 2.0 per pod, 1.0, 0 | adapter `prices` |
| O2 | change failure rate 0.1, restore 1 h, 832 releases a year, process unavailability 2·10⁻⁴, server unavailability 10⁻⁴, tenant share 1, async weight 1; criticality Buy 1, Return 1, Registration 0.3, other 0.3 | `derive.py`, adapter |
| C1 | p90 ≤ 3 × today's, request types with ≥ 200 reference completions | `BUDGET_STATISTIC`, `BUDGET_FACTOR`, `MIN_BUDGET_COUNT` |
| C2 | 0.85 in 10-s bins; database servers and broker | `CAPACITY_LIMIT`, `CAPACITY_BIN_SECONDS` |
| C3 | co-access threshold 2 operations | `coAccessMin` in `metrics.fn` |
| C4 | contract break 0.15, shared server coupling 1.0, bound 1.1 × today's | `CONTRACT_BREAK`, `SHARED_SERVER_COUPLING`, `BOUND_FACTOR` |
| C5 | sync write 1, async write 1.5, replication lag 1 s, cache TTL 60 s, bound 1.1 × today's | `derive.py`, adapter `CACHE_TTL_S` |

## Reporting functions

`metrics.fn` also defines functions that no config optimises, used by the harness, the explorer and the paper's
tables: `modularity`, `replicas`, `utilisation`, `peakUtilisation`, `responseTime`, `simulationFailed`, `peakPods`,
`createdPods`, `simulationWallMs`, `failureSync`, `failureAsync`, `cohesionServices`, `cohesionServers`,
`inconsistencyLooseBound`, and the `print*` functions, which print one line per term of O2, C3, C5 and O3 in the
harness's `evaluate` mode. The part of `metrics.fn` up to "end of the request" is copied verbatim into
`core/mdeo/optimize/domain/detail.fn` (`core/tools/gen_detail_fn.sh`), so the explorer's design detail simulates
with exactly the same request.
