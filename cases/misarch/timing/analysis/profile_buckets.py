#!/usr/bin/env python3
"""Folded stacks (async-profiler, itimer) -> CPU per bucket, per container and segment (README.md §3.1).

    profile_buckets.py WINDOW [--rules buckets.yaml] [--out WINDOW/analysis/buckets.json] [--top 15]
    profile_buckets.py --file F.collapsed[.gz] [--top 30]          classify one file, print buckets + unmatched

Per segment (hooks.json) and app container: samples per bucket x the sampling interval = sampled CPU ms. The idle
baseline is the window's profiled `idle` phase: its bucket rates (ms/s) times the segment's length are subtracted
(clamped at 0). Reported per container: bucket ms (raw and net of idle), unmatched share of the net CPU, the
coverage = sampled CPU / cgroup CPU over the same interval (cpu.csv), and the top unmatched stacks (leaf part) for
the manual rule check. Shares exclude the `instrumentation` part (the cost of the on configuration itself).

Warm check: `jitShare` = the jit bucket (compiler threads) / net CPU without instrumentation, per
container and over all apps of a segment (`_all`); a steady segment above JIT_MAX (3 %) is flagged `jitFlag` (its
code was still being compiled: the type ran cold, README.md §4.2 warm-up bursts). GC is a separate bucket `gc`.
"""
import argparse
import collections
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

RULES = os.path.join(common.HERE, "buckets.yaml")
JIT_MAX = 0.03           # jit share of a steady segment's net CPU above which it counts as not warm


class Classifier:
    def __init__(self, path=RULES):
        y = common.load_yaml(path)
        self.rules = []          # (bucket, part, strong, prefixes, substrings)
        self.parts = {}
        for b in y["buckets"]:
            pats = [str(p) for p in b["frames"]]
            self.rules.append((b["name"], b["part"], b.get("strength", "strong") == "strong",
                               tuple(p for p in pats if not p.startswith("~")),
                               tuple(p[1:] for p in pats if p.startswith("~"))))
            self.parts[b["name"]] = b["part"]
        self.cache = {}

    def frame(self, f):
        r = self.cache.get(f)
        if r is None:
            r = (None, False)
            for name, part, strong, pre, sub in self.rules:
                if f.startswith(pre) or any(s in f for s in sub):
                    r = (name, strong)
                    break
            self.cache[f] = r
        return r

    def stack(self, frames):
        weak = None
        for f in reversed(frames):
            name, strong = self.frame(f)
            if name is None:
                continue
            if strong:
                return name
            if weak is None:
                weak = name
        return weak or "unmatched"


def read_folded(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            st, _, n = line.rpartition(" ")
            try:
                yield st.split(";"), int(n)
            except ValueError:
                continue


def classify_file(cl, path, top=0):
    b = collections.Counter()
    unm = collections.Counter()
    for frames, n in read_folded(path):
        k = cl.stack(frames)
        b[k] += n
        if top and k == "unmatched":
            unm[";".join(frames[-4:])] += n
    return b, unm


def interval_ms(hooks):
    iv = str(hooks.get("interval", "10ms"))
    if iv.endswith("ms"):
        return float(iv[:-2])
    if iv.endswith("us"):
        return float(iv[:-2]) / 1000
    return float(iv) / 1e6        # plain number: nanoseconds (async-profiler default unit)


def analyse_window(d, rules=RULES, top=15):
    d = common.window_dir(d)
    cl = Classifier(rules)
    hooks = common.load_json(d, "hooks.json", {})
    ivms = interval_ms(hooks)
    segs = common.segments(d)
    adir = os.path.join(d, "asprof")
    files = collections.defaultdict(dict)       # seg -> container -> path
    if os.path.isdir(adir):
        for f in os.listdir(adir):
            seg, _, rest = f.partition("__")
            files[seg][rest.split(".collapsed")[0]] = os.path.join(adir, f)
    try:
        cd = common.cpu_data(d)
    except Exception:
        cd = None
    seg_by_file = {common.segname(s): s for s in segs}
    raw = {}
    for fseg, conts in files.items():
        seg = seg_by_file.get(fseg)
        if seg is None:
            continue
        for c, p in conts.items():
            raw[(seg, c)] = classify_file(cl, p, top)
    idle_rate = {}
    if "idle" in segs:
        dur = segs["idle"]["end"] - segs["idle"]["start"]
        for (seg, c), (b, _) in raw.items():
            if seg == "idle" and dur > 0:
                idle_rate[c] = {k: v * ivms / dur for k, v in b.items()}
    out = {"window": os.path.basename(d), "intervalMs": ivms, "rules": os.path.relpath(rules, common.TIMING),
           "parts": cl.parts, "segments": {}}
    for (seg, c), (b, unm) in sorted(raw.items()):
        s = segs[seg]
        dur = s["end"] - s["start"]
        ms = {k: v * ivms for k, v in b.items()}
        idle = {k: r * dur for k, r in idle_rate.get(c, {}).items()} if seg != "idle" else {}
        net = {k: max(0.0, ms.get(k, 0.0) - idle.get(k, 0.0)) for k in set(ms) | set(idle)}
        tot_net = sum(net.values())
        tot = sum(ms.values())
        denom = sum(v for k, v in net.items() if cl.parts.get(k) != "instrumentation")
        cg = None
        if cd is not None:
            u = cd.usec(f"{common.PREFIX}{c}-1", s["start"], s["end"])
            cg = u / 1000 if u is not None else None
        e = {"durationS": round(dur, 2), "sampledMs": round(tot, 1), "cgroupMs": round(cg, 1) if cg is not None else None,
             "coverage": round(tot / cg, 3) if cg else None,
             "bucketsMs": {k: round(v, 1) for k, v in sorted(ms.items())},
             "idleMs": {k: round(v, 1) for k, v in sorted(idle.items()) if v},
             "netMs": {k: round(v, 1) for k, v in sorted(net.items())},
             "netTotalMs": round(tot_net, 1),
             "shares": {k: round(v / denom, 4) for k, v in sorted(net.items())
                        if denom > 0 and cl.parts.get(k) != "instrumentation"},
             "instrumentationShareOfNet": round(net.get("instrumentation", 0) / tot_net, 4) if tot_net else None,
             "unmatchedShare": round(net.get("unmatched", 0) / tot_net, 4) if tot_net else None,
             "unmatchedShareRaw": round(ms.get("unmatched", 0) / tot, 4) if tot else None,
             "jitShare": round(net.get("jit", 0) / denom, 4) if denom > 0 else None}
        if top:
            e["topUnmatched"] = [[round(n * ivms, 1), k] for k, n in unm.most_common(top)]
        out["segments"].setdefault(seg, {})[c] = e
    # per segment: unmatched share over all app containers (CPU-weighted)
    for seg, conts in out["segments"].items():
        tn = sum(v["netTotalMs"] for v in conts.values())
        un = sum(v["netMs"].get("unmatched", 0) for v in conts.values())
        ins = sum(v["netMs"].get("instrumentation", 0) for v in conts.values())
        jit = sum(v["netMs"].get("jit", 0) for v in conts.values())
        js = round(jit / (tn - ins), 4) if tn - ins > 0 else None
        conts["_all"] = {"netTotalMs": round(tn, 1), "unmatchedShare": round(un / tn, 4) if tn else None,
                         "jitShare": js, "jitFlag": bool(seg.endswith(":steady") and js is not None and js > JIT_MAX)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("window", nargs="?")
    ap.add_argument("--file")
    ap.add_argument("--rules", default=RULES)
    ap.add_argument("--out")
    ap.add_argument("--top", type=int, default=15)
    a = ap.parse_args()
    if a.file:
        b, unm = classify_file(Classifier(a.rules), a.file, a.top)
        tot = sum(b.values())
        for k, v in b.most_common():
            print(f"{v:8d} {100 * v / tot:6.2f}%  {k}")
        print("--- top unmatched (last 4 frames)")
        for k, v in unm.most_common(a.top):
            print(f"{v:8d}  {k[:250]}")
        return
    d = common.window_dir(a.window)
    r = analyse_window(d, a.rules, a.top)
    out = a.out or os.path.join(d, "analysis", "buckets.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(r, open(out, "w"), indent=1)
    for seg, conts in r["segments"].items():
        print(f"{seg}: all apps net {conts['_all']['netTotalMs']} ms, unmatched {conts['_all']['unmatchedShare']}, "
              f"jit {conts['_all']['jitShare']}{' NOT WARM' if conts['_all']['jitFlag'] else ''}")
        for c, v in sorted(conts.items(), key=lambda kv: -kv[1]["netTotalMs"]):
            if c == "_all" or v["netTotalMs"] < 50:
                continue
            print(f"   {c:14s} net {v['netTotalMs']:8.1f} ms cov {v['coverage']} unm {v['unmatchedShare']} "
                  f"instr {v['instrumentationShareOfNet']} " +
                  " ".join(f"{k}={x:.2f}" for k, x in sorted(v["shares"].items(), key=lambda kv: -kv[1]) if x >= 0.01))
    print(out)


if __name__ == "__main__":
    main()
