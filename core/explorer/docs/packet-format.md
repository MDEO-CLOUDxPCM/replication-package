# The data packet

The explorer is generic. Everything it knows about one architecture comes in a **data packet**: a bundle directory
(`domains/`, `runs/`, `models/`; [CONTRACT.md](../contract/CONTRACT.md)) plus a manifest `packet.json` and the files
the manifest names. The JSON Schema of the manifest is
[contract/schema/packet.schema.json](../contract/schema/packet.schema.json), and the schema of the Verify files is
[contract/schema/verify.schema.json](../contract/schema/verify.schema.json). Both are generated from
`contract/packet.ts` and `contract/verify.ts` with `pnpm contract:schema`, and `pnpm tsx contract/validate.ts <packet>`
checks a packet against them.

## Three layers

| layer | what | where |
| --- | --- | --- |
| generic | runs, designs, the Pareto views (scatter, matrix, parallel coordinates, table), objectives, constraints, the architecture graph and compare, a design's detail as given | `contract/`, `server/`, `sources/`, `layout/`, `web/src/` |
| family | the Palladio architecture optimisation (PCM layer 1, `architecture.mm` layer 2, `domain.mm` layer 3): the input model with SEFFs, call sites, mechanisms, effect steps and homes (Model panel), the Interactions tab, the plugin's detail simulation (C1/C2 recomputed) | the same code, switched on by `family: "palladio-architecture"` and `capabilities` |
| case | texts, metric docs, the How pipeline, the Interactions examples, the vocabulary's words, the Verify parts, source trees, commands, every path of the case | the packet (built by the case's builder, e.g. `cases/misarch/explorer-packet/`) |

The generic code never imports a case and names none (`tests/no-case-code.test.ts`). A bundle without `packet.json`
is a packet too, with defaults: its id is the source's, it has no docs, and it gets the Model panel only when it has
`models/`.

## Layout

```
<packet>/
  packet.json                the manifest (below)
  domains/<domain>.json      Domain (contract)
  runs/<run>/…               Run, designs.jsonl | designs.json, details/<hash>.json
  models/<domain>.json       InputModel (family palladio-architecture)
  docs/<name>.json | .md     the docs the manifest names (served inlined with the manifest)
  verify/parts.json          the Verify tab's parts (VerifyParts)
  verify/causes.json         per operation part what it causes (VerifyCauses)
  verify/chains.json         per operation the code from its entry to its steps (VerifyChains)
```

## packet.json

| field | meaning |
| --- | --- |
| `contract` | the contract version the packet was built for. The backend rejects another major, and the packet then serves nothing. |
| `id`, `name`, `description` | the identity. `id` is unique among the loaded packets and namespaces the browser's marks. |
| `family` | `palladio-architecture`, or absent for a plain multi-objective packet. |
| `domains` | the packet's domains. A run belongs to the packet of its `domainId`, and the backend sets `RunSummary.packet`. |
| `builtAt`, `builtBy` | when and by what the packet was built. |
| `fingerprint`, `inputs[]` | `inputs` lists every file the packet was built from: `{label, root, path, hash}` (sha256, a prefix is enough). `fingerprint` is a hash over them. The backend hashes the inputs again and reports a changed one as stale (below). |
| `roots` | named directories, relative to the packet directory: `project` (what the input paths and the input model's paths are relative to), and anything else commands and source trees use (`explorer`, `case`, `core`). |
| `objectives`, `constraints`, `metrics` | `{key, label, code?, unit?, direction?, digits?, doc?}`: the measures the runs report, with their doc's key (default `key`). |
| `vocabulary` | `{mechanisms, styles, operationKinds, edges}` of `{id, label, short?, about?}`: the words the UI uses for the family's ids. A missing word shows its id. `mechanisms` are the call sites' decision values only (where a call runs is its placement, below). |
| `docs` | name → file. The explorer reads `texts`, `metrics`, `how` and `interactions` (below). |
| `capabilities` | `model` (the Model panel), `modelTabs` (its tabs in order: how, mech, domain, ops, workload, mm, verify), `verify`, `performance` (the Performance panel), `simulate` (opening a design's performance may simulate it now). |
| `sources` | named source trees: `{kind: "git", label, root?, path, ref}` (a repository at a commit) or `{kind: "dir", label, root?, path, allow?}` (a working tree, restricted to the `allow` prefixes; no `..`, no links out of the tree). The Verify evidence's `repo` is a tree name. |
| `verify` | `{parts, causes?, chains?}`: the Verify files. |
| `commands` | `{simulate?, rebuild?}`: `{argv, cwd?, env?, about?, timeoutS?}`. See *Commands* below. |

### Docs

* **`texts`**: key → template. `{{var}}` inserts a variable, and `{{#flag}}…{{/flag}}` keeps its body when `flag` is truthy (`{{^flag}}…{{/flag}}` when it is not). Inline markup: `` `code` ``, `**bold**`, `[label](model-target)`. The code computes the variables. A missing key renders nothing, or the code's generic wording. The keys are namespaced by area: `workspace.*`, `arch.*`, `perf.*`, `model.*`, `verify.*`.
* **`metrics`**: `MetricDoc[]` (`web/src/lib/metricDocs.ts`): the `?` popover of every objective, constraint and metric: summary, TeX formulas, inputs, assumptions, citations, literature, links into the Model panel.
* **`how`**: the Model panel's Overview: the pipeline steps, what a design decides, how each decision becomes PCM (rows with flags), the parameter groups.
* **`interactions`**: the Interactions tab's case part: per kind its examples, design references and the case's numbers; `placement` `{title?, intro?, noHop?, remote?, own?}` explains the placement badges once; `consistency` `{title?, intro?, lock?, effect?}` explains the consistency levels once (markup; variables `reads`, `calls`, `effects`, `locks`); the card of a strict read or call is `cards.strict`.
* **Placement**: beside a call's mechanism the UI shows where it runs, never as a mechanism: **no hop** (caller and callee in one container), **remote → <service>** (different containers) and, for an access to the operation's own home class, **own data**. Their tooltips are the texts `placement.noHop`, `placement.remote`, `placement.own` (else generic words). A request plan entry's `via` is `root`, `service` (resolved in the service that resolves its parent) or `gateway` (a federation fetch).
* **Consistency levels**: a read of another class and a call carry a chip with its level and rule ids (`strict · S2`; `stale-ok`, `immutable` highlighted: no staleness cost), its tooltip the level's text, the rules' texts and the curated reason (`InputModel.consistency`, else generic words); `lock` marks a statement that only locks, `effect · E1` an effect call. An access to the home class (own data) shows none. Texts: `model.realise.strictCall`, `model.realise.noSite`, `model.op.syncOnly.*`.

### Commands and the local configuration

A packet *declares* commands but never enables them. The backend runs a command only when its **local**
configuration allows it for that packet. That configuration is `server.local.json` in `core/explorer/` (gitignored, see
`server.local.example.json`), or `EXPLORER_LOCAL_CONFIG`:

```json
{ "allowCommands": { "misarch": ["simulate", "rebuild"] } }
```

`EXPLORER_ALLOW_COMMANDS="misarch:simulate+rebuild"` adds to it, and `"misarch"` alone allows all of that packet's
commands. In `argv`, `env` and `cwd`, placeholders `{name}` are filled with the packet directory (`{packet}`), every
root by its name, and the command's own variables:

* **`simulate`**: `{model}`, `{diff}`, `{out}`, `{request}`, `{build}`. It writes the plugin's detail JSON to `{out}` (family palladio-architecture, `server/simulator.ts`).
* **`rebuild`**: `{exportArgs}`, the input model's recorded export arguments. An argument that is only an array placeholder expands to several arguments.

`GET /api/index` lists the allowed commands per packet (`packets[].allowedCommands`).

### Staleness

`PacketSummary.stale` lists the inputs that changed since the build. The input model (`models/<domain>.json`)
carries its own inputs. When one of them changed, `GET /api/domains/:id/model` starts the packet's `rebuild` in the
background if it is allowed (freshness `updating`, then `current` once the backend has re-read the packet).
Otherwise the freshness is `stale`, and the Model panel says to rebuild the packet. A run records its seed's
fingerprint (`modelFingerprint`). When that fingerprint is none of the input model's seeds, the run is tagged
`earlier-model`.

## Backend routes

| | |
| --- | --- |
| `GET /api/index` | `packets[]` (PacketSummary) and `runs[].packet`, besides the runs, domains and sources |
| `GET /api/packets` | PacketSummary[] |
| `GET /api/packets/:id` | `{contract, manifest, docs, summary}`, with the docs inlined |
| `GET /api/packets/:id/verify/:name` | `parts`, `causes`, `chains` (404 without the capability) |
| `GET /api/packets/:id/sources/:tree` | `{files}`: the tree's files (git: at its ref; dir: under its prefixes) |
| `GET /api/packets/:id/sources/:tree/file?path=` | `{tree, path, commit?, text}` |

The backend loads the packets listed in `sources.json` `packets` (paths relative to `core/explorer/`, or `{id, path}`),
plus those in `EXPLORER_PACKETS`.

## Writing a packet for another architecture

1. **Runs.** Export your runs into a bundle: `runs/<run>/run.json` and `designs.jsonl` (or `designs.json`), plus `domains/<domain>.json` (CONTRACT.md). This is enough for the generic explorer.
2. **Manifest.** Write `packet.json` with `contract`, `id`, `name` and `domains`, plus `capabilities` (`{"model": false, "verify": false, "performance": true, "simulate": false}` for a packet with precomputed details only).
3. **Docs** (optional): `docs/metrics.json` for the `?` popovers of your objectives, and `docs/texts.json` for the texts. List both in `docs`.
4. **Inputs** (optional): list the files the packet is built from in `inputs`, with their hashes, so the explorer can tell when it is stale.
5. **Family palladio-architecture.** Also write `models/<domain>.json` (InputModel), set `family`, `capabilities.model` and `modelTabs`, add `how` and `interactions` docs and a `vocabulary`, and declare `commands.simulate` if designs can be simulated on demand.
6. **Verify** (optional): write `verify/parts.json` (claims with evidence `{repo: <tree>, path, line}`), `verify/causes.json` and `verify/chains.json`, and declare the `sources` the evidence points into.
7. **Load it.** Add the directory to `sources.json` `packets` (or set `EXPLORER_PACKETS`), then run `POST /api/reload` or restart the backend. Check it with `pnpm tsx contract/validate.ts <packet>`.

A minimal example is `tests/fixtures/packet-tiny/`, a made-up bookshop that `tests/packet-fixture.test.ts` and
`tests/packet-web.test.ts` run the explorer on without any case code. The MiSArch packet is built by
`cases/misarch/explorer-packet/` (`pnpm packet:misarch` in core/explorer; ../../../docs/case-interface.md). All of its case paths are in
`cases/misarch/explorer-packet/config.ts`.
