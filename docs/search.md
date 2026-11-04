# Search

The search is mdeo's NSGA-II over model transformations: every operator is a `.mt` transformation that changes
decisions only and is followed by its repair ([model.md](model.md#7-incremental-repair)), and every offspring is
evaluated by five simulations ([quality.md](quality.md)).

## The two runs

| paper | config | start model | start design |
| --- | --- | --- | --- |
| Built | `cases/misarch/mdeo/configs/today-3obj-5sim.config` | `domain-today-realised.m` | the as-built cut |
| PerClass | `cases/misarch/mdeo/configs/perclass-3obj-5sim.config` | `domain-perclass-realised.m` | one service per class |

The two configs differ only in their start model. Both minimise O1–O3 under C1–C5
(`goal` block, functions of `core/mdeo/transform/metrics.fn`), use the same 19 mutation and 5 crossover operators
and the same solver settings. The per-class start takes nothing from the as-built cut and is itself infeasible;
the part timings, the latency budgets and the bounds of both runs refer to
the as-built system. The monolith (`domain-monolith-realised.m`) is evaluated as a reference design, not searched
from. `cases/misarch/mdeo/configs/smoke-3obj-5sim.config` is today-3obj-5sim.config with 3 generations, to check a
setup and time a generation.

The configs are staged with the core's operators as `optimize/domain/` of the project (`core/tools/stage_project.py`
→ `build/project/misarch/`), so their `using` paths (`../realised/...`, `./...`, `../crossover/...`) are relative to
that place.

## Solver settings

```
algorithm = NSGAII
population = 175, variation = genetic
crossover { rate = 0.9, parents = 2, strategy = random }
mutation  { step = interval(1, 4), strategy = random }
termination { evolutions = 450 }
runtime timeout: script 600 s (the five simulations of one evaluation), transformation 30 s
```

What mdeo makes of them (mdeo-cloud's `platform/optimizer`):

- **Initial population**: 175 copies of the start model, each mutated like an offspring.
- **Offspring**: parents are drawn in pairs by binary tournament. With probability 0.9 a pair attempts crossover:
  each parent in turn is the primary (its copy becomes the child) and the other the donor; the crossover operators
  are tried in a uniformly random order until one applies (if none applies, the child is a copy of its primary).
  Every child is then mutated.
- **Mutation**: the step count is drawn uniformly from the interval [1, 4), upper bound exclusive, so one to three
  mutations per offspring; each step picks one of the 19 operators uniformly and, if it does not apply, tries
  another.
- **Selection**: offspring and population are merged and truncated to 175 by non-dominated sorting and crowding
  distance, with the MOEA Framework's constrained dominance (a constraint value other than 0 makes a design
  infeasible; feasible designs dominate infeasible ones, infeasible ones compare by total violation).
- The search's random numbers are not seeded; mdeo keeps only the final population of a run (the headless harness
  can also write every evaluated design, below).

## Operators

Every operator fails before it changes anything when it does not apply. Its randomness is the engine's choice among
matches: a pattern with a single free object yields the first match after mdeo's shuffle, i.e. a uniform draw.
Operators bind sites, regions and targets in a fixed order (e.g. a site with at least two options first, then one
of its other options) so that the draw is uniform over what changes, not over the pattern's matches. Derived
elements of the realisation (entity name `realised`) are never moved, coupled or counted.

Each wrapper is the generic operator (`core/mdeo/optimize/generic/`, decisions only), then the layer-3 repair
(`core/mdeo/optimize/sync/`), then the layer-2 repair (`core/mdeo/transform/repair/`); the right column names them.

### Mutations (19)

| operator (config path) | what it changes | repair |
| --- | --- | --- |
| `realised/move-component.mt` | a movable component to another of its candidate containers | placement |
| `realised/move-to-callee.mt` | a component into the container of a component it calls | placement |
| `realised/move-to-caller.mt` | a component into the container of a component that calls it | placement |
| `realised/swap-components.mt` | two components exchange containers (the number of containers in use stays) | placement |
| `realised/merge-containers.mt` | every component of a container that calls another moves there (where allowed) | placement |
| `realised/split-component.mt` | a component of a shared container into an empty candidate container | placement |
| `realised/consolidate-servers.mt` | every schema of one database server onto another one in use | placement |
| `realised/change-mechanism.mt` | one call site (with at least two options) to another allowed mechanism | one site |
| `realised/change-coordination.mt` | one workflow to its other coordination style | coordination |
| `realised/change-home.mt` | one operation with a home decision to another candidate home | whole realisation |
| `domain/change-workflow-mechanisms.mt` | every step site of one workflow to one drawn mechanism, and the workflow's style drawn among its styles (its current one included) | per site layer 3, whole mechanism repair |
| `domain/change-pair-mechanisms.mt` | every call site from one container to another (a drawn directed pair) to one drawn mechanism | per site layer 3, `repair-sites` |
| `domain/change-class-mechanisms.mt` | every call site into one provider component (one class) to one drawn mechanism | per site layer 3, `repair-sites` |
| `domain/change-operation-mechanisms.mt` | every call site in one operation's SEFF to one drawn mechanism | per site layer 3, `repair-sites` |
| `domain/move-group.mt` | a connected region of coupled components (size bound uniform on 2..n of its container) to another candidate container | placement |
| `domain/split-region.mt` | a connected region (size bound uniform on 1..n−1) into an empty candidate container | placement |
| `domain/swap-groups.mt` | two regions of two containers exchange places | placement |
| `domain/move-unit.mt` | every member of a `UnitGroup` (a binding's or a feature's classes) into one candidate container of a member | placement |
| `domain/gather-unit.mt` | the members of a split `UnitGroup` into the container of one member | placement |

Notes:

- A **mechanism group operator** draws its scope (a workflow, a container pair, a provider or an operation, each
  uniformly among those with a site of at least two options), then its target uniformly among the mechanisms that
  would change at least one site of the scope, and sets it at every site that allows it. **Rationale.**
  Single-site changes alone left almost every cross-service access synchronous from an all-synchronous start; a
  saga only leaves the request path when all its steps change together.
- A **region** grows from a random movable component: each step adds a component drawn uniformly from the coupled
  partners of the members in the same container (along `Coupling`s at least as strong as a threshold drawn per move
  from the seed's couplings, which favours strong couplings), until the size bound or no partner is left. Group
  moves let the search cross valleys that single moves cannot, such as moving an aggregate whose separation would
  each time cost a saga. `move-group` fails when no partner joins (that would be `move-component`) or when a whole
  container would move to an empty one (a relabelling); `swap-groups` fails when both regions are single components
  or whole containers.
- **Placement candidates**: a class component may go to any application container of the pool, a schema to any
  database server (`Placement.candidates`).

### Crossovers (5)

Objects of two designs correspond by name: classes, components, containers and operations keep their names in every
descendant of a start model, a workflow is identified by its trigger, a call site by its call, its operation and
its logical caller. Donors are never changed, so a crossover is repaired like the mutation that changes the same
decisions.

| operator | what the child takes from the donor | repair |
| --- | --- | --- |
| `crossover/take-service.mt` | one service: a donor container is drawn among those that would give the child something, and every movable component the donor puts there moves to the child's container of the same name (components already there stay) | placement |
| `crossover/take-mechanisms.mt` | for one provider component (a class) on which the two differ, the donor's mechanism at every site into it, where the site allows it | as the mechanism group operators |
| `crossover/take-workflow.mt` | for one workflow on which they differ, the donor's coordination style and step mechanisms | as `change-workflow-mechanisms` |
| `crossover/take-home.mt` | for one operation on which they differ, the donor's home | as `change-home` |
| `crossover/agree-colocation.mt` | one coupled pair of components that the donors (here the one donor, quorum 1.0) keep in one container but the child separates is co-located | placement |

`take-service` is the grouping crossover restricted to one injected group: the child keeps the rest of its cut.
The configs use the operators' defaults (`services = 1`, `providers = 1`, `quorum = 1.0`, `pairs = 1`).

## Running a search

- **Headless.** `core/harness/setup-worktree.sh` prepares a detached mdeo-cloud worktree (`build/mdeo-wt`) with
  the harness of `core/harness/` (the real language services' exporter and an in-process run of the real
  optimizer). `core/tools/run-domain.sh optimize/domain/today-3obj-5sim.config <run>` stages the project, copies the
  plugin, exports the project, realises and evaluates the four start models (`PREP_ONLY=1` stops there,
  `RUN_ONLY=1` skips it) and runs the optimisation into `build/domain/runs/<run>`, with every evaluated design in
  `designs.jsonl`; an optional `[population generations]` overrides the config's. Threads, plugin services, heap
  and address-space limits are environment variables listed in the script's header; heavy runs wait for
  `core/tools/wait-for-machine.sh`.
- **mdeo platform.** The paper's runs ran on an mdeo instance with the Palladio Simulation plugin;
  [platform.md](platform.md) describes the project, the seeds and how to start and download a run.
- **Checks and costs.** `core/tools/measure-costs.sh` measures the time of one simulation and of one offspring and
  runs the consistency checks of every operator ([model.md](model.md#8-history-independence-and-checks)), on a
  quiet machine.
