#!/usr/bin/env python3
"""Turns a downloaded platform execution (the workbench's "download" zip or core/platform/dl.mjs:
report.json and solution_<i>.m_gen) into a headless-style run directory that the explorer's
exporter reads (cases/misarch/explorer-packet/export-run.ts):

    to_run.py <execution dir> <build>/runs/<name> --seed <seed model.json> [--values <file>] [--generation <g>]
              [--config <the run's .config>]

Written: front.json (objectives and constraints in the domain configs' order, batches[0] = the
platform's front with each model and, with --values, its reporting values), designs.jsonl (one
line per front solution: its decision links that differ from the seed, as the harness's
ArchiveEvaluator writes them), solutions/solution_<i>.model.json (the models as the platform saved
them; the explorer's detail simulates them as they are) and log.txt (operators, crossover counts,
duration, from report.json).

The platform's export holds only the final front, so the run has no populations, no archive and no
other evaluated designs; per generation it has counters, the hypervolume of the feasible front and the best
constraint violation (report.json's graphData, with the hypervolume's normalisation; an execution from before the
platform wrote them there: the plots of its summary.md): written to platform_generations.json (the explorer's
history without populations); the execution's id and times (its execution.json) to platform_execution.json. --seed is the model the platform started from as model JSON (for a
committed realised seed, models/domain-<seed>-realised.m exported with core/harness/export.mjs
--only models): the decision diffs are against it. --values: a JSON object keyed by solution stem
(solution_<i>) with reporting metrics (modularity, replicas, ...; e.g. from a headless
re-evaluation), merged into each solution's report. --config: the objectives and constraints in the
config's order (`minimize f` / `constraint f` lines; default: the paper's goal,
cases/misarch/mdeo/configs/today-3obj-5sim.config, which perclass-3obj-5sim.config shares).
"""
import argparse
import json
import re
from pathlib import Path

DECISION_PROPS = {"resourceContainer", "mechanism", "style", "home"}

ap = argparse.ArgumentParser()
ap.add_argument("execution")
ap.add_argument("run")
ap.add_argument("--seed", required=True)
ap.add_argument("--seed-name", default="realised/domain-today.model.json", help="front.json's seed (relative to the build)")
ap.add_argument("--values")
ap.add_argument("--generation", type=int, help="generation recorded for the solutions (default: the last)")
ap.add_argument("--config", default=str(Path(__file__).resolve().parents[2] / "cases/misarch/mdeo/configs/today-3obj-5sim.config"))
a = ap.parse_args()
text = re.sub(r"//[^\n]*", "", Path(a.config).read_text())
OBJECTIVES = [f"MINIMIZE {f}" for f in re.findall(r"^\s*minimize\s+(\w+)", text, re.M)]
CONSTRAINTS = re.findall(r"^\s*constraint\s+(\w+)", text, re.M)

ex, run = Path(a.execution), Path(a.run)
rep = json.loads((ex / "report.json").read_text())
values = json.loads(Path(a.values).read_text()) if a.values else {}


def model_of(text):
    return json.loads(text[text.index("{"):])


def decisions(m):
    return {f"{l['sourceName']}.{l['sourceProperty']}": l["targetName"] for l in m["links"] if l["sourceProperty"] in DECISION_PROPS}


seed = decisions(json.loads(Path(a.seed).read_text()))
gens = rep.get("graphData", {}).get("generations", [])
last = a.generation if a.generation is not None else max(len(gens) - 1, 0)
front = rep["paretoFront"]
n_o, n_c = len(front[0]["objectives"]), len(front[0]["constraints"])
(run / "solutions").mkdir(parents=True, exist_ok=True)
batch, lines, missing = [], [], 0
for i, s in enumerate(front):
    stem = Path(s["path"]).stem
    m = model_of((ex / Path(s["path"]).name).read_text())
    rel = f"solutions/{stem}.model.json"
    (run / rel).write_text(json.dumps(m))
    d = decisions(m)
    missing += sum(1 for k in seed if k not in d)
    diff = {k: v for k, v in sorted(d.items()) if seed.get(k) != v}
    lines.append(json.dumps({"i": i, "g": last, "o": s["objectives"], "c": s["constraints"], "d": diff}))
    # the reporting metrics only: the objectives and constraints are the platform's own values
    keys = {o.split(" ")[1] for o in OBJECTIVES} | set(CONSTRAINTS)
    report = {k: v for k, v in values.get(stem, {}).items() if k not in keys and isinstance(v, (int, float))}
    batch.append({"objectives": s["objectives"], "constraints": s["constraints"], "model": rel, "report": report})
(run / "designs.jsonl").write_text("\n".join(lines) + "\n")


def summary_plot(title):
    """executions from before report.json had them: the y values of one plot of this batch in the execution's
    summary.md (``` plot blocks after a ##### title)"""
    f = ex.parent / "summary.md"
    if not f.exists():
        return None
    text = f.read_text()
    m = re.match(r"batch_(\d+)$", ex.name)
    if m:
        parts = re.split(r"^### Batch (\d+)\s*$", text, flags=re.M)
        text = next((parts[i + 1] for i in range(1, len(parts), 2) if parts[i] == m.group(1)), text)
    b = re.search(r"^##### " + re.escape(title) + r"\s*\n+```plot\n(.*?)\n```", text, flags=re.M | re.S)
    return json.loads(b.group(1))["data"][0]["y"] if b else None


xf = ex.parent / "execution.json"
if xf.exists():
    x = json.loads(xf.read_text())["execution"]
    (run / "platform_execution.json").write_text(json.dumps({k: x.get(k) for k in ("id", "name", "startedAt", "finishedAt")}))
box = rep.get("graphData", {}).get("hypervolume")
if any("hypervolume" in g for g in gens):
    hv, viol, source = [g.get("hypervolume") for g in gens], [g.get("bestConstraintViolation") for g in gens], "report.json"
else:
    hv, viol, source = summary_plot("Hypervolume (Feasible Solutions)"), summary_plot("Best Constraint Violation"), "summary.md"
pop = gens[0].get("totalModels", 0) if gens else 0
(run / "platform_generations.json").write_text(json.dumps({
    "hypervolume": {"source": source, **({"minimum": box["minimum"], "reference": box["reference"]} if box else {})},
    "generations": [{
        "index": g["generation"], "evaluated": pop * g["generation"], "timeMs": g.get("iterationTimeMs"),
        "executedTransformations": g.get("executedTransformations"), "skippedOperatorSlots": g.get("skippedOperatorSlots"),
        "hypervolume": hv[k] if hv and k < len(hv) else None, "bestViolation": viol[k] if viol and k < len(viol) else None,
    } for k, g in enumerate(gens)]}))
(run / "front.json").write_text(json.dumps({
    "seed": a.seed_name, "objectives": OBJECTIVES[:n_o], "constraints": CONSTRAINTS[:n_c], "batches": [batch],
}))
ops = rep["operators"]
xo = [g.get("crossover", {}) for g in gens]
per = {}
for g in xo:
    for k, v in g.get("perOperator", {}).items():
        per[k] = per.get(k, 0) + v
xlabels = {str(o["id"]): o["label"] for o in ops.get("crossovers", [])}
log = [
    f"platform execution {ex.resolve()}",
    f"operators ({len(ops['mutations'])}): [{', '.join(o['path'] for o in ops['mutations'])}]",
    f"crossover operators ({len(ops.get('crossovers', []))}): [{', '.join(o['path'] for o in ops.get('crossovers', []))}]",
    f"batch 0: {len(front)} solutions in the final front, {rep['durationMs']} ms, {len(gens)} generations, "
    f"{sum(g.get('executedTransformations', 0) for g in gens)} transformations tried, {sum(g.get('skippedOperatorSlots', 0) for g in gens)} operator slots skipped",
    f"batch 0 crossovers: attempted {sum(g.get('attempted', 0) for g in xo)}, succeeded {sum(g.get('succeeded', 0) for g in xo)}, "
    f"fell back {sum(g.get('fellBack', 0) for g in xo)}; applied per operator {{{', '.join(f'{xlabels.get(k, k)}={v}' for k, v in sorted(per.items()))}}}",
    # generation 1's live solutions are the initial population; every later generation evaluates as many offspring
    f"population {gens[0].get('totalModels', 0) if gens else 0}, evaluations {(gens[0].get('totalModels', 0) * len(gens)) if gens else 0}",
    f"search took {rep['durationMs']} ms for 1 batch(es)",
]
(run / "log.txt").write_text("\n".join(log) + "\n")
print(f"{run}: {len(front)} solutions ({n_o} objectives, {n_c} constraints), generation {last}, "
      f"decision links missing against the seed: {missing}, diff sizes {min(len(json.loads(l)['d']) for l in lines)}-{max(len(json.loads(l)['d']) for l in lines)}")
