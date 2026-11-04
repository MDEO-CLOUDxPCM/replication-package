#!/usr/bin/env bash
# The performance detail of one design of a domain run, for the explorer's
# PalladioPluginSimulator (core/explorer/server/simulator.ts; the MiSArch packet's simulate command):
#   1. the design's model: the realised seed with the design's decision links (the run's
#      designs.jsonl diff: allocations, mechanisms, saga styles), made consistent by the layer-3
#      sync + whole realisation (optimize/realised/sync-all.mt, harness apply mode)
#   2. the evaluation request of transform/metrics.fn (scaling groups, sidecar overrides, the
#      model's load profile, window, bins, percentiles, seed, usage streams, pod and event limits,
#      the HPA controller settings),
#      printed by optimize/domain/detail.fn's detailRequest() (harness evaluate; detail.fn is
#      metrics.fn's request part, core/tools/gen_detail_fn.sh)
#   3. `palladio-sim-service detail` on the realised model with that request: the same simulation
#      as the search's pcmEvaluate (more monitors; its `evaluation` is pcmEvaluate's result)
#   core/tools/design_detail.sh <seed.model.json> <diff.json> <out detail.json> [request.json]
# request.json (optional): the detail's own fields (budgetsMs, histogramPerDecade, assemblyOperations,
# ...); the evaluation's fields always come from the model (step 2), so the explorer shows what the
# search evaluated.
# Needs a build prepared by core/tools/run-domain.sh (exports, classpath, plugin copy; build/domain or
# DETAIL_BUILD). Work files in <build>/detail-work/<name of out>/. An empty diff.json simulates the
# model as it is (a realised reference or a saved solution: exactly what the search evaluated). Ports: DETAIL_PLUGIN_PORT (3171), DETAIL_JWKS_PORT (18171).
# DETAIL_BUILD: the run's build/domain when the run comes from a snapshot of the project (its seed,
# transformations, scripts, harness classpath and plugin); the snapshot stays read-only: an overlay
# build/detail-builds/<snapshot> links its exports and holds the work files.
# The detail script (optimize/domain/detail.fn, core/tools/gen_detail_fn.sh) is compiled into the build
# when it has none or when the build's metrics.fn was exported after it (the build was prepared
# again); otherwise the build's copy stays, so a build's detail request is the one of its own
# metrics.fn even after the project's scripts moved on.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$(realpath "${DETAIL_BUILD:-$P/build/domain}")"
B="$SRC"
# a build of this project (build/domain, build/ab, ...) holds its own work files; only a snapshot's
# build elsewhere gets the overlay
if [ "${SRC#"$(realpath "$P/build")"/}" = "$SRC" ]; then
    B="$P/build/detail-builds/$(basename "$(dirname "$(dirname "$SRC")")")"
    mkdir -p "$B/scripts"
    for f in "$SRC"/*; do
        case "$(basename "$f")" in scripts|detail-work|runs|eval) ;; *) ln -sfn "$f" "$B/";; esac
    done
    for f in "$SRC"/scripts/*; do [ "$(basename "$f")" = detail.fn.json ] || ln -sfn "$f" "$B/scripts/"; done
fi
if [ ! -s "$B/scripts/detail.fn.json" ] || [ "$B/scripts/metrics.fn.json" -nt "$B/scripts/detail.fn.json" ]; then
    WT="$(tr ':' '\n' < "$B/test-classpath.txt" | head -1 | sed 's#/platform/.*##')"
    T="$B/detail-export"; rm -rf "$T"; mkdir -p "$T"
    . "$P/core/tools/stage.sh"
    (cd "$WT/app/arch-harness" && node export.mjs "$PROJ" "$T" --metamodel /metamodel/domain.mm --optimize /optimize/domain \
        --contribution "$B/plugin-manifest.json" --only fn) > "$T/export.log" 2>&1 && [ -s "$T/scripts/detail.fn.json" ] \
        || { tail -20 "$T/export.log" >&2; exit 1; }
    rm -f "$B/scripts/detail.fn.json"; cp "$T/scripts/detail.fn.json" "$B/scripts/detail.fn.json"; rm -rf "$T"
fi
seed="$(realpath "$1")"; diff="$(realpath "$2")"; out="$(realpath -m "$3")"; req="${4:-}"
name="$(basename "$out" .json)"
W="$B/detail-work/$name"
rm -rf "$W"; mkdir -p "$W/in"
python3 - "$seed" "$diff" "$W/in/design.model.json" <<'PY'
import json, sys
seed, diff, out = sys.argv[1:4]
m = json.load(open(seed))
d = json.load(open(diff))
props = {"resourceContainer", "mechanism", "style", "home"}
names = {i["name"] for i in m["instances"]}
# placements are decisions only for base components (AllocationContexts with a Placement): the realisation's
# own AllocationContexts (middleware, colocations) follow from them, and their instance names differ between
# independently realised seeds, so a diff never moves them
cls = {i["name"]: i["className"] for i in m["instances"]}
placed = {l["targetName"] for l in m["links"] if cls.get(l["sourceName"]) == "Placement" and l["sourceProperty"] == "allocation"}
done = set()
for l in m["links"]:
    k = f'{l["sourceName"]}.{l["sourceProperty"]}'
    if cls.get(l["sourceName"]) == "AllocationContext" and l["sourceName"] not in placed:
        if k in d:
            done.add(k)
        continue
    if l["sourceProperty"] in props and k in d and l["sourceName"] != "environment":
        if d[k] in names:
            l["targetName"] = d[k]
        done.add(k)
missing = [k for k in d if k not in done and not k.startswith("environment.") and k.split(".")[0] in names]
if missing:
    print("decisions not applied (no such link in the seed):", missing[:10], file=sys.stderr)
json.dump(m, open(out, "w"))
PY
java_() {
    (cd "$B" && env MALLOC_ARENA_MAX=2 ARCH_BUILD="$B" "$@" prlimit --as=10000000000 java -Xmx3g -XX:ActiveProcessorCount=4 \
        -cp "$(cat "$B/test-classpath.txt")" com.mdeo.optimizer.ArchHarnessMainKt)
}
rel="detail-work/$name"
if [ "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$diff")" = 0 ]; then
    # no decisions to apply: the model is a realised one the search evaluated as it is (a reference, a saved
    # solution of the run); a rebuild would reorder its elements, and the simulation depends on that order
    mkdir -p "$W/realised"; cp "$W/in/design.model.json" "$W/realised/design.model.json"
    echo "the model as evaluated (no decisions to apply)" >&2
else
    java_ ARCH_MODE=apply ARCH_OPTIMIZE=/transform ARCH_SCRIPTS=metrics.fn ARCH_TRANSFORM=/optimize/realised/sync-all.mt \
        ARCH_MODELS_DIR="$rel/in" ARCH_OUT="$rel/realised" > "$W/apply.log" 2>&1 || { tail -20 "$W/apply.log" >&2; exit 1; }
    grep -E "applied" "$W/apply.log" >&2 || true
fi
java_ ARCH_MODE=evaluate ARCH_OPTIMIZE=/transform ARCH_SCRIPTS=detail.fn ARCH_SEEDS="$rel/realised/design.model.json" \
    ARCH_OUT="$rel/eval" ARCH_REPORT=detail.fn::detailRequest ARCH_EXTERNAL="spawn:$B/plugin-bin serve" \
    ARCH_PLUGIN_PORT="${DETAIL_PLUGIN_PORT:-3171}" ARCH_JWKS_PORT="${DETAIL_JWKS_PORT:-18171}" \
    > "$W/eval.log" 2>&1 || { tail -20 "$W/eval.log" >&2; exit 1; }
python3 "$P/core/tools/detail_request.py" "$W/realised/design.model.json" "$W/eval.log" "$req" "$W/request.json"
SIM_THREADS=2 prlimit --as=10000000000 "$B/plugin-bin" detail "$W/realised/design.model.json" "$W/request.json" --out "$out.tmp" 2> "$W/detail.err" \
    || { tail -5 "$W/detail.err" >&2; exit 1; }
mv "$out.tmp" "$out"
echo "$out"
