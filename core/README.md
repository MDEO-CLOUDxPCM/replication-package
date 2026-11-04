# The core

What does not depend on one architecture: the MDEO sources, the derivation of optimisation models
from a case's domain model, the headless harness, the tools and the platform client. A case (`../cases/<case>/`)
provides its inputs through its `case.json`; [../docs/case-interface.md](../docs/case-interface.md) is the
interface, `generator/case-stub/` a stub, `tools/check_case.py` the check.

| directory | contents |
| --- | --- |
| `mdeo/` | `metamodel/`, `transform/`, `optimize/`: staged with a case's `mdeo/` into `build/project/<case>/` (`tools/stage_project.py`), the one project root mdeo and the harness read |
| `generator/` | `derive.py` (the derivation engine; a case's adapter supplies its fixed topology, rules and calibration), `sessions.py` (the session-model interpreter), `perclass_seed.py`, `schema/` (JSON Schemas of the case inputs), `case-stub/` |
| `harness/` | `harness.sh` and the harness sources it installs into the mdeo worktree (`setup-worktree.sh`, `install-harness.sh`, `gradle.sh`) |
| `tools/` | `stage_project.py`, `stage.sh`, `case.py`, `check_case.py`, `run-domain.sh`, `realise-seeds.sh`, `seed_headers.py`, `gen_domain_budgets.sh`, `gen_detail_fn.sh`, `design_detail.sh`, `detail_request.py`, `sync_model.py`, `format_model.py`, `pin.py`, `measure-costs.sh`, `wait-for-machine.sh` |
| `explorer/` | the generic explorer: runs, fronts, designs, the input model and Verify, from data packets; a case's packet builder lives with the case (`cases/misarch/explorer-packet/`) |
| `platform/` | the mdeo platform client (`push.sh`, `run.mjs`, `dl.mjs`, `crosscheck.py`, `to_run.py`, `realised_to_m.py`, ...; the case's project id is its `platform.json`; [../docs/platform.md](../docs/platform.md)) |

Generated files that are committed stay next to their sources: `mdeo/optimize/domain/detail.fn`
(`tools/gen_detail_fn.sh`), `mdeo/transform/pinned/*` (`tools/pin.py`), and a case's models and seeds.
