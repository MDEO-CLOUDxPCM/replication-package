# architecture-optimization

Replication package of the paper's architecture optimisation of a microservice system on the Palladio Component
Model (PCM), with the service cut derived from the domain model. The case study is MiSArch in its Kotlin port. The
search runs in mdeo: model transformations (`.mt`) are the operators, script functions (`.fn`) the metrics, and every
candidate is simulated by SimOxide through the Palladio Simulation plugin.

The paper reports two runs. Both minimise cost (O1), failures (O2) and the share of slow requests (O3) under latency,
capacity, cohesion, change-coupling and inconsistency constraints (C1–C5), with five simulations per design,
population 175 and 450 generations:

| run | config | start |
| --- | --- | --- |
| Built | `cases/misarch/mdeo/configs/today-3obj-5sim.config` | the as-built cut (`domain-today-realised.m`) |
| PerClass | `cases/misarch/mdeo/configs/perclass-3obj-5sim.config` | one service per domain class (`domain-perclass-realised.m`) |

The results of both runs, as downloaded from the platform (final populations, per-generation history), are in
[results/](results/README.md).

The documentation is in [docs/](docs/README.md): the model and its derivation ([docs/model.md](docs/model.md)),
the objectives and constraints ([docs/quality.md](docs/quality.md)), the search and its operators
([docs/search.md](docs/search.md)), running in the platform ([docs/platform.md](docs/platform.md)) and the case
interface ([docs/case-interface.md](docs/case-interface.md)).

## Repositories

Two repositories are submodules at the top of this one (`git clone --recursive`, or `git submodule update --init`),
misarch-kotlin twice:

| directory | what | commit |
| --- | --- | --- |
| `palladio-sim-service/` | the Palladio Simulation plugin, with the SimOxide crates it builds in `simoxide/` (SimOxide `d45992d`, its `simoxide.rev`) | branch `vendored-simoxide` |
| `misarch-kotlin/` | the case study's code as the paper analyses it: read by the extraction (the evidence `path:line` in `cases/misarch/domain/misarch-domain.json` is on this commit), its compose files run the timing campaign | `main` (`d569ad9`) |
| `misarch-kotlin-measurement/` | the same repository at the tip of its measurement branches, to read them: `timing-instrumentation` (`b4f00b2`; spans and CPU counters) and on it `timing-mechanisms` (`db170f4`; local copies and response caches), each linear on the one before and off unless switched on (`docs/TIMING-COUNTERS.md`, `docs/MECHANISMS.md` there) | `timing-mechanisms` (`db170f4`) |

The tools use `misarch-kotlin/` and reach the measurement branches through git in it (`origin/<branch>` in the
submodule; `cases/misarch/timing/build-images.sh` builds the campaign's images from them).
The tools find each in the submodule, or in a checkout of the same name beside this repository
(`core/tools/checkout.sh`). The mdeo platform is mdeo-cloud release 0.2.12: its published images for the platform
(`docker-compose.yaml`) and its sources for the headless harness, which runs in a worktree of it (`build/mdeo-wt`;
`core/harness/setup-worktree.sh` clones the release into `build/mdeo-cloud` when there is no `mdeo-cloud` checkout).

## Layout

| path | what |
| --- | --- |
| `core/mdeo/` | the MDEO sources: `metamodel/` (palladio.mm, architecture.mm, domain.mm), `transform/` (realisation, repair, pinned statements, `metrics.fn`), `optimize/` (mutation and crossover operators, copy sync, `domain/detail.fn`) |
| `core/generator/` | the derivation `derive.py`, the session-model interpreter `sessions.py`, `perclass_seed.py`, the JSON Schemas of a case's inputs, a case stub |
| `core/harness/` | the headless harness: real mdeo language services and optimizer in a worktree of mdeo-cloud |
| `core/tools/` | staging, runs, realisation, budgets, design detail, cost measurement |
| `core/platform/` | the mdeo platform client: push, run, download, cross-check, conversion |
| `core/explorer/` | the explorer of runs, designs and the input model (`core/explorer/README.md`) |
| `cases/misarch/` | the case: `extract/` → `domain/`, `workload/`, `timing/`, `generator/` (its adapter), `mdeo/{models,seeds,configs}`, `explorer-packet/`, `platform.json` (`cases/misarch/README.md`) |
| `docs/` | the documentation |
| `docker-compose.yaml` | the mdeo platform (0.2.12) with the plugin, on one machine (`core/platform/setup-local.sh`) |
| `palladio-sim-service/`, `misarch-kotlin/`, `misarch-kotlin-measurement/` | the submodules (Repositories) |
| `results/` | the two runs' downloads from the platform, one zstd-compressed tar each ([results/README.md](results/README.md)) |
| `build/` | everything generated (not committed) |

**Staging.** mdeo reads one project root with `/metamodel`, `/models`, `/optimize`, `/transform`.
`core/tools/stage_project.py` copies `core/mdeo/` and the case's `mdeo/` into `build/project/misarch/` in exactly that
layout (models and seeds → `models/`, configs → `optimize/domain/`); no import line is rewritten. Every entry point
stages first. Configs are named by their project path (`optimize/domain/today-3obj-5sim.config`) or their source.

**Fixed files.** The 156 files the two configs reach (`core/platform/closure.py`) are byte-identical to the files the
paper's runs ran with, and the models record their inputs by path and hash (`// Input:` lines: `derive.py`,
`sessions.py`, the case's adapter, the domain, workload and timing inputs). Comments in these files cite entries of
a development log as "DESIGN.md <id>"; [docs/README.md](docs/README.md) maps them to the documentation.

## Reproducing

### 1. The runs, from the committed models

In the platform, on one machine with Docker ([docs/platform.md](docs/platform.md), "One machine"):

```bash
git submodule update --init
docker compose up -d --build        # mdeo 0.2.12 and the plugin, built from palladio-sim-service/; http://localhost:4242
core/platform/setup-local.sh        # registers the plugin, creates the project, pushes the configs and their files
```

then open `optimize/domain/smoke-3obj-5sim.config` (three generations, to check the setup), `today-3obj-5sim.config`
(Built) or `perclass-3obj-5sim.config` (PerClass) in the workbench and press **Run**. On another mdeo instance:
build and register the plugin, create a project with the plugin enabled, then

```bash
USER_NAME=<user> PASSWORD=<password> core/platform/push.sh <project id> http://<backend>:8080
```

puts exactly the two configs and the files they reach into it.

Headless, on one machine:

```bash
core/harness/setup-worktree.sh                     # once: the mdeo-cloud worktree build/mdeo-wt
core/tools/run-domain.sh optimize/domain/smoke-3obj-5sim.config smoke     # check the setup (3 generations)
ARCH_THREADS=18 ARCH_PLUGINS=3 ARCH_HEAP=18g ARCH_AS=28000000000 \
  core/tools/run-domain.sh optimize/domain/today-3obj-5sim.config built
```

The run writes every evaluated design to `build/domain/runs/<name>/designs.jsonl` (settings: the header of
`core/tools/run-domain.sh`). Built took 19.1 h in the platform, PerClass 28.1 h; their downloads are in
[results/](results/README.md).

### 2. The models, from the case

In order (details: [docs/model.md](docs/model.md) §3–4, [cases/misarch/README.md](cases/misarch/README.md)):

1. **Extraction**: `cases/misarch/extract/build.py` reads misarch-kotlin's `main` and the curated files
   `extract/curated/*.yaml` and writes `cases/misarch/domain/misarch-domain.json`.
   misarch-kotlin's `main` is read through git, also where the submodule's checkout is another commit
   (as `origin/main` in a clone without a local `main`).
2. **Workload**: `cases/misarch/workload/sessions.json`, the session usage model, read by `core/generator/sessions.py`
   with MiSArch's calibration `cases/misarch/generator/gen_sessions.py`.
3. **Timing**: the timing campaign on misarch-kotlin measures the parts of the as-built cut and writes
   `cases/misarch/timing/parts.json` (`cases/misarch/timing/README.md`; needs a quiet machine and the MiSArch stack).
4. **Derivation**: `core/generator/derive.py` writes `cases/misarch/mdeo/models/domain-{neutral,today,monolith}.m`,
   `core/generator/perclass_seed.py` writes `domain-perclass.m`; C1's budgets and the bounds' references come from
   simulating the as-built cut (`core/tools/gen_domain_budgets.sh`), then `derive.py` runs again.
5. **Realisation**: `core/tools/realise-seeds.sh` realises the models whose content changed into the seeds
   `cases/misarch/mdeo/seeds/domain-<seed>-realised.m` (and their one-simulation forms `-realised-1sim.m`).

`core/tools/check_case.py` checks the case's inputs against their schemas.

### 3. The paper's numbers

The paper's generators (`tools/gen_model_numbers.py`, `tools/gen_against_numbers.py` in the paper's repository) read
from this repository:

- the case and its models: `domain-today.m` exported by the harness, the domain, the session model, the configs,
  `metrics.fn`, `cases/misarch/generator/platform.json`;
- the cost and check numbers: `core/tools/measure-costs.sh` (time per simulation and per offspring, and the
  consistency check of every operator on the four realised models) → `build/measure-costs/results.json`;
- per run: the downloaded execution (`core/platform/dl.mjs`, `BYID=1 IDS=<id>`; the paper's two are in `results/`,
  unpacked into `build/platform/executions/`), every final design re-evaluated
  headlessly (`core/platform/crosscheck.py <execution> --config <config> --values values.json`, also the check
  against the platform's values), the references (the as-built cut and the monolith with the same five seeds) and
  the explorer export (`core/platform/to_run.py`, then `pnpm export:run` in `core/explorer`) for the designs'
  structure.

## Machine-wide locks

Heavy work goes through `core/tools/wait-for-machine.sh`. Two locks live in the repository root (gitignored):
`MEASURING.lock` (a timing measurement window is running: no new heavy work; created by the campaign's
`measure.py`, honoured by `wait-for-machine.sh` and the harness) and `STACK.lock` (owner of the MiSArch Docker stack,
`cases/misarch/timing/timing-up.sh`). Run heavy processes under `prlimit --as=…` and `MALLOC_ARENA_MAX=2`.

## Principles

- The plugin does Palladio only: plain PCM and its simulation. Everything above PCM, the architecture decisions and
  the domain layer, is realised in the model by `.mt` transformations and kept consistent by an incremental repair
  after every operator; the metrics over the decision layers are `.fn` functions over the model and the plugin's
  results. mdeo's optimizer has no hook for this problem.
- No commit counts are used as data (MiSArch's services were developed by different people).
