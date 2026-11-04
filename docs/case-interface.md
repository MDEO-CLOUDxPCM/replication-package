# The case interface

What a case (an architecture to optimise) provides to the core, so that a second architecture can be added next to
MiSArch (`cases/misarch/`, the worked example). [model.md](model.md) describes what the core derives from these
inputs.

## The manifest

`cases/<case>/case.json` (schema `core/generator/schema/case.schema.json`; read by `core/tools/case.py`, checked by
`core/tools/check_case.py --case <case>`). Paths are relative to the case's directory. `ARCH_CASE=<case>` selects
the case for every core tool (default `misarch`).

| key | what | format | MiSArch |
| --- | --- | --- | --- |
| `inputs.domain` | the domain extraction: classes by owning service, references, operations with triggers, accesses per class and mode (today's mechanism of each), calls (one invocation into nested fields of the callee: `to` lists them, `parents` says on whose objects each is resolved; a call of an external provider is an effect, `effect: true`), every strong read and strong call with its `consistency` {level strict | stale-ok | immutable, rules, reason}, which decides its mechanisms ([model.md](model.md#call-sites-and-their-mechanisms)), published events, copies, gateway joins, transactions, sagas, request plans, seed demands | `schema/domain.schema.json` | `domain/misarch-domain.json` (`extract/build.py`) |
| `inputs.sessions` | the session usage model: requests and their operations, session classes as steps (calls, think times, fragments, loops, branches), workloads with mixes, load profiles with phases | `schema/sessions.schema.json` | `workload/sessions.json` |
| `inputs.sessionModel` | the case's session module: imports `core/generator/sessions.py` and provides its calibration (`LOGIN`, `workload_rates`, `pcm`, `loadprofile`, `role_sig`; optional `request_rates(model)`: requests/s per session request, the weights of an operation's per-request parts) | Python module | `generator/gen_sessions.py` (round 2's rates, the admin class, the login) |
| `inputs.platform` | the platform's parameters, `S[...]` of the derivation: sidecar and broker costs, the entry's compose CPU, local copies' and caches' costs, cores per replica and database server, cost rules | `schema/platform.schema.json` | `generator/platform.json` (`generator/platform.py` from round 2's msa model and the campaign's mechanism parameters) |
| `inputs.parts` | the measured parts per operation (own CPU, per request) and per access (database ms, mapping CPU, statements), the at-load scales k_c, the order path's cardinality terms; version 3 adds the effect steps' envelope | `schema/parts.schema.json` | `timing/parts.json` (`timing/analysis/parts.py`) |
| `inputs.envelopeEstimate` | the envelopes while `parts` has none (parts version 3 has its own): the effect steps' envelope and, in its request rows, the receiving envelope of a synchronous call across containers | `schema/envelope-estimate.schema.json` | `timing/envelope-estimate-v2.json` |
| `inputs.latencyFit` | the latency-only waits (statement round trip, commit delay, publish wait); placeholders while missing | `schema/latency-fit.schema.json` | `timing/latency_fit.json` |
| `inputs.cacheHits` | per call site that allows a cache its hit ratio and stale share (the profile's key streams) | `schema/cache-hits.schema.json` | `mdeo/models/domain-cache-hits.json` (`generator/cache_hits.py`) |
| `inputs.budgets`, `inputs.bounds` | today's simulated statistics per request type and today's objectives, the references of C1's budgets and of the ObjectiveBounds; none while missing | written by `core/tools/gen_domain_budgets.sh` | `mdeo/models/domain-today-{p95,objectives}-day.json` |
| `generator.adapter` | the adapter module (below) | Python module | `generator/misarch.py` |
| `mdeo.models` | the base models the derivation writes (`domain-{neutral,today,monolith,perclass}.m`), staged as `models/` | mdeo `.m` | `mdeo/models/` |
| `mdeo.seeds` | the realised seeds (`domain-<seed>-realised[-1sim].m`), staged as `models/` | mdeo `.m` | `mdeo/seeds/` |
| `mdeo.configs` | the optimisation configs, staged as `optimize/domain/` (their `using`/`model =` paths are relative to that staged place) | mdeo `.config` | `mdeo/configs/` |

`<case>/platform.json` (optional) names the case's project on the mdeo platform (`projectId`; `core/platform/`).

## The adapter

The core's derivation (`core/generator/derive.py`) derives a microservice system of one style: one component and
one schema per domain class, an **entry** component that serves every request type of the usage model (MiSArch: the
GraphQL gateway; its joins are call mechanisms), a **broker** that delivers every message, an **authentication**
component that serves the login, and pools of application containers and database servers. The adapter names these
fixed parts and writes their objects; it also holds the case's rules and calibration. `core/generator/case-stub/`
has a stub of the adapter and of the manifest; `check_case.py` lists what is missing.

| name | what |
| --- | --- |
| `NAME`, `REPOSITORY`, `TITLE`, `DOMAIN_SOURCE`, `SEED_TEXT` | the System's, Repository's and Domain's names; the models' header texts |
| `ENTRY`, `ENTRY_IFACE`, `ENTRY_CONTAINER`, `ENTRY_CPU` | the entry component, its interface, its container and the platform parameter of its CPU per request |
| `BROKER`, `BROKER_IFACE`, `BROKER_CONTAINER` | the broker (`RemoteCalls.broker`; C2 bounds its container) |
| `AUTH`, `AUTH_IFACE`, `AUTH_SIG`, `AUTH_CONTAINER`, `AUTH_REQUEST` | the authentication and the usage-model request it serves |
| `FIXED`, `PROVIDED`, `FIXED_PLACEMENT` | the fixed components, the System's provided roles, their containers |
| `skip_request(key)` | a usage-model request that is no request type of the entry (the login) |
| `glue(d, ops)` | operations that are glue of the entry's joins, not domain operations (MiSArch: federation `_entities` resolvers) |
| `trigger_type(o)` | the class an operation's trigger belongs to (MiSArch: the GraphQL type) |
| `role_sig(req, entry_sig)` | the provided role and signature of a usage-model request |
| `entry_comments(b, S)`, `components(b, S)`, `containers(b, S)`, `deployables(b, S)`, `prices(S)` | the fixed parts' objects, written through the core's builder `b` |
| `PROCESS_CRITICALITY`, `DEFAULT_CRITICALITY` | business criticality per saga (every saga of the domain) and of work of no process (O2) |
| `CHANGES_PER_YEAR`, `CHANGES_TEXT` | the system's releases a year (O2, O3), shared by the classes by their domain operations |
| `CACHE_TTL_S`, `CACHE_TEXT`, `COST_TEXT` | a cache's TTL (O4); comment texts |

The rest of the derivation (decisions, mechanisms and their options, workflows, homes, the quality model, the
budgets, the domain section and its trace) and every MDEO source (`core/mdeo/`) are the core's. A case whose
architecture does not fit this style (no entry component, several brokers, ...) extends the engine instead.

## Adding a case

1. `cp -r core/generator/case-stub cases/<case>` and lay out the inputs above (an extraction of your own producing
   the domain format; a session model; timings, or seed demands in the domain's `msaMapping.seedDemands` for
   operations without parts).
2. Fill in the adapter; `core/tools/check_case.py --case <case>` until it reports `case ok`.
3. `ARCH_CASE=<case> core/generator/derive.py` (needs the harness, `core/harness/setup-worktree.sh`; it stages
   `build/project/<case>-gen/` and writes `mdeo/models/`), `core/generator/perclass_seed.py`, then
   `SEEDS="1 2 3 4 5" core/tools/gen_domain_budgets.sh` (as many seeds as the models' simulations per evaluation)
   and `derive.py` and `perclass_seed.py` again for the references of C1, O3, C4 and C5,
   `core/tools/realise-seeds.sh` for the seeds ([model.md §4](model.md#4-running-the-derivation)); configs in `mdeo/configs/` (copy MiSArch's); `ARCH_CASE=<case> core/tools/run-domain.sh
   optimize/domain/<config> <run>`.

Every tool of the core takes the staged project (`build/project/<case>/`, `core/tools/stage_project.py`) as its MDEO
project root; a case never needs a copy of the core's MDEO sources.
