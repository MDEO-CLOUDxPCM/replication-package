# MiSArch timing campaign

The campaign measures, for every operation of the domain model (`../domain/misarch-domain.json`) on today's cut of
MiSArch (misarch-kotlin `main` d569ad9, 17 services), the **parts** from which `core/generator/derive.py` assembles
the model: an operation's own CPU, per (class, read/write) access its statements, DB time and app-side mapping CPU,
the receiving envelope of event handlers and invocations, the mechanisms' costs (local copies, response caches), the
order path's cardinality costs, the at-load scale per container, and the latency-only waits (statement round trips,
commits, publishes). It runs on one host (the dev VM) as a set of measurement windows ("approx4", 16 windows plus 3
re-run windows); one replicate per window. Results: `RESULTS.md` (summary and caveats), `RESULTS-checks.md`
(composition checks, generated).

Paths are relative to this directory (`cases/misarch/timing/`); paths starting with `timing/` and the commands of §7
are relative to `cases/misarch/` (the scripts resolve every path from their own location).

## Model inputs

| file | what | written by |
| --- | --- | --- |
| `timing/parts.json` | the parts (schema version 3, `core/generator/schema/parts.schema.json`): `operations`, `perExecution`, `requests`, `kDb`, `kAtLoad`, `orderPathCardinality`, `mechanisms`, `envelope`, `middleware`, `rateSensitivity`, `scheduledJobs` | `timing/analysis/parts.py` (via `analyse_pass.sh`, §8) |
| `timing/latency_fit.json` | `stmtRoundTripMs`, `commitDelayMs`, `publishWaitMs` (§5.2) | `timing/analysis/latency_fit.py` |
| `timing/envelope-estimate-v2.json` | an envelope estimate from another set of instrumented windows (`approx2_on_w1`–`w3`), not part of this package and not reproducible from it. derive.py uses it only when `parts.json` has no `envelope`; since `parts.json` has one, the file only enters the models' input hashes. Kept unchanged | — |

All three are hashed into the committed models (`// Input: ... sha256`). `case.json` names them. Other inputs used here:
`timing/calibration/params.json` (the calibrated middleware of the calibration runs on misarch-kotlin with the tooling
in `calibration/`, called "round 2" in the code and in `parts.json`: hop, gateway, publish, deliver, login CPU; copied
into `parts.json` `middleware`), `timing/calibration/results-kotlin/demands.json` (the calibration's isolation demands;
read by `../extract/assemble.py`), and `timing/LITERATURE-NETWORK.md` (literature values
for what one host cannot measure; its "Recommended model defaults" give the model's ASSUMED network delay).

## 1. Principle: totals from cgroups, shares from instrumentation

- **Totals** per (request type, container): isolation windows, one request type at a time, open Poisson arrivals,
  steady state, `D = (U − U_idle) / X` from 1-Hz cgroup `cpu.stat` (`calibration/scripts/cpumon.py`,
  `analyze_iso.py`). Async follow-up work (event handlers, sagas) is inside because the window is steady. These
  windows run the **production configuration** (block 2: OTel agent as deployed, metrics only; no profiler, no
  `pg_stat_statements`).
- **Shares** within a container come from instrumented windows of the same types at the same rates (async-profiler,
  `pg_stat_statements`, OTel spans, the CPU counters of §2.2). A part = production total × instrumented share. The
  overhead `D_on − D_off` per container is reported (`overheadOnVsOff`).
- Σ parts = total holds by construction for CPU; the real checks are §5.

## 2. Instrumentation

### 2.1 Builds and images

Three builds of misarch-kotlin, each image labelled `misarch.commit`; `run-fourth-pass.sh --check` compares the labels
with the repository (`MISARCH_KOTLIN_REPO`, default the submodule `misarch-kotlin/` of this repository, else
`../misarch-kotlin`; a branch missing locally, as in the submodule, is read as `origin/<branch>`). Built with
`timing/build-images.sh <commit> <tag> [<svc>...]` (jars in a worktree at the commit, base image revision 4 from
`timing-instrumentation`'s tools for all three).

| tag | branch (commit) | used in |
| --- | --- | --- |
| `:cut-20261101` | `main` (d569ad9), the production build, all 17 apps | blocks 2, 7 (mode off) |
| `:timing-20261101` | `timing-instrumentation` (b4f00b2, linear on main): manual spans and CPU counters in `libs/common`, inert unless switched on | blocks 3, 4b, 5; block 6 for the apps other than catalog, shipment, order |
| `:mech-20261101` | `timing-mechanisms` (db170f4, linear on main): order's local copies, the entity-fetch response cache (per user or shared per key), order's caller-side cache, all behind switches that default to off (misarch-kotlin `docs/MECHANISMS.md`) | block 6: catalog, shipment, order |

The instrumentation build adds, with `MISARCH_TIMING_SPANS=true`: spans `dataloader <Entity>`, `connection <Entity>`,
`repo <Entity>.<method>`, `publish <topic>`, `invoke <app>.<method>` (OTel API, bridged by the agent), and the counters
of §2.2. With the switch off its behaviour equals main's.

### 2.2 CPU counters

`GET /timing/counters` on every app with `libs/common` (16 of 17; not simulation), on with `MISARCH_TIMING_COUNTERS`
(default: follows `MISARCH_TIMING_SPANS`), cumulative since JVM start; `window.py --counters` reads them at each steady
segment's start and end (`counters.json`). Semantics (misarch-kotlin `docs/TIMING-COUNTERS.md`):
- operations by kind: `graphql` (`Parent.field`, non-trivial fetchers), `entities` (`_entities.<Type>`), `dataloader`
  (loader class, calls = batches), `event` (topic), `http` (`METHOD route`; `POST /graphql` = engine work outside
  fetchers);
- statements keyed `<mode> <entity> <hash>` with SQL normalised like `pg_stat_statements`, calls, rows, driver and
  mapping CPU;
- disjoint: an operation's CPU excludes nested operations and the statement CPU inside it;
- not attributed: Netty I/O, protocol decode before row mapping, body decode/encode in Reactor chains, WebClient I/O,
  BEGIN/COMMIT, GC/JIT and agent threads. Coverage (attributed / thread CPU) is reported (`countersCoverage`).
- overhead ≈ 0.4 µs per frame (≈ 0.3 % of a request's CPU).

### 2.3 Switches

`timing-up.sh up --mode off|on --images cut|timing=TAG|mech=TAG [--sampler R] [mechanism switches]` brings the stack up
from misarch-kotlin's `deploy/compose` under `STACK.lock` (repository root), with heaps pinned by
`calibration/results-kotlin/stack.env` (`-Xms512m -Xmx2g`, Keycloak `-Xmx2g`) and k8s CPU limits.
- `--mode off`: today's stack (no override, Dapr tracing off). `--images cut` pins `:cut-20261101`.
- `--mode on`: adds `docker-compose.timing.yaml` (generated by `harness/gen_override.py`): OTLP spans with
  `OTEL_TRACES_SAMPLER=traceidratio` (`--sampler`, 0.1 in this campaign), data-fetcher spans, `MISARCH_TIMING_SPANS`,
  async-profiler 4.2.1 mounted read-only (`TIMING_ASPROF_DIR`, `local.env`), a `/timing` results volume, Postgres with
  `pg_stat_statements` (`track=top`, `track_io_timing=on`); Dapr tracing on. async-profiler is started and stopped per
  segment with `asprof` (`-e itimer`, 10 ms), so no JVM restarts are needed.
- `--images mech`: block 6, `docker-compose.mechanisms.yaml`; `timing-up.sh mech --copies on|off --cache on|off
  [--ttl S] [--shared-cache on|off] [--caller-cache TARGETS|off]` changes the switches (recreates order, catalog,
  shipment and their sidecars only if a switch changes).

## 3. Attribution of CPU and DB time

### 3.1 Profile buckets

Folded stacks (async-profiler) → buckets by frame rules (`analysis/buckets.yaml`, `profile_buckets.py`; a stack is
scanned from the leaf towards the root, the first frame of a strong bucket decides, Netty/Reactor transport frames are a
weak fallback): `db-driver`, `mapping` (access, app side), `dapr-client` (middleware), `graphql`, `resolver`,
`serialisation`, `http` (own work), `jit` (compiler threads), `gc` (GC and other JVM runtime threads; both spread over
the segment's requests), instrumentation (excluded from every share), unmatched (reported). The window's profiled idle
phase is the baseline. A steady segment with a jit share above 3 % is flagged (`jitFlag`).

### 3.2 DB side

`pg_stat_statements` is reset and dumped per segment (`analysis/queries.py`). Each normalised statement → tables
(`FROM`/`JOIN`/`INSERT INTO`/`UPDATE`/`DELETE FROM`) → class (the domain model's mapping), read/write by statement
kind; per request: calls, rows, exec ms. DB CPU = exec ms × `k_db` per DB container ((cgroup CPU between reset and
dump − idle baseline) / Σ exec + plan time; reported as `kDb`). Statements above 1,000 shared blocks per call are
listed (`scanSuspects`).

### 3.3 App side of an access, own work

Where counters exist (every instrumented window): per access the counters' driver + mapping CPU (statements matched to
the `pg_stat_statements` accesses by table and mode, the unmatched rest spread by the fit weights), per operation the
counters' own CPU (keys matched to the domain model's triggers), and the rest of the service's CPU is the request's
overhead (`requestOverheadCpuMs`: HTTP, GraphQL parse/validate, serialisation, GC, JIT) on its entry operation. Shares
are relative to the app's instrumented cgroup CPU without the profile's instrumentation share; production values =
off totals × shares. Cross-checks kept in `parts.json`: the per-service fit `p = αRead·reads + αWrite·writes + β·rows`
of the profile's persistence CPU (`fits`, `fitVsCounters`), `profileAccessRatio`, `countersCoverage`, `threadCoverage`.

### 3.4 Load dependence

- **At-load scale** `k_c` per container (`analysis/atload.py`, block 7): measured container CPU at the session
  workload's levels 0.25–0.75 / CPU predicted from the isolation parts plus the order path's cardinality term (§3.6),
  utilisation-law fit as in the calibration. Multiplies every part of container `c` (`kAtLoad`).
- **Rate sensitivity** of rare types (`analysis/sensitivity.py`, `rateSensitivity`): `D(X) = a + b/X` from the pilot
  windows (block 1, three rates per type) transferred to the mid-rate totals, checked on the copy-write types in
  `mech_on_w1`.

### 3.5 From request types to operations

The isolation unit is a request type (a GraphQL document; `requests/reqs.py`: the 36 request types of
`../workload/sessions.json` plus `products.anon`, `product.anon` and the factorial cells). A request runs several
operations (root field, field resolvers, `_entities` joins, event handlers and saga steps). Accesses are attributed via
the persistence method each access names (`via`) and that method's statements; a statement shape shared by several
operations is split by their executions. Values are **per execution** (`perExecution`): per-request part / executions
per request (counter calls relative to the root's; a plan operation 1); nothing goes to an operation that did not run.
A type measured in two windows takes the later window (re-runs, §4.2).

### 3.6 Order-path factorial (block 4b)

createOrder + placeOrder with the saga in 22 cells: a half fraction of items {1, 3} × quantity {1, 3} × coupon
{no, yes} × payment method (4 cells per method), for PREPAYMENT and CREDIT_CARD each cell's twin with the coupon flipped
(so both have all 8 combinations), and two INVOICE cells at 600 instead of 60 stock items per variant; 3 windows,
interleaved by payment method. `analysis/factorial.py` fits
`y = b0 + item·(i−1) + unit·i(q−1) + coupon + PRE + CC + s600` per container by ordinary least squares (`fits`; a Huber
fit `fitsRobust` is reported next to it). The model uses the item, unit and coupon terms (`orderPathCardinality`).

## 4. Runs

### 4.1 Blocks and windows

Plans: `plans/approx3/` (loadgen's plan format, windows ≤ 30 min, `manifest.json` in run order; `python3
plans/gen_plans.py approx3 --rates plans/rates.json` in `timing/` regenerates every file but `bursts.json`), re-run
plans `plans/rerun4/` (`rerun_plans.py`, regenerated by `run-rerun.sh`), pilot `plans/pilot/`. Rates: mid ≈ 25 % of the
busiest CPU-limited container's limit, from the pilot windows (`gen_plans.py pilot-rates` → `plans/rates.json`).
`plans/approx3/bursts.json` (`burst_table.py`) was computed from another set of windows, measured without bursts
(approx2_*, not in this package), and is kept as a plan input. Every isolation segment is `pre` (local baseline) → `warm` → `steady` → `drain`; types that create rows run last in a window with shorter segments.

| block | windows | build, mode | what |
| --- | --- | --- | --- |
| 1 | `pilot_w1`–`w3` | production build of an older main, off, no lock | each type 20 s at three rates: `rates.json` and the rate sensitivity's shape; not repeated on d569ad9 (approximate) |
| 2 | `approx4_off_w1`–`w3` | cut, off | production totals, all 38 types |
| 7 | `approx4_atload_w1` | cut, off | session workload (`sessiongen.py`), levels 0.25–1.0 (the analysis uses ≤ 0.75) |
| 6 off | `approx4_mech_off_w1`, `mech_cc_w1`, `mech_on_w1` | mech, off | switches off (reference, incl. `createOrder.hot`) / caller cache on / copies + entity cache + shared-key cache on |
| 6 on | `approx4_mech_on_w2`, `mech_cc_w2` | mech, on | the same instrumented |
| 3 | `approx4_on_w1`–`w3` | timing, on, sampler 0.1 | shares: profiles, spans, `pg_stat_statements`, counters |
| 4b | `approx4_fo_w1`–`w3` | timing, on | the factorial (§3.6) |
| 5 | `approx4_latency_w1` | timing, on, 0.1 (block 3's JVMs) | one request at a time per type: end-to-end latency |
| re-run | `approx4_rerun_off`, `_rerun_on`, `_rerun_mech_on` | as their blocks | segments hit by a host-side slow episode (§4.2) |

Block 6's caller cache targets shipment, discount, inventory (TTL 60 s); `createOrder` (fresh cart lines: misses) and
`createOrder.hot` (four fixed buyer/cart/method triples: hits). The entity cache keys Order (shipment) and
ProductVariant (catalog), ProductVariant shared across users in the on windows; `orderTracking`/`wishlistView` run
with an all-hit (`.hot`) and an all-miss (`.cold`) key set.

### 4.2 Flow and decisions of the pass

Per window (`harness/campaign.py`, `window.py`): warm-up bursts of its cold types → data reset (`data/reset.sh`,
`data/README.md`) → migrations the snapshot lacks (`harness/migrations.py`) → prep (pools, stock) → block 6 switches and copies backfill
(`harness/mech_backfill.py`) → warm-up plan → the window under `MEASURING.lock` (`calibration/scripts/measure.py`), with
per-segment hooks: `pg_stat_statements` reset/dump, `asprof` start/stop per app, counters, `pg_stat_database` /
`pg_stat_wal` (`pgxact.json`), row counts before and after (`volume_*.json`); spans fetched from Zipkin in time slices
(`harness/spans.py`; Zipkin emptied before every instrumented window).

- **No speed gate, one replicate.** Windows run when they are due; the machine's speed regime is not probed or waited
  for (waiting for a "fast" regime would select the data). `analysis/speed.py` derives the regime per segment from
  `cpu.csv` afterwards.
- **Warm-up bursts** (`harness/bursts.py`, `plans/approx3/bursts.json` from `plans/burst_table.py`): ~5,000 requests
  (fewer where a pool limits them) for every type whose gc+jit share was above 5 %, packed concurrently below 60 % of
  every CPU-limited container, only for types whose JVMs are cold (a stack-mode change, a block-6 switch change, an app
  restart); one burst before the first window of a stack mode covers its later windows. Block 6's bursts are halved.
- **Data reset before every window**, then missing migrations from outside: only block 6's order `V2__local_copies`
  may be missing; anything else stops the pass.
- **Scheduled jobs kept out of the measured phases.** Every cron trigger of the domain model (payment's two
  `checkOpen*` jobs, `0 */15 * * * *`) is passed to `window.py --clear-cron`; before an idle phase and before each
  segment's run of pre … steady phases, the load generator holds at zero load (`<segment>:hold`) while a firing would
  fall into it, until 6 s after it (`calibration/scripts/cronjobs.py`). At-load is held once, before its first level.
  The CPU analysis still masks every firing (3 s, payment and payment-db) and reports its cost (`scheduledJobs`);
  `scheduledJobsCheck` counts firings in measured phases (0 in every window).
- **Block 5 at sampler 0.1** in block 3's JVMs (a sampler change would recreate every app).
- **Re-runs.** A segment whose steady phase or local baseline fell into a host-side slow episode (every container
  ×1.3 at once, nothing foreign in the VM; `speed.py`) is measured again: `plans/rerun_plans.py` cuts those segments
  (with the segments they depend on) out of the approx3 plans into `plans/rerun4/`, `run-rerun.sh` runs them with the
  same flow (windows `approx4_rerun_*`), and the analysis lists them after the pass's own windows.

### 4.3 Writes measured only inside another statement

Three effect steps write a class that today's code writes inside the home class's statement, so no window sees them on
their own and `parts.json` has no access for them:

| operation | write | today inside |
|---|---|---|
| `discount.registerCoupon` | Coupon (`usages + 1`) | the CouponRedemption insert (trigger `before_insert_update_coupon_usages`) |
| `order.createOrder` | OrderItem (and `OrderItem.discounts`) | the Order insert |
| `payment.on:discount/order/validation-succeeded` | OrderItem | the home's write (items inside `orderJson`) |

The model's ESTIMATE: joined in the transaction nothing extra (the measured statement already includes the write);
separated, the step's envelope and one commit (`commitDelayMs`) but 0 ms of statement time for the write. To measure
them, a switch on the mechanisms build would do the write as a statement of its own in its own transaction (switch off
= reference); it changes semantics (registerCoupon's limit check is no longer atomic with the redemption), so it would
be a measuring build only.

### 4.4 Quiet-machine protocol

`MEASURING.lock` in the repository root, through `calibration/scripts/measure.py`: before a window no lock, foreign CPU
below 0.3 cores over 30 s, no heavy process, ≥ 5 min since the last window, ≥ 8 GB free disk; the window takes the
lock (purpose, start, expected end, pid) and runs at most 30 min. Valid if mean foreign CPU stays below 0.3 cores and
no 10-s interval exceeds 1.1 cores. `STACK.lock` marks the owner of the MiSArch stack (81 containers, ~11.4 GB RAM).

## 5. Composition checks (`analysis/compose_check.py` → `RESULTS-checks.md`, `raw/checks.json`)

1. **CPU** per (request, container): persistence, middleware and own CPU, unmatched share, instrumentation share,
   coverage, the fit residual (flag above 20 %), the on/off overhead (flag above 10 %).
2. **Latency at low load** (block 5): the end-to-end time against the critical path through the measured structure
   (gateway CPU, per hop the calibrated hop latency and sidecar CPU, own work, per access DB ms + mapping CPU). The
   latency-only waits come from `latency_fit.py` on the block-3 windows: server span − CPU parts − DB exec =
   a·statements + b·commits + c·publishes (no intercept), fast segments only.
3. **At load** (block 7): `k_c` per container (§3.4).

## 6. Envelope vs work (`analysis/envelope.py` → `parts.json` `envelope`)

### 6.1 Fields

CPU ms per delivered event / publish / inbound request at production configuration (the scale of `ownCpuMs`).
- `handlers["<service>.on:<topic>"]`: `workCpuMs` (the handler's business code and statements, app CPU),
  `envelopeAppCpuMs` = dispatch + decode + tx + idempotency (`envelopeParts`; idempotency is always 0: MiSArch has no
  generic inbox, the handlers' duplicate checks are listed in `idempotencyCheck` and stay in the work),
  `envelopeParts.deliveryCpuMs` (the subscriber's daprd + ecs sidecars per delivery, block 6), `envelopeCpuMs`,
  `countersRemainderCpuMs` (the subscriber app's CPU outside the counters per inbound request: what derive.py uses as
  a handler's envelope), `from` (`measured` / `container` / `pooled`), `types`.
- `senders["<service>"]`: `publishAppCpuMs`, `publishSidecarCpuMs` (the calibrated `publishCpuMs`), `publishCpuMs`.
- `callees["<service>"]`: the callee side of a synchronous invocation (dispatch, decode, tx, `envelopeAppCpuMs`).
- `requestOverhead["<type>"]`: `entryOperation`, `requestOverheadCpuMs`, `byPlanContainer`.
- `hopsMs["<topic> -> <subscriber>"]`: wall p50 of `appPublish`, `daprPublish`, `broker`, `sidecarToApp`,
  `deliveryOverhead`, `handler`.
- `rows`: per (service, type) the envelope share of query types, the source of the receiving envelope of a
  synchronous call into a service that is not invoked anywhere today.

### 6.2 Method

From the instrumented windows' profiles (no image change): every sample is classified from the leaf up to the first
business frame (bucket resolver/graphql); the first marker frame decides `tx`, `decode`, `publish`, `invoke`
(`envelope.py` `MARKERS`), outbound client frames below the business frame are publish or invoke, the rest of `http` is
dispatch, everything else work. Counts per segment and app come from the spans (sampler `traceidratio` 0.1, whole
traces kept or dropped): deliveries, other inbound requests, publishes, multiplied by the plan's subgraph fetches per
request (`check_inbound` refuses counts inconsistent with the plan). Envelope per inbound request = (dispatch + decode
+ tx) share × D / inbound requests; work per delivery = work share × D split over the app's handlers by their
counter-measured own + access CPU. The DB side of a commit is not CPU-separable; it is a latency (`commitDelayMs`).

### 6.3 Dapr delivery settings as deployed

misarch-kotlin `deploy/compose`: `pubsub.redis` without metadata, no resiliency spec, no dead-letter topic, no
`--app-max-concurrency`, programmatic subscriptions; so Dapr 1.15 defaults: one consumer group per subscriber app,
concurrency 10 per subscriber sidecar, queueDepth 100, processingTimeout 15 s, redeliverInterval 60 s, streams not
trimmed. App side: WebFlux on Netty, R2DBC pool default 10 connections per app.

## 7. Running the campaign

Prerequisites:
- misarch-kotlin with `main`, `timing-instrumentation` and `timing-mechanisms` (both linear on main, no merges) and the
  three image sets of §2.1;
- async-profiler 4.2.1: `cp timing/local.env.example timing/local.env` and set `TIMING_ASPROF_DIR` (and
  `MISARCH_KOTLIN_REPO`);
- the calibration venv (the harness runs with it): `python3 -m venv timing/calibration/.venv &&
  timing/calibration/.venv/bin/pip install -r timing/calibration/requirements.txt`;
- the data baseline snapshot (`timing/data/README.md`), whose migrations match main (`timing/data/baseline_migrations.json`;
  otherwise the run converts and migrates it first, `timing/data/migrate-baseline.sh`, `timing/data/conversion/README.md`);
- ≥ 15 GB free on `/`; no other MiSArch stack, no `MEASURING.lock`, `STACK.lock` free or ours.

```
timing/run-fourth-pass.sh --check     # preflight: images vs commits, plans, profiler, baseline, domain, cron guard
timing/run-fourth-pass.sh --dry-run   # schedule and estimate (about 10.3 h incl. bursts and holds)
timing/run-fourth-pass.sh             # blocks 2, 7, 6, 3, 4b, 5; resumes (windows with a window.json are skipped)
timing/run-rerun.sh [--with-mech]     # re-run the segments listed in plans/rerun_plans.py (same preflight and flow)
```

Run them in a terminal that outlives the session (tmux/screen). Output: `timing/raw/campaign-<date>.out`,
`timing/raw/campaign.log`, one directory per window in `timing/raw/windows/` (`raw/` is not in git). The stack is taken
down at the end (volumes kept). Lower-level entry points: `run_campaign.sh` (→ `harness/campaign.py`, `--blocks`,
`--plans`, `--smoke`), `timing-up.sh`, `requests/run.py` (request types, pools, prep, smoke).

## 8. Re-running the analysis

```
cd cases/misarch/timing
MISARCH_KOTLIN_REPO=/path/to/misarch-kotlin bash analysis/analyse_pass.sh approx4
python3 -m unittest discover -s analysis/tests        # unit tests, no stack, no raw data needed
```

`analyse_pass.sh` (system `python3`, stdlib only; misarch-kotlin is read with `git show`, its working tree is not
touched) computes the per-window caches (`raw/windows/<w>/analysis/`), then `factorial.py`, `parts.py`,
`mechanisms.py`, `sensitivity.py`, `parts.py` again with both, `latency_fit.py`, `compose_check.py`, `volumes.py`,
`speed.py`. It writes `parts.json`, `latency_fit.json`, `RESULTS-checks.md` and `raw/{factorial,mechanisms,sensitivity,
checks,volumes}.json`, `raw/speed.out`; about 1.5 min on one core. From the windows below alone (no caches), it
reproduces `parts.json`, `latency_fit.json` and `RESULTS-checks.md` byte for byte.

Raw data it needs (`raw/windows/`, ~320 MB, ~100 MB gzipped):
- `approx4_off_w1`–`w3`, `approx4_on_w1`–`w3`, `approx4_fo_w1`–`w3`, `approx4_latency_w1`, `approx4_atload_w1`,
  `approx4_mech_off_w1`, `approx4_mech_on_w1`, `approx4_mech_on_w2`, `approx4_mech_cc_w1`, `approx4_mech_cc_w2`,
  `approx4_rerun_off`, `approx4_rerun_on`, `approx4_rerun_mech_on` (301 MB);
- `pilot_w1`–`w3` (21 MB; `sensitivity.py`'s default `--pilot`);
- optional: `approx4_rerun_off2.slow-20261101` (1.5 MB; a re-run that ran into another slow episode, set aside; only
  `volumes.py` and `speed.py` list it).

## 9. Layout

| path | what |
| --- | --- |
| `run-fourth-pass.sh`, `run-rerun.sh`, `run_campaign.sh`, `timing-up.sh` | entry points (§7, §2.3) |
| `harness/` | `campaign.py` (blocks, stack modes, bursts, resets, windows), `window.py` (one window + hooks), `bursts.py`, `migrations.py`, `mech_backfill.py`, `spans.py`, `stackctl.py`, `speedprobe.py`, `gen_override.py` |
| `docker-compose.timing.yaml`, `docker-compose.mechanisms.yaml` | the on-mode override (generated) and block 6's switches |
| `requests/` | request types (`reqs.py`, `ext.py`: GraphQL documents, actors, preconditions), `run.py` (setup, prep, stock, cleanup, smoke) |
| `sessiongen.py` | the session load generator (block 7), executing `../workload/sessions.json` |
| `plans/` | `gen_plans.py`, `burst_table.py`, `rerun_plans.py`, `rates.json`; plan sets `approx3/`, `rerun4/`, `pilot/` |
| `analysis/` | the analyses (§3, §5, §6, §8), `buckets.yaml`, `analyse_pass.sh`, `tests/` |
| `calibration/` | the calibration tooling (round 2), plus the scheduled-job guard `cronjobs.py`: `scripts/` (loadgen, measure, maintain, cpumon, cpuan, analyze_iso, cronjobs, redisq, mclient, stack, seed), `plans/kotlin/warm_{mix,all}.json` (warm-up after a stack start / default warm-up), `workarounds/` (seed.py's discount schema fix), `results-kotlin/` (`demands.json`, `stack.env`; the seeded state `seed/`, `pools.json`, `tokens.json` are not in git), `params.json`, `requirements.txt` |
| `data/` | the data baseline: loader, check, reset, conversion (`data/README.md`) |
| `parts.json`, `latency_fit.json`, `envelope-estimate-v2.json` | model inputs |
| `RESULTS.md`, `RESULTS-checks.md` | results, composition checks |
| `LITERATURE-NETWORK.md` | literature values for network, sidecar, broker and commit latency |
| `local.env.example` | machine-specific settings (`local.env`, not in git) |
| `raw/`, `state/` | not in git: measurement data, the stack's runtime state |
