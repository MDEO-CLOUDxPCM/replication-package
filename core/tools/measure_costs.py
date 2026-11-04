#!/usr/bin/env python3
"""Summary of core/tools/measure-costs.sh: <build>/results.json and a short report.

    measure_costs.py <build dir>

  - daySimSeconds: median wall time of one evaluation with one day-profile simulation (the seeds' one-simulation
    forms, single-threaded JVM, one plugin), from the harness's evaluate log (each seed's "(N ms)"); also the
    simulation's own wall time (metrics.fn simulationWallMs) and the range per seed;
  - perOffspringMs: the run's mean variation time per offspring (crossover + mutation including the repairs) over
    every kind of offspring (crossover, its fallback, mutation only), from log.txt's "offspring (ms per offspring)";
  - checkApplications: applied mutation tries of operators.json, with the inconsistent and multiplicity-broken ones;
  - checkCrossoverApplications: applied crossover tries of crossovers.json, likewise (and donors changed).
"""
import json
import os
import re
import statistics as st
import subprocess
import sys

B = sys.argv[1]
R = {"build": B, "commit": subprocess.run(["git", "-C", os.path.dirname(os.path.abspath(__file__)), "rev-parse", "--short", "HEAD"],
                                          capture_output=True, text=True).stdout.strip(),
     "host": os.uname().nodename, "cpus": os.cpu_count()}

f = os.path.join(B, "sim/java.log")
if os.path.exists(f):
    per, wall = {}, {}
    dec = json.JSONDecoder()
    for line in open(f):
        m = re.match(r"sim/models/(\w+)-(\d+)\.model\.json: (\{.*\}) \((\d+) ms\)\s*$", line)
        if m:
            per.setdefault(m.group(1), []).append(int(m.group(4)) / 1000)
            wall.setdefault(m.group(1), []).append(dec.raw_decode(m.group(3))[0]["simulationWallMs"] / 1000)
    allv = [x for v in per.values() for x in v]
    R["daySimSeconds"] = {"median": st.median(allv), "simulationMedian": st.median([x for v in wall.values() for x in v]),
                          "perSeed": {k: {"evaluation": v, "simulation": wall[k]} for k, v in per.items()}}

f = os.path.join(B, "offspring/log.txt")
if os.path.exists(f):
    txt = open(f).read()
    rows = re.findall(r"^  (crossover|fallback|mutation): (\d+) offspring.*?variation ([\d.]+) ms", txt, re.M)
    n = sum(int(c) for _, c, _ in rows)
    R["perOffspringMs"] = {"mean": sum(int(c) * float(v) for _, c, v in rows) / n, "offspring": n,
                           "byKind": {k: {"offspring": int(c), "ms": float(v)} for k, c, v in rows},
                           "searchTook": re.search(r"search took (\d+) ms", txt).group(1)}

f = os.path.join(B, "operators/operators.json")
if os.path.exists(f):
    ops = json.load(open(f))
    flat = [o for seed in ops.values() for o in seed["operators"].values()]
    R["checkApplications"] = {"applied": sum(o["applied"] for o in flat), "tries": sum(o["tries"] for o in flat),
                              "inconsistent": sum(o["inconsistent"] for o in flat), "multiplicityBroken": sum(o["multiplicityBroken"] for o in flat),
                              "operators": len({k for seed in ops.values() for k in seed["operators"]}), "seeds": len(ops),
                              "msPerTry": st.mean(o["msPerTry"] for o in flat)}

f = os.path.join(B, "crossovers/crossovers.json")
if os.path.exists(f):
    xs = json.load(open(f))
    R["checkCrossoverApplications"] = {"applied": sum(x["applied"] for x in xs), "tries": sum(x["tries"] for x in xs),
                                       "inconsistent": sum(sum(x["inconsistent"]) for x in xs),
                                       "multiplicityBroken": sum(x["multiplicityBroken"] for x in xs),
                                       "donorChanged": sum(x["donorChanged"] for x in xs), "jobs": len(xs),
                                       "operators": len({x["operator"] for x in xs})}

json.dump(R, open(os.path.join(B, "results.json"), "w"), indent=1)
for k in ("daySimSeconds", "perOffspringMs", "checkApplications", "checkCrossoverApplications"):
    if k in R:
        v = R[k]
        print(k, {a: b for a, b in v.items() if a not in ("perSeed", "byKind")})
