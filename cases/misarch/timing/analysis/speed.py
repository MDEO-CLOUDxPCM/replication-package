#!/usr/bin/env python3
"""Machine speed regime per window and per phase (README.md §4.2).

    speed.py WINDOW [WINDOW ...]          print the probe per window (median, slow share) and per quiet phase

The dev VM runs in two regimes. In the "slow" one the same background work of the stack takes ~1.5x the CPU time
(no steal is reported, so it is contention or frequency on the host, invisible inside the VM): Dapr placement
~33-43 ms/s instead of 26-30, the sum of the sidecars' background ~1.5-1.8x, the gateway's idle CPU 100-135 ms/s
instead of 65-75, and the order path's CPU per order 1.6-1.8x in the factorial. A CPU total measured
in the slow regime is inflated by that factor.

Probes:
- `placement` (Dapr placement service, load-independent background): median of its CPU over 10-s bins of an
  interval, in ms/s. Works in every window, also at load. Fast regime ~28 ms/s (median over off/on/mech windows),
  slow > PLACEMENT_SLOW.
- `gateway_factor`: the gateway's CPU in an interval minus its request work, relative to its idle CPU in the fast
  regime (GATEWAY_FAST ms/s). Only meaningful where the gateway is nearly idle (the factorial at 2 requests/s);
  used there as the multiplicative speed factor because it tracks the order path's CPU (placement does not scale
  in proportion).
"""
import statistics as st
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

PLACEMENT_FAST = 28.0      # ms/s, median over off, on and mech windows in the fast regime
PLACEMENT_SLOW = 32.0      # above: slow regime
GATEWAY_FAST = 70.0        # ms/s, the gateway's idle CPU in the fast regime (median of quiet phases)


def binned_median(cd, key, s, e, step=10.0):
    """Median over `step`-s bins of a container's CPU in [s, e], ms/s; None without data."""
    v = []
    t = s
    while t + step / 2 <= e:
        c = cd.cores(key, t, min(e, t + step))
        if c is not None:
            v.append(c * 1000)
        t += step
    return st.median(v) if v else None


def placement(cd, s, e):
    return binned_median(cd, common.PREFIX + "placement-1", s, e)


def regime(probe_ms):
    if probe_ms is None:
        return None
    return "slow" if probe_ms > PLACEMENT_SLOW else "fast"


def gateway_factor(gateway_ms_per_s, request_work_ms_per_s, fast=GATEWAY_FAST):
    """Multiplicative speed factor >= 1 from the gateway's CPU rate (ms/s) in an interval where it is nearly idle:
    (gateway - its request work) / its fast idle rate, never below 1 (a fast interval is not corrected)."""
    if gateway_ms_per_s is None:
        return 1.0
    return max(1.0, (gateway_ms_per_s - request_work_ms_per_s) / fast)


def window_regime(w):
    """{window, probeMedian, slowShare (of the steady phases), phases: {name: probe}} for a window."""
    d = common.window_dir(w)
    cd = common.cpu_data(d)
    ph = common.phases(d)
    out = {}
    for n, (s, e) in sorted(ph.items(), key=lambda kv: kv[1][0]):
        if e - s >= 15:
            out[n] = placement(cd, s, e)
    steady = [v for n, v in out.items() if n.endswith(":steady") and v is not None]
    allv = [v for v in out.values() if v is not None]
    return {"window": os.path.basename(d), "probeMedian": round(st.median(allv), 1) if allv else None,
            "regime": regime(st.median(allv)) if allv else None,
            "slowSteadyShare": round(sum(v > PLACEMENT_SLOW for v in steady) / len(steady), 2) if steady else None,
            "phases": {k: (round(v, 1) if v is not None else None) for k, v in out.items()}}


def segment_regimes(w):
    """Third pass: {steady segment: {placement, benchMs, benchRatio, regime}}: placement over the steady phase
    (cpu.csv) and the bench window.py ran at the segment's end (hooks.json `speedBench`); window.json's gate probe
    under `window`."""
    d = common.window_dir(w)
    cd = common.cpu_data(d)
    ph = common.phases(d)
    bench = {r["seg"]: r["speedBench"] for r in (common.load_json(d, "hooks.json", {}) or {}).get("log", [])
             if r.get("speedBench") and "medianMs" in r["speedBench"]}
    out = {}
    for n, (s, e) in ph.items():
        if not n.endswith(":steady") or e - s < 15:
            continue
        p = placement(cd, s, e)
        b = bench.get(n, {})
        out[n] = {"placement": round(p, 1) if p is not None else None, "benchMs": b.get("medianMs"),
                  "benchRatio": b.get("ratio"), "regime": regime(p)}
    wj = common.load_json(d, "window.json", {}) or {}
    return {"window": wj.get("speedProbe"), "gateRegime": wj.get("speedRegime"), "segments": out}


def main():
    for w in sys.argv[1:]:
        r = window_regime(w)
        print(f"{r['window']:24s} placement median {r['probeMedian']} ms/s -> {r['regime']}, slow steady phases "
              f"{r['slowSteadyShare']}")
        slow = [k for k, v in r["phases"].items() if v is not None and v > PLACEMENT_SLOW]
        if slow:
            print("   slow phases:", ", ".join(f"{k} {r['phases'][k]}" for k in slow[:20]))


if __name__ == "__main__":
    main()
