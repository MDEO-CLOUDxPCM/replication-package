#!/usr/bin/env bash
# C1 per request type: simulate today's cut (models/domain-today.m) under its
# load profile (day) with the evaluation's request (transform/metrics.fn's pcmEvaluate: the model's
# profile, scaling groups, seed, usage streams, window) and write per request type (gateway system
# operation) its simulated mean, p50, p90, p95, p99 and completions to models/domain-today-p95-day.json,
# from which core/generator/derive.py writes the budgets' references (LatencyBudgetPolicy: statistic x
# factor). Everything in build/l-domain (own plugin copy, manifest, ports 3191/18191).
#   [ARCH_WT=build/mdeo-wt] [SEEDS="1 2 3 4 5"] core/tools/gen_domain_budgets.sh
# Also today's changeCoupling and inconsistency (means over the seeds) to
# models/domain-today-objectives-day.json, the references of the ObjectiveBounds (C4, C5).
# SEEDS (default: the model's own seed only): today's cut is simulated once per seed (the
# LoadProfile's seed replaced) and every statistic is the mean over them (`seeds` in the file; the
# reference of C1's budgets, and so of O5's; gen_domain.py wants as many as its REPLICATIONS).
# Then: core/generator/derive.py (all seeds), core/generator/perclass_seed.py, and core/tools/run-domain.sh again.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
B="$P/build/l-domain"
WT="${ARCH_WT:-$P/build/mdeo-wt}"
p=day
n=domain-today
mkdir -p "$B"
. "$P/core/tools/stage.sh"
export_() { (cd "$WT/app/arch-harness" && node export.mjs "$PROJ" "$B" --metamodel /metamodel/domain.mm "$@"); }
java_() {
    "$P/core/tools/wait-for-machine.sh"
    (cd "$B" && env MALLOC_ARENA_MAX=2 ARCH_BUILD="$B" "$@" prlimit --as=10000000000 \
        java -Xmx3g -XX:ActiveProcessorCount=4 -cp "$(cat "$B/test-classpath.txt")" com.mdeo.optimizer.ArchHarnessMainKt)
}
"$P/core/harness/install-harness.sh" "$WT"
cp "${ARCH_PLUGIN_SRC:-$("$P/core/tools/checkout.sh" palladio-sim-service)/target/release/palladio-sim-service}" "$B/plugin-bin.new" && mv -f "$B/plugin-bin.new" "$B/plugin-bin"
PORT=3192 HOST=127.0.0.1 BACKEND_API_URL=http://127.0.0.1:1/api "$B/plugin-bin" serve > "$B/manifest-serve.log" 2>&1 &
pid=$!
for _ in $(seq 50); do curl -sf http://127.0.0.1:3192/ -o "$B/plugin-manifest.json" && break; sleep 0.2; done
kill $pid
{
    export_ --optimize /transform --only mm
    export_ --optimize /transform --only models --models "$n.m"
    export_ --optimize /transform --only mt
    export_ --optimize /transform --contribution "$B/plugin-manifest.json" --only fn
} > "$B/export.log" 2>&1 || { grep -E "errors|FAILED|Error" "$B/export.log" | grep -v " 0 errors" | head -20; exit 1; }
if grep -E "[1-9][0-9]* errors" "$B/export.log"; then exit 1; fi
if [ ! -s "$B/test-classpath.txt" ] || [ "$(head -c ${#WT} "$B/test-classpath.txt")" != "$WT" ]; then
    ARCH_WT="$WT" "$P/core/harness/gradle.sh" :optimizer:testClasses -q
    ARCH_WT="$WT" "$P/core/harness/gradle.sh" -q :optimizer:printTestClasspath | tail -1 > "$B/test-classpath.txt"
fi
# the whole realisation (checked idempotent)
rm -rf "$B/realised"; mkdir -p "$B/realised"
java_ ARCH_MODE=apply ARCH_OPTIMIZE=/transform ARCH_SCRIPTS=metrics.fn ARCH_TRANSFORM=/transform/realise.mt ARCH_OUT=realised \
    ARCH_SEEDS="$n.model.json" > "$B/java-apply.log" 2>&1 || { tail -40 "$B/java-apply.log"; exit 1; }
grep -E "applied (true|false)" "$B/java-apply.log"
# one evaluation per seed (its OP lines: one per system operation)
rm -rf "$B/eval-$p"; mkdir -p "$B/eval-$p"
runs="realised/$n.model.json"
if [ -n "${SEEDS:-}" ]; then
    runs=$(python3 - "$B" "$n" ${SEEDS} <<'PY'
import json, sys
b, n, seeds = sys.argv[1], sys.argv[2], sys.argv[3:]
m = json.load(open(f"{b}/realised/{n}.model.json"))
out = []
for s in seeds:
    for i in m["instances"]:
        if i["className"] == "LoadProfile":
            i["properties"]["seed"] = float(s)
            i["properties"]["replications"] = 1.0
    f = f"realised/{n}-seed{s}.model.json"
    json.dump(m, open(f"{b}/{f}", "w"))
    out.append(f)
print(",".join(out))
PY
)
fi
java_ ARCH_MODE=evaluate ARCH_THREADS=1 ARCH_OPTIMIZE=/transform ARCH_SCRIPTS=metrics.fn ARCH_SEEDS="$runs" ARCH_OUT="eval-$p" \
    ARCH_REPORT="metrics.fn::printOperations,metrics.fn::latencyBudget,metrics.fn::simulationFailed,metrics.fn::responseTime,metrics.fn::changeCoupling,metrics.fn::inconsistency" \
    ARCH_EXTERNAL="spawn:$B/plugin-bin serve" ARCH_PLUGIN_PORT=3191 ARCH_JWKS_PORT=18191 \
    > "$B/eval-$p/java.log" 2>&1 || { tail -40 "$B/eval-$p/java.log"; exit 1; }
# next to the model's source (the case's models)
src="$(python3 "$P/core/tools/stage_project.py" --source "models/$n.m")"
python3 - "$B/eval-$p/java.log" "$P/$(dirname "$src")/$n-p95-$p.json" "$p" "$P/$src" <<'PY'
import json, re, sys
log, out, profile, model = sys.argv[1:5]
runs, cur, failed, objs = [], {}, None, []
for line in open(log):
    w = line.split()
    if w[:1] == ["OP"]:
        name, count = w[1], int(float(w[2]))
        mean, p50, p90, p95, p99 = map(float, w[3:8])
        cur[name] = dict(count=count, meanMs=mean, p50Ms=p50, p90Ms=p90, p95Ms=p95, p99Ms=p99)
    elif w[:1] == ["FAILED"]:
        failed = line.strip()
    elif ".model.json: {" in line:
        runs.append(cur); cur = {}
        objs.append(json.loads(line[line.index("{"):line.rindex("}") + 1]))
if failed or not runs or not all(runs):
    sys.exit(f"{log}: a simulation of today failed or measured nothing ({failed})")
# the mean over the seeds' simulations (one simulation: its values); a request type missing in one counts 0
names = sorted(set().union(*runs))
ops = {k: {s: sum(r.get(k, {}).get(s, 0.0) for r in runs) / len(runs) for s in ("meanMs", "p50Ms", "p90Ms", "p95Ms", "p99Ms", "count")}
       for k in names}
for v in ops.values():
    v["count"] = int(round(v["count"]))
text = open(model).read()
warm = re.search(r"warmUpSeconds\s*=\s*([0-9.]+)", text).group(1)
end = re.search(r"endSeconds\s*=\s*([0-9.]+)", text).group(1)
ops.pop("token", None)  # the login is Keycloak's, not a gateway request type
json.dump({"source": f"realised {model.split('/')[-1]} simulated with its {profile} profile (window {warm}-{end} s), "
                     "core/mdeo/transform/metrics.fn printOperations (core/tools/gen_domain_budgets.sh)",
           "unit": "ms", "seeds": len(runs),
           **{s: {k: v[s] for k, v in sorted(ops.items())} for s in ("meanMs", "p50Ms", "p90Ms", "p95Ms", "p99Ms", "count")}},
          open(out, "w"), indent=1)
open(out, "a").write("\n")
# today's values that C4 and C5 bound (ObjectiveBound): means over the seeds
bounds = out.replace("-p95-", "-objectives-")
json.dump({"source": f"realised {model.split('/')[-1]}, {profile} profile, metrics.fn (core/tools/gen_domain_budgets.sh)",
           "seeds": len(objs), **{k: sum(o[k] for o in objs) / len(objs) for k in ("changeCoupling", "inconsistency")}},
          open(bounds, "w"), indent=1)
open(bounds, "a").write("\n")
low = sorted(k for k, v in ops.items() if v["count"] < 20)
print(f"{profile}: wrote {out} ({len(ops)} request types; fewer than 20 completions: {', '.join(low) or 'none'})")
PY
echo "next: core/generator/derive.py, core/generator/perclass_seed.py, then core/tools/run-domain.sh"
