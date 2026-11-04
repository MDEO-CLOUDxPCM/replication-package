# Running in the mdeo platform

The paper's two runs ran in the mdeo platform (the workbench and its optimizer, mdeo-cloud), every candidate simulated
by SimOxide through the Palladio Simulation plugin (`palladio-sim-service/`). The headless harness
(`core/tools/run-domain.sh`) runs the same configs on one machine; this file is about the platform.

## One machine

`docker-compose.yaml` starts mdeo 0.2.12 from its published images with the plugin built from the submodule
`palladio-sim-service/`, and `core/platform/setup-local.sh` does §1.3 and §2 below (the plugin registered as
`http://palladio-sim:3022/`, a project with it enabled, the files of the paper's two configs and of
`smoke-3obj-5sim.config`, the check of `metrics.fn`):

```bash
git submodule update --init
OPTIMIZER_THREADS=16 SIM_THREADS=16 docker compose up -d --build  # the workbench: http://localhost:4242 (admin/admin)
core/platform/setup-local.sh                                      # prints the project id (PID=...)
```

Then open `optimize/domain/smoke-3obj-5sim.config` in the workbench and press **Run** (§4). The settings and their
defaults are in the header of `docker-compose.yaml`.

## 1. The plugin

1. Build `palladio-sim-service` (`cargo build --release` in `palladio-sim-service/`; SimOxide is in its `simoxide/`,
   or `docker build`). For values comparable with the headless harness, use the same binary (`core/tools/run-domain.sh`
   copies `palladio-sim-service/target/release/palladio-sim-service` into its build directory as `plugin-bin`).
2. Start it where the mdeo backend can reach it and it can reach the backend:

   ```bash
   PORT=3022 BACKEND_API_URL=http://<backend host>:8080/api SIM_THREADS=<cores> \
   target/release/palladio-sim-service serve
   ```

   `curl -s http://<host>:3022/ | jq .version` prints the version the platform records.
3. Register it under **Settings → Plugins** with the URL the backend and the execution services reach it at (e.g.
   `http://palladio-sim:3022/`; name "Palladio Simulation", contribution `palladio-arch`). After a new plugin build,
   re-read its manifest there (or `core/platform/refresh.mjs`) instead of adding a second registration.

## 2. The project

1. **Create a project** and **enable "Palladio Simulation"** in it before adding files (`metrics.fn` type-checks
   only with the plugin enabled). API: `POST /api/projects {"name": ...}`, then
   `POST /api/projects/<id>/plugins {"pluginId": "<plugin id>"}`.
2. **Push the files.** The project is a git repository at `<backend>/git/<project id>.git` (basic auth):

   ```bash
   USER_NAME=<user> PASSWORD=<password> core/platform/push.sh <project id> http://<backend host>:8080
   ```

   The project then holds exactly the two configs `optimize/domain/today-3obj-5sim.config` (Built) and
   `optimize/domain/perclass-3obj-5sim.config` (PerClass) and every file they reach (`core/platform/closure.py`:
   the metamodels, the two realised seeds, the transformations and `metrics.fn`), 156 files, plus the platform's own
   `project.mdeo`. The layout is the staged project's (`metamodel/`, `models/`, `optimize/`, `transform/`;
   `core/tools/stage_project.py`), so the relative paths in the files hold. Any other file in the project is removed,
   and a fresh clone is compared byte by byte with the staged files after the push.
3. Open a config once: no red files in the tree, no error markers (`core/platform/check.mjs` does this through the UI;
   `GET /api/projects/<id>/file-data/diagnostics?path=/transform/metrics.fn` must list none).

MiSArch's project is `cases/misarch/platform.json` (`projectId`), which the tools below use unless `PID` is set.

## 3. The seeds

The platform's optimizer starts from the model file the config names as it is: generation 1 is that model mutated
once per individual, and nothing realises it first. So the configs name realised models,
`models/domain-today-realised.m` and `models/domain-perclass-realised.m` (sources: `cases/misarch/mdeo/seeds/`):
the harness's realisation (`core/mdeo/transform/realise.mt`) of the derived models, written as `.m` by
`core/platform/realised_to_m.py` (a `// Source: <model> sha256 <hash>` line names the model they came from). Exported
again with the platform's language services (`core/harness/export.mjs`) they give exactly the harness's model data.
Their LoadProfile has `replications = 5.0`: five simulations (seeds 1–5) per evaluation.

After a change of the models or of the realisation, remake them with `core/tools/realise-seeds.sh` (only the seeds
whose model changed; it also writes the one-simulation forms `-realised-1sim.m`, which `core/platform/to_run.py`
and the explorer use), then push again. Realising again names the generated elements in another order, and
simulation results depend on names, so for comparable values keep the committed seeds.

## 4. Running and results

Open the config and press **Run** (the triangle at the top right of the editor); the workbench posts
`POST /api/projects/<id>/executions {"filePath": "/optimize/domain/<config>", "data": {}}`. The Executions panel shows
the run; its summary has the final population, the per-generation plots and the solution models
(`solution_<i>.m_gen`).

| tool (`core/platform/`) | does |
| --- | --- |
| `run.mjs <folder/...> <config> <shot>` | open the config in the workbench and press Run |
| `status.mjs`, `wait.sh` | list the project's executions; wait until none is queued or running |
| `cancel.mjs <execution id>` | cancel a running execution |
| `api.mjs <METHOD> <path> [body]` | one backend API call with the workbench's session |
| `dl.mjs` | download report, summary and solution models of the executions to `build/platform/executions/<config>/` (`BYID=1`: `<config>-<id8>`; `IDS=`, `SINCE=`) |
| `dl.py <id prefix>...` | the same over plain HTTP with the session cookie of `build/platform/state.json` (log in once with any `.mjs` tool), for large executions |
| `crosscheck.py <execution> --config <config>` | re-evaluate the downloaded solutions with the headless harness and compare with the platform's values (`--values` keeps every solution's values) |
| `to_run.py <execution> <run dir> --seed …` | turn a downloaded execution into a run directory for the explorer (`core/explorer/README.md`) |

The browser scripts need `playwright-core` 1.56.1 and a Chromium: `cd core/platform && npm i playwright-core@1.56.1`
(`node_modules/` is ignored), `CHROME=<chromium binary>`, `BASE=<workbench url>`, `USER_NAME`/`PASSWORD`,
`PID=<project id>`.

## 5. After a push that changes a metamodel

The platform's language service can keep stale types of `domain.mm` (which imports `architecture.mm`) and a stale
typed-AST closure of `metrics.fn`: an execution then stops with "Could not load script /transform/metrics.fn or a file
it imports" although the editor shows no error. After such a push, re-process `domain.mm` and then `metrics.fn`
(append a comment line to each in the project and push; the next `push.sh` restores the repository's files) and check
`GET /api/projects/<id>/file-data/typed-ast-closure?path=/transform/metrics.fn` (not `"data":null`) and its
diagnostics (empty) before running.
