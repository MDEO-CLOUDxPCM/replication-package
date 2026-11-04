# Results

The two runs the paper reports, as downloaded from the mdeo platform after they completed
(`core/platform/dl.mjs`, `BYID=1 IDS=<execution id>`, or the same REST endpoints directly),
unchanged, one zstd-compressed tar each:

| archive | run | config | execution | duration | packed | unpacked | population / generations / sims | optimizer nodes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `today-3obj-5sim-0c30b0d0.tar.zst` | Built | `optimize/domain/today-3obj-5sim.config` | `0c30b0d0-5748-43f0-9fec-f12c598c0b8f` | 19.1 h | 27.2 MB | 2.2 GB | 175 / 450 (448 logged) / 5 | 10 of 18 threads |
| `perclass-3obj-5sim-e33d7d40.tar.zst` | PerClass | `optimize/domain/perclass-3obj-5sim.config` | `e33d7d40-050d-4d06-92b7-0f8949b46bb8` | 28.1 h | 27.6 MB | 2.1 GB | 175 / 450 (448 logged) / 5 | 8 of 22 threads |

Both ran with population 175 for 450 generations (448 generations logged) and five simulations per design; each
ran on its own deployment, with at least one evaluation thread per design of the population (the table's last
two columns).

## Unpacking

```bash
mkdir -p build/platform/executions
tar --zstd -xf results/perclass-3obj-5sim-e33d7d40.tar.zst -C build/platform/executions
tar --zstd -xf results/today-3obj-5sim-0c30b0d0.tar.zst -C build/platform/executions
```

(or `zstd -dc <archive> | tar -x -C build/platform/executions`). The archives use a 128 MiB window
(`zstd --ultra -22 --long=27`), which zstd decompresses without extra options. This gives the layout that `dl.mjs`
writes and the tools of `core/platform/` read.

## Contents

Each archive holds one directory `<config>-<execution id prefix>/` with:

| file | what |
| --- | --- |
| `execution.json` | the platform's record of the execution: config path, start model, state, created, started and finished times |
| `summary.json`, `summary.md` | the platform's summary: execution resources (nodes, threads), operators, plots |
| `batch_1/report.json` | the final population (`paretoFront`: 175 solutions with their objectives O1–O3 and constraints C1–C5 in the config's order), the operators and, per generation (`graphData.generations`), the hypervolume of the feasible front, the best constraint violation, crossover and operator counters and the time per node |
| `batch_1/solution_<i>.m_gen` | the 175 final designs as the platform saved them: complete realised models (decisions and derived realisation), each 11–13 MB of model JSON |

mdeo keeps only the final population of a run, so there are no intermediate populations
([docs/search.md](../docs/search.md)).

## Using them

- **Re-evaluate and check** every final design with the headless harness (the same `metrics.fn` and plugin binary)
  and compare with the platform's values:
  `core/platform/crosscheck.py build/platform/executions/perclass-3obj-5sim-e33d7d40 --config cases/misarch/mdeo/configs/perclass-3obj-5sim.config --values values.json`
  (harness build from `core/tools/run-domain.sh`; the header of `crosscheck.py` has the options).
- **Explore** the designs: `core/platform/to_run.py <execution> build/domain/runs/<name> --seed <seed model.json> --values values.json --config <config>`,
  then `pnpm export:run` in `core/explorer` ([core/explorer/README.md](../core/explorer/README.md)).
- The paper's numbers per run come from these downloads as [README.md](../README.md#3-the-papers-numbers) §3 describes.
