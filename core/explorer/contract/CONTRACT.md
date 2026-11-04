# Explorer data contract, version 1.14.0

The format the explorer reads and the project's exporters write. Types: `types.ts` (the source of
truth); JSON schema generated from it: `schema/explorer-contract.schema.json`
(`pnpm contract:schema`); validation: `pnpm tsx contract/validate.ts <bundle>` (ajv).

Versioning: `CONTRACT_VERSION` in `types.ts`, written into every document's `contract` field.
Minor bump for additive changes (new optional fields), major bump for anything an older reader
would misread. The backend serves whatever its sources give it; the reader checks the major.

## Bundle layout (what an exporter writes)

```
<bundle>/
  domains/<domainId>.json            Domain
  runs/<runId>/run.json              Run
  runs/<runId>/designs.jsonl         line 1 { contract, runId }, then one Design per line
  runs/<runId>/designs.json          DesignFile  { contract, runId, designs: Design[] }  (small runs)
  runs/<runId>/details/<hash>.json   DesignDetail (optional, precomputed)
  models/<domainId>.json             InputModel (optional): the optimisation's input model
  packet.json                        PacketManifest (optional): the bundle as a data packet (docs/packet-format.md)
  docs/<name>.json                   the packet's docs (texts, metrics, how, interactions)
  verify/{parts,causes,chains}.json  the packet's Verify files (contract/verify.ts)
```

A run exports **every evaluated design** (tens of thousands per run): write `designs.jsonl`
(readers prefer it over `designs.json`). The backend streams it, keeps the summaries and a byte
offset per design, and reads one design's decisions on demand; `designs.json` is loaded whole and
suits small runs only.

The backend reads packets and bundles from `core/explorer/sources.json` (`packets`: `../../build/explorer-sim` is the
MiSArch packet, `pnpm packet:misarch`; its runs come from `pnpm export:run`). Units: times in seconds unless a field says `Ms`; rates per second
at the reference (design) load; utilisations 0..1.

## Documents

**Run** (`RunSummary` + detail). Identity (`id`, `name`, `source` {kind headless | mdeo | bundle,
location, executionId, synthetic}), `problem` (e.g. `sim-day`), `domainId`, `algorithm`, `status`,
times, sizes (`populationSize`, `generations`, `evaluated`, `designCount`, `archiveSize`).
`objectives[]` {key, label, unit, **direction** minimize | maximize, digits}; values are always in
the objective's own direction (a maximised objective is positive). `constraints[]` {key, label}; a
constraint value is its **violation** (0 = met). `metrics[]` further per-design scalars (services,
sync calls, ...). `config` {populationSize, generations, operators[], mutationSteps, crossover,
initialisation, randomSeed, threads, evaluation, raw}. `evaluation` {profile day | steady, warmUpS, endS, binS, seed,
usageStreams, maxPods, phases[] {name, fromS}, latency {statistic, factor, minCompletions, source}, budgets{request →
{budgetMs, referenceMs, referenceCount}}, peakCapacity {limit, binS, containers[]}, pluginVersion}: how every design of the run
was simulated, read from the run's seed model and build. `history[]` per generation {index,
evaluated, timeMs, executedTransformations, skippedOperatorSlots, population[] {o, c, d?}} — `d` is
a design id when the design's decisions are known; an empty population means the source reports
none (dev-instance executions). `hypervolume` {method, ideal[], nadir[] (minimisation form),
population[], archive[]} per generation, `null` where not computed. `archive[]`,
`finalPopulation[]` design ids; `references[]` {designId, label} (today's cut, monolith, knee).

**Design** (`DesignSummary` + decisions). `id` (unique in its run), `hash` (see below),
`objectives[]`, `constraints[]`, `feasible`, `rank` (non-domination rank among the run's feasible
designs, 0 = front), `born` / `died` (archive generations), `inArchive`, `inFinalPopulation`,
`reference`, `metrics{}`, `hasDetail`, `hasDecisions`. `decisions`:

- `services[]` {id, name, classes[], replicas, database}: the cut, every class in exactly one
  service. `replicas` is `{mode: fixed, count}` or `{mode: hpa, min, max, targetUtilisation}`.
- `mechanisms{}`: key `operationId|classId|read|write` → `sync | copy | cache | join | saga` for
  every access whose class lives in another service than the operation runs in. An access within one
  service has no mechanism and is not listed (`DerivedAccess.mechanism` is null there, its placement "no hop").
  A missing cross-service entry means the default (`contract/derive.ts`).
- `sagas[]` {process, style choreography | orchestration, orchestrator?} for processes spanning
  services; also the transaction workflows (`tx_<SEFF>`) while a written class sits in another service than
  the trigger.
- `databases[]` {id, name, placement own | shared, services[]}.
- `operationPlacement{}` (optional): operation → service when it does not run with its home class.

`rawDecisions{}` holds a source's decisions as is: for the MiSArch runs the model's decision links that differ
from the run's seed (the detail simulator rebuilds the design from them). **Design hash** (`contract/hash.ts`): cyrb53 of the canonical decisions — independent of
service ids, names and list order — the cache key for simulated details.

**Domain**. `classes[]` {id, name, aggregate, sizeKb, attributes}, `references[]` {from, to, name,
kind composition | association | snapshot, multiplicity}, `aggregates[]` {id, root, classes},
`operations[]` {id, name, kind query | mutation | handler | internal, feature, **homeClass** (the
operation runs in its service), trigger (event), publishes[], rate, cpuMs, dbMs, budgetMs,
accesses[] {class, mode read | write, perExecution, level, rules, reason, lock, joined}}, `events[]` {publishers[],
subscribers[], class}, `features[]`, `processes[]` {trigger, steps[], transaction {writes[]} (a transaction workflow: the
classes the trigger writes in its transaction; `steps` empty)} (saga candidates),
`requests[]` {id, document, operations[] (the gateway plan, root first), rate, budgetMs},
`sessions[]` {share, thinkTimeS, steps[] {request, probability, repeat = expected visits}},
`loadProfiles[]` (LoadProfile, below), `cuts[]` (named reference cuts).

**InputModel** (written by the case's exporter, `cases/misarch/explorer-packet/export-model.ts`). How the domain enters the
optimisation: `classes[]` {id, service (today), table, attributes, rowBytes, evidence, component, schema, placement per
seed}, `references[]` {from, to, name, kind, upper, snapshot, storage}, `operations[]` {kind query | mutation |
resolver | reaction | callback | job, trigger, entry, homeClass, cpuMs, accesses[] {class, mode, shape, count, rows,
level, rules, reason, lock, cpuMs, dbMs, local, today}, calls[] {callee, count, level, rules, reason,
nestedIn}, effectCalls[], raises[], reactsTo, bindings[], process, seffs[], reach[] {request,
visits}, rate}, `events[]`, `bindings[]`, `processes[]` {styles, today, neutral, workflow (`saga_<Process>` |
`tx_<SEFF>`), transaction {seff, request, sites[], writes[]} (a transaction workflow: no business process, its steps
the trigger's transaction-bound write sites)}, `requests[]` {plan[] {op, via (root | service | gateway)}, rate,
budgets[] {profile, statistic, referenceMs, referenceCount, budgetMs}, seff, work {gateway, app, db}}, `sessions[]` {share, sessionsPerS, thinkTimeS, visits[]},
`designSessionsPerS`, `profiles[]` {id, model, warmUpS, endS, seed, usageStreams, maxPods, about, phases[], steps[]
{session | null, timeS, factor}, baseRates{session → sessions/s}, latency {statistic, factor, minCompletions}}, `seffs[]` {component, signature, kind gateway | request | operation | access | db, op, request,
class, parts[] {t work | call, name, ms, resource, kind, to, p, async, site}}, `sites[]` {op, request, kind, class,
callee, mode, allowed[], neutral, today, monolith, writes, event (event sites: the raise they
realise), planVia (field sites: today's plan entry, service | gateway), copyFeed {writers[] {op, request}} (sites that allow
a copy: who feeds it; no writers: event-carried), hitRatio, staleShare (the site's own cache values),
cachedService, cachedSeff (the provider's cache as built; its SEFF has kind `cache`), family fetch | effect,
effect {bound, p, cascades {sites, raises[]}, external} (effect sites), copyTopics[] {topic, role, today} (copy sites: the topics that
feed the reader's copy today, else those that carry the class)}, `topics[]` {id, role replication | process | mixed |
unsubscribed, publishers, payload, subscribers[] {op, service, copy}} (the extraction, cases/misarch/domain/REPORT.md §5), `parameters[]` {class, name, properties, links},
`metamodels[]` {id, title, layer, files, description, imports, enums, classes {name, abstract, supers, attributes,
doc, section, used}, references {source, name, multiplicity, kind, target, opposite}, views, sections}, `origin[]`,
`inputs[]`, `notes[]`. `timing` {source campaign-v3, label, kApplied, mapShare, note, envelope {source measured-v3, file, note}} (the case's
timing campaign), `operations[].mapCpuMs` (the home class's mapping
CPU, folded into the SEFF's `work`; the export splits it into a part `map` with `split: true`), `requests[].work.map` /
`.wait` (mapping CPU within app; latency-only DELAY waits, ms), DELAY demands in ms (the model's seconds × 1000).
One file per model: `misarch-kotlin-derived` (the current model, `pnpm export:model`).

**DesignDetail** (the simulation of one design, with the search's request; `server/simulator.ts`).
`designHash`, `origin` precomputed | simulated | synthetic, `simulator` {name, version (plugin), seed, durationS, warmupS,
binS, profile, events, simulatedS, wallMs}, `status` {failed, capped, timedOut, message}, `model` as evaluated | rebuilt,
`load` {t[], sessionsPerSecond[], mix{session → share[]}}, `phases[]` {name, fromS, toS}, `requests[]` / `sessions[]` (from
the plugin's `evaluation`) and `operations[]` (assembly operations) as `ResponseStats` {key, count, meanMs, p50Ms, p90Ms,
p95Ms, p99Ms, maxMs, budgetMs (C1), statisticMs (C1's statistic), histogram {edgesMs[], counts[]} (log-spaced), overTime
{t[], meanMs[], p95Ms[], throughput[]} per bin of the window}, `services[]` (scaling groups) {service, autoscaled, cores, t[],
utilisation[] (per ready pod), replicas[] (ready + starting), ready[], meanReady, peakReady, rescales, createdPods},
`resources[]` (what does not scale) {kind cpu | db | broker | gateway, utilisation, maxBinUtilisation, peakCapacity (C2
checks it), waitMs, queueLength, t[], utilisationOverTime[]}, `hpa` {t[], pods[], ready[], peakPods, createdPods,
rescales, reversals, maxPods}, `constraints` {latencyBudget, peakCapacity, statistic} recomputed from the simulation.

## Backend API (read only, plus on-demand detail)

| | |
| --- | --- |
| `GET /api/index` | `RunIndex` {runs: RunSummary[] (with `packet`), domains, sources: status per source, packets: PacketSummary[]} |
| `GET /api/packets` | `PacketSummary[]` |
| `GET /api/packets/:id` | `PacketBody` {manifest, docs inlined, summary} |
| `GET /api/packets/:id/verify/:name` | the Verify file `parts`, `causes` or `chains` |
| `GET /api/packets/:id/sources/:tree[/file?path=]` | a source tree's file list, one file `{tree, path, commit?, text}` |
| `GET /api/domains/:id` | `Domain` |
| `GET /api/domains/:id/model` | `InputModel` (404 when none was exported), with `freshness` against its packet's inputs |
| `GET /api/runs/:id` | `Run` |
| `GET /api/runs/:id/designs` | `DesignList` (summaries, no decisions) |
| `GET /api/runs/:id/designs/:did` | `Design` |
| `GET /api/runs/:id/designs/:did/detail[?simulate=1]` | `DesignDetail`: precomputed → cached → simulated now (cached under `build/explorer-cache/<domain>-<problem>-<hash>-<build>-<plugin version>.json`); header `X-Detail-Status` |
| `POST /api/reload` | re-read all sources |
