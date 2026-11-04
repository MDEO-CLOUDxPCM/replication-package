# Documentation

How the optimisation of the paper is built and how to reproduce it.

| file | contents |
| --- | --- |
| [model.md](model.md) | the layers and metamodels, what a design decides, how the optimisation models are derived from the case, the realisation, the copy sync, the incremental repair, history independence |
| [quality.md](quality.md) | the simulation of a design, the objectives O1–O3 and constraints C1–C5 as `core/mdeo/transform/metrics.fn` defines them, where references and budgets come from, the settings |
| [search.md](search.md) | the two runs (Built, PerClass), NSGA-II settings, the 19 mutation and 5 crossover operators and their repairs, how to run a search |
| [case-interface.md](case-interface.md) | what a case provides to the core (manifest, inputs, adapter), how to add one |
| [platform.md](platform.md) | running in the mdeo platform |

The code is the reference; these files describe its current state.

## Names in the paper and in the repository

| paper | repository |
| --- | --- |
| as-built cut (design) | `today`: `cases/misarch/mdeo/models/domain-today.m`, seed `domain-today-realised.m` |
| per-class design | `perclass`: `domain-perclass.m` (`core/generator/perclass_seed.py`) |
| monolith | `monolith`: `domain-monolith.m` |
| run Built | `cases/misarch/mdeo/configs/today-3obj-5sim.config` |
| run PerClass | `cases/misarch/mdeo/configs/perclass-3obj-5sim.config` |
| O1, O2, O3 | `cost`, `failure`, `performance` (the comments in `metrics.fn` call performance "O5") |
| C1, C2, C3 | `latencyBudget`, `peakCapacity`, `cohesion` |
| C4, C5 | `changeCouplingBound`, `inconsistencyBound`, bounding `changeCoupling` and `inconsistency` (the comments in `metrics.fn` call these "O3" and "O4") |
| layer 1, layer 2, layer 3, domain layer | `palladio.mm`, `architecture.mm`, the local copies in `architecture.mm`, `domain.mm` (`core/mdeo/metamodel/`) |
| synchronous call / step, asynchronous step, step in the caller's transaction | mechanisms `sync`, `async`, `inTx` |
| cache, gateway join, gateway join with the provider's entity cache, local copy | `cache`, `join`, `joinCache`, `copy` |
| realization | realisation (the repository's spelling) |

## Comments that cite "DESIGN.md"

Many source files, models and configs cite entries of a development decision log as "DESIGN.md <id>" (for example
"(DESIGN.md AB56)"). That log is not part of this package, and the files are kept byte-identical to what produced
the paper's results, so the citations stay. The table maps the ids cited most often to the section that describes
the topic. Some cited ids (H10–H19, D32, D47, D52, D58, M7, P10) come from the logs of earlier projects the code
was adapted from; they are mapped by the topic of the comment that cites them.

| ids | topic | section |
| --- | --- | --- |
| §A, A1–A9 | domain layer, extraction, bindings | [model.md §1](model.md#1-layers), [§3 step 1](model.md#3-deriving-the-models-from-the-case) |
| §B, B1–B1.9, B3 | realisation in place: rules, order, structures, protection of derived elements | [model.md §5](model.md#5-realisation) |
| B4, B4.5, B4.9, B4.10, B4.12, S3 | incremental repair, pinned statements, placement trace, moved units | [model.md §7](model.md#7-incremental-repair) |
| H10–H16, H19, AB49 | copy sync (layer 3) and its local repairs | [model.md §6](model.md#6-copy-sync-layer-3) |
| AB22, AB66 | history-independent realisation | [model.md §8](model.md#8-history-independence-and-checks) |
| §C, C4, AB3 | session workload, the `day` profile | [model.md §3 step 2](model.md#3-deriving-the-models-from-the-case) |
| §F, F1–F16 | derivation of the models | [model.md §3](model.md#3-deriving-the-models-from-the-case) |
| F2, AB38, AB41, AB71 | homes | [model.md Homes](model.md#homes) |
| F4, F5, AB37, AB60, AB33.1 | call sites, allowed mechanisms, effect steps, consistency levels, the provider's entity cache | [model.md Call sites](model.md#call-sites-and-their-mechanisms) |
| F6, AB35 | bindings, workflows, one saga notion | [model.md Workflows](model.md#workflows) |
| F9, AB30.10 | the start designs | [model.md The four models](model.md#the-four-models) |
| AB32, AB64, AB68–AB70, AB33.3 | timing parts, latency-only waits | [model.md §3 step 3](model.md#3-deriving-the-models-from-the-case) |
| AB33.2 | per-site cache hit ratios and staleness | [model.md §3 step 5](model.md#3-deriving-the-models-from-the-case), [quality.md C5](quality.md#c5-inconsistency-bound) |
| AB39, AB42, AB43, AB55, AB56, AB67 | network per hop, accesses of references, federation glue, nested fields, receiving envelope, own data in copy tables | [model.md §3 step 4](model.md#3-deriving-the-models-from-the-case) |
| AB1, AB2, AB10, AB26, AB28, AB72 | simulation per design, HPA, load profile, five simulations per evaluation | [quality.md Simulation](quality.md#simulation-of-a-design) |
| AB30 | database servers sized to their peak, objective bounds | [quality.md O1](quality.md#o1-cost), [C4](quality.md#c4-change-coupling-bound) |
| AB13, AB24, AB25, F11, §U, §W, U1 | O2: failure sources, change units, asynchronous work, shared fate | [quality.md O2](quality.md#o2-failures) |
| AB27 | O3: share of slow requests | [quality.md O3](quality.md#o3-slow-requests) |
| L, L1, AB6, AB20 | C1: latency budgets | [quality.md C1](quality.md#c1-latency-budget) |
| AB25.3, AB26 (C3) | C3: cohesion | [quality.md C3](quality.md#c3-cohesion) |
| U2 | shared-server coupling | [quality.md C4](quality.md#c4-change-coupling-bound) |
| AB23 | staleness weighting | [quality.md C5](quality.md#c5-inconsistency-bound) |
| E3, S4, G9, D58 | operator randomness, failing before a change, derived elements skipped, site-first draws | [search.md Operators](search.md#operators) |
| G1–G8, I1, I6, D32, D47 | group and unit operators, unit groups, couplings, database server consolidation | [search.md Mutations](search.md#mutations-19) |
| M1–M7 | mechanism group operators | [search.md Mutations](search.md#mutations-19) |
| AC1–AC5 | crossover operators | [search.md Crossovers](search.md#crossovers-5) |
| AB52 | the core/case split | [case-interface.md](case-interface.md) |
