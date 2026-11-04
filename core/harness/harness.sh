#!/usr/bin/env bash
# Entry point of the headless harness (needs the worktree of core/harness/setup-worktree.sh) for single steps on
# architecture.mm models: metamodel /metamodel/architecture.mm, scripts and operators of /optimize, build
# directory build/misarch. The derivation's copy sync (core/tools/sync_model.py) runs through its `apply`;
# runs of the domain problem go through core/tools/run-domain.sh.
#
#   core/harness/harness.sh export [--only mm|models|mt|fn]   validate + export (ARCH_CONTRIBUTION=<plugin
#                                                      manifest> for scripts that call the plugin)
#   core/harness/harness.sh config <cfg> <out.json> [--population N --evolutions N --batches N --model P]
#   core/harness/harness.sh classpath                         compile the harness, cache the test classpath
#   core/harness/harness.sh evaluate <seed.model.json,...>    report functions of the seeds -> <build>/eval
#   core/harness/harness.sh operators <config.json> [tries]   apply every operator to the seeds -> <build>/operators
#   core/harness/harness.sh runjava <config.json> <seed.model.json> <out dir>   optimisation run, plain JVM
#   core/harness/harness.sh apply <transformation> <out dir> [seed.model.json,...]   apply a transformation
#                                                      (e.g. /optimize/sync-microservices.mt) once to each
#                                                      model (or every model of ARCH_MODELS_DIR), write the
#                                                      results to <build>/<out dir>, check that a second
#                                                      application changes nothing (apply.json)
#
# The project is the staged root of the case ARCH_CASE (default misarch; core/tools/stage_project.py into
# build/project/<case>, staged by every call unless ARCH_PROJECT names a staged root already).
#
# ARCH_HEAP (default 1500m) is the JVM heap of evaluate/operators/runjava, ARCH_CPUS (default 4)
# its processor count, ARCH_THREADS (runjava, default 1) the candidates evaluated at once.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
WT="${ARCH_WT:-$P/build/mdeo-wt}"
MM=/metamodel/architecture.mm; OPT=/optimize; B="$P/build/misarch"
mkdir -p "$B"
. "$P/core/tools/stage.sh"
export ARCH_LOCK_FILES="${ARCH_LOCK_FILES:-$P/MEASURING.lock}"   # the locks live in the repository root (README.md)
HEAP="${ARCH_HEAP:-1500m}"
cmd="${1:?command}"; shift
contrib=()
[ -n "${ARCH_CONTRIBUTION:-}" ] && contrib=(--contribution "$ARCH_CONTRIBUTION")
java_run() {
    local log="$1"; shift
    "$P/core/tools/wait-for-machine.sh"
    env "$@" ARCH_BUILD="$B" ARCH_OPTIMIZE="$OPT" \
        java -Xmx"$HEAP" -XX:ActiveProcessorCount="${ARCH_CPUS:-4}" -cp "$(cat "$B/test-classpath.txt")" \
        com.mdeo.optimizer.ArchHarnessMainKt > "$log" 2>&1 || { tail -40 "$log"; exit 1; }
}
case "$cmd" in
    export)
        "$P/core/harness/install-harness.sh" "$WT"
        (cd "$WT/app/arch-harness" && node export.mjs "$PROJ" "$B" --metamodel "$MM" --optimize "$OPT" "${contrib[@]}" "$@") ;;
    config)
        "$P/core/harness/install-harness.sh" "$WT"
        cfg="$1"; out="$2"; shift 2
        case "$out" in /*) ;; *) out="$B/$out" ;; esac
        (cd "$WT/app/arch-harness" && node config.mjs "$PROJ" "$cfg" "$out" "${contrib[@]}" "$@") ;;
    classpath)
        "$P/core/harness/install-harness.sh" "$WT"
        "$P/core/harness/gradle.sh" :optimizer:testClasses -q
        "$P/core/harness/gradle.sh" -q :optimizer:printTestClasspath | tail -1 > "$B/test-classpath.txt"
        echo "classpath: $(tr ':' '\n' < "$B/test-classpath.txt" | wc -l) entries" ;;
    evaluate)
        java_run "$B/java-evaluate.log" ARCH_MODE=evaluate ARCH_SEEDS="$1" ARCH_OUT=eval
        grep "model.json:" "$B/java-evaluate.log" || true ;;
    operators)
        rm -rf "$B/operators"
        java_run "$B/java-operators.log" ARCH_MODE=operators ARCH_CONFIG="$1" ARCH_TRIES="${2:-30}" \
            ARCH_SEEDS="${ARCH_SEEDS:?ARCH_SEEDS}" ARCH_OUT=operators
        grep -E "applied [0-9]+/" "$B/java-operators.log" || true ;;
    apply)
        rm -rf "${B:?}/$2"; mkdir -p "$B/$2"
        java_run "$B/java-apply-$2.log" ARCH_MODE=apply ARCH_TRANSFORM="$1" ARCH_OUT="$2" \
            ARCH_SEEDS="${3:-${ARCH_SEEDS:-}}" ARCH_MODELS_DIR="${ARCH_MODELS_DIR:-}"
        grep -E "applied (true|false)" "$B/java-apply-$2.log" || true ;;
    runjava)
        rm -rf "${B:?}/$3"; mkdir -p "$B/$3"
        java_run "$B/java-$3.log" ARCH_MODE=run ARCH_CONFIG="$1" ARCH_SEEDS="$2" ARCH_OUT="$3"
        cat "$B/$3/log.txt" ;;
    *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
