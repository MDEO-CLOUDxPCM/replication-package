# Cut Explorer

A local app to post-process the optimisation results of this project: runs and their convergence,
the designs of a run (Pareto front, filters, brushing), a design's class-to-service cut as a graph,
two designs side by side, and the performance of request types, operations and sessions.

## Start

```
cd core/explorer
pnpm install          # once (pnpm via corepack, Node 24)
                      #   (its postinstall links node_modules into each cases/<case>/explorer-packet: tools/link-packets.mjs)
pnpm packet:misarch   # the MiSArch packet in ../../build/explorer-sim (input model, docs, Verify parts, packet.json)
cp server.local.example.json server.local.json   # once: let the MiSArch packet simulate designs and rebuild itself
pnpm dev              # backend :5181 + Vite :5180  ->  http://localhost:5180
```

Production: `pnpm build && pnpm start` (backend serves `dist/` on :5181). Ports:
`EXPLORER_API_PORT`, `EXPLORER_WEB_PORT`. Detail cache: `EXPLORER_CACHE` (default
`../../build/explorer-cache`). Checks: `pnpm test` (contract, layout adapter, diff and effect steps, sources, packets
and the fixture packet, the case-code lint, the Verify viewer; the MiSArch packet's own tests in
`../../cases/misarch/explorer-packet/tests/`, skipped when their inputs are missing) and `pnpm typecheck`. Under
`prlimit --as=…` tsx needs `NODE_OPTIONS=--disable-wasm-trap-handler`.

## Runs into the explorer

Every design of a run is evaluated by SimOxide simulations (the plugin's `pcmEvaluate`, Palladio semantics, the HPA
scaling every application container) under the model's load profile (the day). The explorer lists the runs in
`../../build/explorer-sim` (`sources.json`), domain `misarch-kotlin-derived`: the current model, `models/domain-*.m`.

A run needs a **build**: a directory prepared by `core/tools/run-domain.sh` (`PREP_ONLY=1` for the preparation only:
exports, realised seeds, their values in `eval/values.json`, the plugin; `ARCH_DIR` sets the directory). A headless
run writes its run directory into `<build>/runs/<name>`; a platform execution (downloaded with
`core/platform/dl.mjs`) is converted into one with `core/platform/to_run.py`. The seed must be the platform's own (the
committed realised seed it started from, exported to model JSON with the harness's `export.mjs --only models`): the
decision diffs are taken against it.

```
# from the project root: a platform execution -> <build>/runs/<name>
python3 core/platform/to_run.py build/platform/executions/<execution> <build>/runs/<name> \
    --seed <build>/realised/<seed>.model.json --seed-name realised/<seed>.model.json \
    --config cases/misarch/mdeo/configs/today-3obj-5sim.config
cd core/explorer
pnpm export:run --run <build>/runs/<name> [--seed <build>/realised/<seed>.model.json] [--id domain-<name>] [--name "…"]
                      # -> ../../build/explorer-sim/runs/<id>: seed, config, references (today, monolith, as far as
                      #    the build has them), values and plugin version from the run's build
pnpm dev              # or POST /api/reload if it runs
```

`export:run` writes the run's evaluation (`config.evaluation`: profile, window, phases, C1's statistic, factor and
budgets, C2's containers and limit, plugin version) and its build (`config.raw.buildDir`), every evaluated design
(`designs.jsonl`) with its decisions and its structure metrics (services, database servers, local copies,
cross-service synchronous accesses, effect steps), the archive, the final population (with the models the harness or
the platform saved) and the references. `--box '{"ideal":[…],"nadir":[…],"label":"…"}'` puts several runs'
hypervolumes into one box so they compare.

**A design's performance.** Opening a design's performance simulates it again with exactly the search's request (the
packet's `simulate` command, `core/tools/design_detail.sh` in the run's build, when `server.local.json` allows it:
references and saved solutions as they are, other designs rebuilt from the seed and their decision links; one at a
time, cached in `../../build/explorer-cache` per build, profile and plugin version). The Performance panel recomputes
C1 and C2 from that simulation and says whether they (and the peak utilisation and pods the search reported) equal the
design's values.

**The input model follows its inputs** (`server/model-sync.ts`): the export records every input with its content hash
(the extraction, the workload, the timings, the committed realised seeds `cases/misarch/mdeo/seeds/domain-<seed>-realised.m`,
the metamodels, the exporter's code); the backend hashes them again when it serves the model and, when one changed,
rebuilds the packet in the background with its `rebuild` command if `server.local.json` allows it (the Model panel
says so and reloads), else shows the model as stale. What it cannot redo is reported there: a realised seed older than
its model (`core/tools/realise-seeds.sh`), a model older than what `core/generator/derive.py` made it from. A run
records its seed's fingerprint (`modelFingerprint`); the backend tags it `earlier-model` when that is none of the
input model's seeds (listed in a group of its own, never opened by default). `pnpm export:model [--build <build>]`
exports the input model alone.

A second instance for checks: `EXPLORER_SOURCES=<sources file> EXPLORER_API_PORT=5191 EXPLORER_LOCAL_CONFIG=/nonexistent npx tsx server/main.ts`
plus a Vite config with another port, proxy and `cacheDir` (the running dev server is not touched; no local config:
it runs no command of a packet, so it never writes into the packet).

## Data packets

The explorer is generic: what it shows of an architecture comes in a **data packet**, a bundle (`domains/`, `runs/`,
`models/`) plus a manifest `packet.json` and the files it names: `docs/` (the texts, the metric docs of every `?`, the
How pipeline, the Interactions examples), `verify/` (the Verify tab's parts, causes and chains, precomputed), the
vocabulary, the capabilities that turn panels and tabs on or off, named source trees (a git repository at a commit,
a directory under allowed prefixes) and commands. The format, its JSON Schema and how to write a packet for another
architecture: [docs/packet-format.md](docs/packet-format.md). A minimal packet without any case code:
`tests/fixtures/packet-tiny/` (a made-up bookshop; `tests/packet-fixture.test.ts`, `tests/packet-web.test.ts`).

| layer | | |
| --- | --- | --- |
| generic | runs, designs, Pareto views, objectives, architecture graph and compare, a design's detail | `contract/`, `server/`, `sources/`, `layout/`, `web/src/` |
| family `palladio-architecture` | the input model (SEFFs, call sites, mechanisms, effect steps, homes), the Model panel and its Interactions tab, the plugin's detail simulation, C1/C2 | the same code, gated by `packet.family` and `capabilities` |
| case (MiSArch) | texts, metric docs, Verify parts, source trees, commands, paths | `../../cases/misarch/explorer-packet/` builds the packet |

**The MiSArch packet.** `pnpm packet:misarch [--out <dir>] [--only model,docs,verify] [--link-runs <bundle>] [-- <export-model args>]`
(`../../cases/misarch/explorer-packet/build.ts`) writes into `../../build/explorer-sim` (`MISARCH_PACKET`): the input model
(`export-model.ts`), the docs (from the modules `docs/*.ts`: `metrics.ts`, `how.ts`, `interactions.ts`, `texts-*.ts`,
`vocabulary.ts`), the Verify files (`verify/`: the part builders over the extraction, the inventory, the workload,
misarch-kotlin's tree at the extraction's commit and the input model; `chains.py` on `cases/misarch/extract/callgraph.py`)
and `packet.json` (roots, source trees, commands, capabilities, measures, every input with its hash, the fingerprint);
a few seconds. `pnpm export:run` exports runs into the same directory. **Every path of the case** — the extraction,
inventory, workload, timings, realised seeds, metamodels, misarch-kotlin (`MISARCH_KOTLIN`), the harness (`ARCH_WT`),
`core/tools/design_detail.sh`, the build directories, the Verify tab's project files, the How tab's origin table — is in
`../../cases/misarch/explorer-packet/config.ts` and nowhere else.

**Commands.** A packet declares `simulate` (a design's detail: `core/tools/design_detail.sh` in the run's build) and
`rebuild` (`pnpm packet:misarch` again when an input changed); the backend runs them only when its local
configuration allows it: `server.local.json` (gitignored; `server.local.example.json` allows both for `misarch`),
`EXPLORER_LOCAL_CONFIG`, or `EXPLORER_ALLOW_COMMANDS=misarch:simulate+rebuild`. Without it the Performance panel's
simulation answers that the packet may not simulate, and a changed input shows the input model as stale.

**Sources.** `sources.json` `packets` lists the packet directories (`EXPLORER_PACKETS` adds more); a plain bundle in
`sources` (`{id, kind: "bundle", path}`) is a packet with defaults; a `sources.local.json` (gitignored) replaces the
file. The Verify marks are kept per packet (`explorer-verify-v1:<packet>` in localStorage).

The lint `tests/no-case-code.test.ts` keeps the generic code free of the case: no case names anywhere (comments
included), no citation ids (`§…`, `AB<n>`, `AA<n>`), case paths or case class names in user-visible strings, no imports of
a case.

## Workspace

One page (`/`), no view tabs. The header holds the brand, the panel buttons, designs A and B, the
data sources and the theme. Four panels side by side, a drill-down from left to right, and the Model panel beside them:

| Panel | shows |
| --- | --- |
| Runs | run list and the selected run's overview: config, hypervolume, convergence per objective, final distributions, time per generation |
| Designs | the run's designs as scatter / matrix / parallel coordinates and a virtualised table, hover linked both ways. Click = A, shift-, alt- or right-click = B (keys ↑ ↓ a b). Drag in the scatter or matrix marks an area (shift-drag: one more, ×: remove one, Reset or Esc: all); parallel coordinates: drag along an axis. The table shows the marked designs |
| Architecture | A alone: its graph (services with their classes, dependencies, side tabs overview / services / operations / accesses / effects / sagas; Effects: every effect step with its mechanism and whether it joins the caller's transaction, else why not). A and B: the compare (B placed at A's positions, one shared pan/zoom, colours follow matched services, moved classes and changed mechanisms marked, effect steps whose mechanism or joining changed, objective and p95 deltas) |
| Performance | the design's simulation as the search evaluated it (A alone or A vs B): C1's statistic per request type against its budget, pods over the load profile, per request type / operation / session CDF, histogram and per-bin series with the profile's phases; pods, ready pods and utilisation per scaling group (HPA activity); databases and broker per bin against C2's limit; failed or capped simulations and any difference from the search's values marked |
| Model | how MiSArch is the optimisation's input: Overview (how a design is built, origin, parameters), Domain (class diagram, a class's references, operations, accesses), Operations (the entry points — request roots and provider callbacks — each opening into the downstream operations it reaches through call sites, every link with its kind, allowed mechanisms and, with A, A's mechanism and its placement; a downstream operation's paths from the entry points; flat lists of the downstream or all operations), Interactions (every kind of interaction with its mechanisms as sequence diagrams, grouped by fetch / effect: the effect step "operation A causes a change at class B" with the mechanisms in transaction / sync step / async message, the attributes of today's writes, event reactions and callbacks, when in-transaction joins and why not, the home of an operation as a decision), Workload (request types with C1's budgets per profile and how one request expands, sessions, the model's load profile), Metamodels (layers 1–3 and PCM as class diagrams), Verify (the model of MiSArch in parts — classes, references, operations, events, joins, bindings, sagas, request types, features, timings, session classes, load profiles, the workload, parameters — each claim with its evidence in misarch-kotlin at the extraction's commit and the schema, port spec, fix notes and curated facts beside it; per service a coverage part maps misarch-kotlin's inventories to the parts; the source view is highlighted (Shiki, grammars loaded on demand) and the calls between the functions from an operation's entry to its steps are links (`verify/chains.py`, precomputed by `pnpm packet:misarch` like the parts); a part is marked verified or an issue, kept in the browser). With A selected it shows where things live in A and A's mechanisms |

**Labels: mechanism, placement, own data.** A *mechanism* chip is only a call site's decision
(the vocabulary's `mechanisms`: sync, async, in transaction, cache, copy, join, join + cache; on the Architecture graph
the per-access sync, copy, cache, join, saga). Where a call runs is its *placement*, one badge everywhere (call tree,
Operations list, an operation's and a class's details, Architecture › Accesses / Effects, the compare): **no hop**
(caller and callee in one container: a direct call, no middleware, network or receiving envelope) or **remote →
<service>** (the hop, and for a synchronous call the receiving envelope). An access to the operation's own
home class is **own data**, the third placement badge, always beside its fixed mechanism chip (no call site): a read
**sync**, a write **in transaction** (the operation's own transaction). A request plan entry's `via` reads root
resolver, parent's service or gateway fetch. The Interactions tab explains the badges once (packet doc
`interactions.placement`, texts `placement.*`; `web/src/components/PlacementBadge.tsx`).

**Consistency levels.** How current a read of another class or a call of another operation must
be, curated per statement by the case: **strict** (sync only; a copy only where today's code reads its own store),
**stale-ok** (sync, cache or copy, priced by O4), **immutable** (as stale-ok, no staleness cost). A compact chip
"strict · S2" beside the mechanisms, its tooltip the rules' texts and the curated reason; an operation's details list
what is *sync only by its level* with the reasons. `lock` marks a statement that only locks, `effect · E1` an effect
call (a registration with an external provider). The Interactions tab explains the levels and lists the rules once
(`web/src/components/LevelChip.tsx`, `contract/consistency.ts`).

Every objective, constraint and metric has a `?`: a popover with the definition, the computation as implemented
(formula, inputs, assumptions, the model's parameter values) and its sources (`web/src/lib/metricDocs.ts`).

Panels: a header button opens a closed panel, collapses an expanded one to a rail and expands a
rail; every panel header has collapse and close (Runs only collapse); closing a panel closes the
panels to its right (not Model, a reference beside the drill-down). Links into the Model panel: the book icon on
operation, request type and session rows, linked class and operation names, right-click or alt-click on a class node of
the graph, the links in a `?` popover. Selecting a design opens Architecture. When the open panels do not fit their
minimum widths, the leftmost collapse to thin rails first (the panel last opened or expanded stays);
click or drag a rail to expand it; dragging a divider far below a panel's minimum collapses it.
Divider positions are kept in localStorage.

The graph shows components (services) by default; clicking a service shows its classes;
`components | detailed`; `merged | by type`: by default every dependency type between two nodes is
one arrow per direction (width by rate, tooltip lists the types and operations), `by type` draws
one arrow per mechanism (colour and dash), the legend toggles layers in both. Edges run orthogonally from
border to border around the other nodes (`layout/route.ts`). Nodes can be dragged (services with
their classes, classes inside their service); the edges follow; positions are kept per layout,
the re-layout button drops them.

URL (shareable): `/?run=<run>&a=<design>&b=<design>&p=designs,arch,perf&rail=runs` plus the panels'
own parameters: Designs `mode=scatter|matrix|parallel&x=&y=&color=&feas=1&front=1&arch=1&sort=&area=<x>,<y>,<x0>,<x1>,<y0>,<y1>`
(repeated), Architecture `detail=1&open=&collapsed=&hide=&edges=classes&types=1&layouter=&tab=&op=`,
Performance `ptab=&key=&m=`, Model `model=<target>&mtab=&mgroup=&mattr=&mview=&mused=` (targets: `how`,
`param:<Class>`, `domain`, `class:<id>`, `ops`, `op:<id>`, `workload`, `req:<id>`, `session:<id>`, `mm:<id>[/<Class>]`,
`verify[:<part>]`). A design of another run is `<run>~<design>`.

Every chart and graph exports as SVG and PDF in the light theme (download icon). Theme: system by
default, toggle top right. Chart legends wrap into rows (never clipped or paged).

## Effect steps and homes

Every write of another class, event reaction and provider callback is one **effect step**: operation A causes a change
at class B. Mechanisms: **in transaction** (`inTx`: B's work as a local call inside A's transaction, no envelope,
commit or message), **sync step** and **async message** (B's step form `I<B>.<x>_step` in B's own transaction:
envelope, work, B's commit). In transaction *joins* only while A's and B's components share a container and their
schemas a database server and the step is no orchestrated workflow step; otherwise it is a synchronous step. The
explorer shows why a step does not join: `apart` (not co-located), `servers` (the schemas on different database
servers), `orchestrated`, `external` (callbacks: async only), `chosen` (another mechanism). `export:model` writes per
effect site `effect.step` (step form, work, commit SEFFs, envelope ms, the two schemas) and `effect.joined` per seed;
`export:run` writes `domain.effectSites` and per design `decisions.effects` (`{m, joined?, why?, together?}`, the join
condition of the realisation evaluated on the design's placement) and the metrics `joinedSteps`, `inTxSteps`.

**Home as a decision** (layer 2's `Home {operation}` with `HomeOption {cls}`, decision link `home`, `written` = today's):
`export:model` writes `homes[]` (options with their SEFFs, written, the seeds' choice), `seffs[].home` and `sites[].home`
(the option SEFFs and their sites, inert while another option is chosen); `export:run` writes `domain.homes`,
`decisions.homes` (the chosen class) and places the operation at its chosen home (`operationPlacement`).
**Network** (`RemoteCalls.networkMs`, an assumed value): shown in the Interactions header, How and the C1 and slow
requests help.

## Large runs

A run exports every evaluated design, so it has tens of thousands of designs. The explorer is built for that: the
designs are a **dense layer** (`web/src/charts/dense.ts`), a canvas under the ECharts canvas: points as sprites
(overlaps accumulate, one draw per pixel), hover and click through a pixel grid index, the hover mark on a canvas above;
ECharts keeps the axes (scaled by an invisible bounds series), the brush and the few overlay marks (A/B, references).
Parallel coordinates draw a layer line by line up to 2 500 lines and **decimate** beyond: per pair of neighbouring axes
the segments are binned (≤ 160 × 160 bins) and drawn once per occupied bin pair, opacity by log count; hover
interpolates every line at the pointer. Brushing selects from the data, not from drawn items. The **SVG export** draws
the same layers as SVG paths (points on the same half pixel merged; decimated lines as a few paths per opacity level).
The **table** is virtualised (TanStack Table + Virtual); URL changes that do not touch its filter or sort do not
re-filter or re-sort. The backend streams `designs.jsonl`, keeps summaries and byte offsets only, serves the list from
a cached gzip body and reads one design's decisions on demand.

## Architecture

```
contract/   types.ts (the contract), hash.ts, derive.ts (cut -> accesses, edges, sagas), diff.ts,
            pareto.ts (ranks, hypervolume), schema/ (generated), validate.ts, CONTRACT.md,
            packet.ts (the packet manifest), verify.ts (the Verify files), metamodel.ts (the .mm parser)
sources/    bundle.ts (explorer bundles and packets), source.ts (the Source interface)
server/     main.ts (Hono), app.ts (the routes), registry.ts (sources, packets, index, detail cache), packets.ts
            (manifest, docs, Verify files, source trees, commands, staleness), local-config.ts (allowCommands),
            model-sync.ts (the input model against its inputs), simulator.ts (the packet's simulate; a synthetic
            stand-in for the tests)
layout/     types.ts (Layouter interface), engines.ts (catalogue), worker.ts (the layout worker),
            index.ts (main-thread proxy, layout cache), tala.ts + tala-engine.ts (TALA via orthoflow,
            architecture graph and ungrouped class diagrams), elk.ts + elk-graph.ts (elkjs, grouped
            class diagrams), route.ts (orthogonal routing after drags), pin.ts (compare pinning)
dummy/      synthetic test data: generate.ts (a bundle over a contract domain; tests/contract.test.ts),
            search.ts (small NSGA-II), model.ts (analytic objectives), simulate.ts (synthetic detail)
web/src/    views/ (Workspace + the panel bodies), lib/workspace.ts (panels, fit, URL),
            graph/ (React Flow + SVG export), charts/ (ECharts + dense canvas layers),
            model/ (the Model panel: class diagrams, details, SEFF trees; verify/ the Verify viewer), help/ (the `?` popovers, KaTeX;
            Rich.tsx the packet texts' markup), lib/packet.tsx (the workspace's packet: texts, docs, capabilities,
            vocabulary), lib/metricDocs.ts (the metric docs' types), lib/modelTarget.ts (`model=` targets),
            components/ (shadcn/ui; ScrollArea for every scrolling region)
tools/      link-packets.mjs (links node_modules into the case packets' builders)
tests/      the tests; fixtures/ packet-tiny (a non-MiSArch packet, made by make-packet-tiny.ts), verify-mini
            (the Verify viewer's fixture)
docs/       packet-format.md (the packet format and its schema)
../../cases/misarch/explorer-packet/  the MiSArch packet (the case, ../../docs/case-interface.md): config.ts (every case path),
            build.ts (pnpm packet:misarch), docs.ts + docs/ (texts, metrics, how, interactions, vocabulary),
            verify/ (the Verify parts' builders, chains.py), export-model.ts, export-run.ts, evaluation-setup.ts,
            domain-a.ts (the extraction), workload-c.ts (the workload), tests/
```

Stack: Vite 7, React 19, TypeScript 5.9, Tailwind 4, shadcn/ui (Radix), React Flow 12, orthoflow
0.1 (TALA, WebAssembly), elkjs 0.11, ECharts 5.6 (canvas on screen, SVG renderer for export), jsPDF + svg2pdf, TanStack
Query/Table/Virtual, Hono 4.

## Adding a source

`sources.json`:

- `packets` (top level): packet directories, a path or `{id, path}`; `../../build/explorer-sim` (the MiSArch
  packet). `EXPLORER_PACKETS` adds more.
- `sources`: further bundles, `{id, kind: "bundle", path, hint?}` (a packet when it has a packet.json, else one with
  the defaults). A missing directory is fine (0 runs).

A new kind: implement `Source` (`sources/source.ts`: `load`, `status`, `runs`, `domains`, `run`,
`designs` (summaries), `design` (one design with decisions), `detail`), map to the contract types,
add a `kind` in `server/registry.ts` and an entry in `sources.json` (or `sources.local.json`). Run
ids must be unique across sources. Test with `contract/validate.ts` on what it returns.

## Layouters

Layouters run **in the browser, in the layout web worker** (`layout/worker.ts`); the main thread
talks to them through a proxy with the same shape (`layout/index.ts`), so a slow layout never blocks
the UI. The proxy caches results by graph (in memory and in IndexedDB, keyed with
`ENGINES_VERSION`), lays a graph out once however often it is asked for, sends the worker one job at
a time, drops jobs nobody waits for and terminates the worker to cut a running one short when
another graph is asked for meanwhile.

- `tala` (default): TALA, D2's orthogonal layout engine, via [orthoflow](https://www.npmjs.com/package/orthoflow)
  (WebAssembly, `layout/tala.ts` + `layout/tala-engine.ts`). Groups are TALA containers whose label
  reserves the header; TALA grows nodes to fit their ports, so leaves are drawn at their own size in
  the middle of the grown box and their routes are continued to the real border; an edge TALA could
  not route (a diagonal) is routed by `layout/route.ts`. Edges are undirected (arrowheads at both
  ends) unless `graph.directed` (the class diagrams: TALA then ranks the nodes along the edges).
  Three seeds up to 80 nodes + edges, one above.
- `elk-packed` (hidden): grouped class diagrams (the domain diagram by service or aggregate), groups
  laid out inside and rect-packed (TALA spreads many small groups over a much larger area).

Another engine: implement `Layouter` (`layout/types.ts`) in a module of its own (it runs in the
worker: no DOM; a WASM file is bundled by Vite with `?url`) and add an entry to `layout/engines.ts`;
with more than one visible engine the architecture panel shows a layouter menu (`?layouter=<id>`).
A result needs absolute boxes per node and may leave edges unrouted (`completeRoutes` in
`layout/pin.ts` routes them). `registerLayouter` (`layout/index.ts`) adds a main-thread layouter
instead (tests, experiments).

The compare view does not lay B out on its own: `pinLayout` (`layout/pin.ts`) places B at A's
result, whatever layouter produced it.
