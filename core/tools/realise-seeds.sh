#!/usr/bin/env bash
# The realised seeds after a model change: models/domain-<seed>-realised.m (and the -1sim forms of the configs) from
# the models core/generator/derive.py and core/generator/perclass_seed.py wrote. Only a seed whose model changed since (its
# `// Source:` hash) is realised again: the realisation names the elements it creates in no fixed order, so a seed
# realised again is the same model under other names, with another fingerprint (and other random streams).
# core/tools/run-domain.sh's prep realises them (transform/realise.mt in the headless harness, then evaluates them once:
# JVM, 4 GB heap, the plugin); core/platform/realised_to_m.py writes each as a model file with the hash of the model
# it came from. The explorer exports its input model again from them by itself (core/explorer/server/model-sync.ts) and
# reports seeds older than their models. A script the user starts (several minutes).
# The case's base models and seeds are its case.json `mdeo.models` and `mdeo.seeds` (ARCH_CASE, default misarch);
# a seed is current when its `// Source:` line names its base model's repository path and content hash.
#   [ARCH_DIR=build/realise] [ARCH_WT=build/mdeo-wt] [ARCH_CASE=misarch] core/tools/realise-seeds.sh
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
export ARCH_DIR="${ARCH_DIR:-$P/build/realise}"
MD="$(python3 "$P/core/tools/case.py" path mdeo.models)" SD="$(python3 "$P/core/tools/case.py" path mdeo.seeds)"
stale=()
for seed in neutral today monolith perclass; do
    m="$MD/domain-$seed.m" r="$P/$SD/domain-$seed-realised.m"
    h="$(sha256sum "$P/$m" | cut -c1-16)"
    grep -q "^// Source: $m sha256 $h$" "$r" 2>/dev/null || stale+=("$seed")
done
[ ${#stale[@]} -gt 0 ] || { echo "every realised seed is current"; exit 0; }
echo "realising: ${stale[*]}"
ARCH_MODELS="${stale[*]/#/domain-}" PREP_ONLY=1 "$P/core/tools/run-domain.sh" optimize/domain/today-3obj-5sim.config realise
for seed in "${stale[@]}"; do
    python3 -I "$P/core/platform/realised_to_m.py" "$ARCH_DIR/realised/domain-$seed.model.json" \
        "$P/$MD/domain-$seed.m" "$P/$SD/domain-$seed-realised.m"
    # one simulation per evaluation (docs/platform.md §4): the configs' seeds
    [ "$seed" = monolith ] || sed 's/^    replications = 5.0$/    replications = 1.0/' "$P/$SD/domain-$seed-realised.m" > "$P/$SD/domain-$seed-realised-1sim.m"
    # the realised seed itself has the model's five simulations per evaluation (the -5sim configs)
done
