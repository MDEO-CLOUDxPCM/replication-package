#!/usr/bin/env bash
# A headless optimisation run of the domain problem: the derived domain models
# (metamodel/domain.mm, §F) with the realised layer 2 (§B). Everything in build/domain:
#   1. the plugin (a copy of its binary) and the manifest it serves
#   2. export: domain.mm, the domain models, B's realised wrappers (optimize/realised), the domain
#      problem's wrappers and config (optimize/domain), transform/*.mt, transform/metrics.fn
#   3. the seeds realised (transform/realise.mt): domain-neutral, today, monolith, perclass
#      (models/domain-<seed>.m), with their objective values (eval/values.json)
#   4. the run (harness `run` mode, plain JVM, its own plugin service), every evaluated design in
#      <run>/designs.jsonl (ARCH_DESIGNS=1); its seed is the realised model the config names
#      (`model = ".../domain-today-realised.m"`)
#   [ARCH_THREADS=6 RUN_ONLY=1] core/tools/run-domain.sh <config> <run name> [population generations]
# Speed: ARCH_THREADS evaluation threads, ARCH_PLUGINS plugin services (ports
# ARCH_PLUGIN_PORT + 0, 2, 4, ...), ARCH_HEAP, ARCH_AS (address-space limit of the JVM and its plugins),
# ARCH_CPUS (the JVM's processor count, default ARCH_THREADS); the plugins run with glibc's default
# malloc arenas (ARCH_PLUGIN_ARENAS, default 0; MALLOC_ARENA_MAX=2 made one plugin the bottleneck),
# the JVM with ARCH_MALLOC_ARENAS (2). ARCH_TIMING=1 prints per generation: wall, busy thread time,
# plugin calls. For this VM (25 vCPUs, 35 GB) at population 160 (the JVM holds parents and offspring,
# ~30 MB per model; 4 plugins and a 20 GB heap ran it out of memory):
#   ARCH_THREADS=18 ARCH_PLUGINS=3 ARCH_HEAP=18g ARCH_AS=28000000000
# RUN_ONLY=1 skips steps 1-3 (they are done); PREP_ONLY=1 stops after them. Ports: ARCH_PLUGIN_PORT (3161), ARCH_JWKS_PORT (18161).
# Worktree: ARCH_WT (default build/mdeo-wt, a detached worktree of mdeo-cloud;
# core/harness/setup-worktree.sh). Build dir: ARCH_DIR (default build/domain).
# A config whose model is a committed realised seed (models/domain-<seed>-realised.m, the platform's form)
# runs from the harness's realised/domain-<seed>.model.json (the same model, docs/platform.md §4); one that
# names its one-simulation form (-realised-1sim.m) from realised/domain-<seed>-realised-1sim.model.json, which
# the prep writes next to it (the same model with LoadProfile.replications 1, as core/tools/realise-seeds.sh's).
# The project is the staged root of the case ARCH_CASE (default misarch; core/tools/stage_project.py, unless
# ARCH_PROJECT names one); <config> is its project path (optimize/domain/today-3obj-5sim.config) or a source file of it.
# Crossover configs (variation = genetic) need no extra setting: designs.jsonl records
# per offspring its kind and crossover operator ("v"), log.txt the crossover counts and times.
# Configs: optimize/domain/today-3obj-5sim.config (Built) and perclass-3obj-5sim.config (PerClass), five simulations
# of the day profile per evaluation; smoke-3obj-5sim.config (three generations) to check a setup.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
cfg="$1"; name="$2"; pop="${3:-}"; evo="${4:-}"
B="${ARCH_DIR:-$P/build/domain}"
WT="${ARCH_WT:-$P/build/mdeo-wt}"
export ARCH_PLUGIN_PORT="${ARCH_PLUGIN_PORT:-3161}" ARCH_JWKS_PORT="${ARCH_JWKS_PORT:-18161}"
export ARCH_PLUGIN_ARENAS="${ARCH_PLUGIN_ARENAS:-0}"
mkdir -p "$B"
. "$P/core/tools/stage.sh"
csv() { local IFS=,; echo "$*"; }
# ARCH_MODELS (space-separated, default below) overrides the seeds the prep exports, realises and evaluates
read -r -a MODELS <<< "${ARCH_MODELS:-domain-neutral domain-today domain-monolith domain-perclass}"
REALISED=(); for m in "${MODELS[@]}"; do REALISED+=("realised/$m.model.json"); done
# the config's project path: as given, or the staged path of a source file
case "$cfg" in
    "$PROJ"/*) cfg="${cfg#"$PROJ"/}" ;;
    /*) cfg="$(python3 "$P/core/tools/stage_project.py" --staged "$cfg")" ;;
    *) [ -f "$PROJ/$cfg" ] || cfg="$(python3 "$P/core/tools/stage_project.py" --staged "$P/$cfg")" ;;
esac
cf="$PROJ/$cfg"
# the run's seed: the realised form of the model the config names
model="$(basename "$(grep -oE '^ *model = "[^"]+"' "$cf" | head -1 | sed -E 's/^ *model = "(.*)"/\1/')" .m)"
case "$model" in *-realised) seed="realised/${model%-realised}.model.json" ;; *) seed="realised/$model.model.json" ;; esac
export_() { (cd "$WT/app/arch-harness" && node export.mjs "$PROJ" "$B" --metamodel /metamodel/domain.mm "$@"); }
java_() {
    "$P/core/tools/wait-for-machine.sh"
    (cd "$B" && env MALLOC_ARENA_MAX="${ARCH_MALLOC_ARENAS:-2}" ARCH_BUILD="$B" ARCH_OPTIMIZE=/transform ARCH_SCRIPTS=metrics.fn "$@" \
        prlimit --as="${ARCH_AS:-12000000000}" java ${ARCH_JAVA_OPTS:-} -Xmx"${ARCH_HEAP:-4g}" -XX:ActiveProcessorCount="${ARCH_CPUS:-${ARCH_THREADS:-8}}" \
        -cp "$(cat "$B/test-classpath.txt")" com.mdeo.optimizer.ArchHarnessMainKt)
}
if [ -z "${RUN_ONLY:-}" ]; then
    "$P/core/harness/install-harness.sh" "$WT"
    cp "${ARCH_PLUGIN_SRC:-$("$P/core/tools/checkout.sh" palladio-sim-service)/target/release/palladio-sim-service}" "$B/plugin-bin.new" && mv -f "$B/plugin-bin.new" "$B/plugin-bin"
    mport=$((ARCH_PLUGIN_PORT + 1))
    PORT=$mport HOST=127.0.0.1 BACKEND_API_URL=http://127.0.0.1:1/api "$B/plugin-bin" serve > "$B/manifest-serve.log" 2>&1 &
    pid=$!
    for _ in $(seq 50); do curl -sf "http://127.0.0.1:$mport/" -o "$B/plugin-manifest.json" && break; sleep 0.2; done
    kill $pid
    {
        export_ --optimize /optimize/domain --only mm
        export_ --optimize /optimize/domain --only models --models "$(csv "${MODELS[@]/%/.m}")"
        export_ --optimize /optimize/realised --only mt
        export_ --optimize /optimize/domain --only mt
        export_ --optimize /optimize/crossover --only mt
        export_ --optimize /transform --only mt
        export_ --optimize /transform --contribution "$B/plugin-manifest.json" --only fn
    } > "$B/export.log" 2>&1 || { grep -E "errors|FAILED|Error" "$B/export.log" | grep -v " 0 errors" | head -20; exit 1; }
    grep -cE "0 errors" "$B/export.log" | sed 's/^/exported files: /'
    # the classpath is (re)made when missing or made for another worktree
    if [ ! -s "$B/test-classpath.txt" ] || [ "$(head -c ${#WT} "$B/test-classpath.txt")" != "$WT" ]; then
        ARCH_WT="$WT" "$P/core/harness/gradle.sh" :optimizer:testClasses -q
        ARCH_WT="$WT" "$P/core/harness/gradle.sh" -q :optimizer:printTestClasspath | tail -1 > "$B/test-classpath.txt"
    else
        ARCH_WT="$WT" "$P/core/harness/gradle.sh" :optimizer:testClasses -q
    fi
    # the seeds, realised once (checked idempotent)
    rm -rf "$B/realised"; mkdir -p "$B/realised"
    java_ ARCH_MODE=apply ARCH_TRANSFORM=/transform/realise.mt ARCH_OUT=realised \
        ARCH_SEEDS="$(csv "${MODELS[@]/%/.model.json}")" > "$B/java-apply.log" 2>&1 \
        || { tail -30 "$B/java-apply.log"; exit 1; }
    grep -E "applied (true|false)" "$B/java-apply.log"
    # the one-simulation forms (the configs' seeds, docs/platform.md §4)
    for m in "${MODELS[@]}"; do
        sed -E 's/^( *"replications": )[0-9.]+$/\11.0/' "$B/realised/$m.model.json" > "$B/realised/$m-realised-1sim.model.json"
    done
    rm -rf "$B/eval"; mkdir -p "$B/eval"
    java_ ARCH_MODE=evaluate ARCH_OUT=eval \
        ARCH_SEEDS="$(csv "${REALISED[@]}")" ARCH_THREADS=6 \
        ARCH_REPORT=metrics.fn::cost,metrics.fn::failure,metrics.fn::changeCoupling,metrics.fn::inconsistency,metrics.fn::performance,metrics.fn::latencyBudget,metrics.fn::peakCapacity,metrics.fn::cohesion,metrics.fn::cohesionServices,metrics.fn::cohesionServers,metrics.fn::failureSync,metrics.fn::failureAsync,metrics.fn::modularity,metrics.fn::replicas,metrics.fn::utilisation,metrics.fn::peakUtilisation,metrics.fn::responseTime,metrics.fn::simulationFailed,metrics.fn::peakPods,metrics.fn::createdPods,metrics.fn::simulationWallMs \
        ARCH_EXTERNAL="spawn:$B/plugin-bin serve" > "$B/java-evaluate.log" 2>&1 || { tail -30 "$B/java-evaluate.log"; exit 1; }
    grep "model.json:" "$B/java-evaluate.log"
fi
[ -z "${PREP_ONLY:-}" ] || exit 0
[ -s "$B/$seed" ] || { echo "no realised seed $B/$seed (run without RUN_ONLY first)"; exit 1; }
# the config
args=()
[ -n "$pop" ] && args+=(--population "$pop")
[ -n "$evo" ] && args+=(--evolutions "$evo")
(cd "$WT/app/arch-harness" && node config.mjs "$PROJ" "$cfg" "$B/config-$name.json" --contribution "$B/plugin-manifest.json" "${args[@]}") \
    > "$B/config-$name.log" 2>&1 || { cat "$B/config-$name.log"; exit 1; }
tail -1 "$B/config-$name.log"
rm -rf "${B:?}/runs/$name"; mkdir -p "$B/runs/$name"
started=$(date +%s)
java_ ARCH_MODE=run ARCH_CONFIG="config-$name.json" ARCH_SEEDS="$seed" ARCH_OUT="runs/$name" \
    ARCH_DESIGNS=1 ARCH_THREADS="${ARCH_THREADS:-6}" \
    ARCH_REPORT="${ARCH_REPORT:-metrics.fn::modularity,metrics.fn::replicas,metrics.fn::peakUtilisation,metrics.fn::responseTime,metrics.fn::simulationFailed,metrics.fn::peakPods}" \
    ARCH_EXTERNAL="spawn:$B/plugin-bin serve" SIM_THREADS="${SIM_THREADS:-6}" SIM_MODEL_CACHE_SIZE=4 SIM_RESULT_CACHE_SIZE=64 \
    > "$B/runs/$name/java.log" 2>&1 || { tail -40 "$B/runs/$name/java.log"; exit 1; }
echo "wall time $(( $(date +%s) - started )) s"
cat "$B/runs/$name/log.txt" | grep -vE "^seed " | head -20
