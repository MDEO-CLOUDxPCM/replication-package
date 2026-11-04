# MiSArch, the case

MiSArch in its Kotlin port (the submodule `misarch-kotlin/` of the repository, main d569ad9), the case study of this repository. `case.json` names what it provides to the core ([../../docs/case-interface.md](../../docs/case-interface.md)).

| directory | contents |
| --- | --- |
| `extract/` | the extraction (`build.py`, `inventory.py`, `report.py`; `curated/*.yaml`) |
| `domain/` | its result `misarch-domain.json`, `misarch-inventory.json`, `REPORT.md`; `msa/` round 2's msa model (`KOTLIN-MODEL.md`) |
| `workload/` | the session usage model `sessions.json` (`WORKLOAD.md`) |
| `timing/` | the timing campaign (`README.md`, `timing-up.sh`, `run-fourth-pass.sh`, `run_campaign.sh`, `analysis/parts.py` → `parts.json`, `latency_fit.json`, `calibration/`) |
| `generator/` | the adapter to the core's derivation `misarch.py` (gateway, broker, Keycloak; federation and login rules; criticality, change rates, cache TTL), `gen_sessions.py` (the session model's calibration against round 2, CLI), `platform.py` → `platform.json`, `cache_hits.py` → `mdeo/models/domain-cache-hits.json` |
| `mdeo/models/` | the base models `domain-{neutral,today,monolith,perclass}.m` and today's references (`domain-today-{p95,objectives}-day.json`, the cache hits) |
| `mdeo/seeds/` | the realised seeds `domain-<seed>-realised[-1sim].m` |
| `mdeo/configs/` | the paper's configs `today-3obj-5sim.config` (Built) and `perclass-3obj-5sim.config` (PerClass), `smoke-3obj-5sim.config` (three generations, to check a setup); staged as `optimize/domain/` |
| `explorer-packet/` | the builder of MiSArch's explorer packet (`pnpm packet:misarch` in core/explorer → build/explorer-sim): `config.ts` holds every case path the explorer side reads, `export-model.ts`, `export-run.ts`, `docs/`, `verify/`, `tests/` |
| `platform.json` | the case's project on the mdeo platform (`docs/platform.md`) |

Paths inside the case are relative to `cases/misarch/` (`timing/...`, `domain/...`): the timing campaign, the
extraction and the docs here keep their relative layout, and the timing scripts resolve the repository root (the
locks) and misarch-kotlin (`core/tools/checkout.sh misarch-kotlin`: the submodule, else `../misarch-kotlin`) from
their own location.

Regenerating the models: `core/generator/derive.py`, `core/generator/perclass_seed.py`, then
`core/tools/realise-seeds.sh` (seeds whose base model changed) or, when only the inputs' paths changed and the bodies
are identical, `core/tools/seed_headers.py`.
