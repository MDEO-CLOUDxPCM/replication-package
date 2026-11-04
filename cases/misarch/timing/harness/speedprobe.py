#!/usr/bin/env python3
"""Machine speed regime before and during a window (README.md §4.2; RESULTS.md §9).

    speedprobe.py [--placement-s 60] [--bench-only]      print one probe as JSON

The dev VM has a fast and a slow regime (the same work takes ~1.6-1.8x the CPU time in the slow one; no steal is
reported). Two probes:
- `placement`: the Dapr placement service's CPU (pure background, load-independent) from its cgroup over ~60 s, median
  of 10-s bins in ms/s. Fast ~28 ms/s, slow > PLACEMENT_SLOW (analysis/speed.py, same thresholds). Needs the stack.
- `bench`: a fixed-work CPU loop timed in a short-lived Python process (7 x 600k iterations of an LCG step, ~33 ms
  each on a fast core of the dev VM; median and min in ms). It needs no stack and costs ~0.25 CPU s, so it also runs
  at every steady segment's end (window.py). Its slow threshold is relative: median > BENCH_SLOW_RATIO x the fast
  reference (BENCH_FAST_MS, or $TIMING_BENCH_FAST_MS).
Rule (`regime`): placement decides when it has data; without placement the bench decides. `benchRatio` is recorded
in every probe, so the bench's own threshold can be checked against placement afterwards.
"""
import argparse
import json
import os
import statistics as st
import subprocess
import sys
import time

PREFIX = "misarch-kotlin-"
PLACEMENT = f"{PREFIX}placement-1"
PLACEMENT_FAST = 28.0
PLACEMENT_SLOW = 32.0        # analysis/speed.py
BENCH_FAST_MS = float(os.environ.get("TIMING_BENCH_FAST_MS", "32.6"))   # median on the dev VM, fast regime
BENCH_SLOW_RATIO = 1.3
BENCH_CODE = r"""
import time
def work(n):
    x = 0
    for i in range(n):
        x = (x * 1103515245 + 12345 + i) & 0xffffffff
    return x
r = []
for k in range(7):
    t = time.perf_counter(); work(600000); r.append((time.perf_counter() - t) * 1000)
print(" ".join(f"{x:.3f}" for x in r))
"""


def bench():
    """{medianMs, minMs, runsMs, ratio} of the fixed-work loop in a fresh process (no GIL contention with the load
    generator in the caller)."""
    t = time.time()
    try:
        out = subprocess.run([sys.executable, "-I", "-c", BENCH_CODE], capture_output=True, text=True, timeout=60).stdout
        runs = [float(x) for x in out.split()]
    except Exception as e:
        return {"t": t, "error": f"{type(e).__name__}: {e}"[:160]}
    if not runs:
        return {"t": t, "error": "no output"}
    med = st.median(runs)
    return {"t": t, "medianMs": round(med, 2), "minMs": round(min(runs), 2), "runsMs": [round(x, 2) for x in runs],
            "ratio": round(med / BENCH_FAST_MS, 3)}


def _cg_path(name):
    r = subprocess.run(["docker", "inspect", "-f", "{{.Id}}", name], capture_output=True, text=True)
    cid = r.stdout.strip()
    if not cid:
        return None
    p = f"/sys/fs/cgroup/system.slice/docker-{cid}.scope/cpu.stat"
    return p if os.path.exists(p) else None


def _usage_usec(p):
    for line in open(p):
        if line.startswith("usage_usec"):
            return int(line.split()[1])
    return None


def placement(seconds=60.0, step=10.0):
    """{medianMsPerS, binsMsPerS, seconds} of the placement container's CPU; None when it does not run."""
    p = _cg_path(PLACEMENT)
    if not p:
        return None
    bins = []
    t0 = time.time()
    u0, w0 = _usage_usec(p), time.monotonic()
    start = w0
    while time.monotonic() - start < seconds - 1e-6:
        time.sleep(step)
        u1, w1 = _usage_usec(p), time.monotonic()
        bins.append((u1 - u0) / 1000 / (w1 - w0))
        u0, w0 = u1, w1
    return {"t": t0, "seconds": round(time.time() - t0, 1), "medianMsPerS": round(st.median(bins), 2),
            "binsMsPerS": [round(x, 2) for x in bins]}


def regime_of(pl, bn):
    if pl and pl.get("medianMsPerS") is not None:
        return "slow" if pl["medianMsPerS"] > PLACEMENT_SLOW else "fast"
    if bn and bn.get("ratio") is not None:
        return "slow" if bn["ratio"] > BENCH_SLOW_RATIO else "fast"
    return None


def probe(placement_s=60.0):
    """One full probe: bench, then placement over `placement_s` (0: bench only)."""
    bn = bench()
    pl = placement(placement_s) if placement_s > 0 else None
    return {"t": time.time(), "bench": bn, "placement": pl, "regime": regime_of(pl, bn),
            "rule": "placement" if pl else "bench",
            "thresholds": {"placementSlowMsPerS": PLACEMENT_SLOW, "benchFastMs": BENCH_FAST_MS,
                           "benchSlowRatio": BENCH_SLOW_RATIO}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--placement-s", type=float, default=60.0)
    ap.add_argument("--bench-only", action="store_true")
    a = ap.parse_args()
    print(json.dumps(probe(0 if a.bench_only else a.placement_s), indent=1))


if __name__ == "__main__":
    main()
