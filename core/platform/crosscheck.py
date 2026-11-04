#!/usr/bin/env python3
"""Evaluates the solutions of a downloaded platform execution (core/platform/dl.mjs) with the
headless harness (the same metrics.fn and plugin binary, ARCH_MODE=evaluate) and compares the
values with the platform's report.json.

    crosscheck.py build/platform/executions/<execution> [--build build/ab] [--threads 4] [--values <file>] [--config <the run's .config>]

The execution is dl.mjs's layout (batch_<n>/report.json) or the workbench's download zip unpacked
(report.json and the solutions at the top, as batch 1). The harness build dir (default build/ab,
made by core/tools/run-domain.sh with ARCH_DIR=build/ab) must hold test-classpath.txt, plugin-bin and the
exported scripts. --values writes every solution's harness values, the reporting metrics included
(modularity, replicas, ...), keyed by solution stem, for core/platform/to_run.py --values. --config: the
objectives and constraints in the config's order (`minimize f` / `constraint f` lines, as report.json lists them;
default: the paper's goal, cases/misarch/mdeo/configs/today-3obj-5sim.config, which perclass-3obj-5sim.config shares).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

P = Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument("execution")
ap.add_argument("--build", default=str(P / "build/ab"))
ap.add_argument("--threads", type=int, default=4)
ap.add_argument("--values")
ap.add_argument("--config", default=str(P / "cases/misarch/mdeo/configs/today-3obj-5sim.config"))
a = ap.parse_args()
B = Path(a.build).resolve()
ex = Path(a.execution).resolve()
REPORT = ["cohesionServices", "cohesionServers", "failureSync", "failureAsync", "modularity", "replicas", "utilisation",
          "peakUtilisation", "responseTime", "simulationFailed", "peakPods", "createdPods", "simulationWallMs"]
text = re.sub(r"//[^\n]*", "", Path(a.config).read_text())
NAMES = re.findall(r"^\s*minimize\s+(\w+)", text, re.M) + re.findall(r"^\s*constraint\s+(\w+)", text, re.M)
REPORT = [n for n in ["changeCoupling", "inconsistency", "performance"] if n not in NAMES] + REPORT
rel = f"platform-check/{ex.name}"
work = B / rel
shutil.rmtree(work, ignore_errors=True)
(work / "out").mkdir(parents=True)
report, seeds = {}, []
flat = (ex / "report.json").exists()
for bdir in [ex] if flat else sorted(ex.glob("batch_*")):
    rep = json.loads((bdir / "report.json").read_text())
    for s in rep["paretoFront"]:
        stem = Path(s["path"]).stem if flat else f"{bdir.name}-{Path(s['path']).stem}"
        text = (bdir / Path(s["path"]).name).read_text()
        (work / f"{stem}.model.json").write_text(text[text.index("{"):])
        seeds.append(f"{rel}/{stem}.model.json")
        report[stem] = s["objectives"] + s["constraints"]
env = dict(os.environ, MALLOC_ARENA_MAX="2", ARCH_BUILD=str(B), ARCH_OPTIMIZE="/transform", ARCH_SCRIPTS="metrics.fn",
           ARCH_MODE="evaluate", ARCH_OUT=f"{rel}/out", ARCH_SEEDS=",".join(seeds), ARCH_THREADS=str(a.threads),
           ARCH_REPORT=",".join(f"metrics.fn::{n}" for n in NAMES + (REPORT if a.values else [])), ARCH_EXTERNAL=f"spawn:{B}/plugin-bin serve")
cp = (B / "test-classpath.txt").read_text().strip()
log = subprocess.run(["java", f"-Xmx{os.environ.get('ARCH_HEAP', '6g')}", f"-XX:ActiveProcessorCount={a.threads}", "-cp", cp, "com.mdeo.optimizer.ArchHarnessMainKt"],
                     cwd=B, env=env, capture_output=True, text=True)
(work / "java.log").write_text(log.stdout + log.stderr)
worst = 0.0
harness = {}
for line in log.stdout.splitlines():
    if ".model.json: {" not in line:
        continue
    name, vals = line.split(": ", 1)
    stem = Path(name).name.replace(".model.json", "")
    h = json.loads(vals[: vals.rindex("}") + 1])
    harness[stem] = h
    diffs = []
    for n, pv in zip(NAMES, report[stem]):
        r = abs(pv - h[n]) / max(abs(h[n]), 1e-300) if h[n] != pv else 0.0
        worst = max(worst, r)
        diffs.append(f"{n} {pv!r}/{h[n]!r}" + (f" ({r:.1e})" if r else ""))
    print(stem, "; ".join(diffs))
if a.values:
    Path(a.values).write_text(json.dumps(harness, indent=1))
print(f"{len(report)} solutions, {len(harness)} evaluated by the harness, largest relative difference {worst:.1e}")
