#!/usr/bin/env bash
# Measures the cost and check numbers the paper states (paper/tools/model-measured.json) on the current model, on
# this machine, one measurement at a time; it refuses to start while other heavy work runs (a JVM or a plugin of
# another run, or a load above 2). Everything in build/measure-costs (ARCH_DIR), the summary in results.json:
#   1. prep: the current model's seeds exported, realised and evaluated (core/tools/run-domain.sh PREP_ONLY=1);
#   2. sim: one day-profile simulation per evaluation (the seeds' one-simulation forms), each seed SIM_REPEATS
#      times (default 3), single-threaded JVM, one plugin: daySimSeconds;
#   3. offspring: a short optimisation run (today-3obj-5sim.config's search, population 30, 8 generations, from
#      today's cut with one simulation per design), single-threaded: the optimiser's own time per offspring
#      (crossover and mutation including the repairs, ParallelEvaluator.variationSummary): perOffspringMs;
#   4. operators: every mutation operator OP_TRIES times (default 10) on each seed, each result checked against the
#      whole-model sync (/optimize/realised/sync-all.mt) and the multiplicities: checkApplications;
#   5. crossovers: every crossover operator on every ordered pair of the seeds and one descendant of each (4 random
#      mutations), XO_TRIES (default 2) tries, also with two donors, with the same checks: checkCrossoverApplications.
#   core/tools/measure-costs.sh [steps, default "prep sim offspring operators crossovers"]
# About 1-1.5 h. A step whose output exists is skipped (delete its directory to repeat it).
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
B="${ARCH_DIR:-$P/build/measure-costs}"
WT="${ARCH_WT:-$P/build/mdeo-wt}"
CFG=optimize/domain/today-3obj-5sim.config
STEPS="${1:-prep sim offspring operators crossovers}"
SEEDS=(today perclass monolith neutral)
export ARCH_PLUGIN_PORT="${ARCH_PLUGIN_PORT:-3201}" ARCH_JWKS_PORT="${ARCH_JWKS_PORT:-18201}" ARCH_PLUGIN_ARENAS=0
mkdir -p "$B"
. "$P/core/tools/stage.sh"

busy=$(pgrep -fa "ArchHarnessMainKt|plugin-bin serve|palladio-sim-service" | grep -v "$B" || true)
load=$(cut -d' ' -f1 /proc/loadavg)
if [ -n "$busy" ] || awk -v l="$load" 'BEGIN { exit !(l > 2) }'; then
    echo "machine not quiet (load $load):"; echo "$busy"; exit 1
fi

java_() {
    local log="$1"; shift
    (cd "$B" && env MALLOC_ARENA_MAX=2 ARCH_BUILD="$B" ARCH_OPTIMIZE=/transform ARCH_SCRIPTS=metrics.fn \
        ARCH_EXTERNAL="spawn:$B/plugin-bin serve" ARCH_PLUGINS=1 "$@" \
        java -Xmx6g -XX:ActiveProcessorCount="${CPUS:-1}" -cp "$(cat "$B/test-classpath.txt")" com.mdeo.optimizer.ArchHarnessMainKt) > "$B/$log" 2>&1
}
for step in $STEPS; do
    echo "== $step $(date -Is)"
    case "$step" in
        prep)
            [ -s "$B/eval/values.json" ] && continue
            ARCH_DIR="$B" PREP_ONLY=1 ARCH_THREADS=4 "$P/core/tools/run-domain.sh" "$CFG" measure
            for s in "${SEEDS[@]}"; do
                sed -E 's/^( *"replications": )[0-9.]+$/\11/' "$B/realised/domain-$s.model.json" > "$B/realised/domain-$s-1sim.model.json"
                grep -q '"replications": 1$' "$B/realised/domain-$s-1sim.model.json" || { echo "replications of $s not set"; exit 1; }
            done
            (cd "$WT/app/arch-harness" && node config.mjs "$PROJ" "$CFG" "$B/config-measure.json" --contribution "$B/plugin-manifest.json" \
                --population 30 --evolutions 8) > /dev/null ;;
        sim)
            [ -s "$B/sim/values.json" ] && continue
            mkdir -p "$B/sim/models"; seeds=()
            for s in "${SEEDS[@]}"; do for k in $(seq 1 "${SIM_REPEATS:-3}"); do
                cp "$B/realised/domain-$s-1sim.model.json" "$B/sim/models/$s-$k.model.json"; seeds+=("sim/models/$s-$k.model.json")
            done; done
            java_ sim/java.log ARCH_MODE=evaluate ARCH_OUT=sim ARCH_THREADS=1 ARCH_SEEDS="$(IFS=,; echo "${seeds[*]}")" \
                ARCH_REPORT=metrics.fn::cost,metrics.fn::simulationWallMs ;;
        offspring)
            [ -s "$B/offspring/log.txt" ] && continue
            mkdir -p "$B/offspring"
            java_ offspring/java.log ARCH_MODE=run ARCH_CONFIG=config-measure.json ARCH_SEEDS=realised/domain-today-1sim.model.json \
                ARCH_OUT=offspring ARCH_THREADS=1 ARCH_TIMING=1 ARCH_ARCHIVE=0 ;;
        operators)
            [ -s "$B/operators/operators.json" ] && continue
            mkdir -p "$B/operators/realised"   # the harness names its outputs by the seed's path
            java_ operators.log ARCH_MODE=operators ARCH_CONFIG=config-measure.json ARCH_OUT=operators ARCH_TRIES="${OP_TRIES:-10}" \
                ARCH_CHECK_SYNC=/optimize/realised/sync-all.mt ARCH_REPORT=metrics.fn::changeCoupling \
                ARCH_SEEDS="$(for s in "${SEEDS[@]}"; do printf 'realised/domain-%s.model.json,' "$s"; done | sed 's/,$//')"
            mv "$B/operators.log" "$B/operators/java.log" ;;
        crossovers)
            [ -s "$B/crossovers/crossovers.json" ] && continue
            CPUS=6 java_ crossovers.log ARCH_MODE=crossovers ARCH_CONFIG=config-measure.json ARCH_OUT=crossovers ARCH_TRIES="${XO_TRIES:-2}" \
                ARCH_THREADS=6 ARCH_XO_WALK=1*4 ARCH_XO_MULTI=1 ARCH_CHECK_SYNC=/optimize/realised/sync-all.mt ARCH_REPORT=metrics.fn::changeCoupling \
                ARCH_SEEDS="$(for s in "${SEEDS[@]}"; do printf 'realised/domain-%s.model.json,' "$s"; done | sed 's/,$//')"
            mv "$B/crossovers.log" "$B/crossovers/java.log" ;;
        *) echo "unknown step $step"; exit 2 ;;
    esac
done
python3 "$P/core/tools/measure_costs.py" "$B"
