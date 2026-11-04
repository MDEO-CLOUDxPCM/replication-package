#!/usr/bin/env python3
"""Warm-up bursts before the windows (README.md §4.2).

    bursts.py plan --table plans/approx3/bursts.json --types a,b,c [--out P.json]   the burst plan for these types
    bursts.py estimate --table plans/approx3/bursts.json --types a,b,c              its duration
    bursts.py state                                                                  which types are warm now

Why: without bursts the jit share (compiler threads) of a rare or writing type's steady segment was 5-56 % of its
apps' CPU (1.7-3 % for the hot reads; plans/burst_table.py): a type that runs 50-200 times per segment is measured
while C2 still compiles its path. On a large platform every path runs often enough to stay compiled, so the campaign
measures every type warm: before a window, each of its types whose gc+jit share was above 5 % (`need` in bursts.json,
burst_table.py) gets a burst of
~5,000 requests (C2's tier-4 threshold) unless its JVMs are still warm from an earlier burst; then the data reset
(timing/data/reset.sh) undoes the burst's rows. The JVMs keep their compiled code across the reset.

Warm state (raw/state/warm-state.json): per type the start time (docker StartedAt + restart count) of each app it
runs on, recorded when its burst ended. A type is warm while all those apps still have the same start: a stack mode
change, a switch change (block 6) or a restart during the reset makes it cold again.

Packing: bursts of types run concurrently in phases. The planned rate of a type is n / phase length, never above its
`maxRate` (U_TYPE of its busiest CPU-limited container); a type joins a phase only if every CPU-limited container
(apps 0.5 cores, gateway 2.4, Keycloak 2.0) stays below U_MAX of its limit, from the off totals per container in bursts.json
(`util`: fraction of the limit per request/s). Groups: the order chain (createShoppingcartItem -> createOrder ->
placeOrder) runs in one phase with the carts at 1.15x and the placements at 0.95x of the orders; a factorial cell's
foCart/foOrder/foPlace likewise, and two cells never share a phase (ext.py switches kits per cell).
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.dirname(HERE)
RAW = os.environ.get("TIMING_RAW") or os.path.join(T, "raw")
STATE = os.path.join(RAW, "state", "warm-state.json")
sys.path.insert(0, HERE)

U_MAX = 0.6          # per CPU-limited container, all concurrent bursts together
SETTLE_S = 30        # idle phase at the end of a burst plan (async follow-ups)
CHAIN = {"createOrder": 1.0, "createShoppingcartItem": 1.15, "placeOrder": 0.95}


def load(table):
    return json.load(open(table))


def groups(tab, types):
    """Burst groups for the types that need one: [{name, lead, members {type: factor}, n, maxRate, util, exclusive}]."""
    tt = tab["types"]
    need = [t for t in types if tt.get(t, {}).get("need")]
    out, done = [], set()
    chain = [t for t in need if t in CHAIN]
    if chain and ("createOrder" in chain or "placeOrder" in chain):
        mem = {t: f for t, f in CHAIN.items() if t in ("createOrder", "createShoppingcartItem") or t in chain}
        out.append(_group("chain", "createOrder", mem, tt, max(tt[t]["n"] for t in chain)))
        done |= set(mem)
    for t in need:
        if t in done:
            continue
        kind, _, cell = t.partition(".")
        if kind in ("foOrder", "foPlace", "foCart"):
            if cell in done:
                continue
            mem = {f"foCart.{cell}": 1.05, f"foOrder.{cell}": 1.0, f"foPlace.{cell}": 1.0}
            out.append(_group(f"fo:{cell}", f"foOrder.{cell}", mem, tt, tt[t]["n"], exclusive="fo"))
            done |= {cell} | set(mem)
            continue
        out.append(_group(t, t, {t: 1.0}, tt, tt[t]["n"]))
        done.add(t)
    return out


def _group(name, lead, members, tt, n, exclusive=None):
    util, rmax = {}, 1e9
    for t, f in members.items():
        e = tt.get(t) or tt.get(lead) or {}
        rmax = min(rmax, e.get("maxRate", 1e9) / f)
        for c, u in (e.get("util") or {}).items():
            util[c] = util.get(c, 0.0) + f * u
    return {"name": name, "lead": lead, "members": members, "n": n, "maxRate": rmax, "util": util,
            "exclusive": exclusive, "apps": sorted({a for t in members for a in (tt.get(t) or {}).get("apps", [])})}


def pack(gs, u_max=U_MAX):
    """Phases [{duration, groups: [(group, rate)]}]: longest first; a group joins the first phase where all limited
    containers stay below u_max at rate n / duration (<= its maxRate since the phase is at least as long)."""
    phases = []
    for g in sorted(gs, key=lambda g: -g["n"] / g["maxRate"]):
        for p in phases:
            r = g["n"] / p["duration"]
            if r > g["maxRate"] * 1.0001 or (g["exclusive"] and any(x["exclusive"] == g["exclusive"] for x, _ in p["groups"])):
                continue
            load = dict(p["load"])
            for c, u in g["util"].items():
                load[c] = load.get(c, 0.0) + u * r
            if all(v <= u_max for v in load.values()):
                p["groups"].append((g, r))
                p["load"] = load
                break
        else:
            r = g["maxRate"]
            phases.append({"duration": g["n"] / r, "groups": [(g, r)],
                           "load": {c: u * r for c, u in g["util"].items()}})
    return phases


def plan(tab, types, name="burst", u_max=None, scale=1.0):
    """loadgen plan of the bursts for `types` (only those with `need`), or None if none needs one. `scale` multiplies
    every group's n (a window's `burstScale`, at least 200 requests)."""
    gs = groups(tab, types)
    if not gs:
        return None
    for g in gs:
        g["n"] = max(200, round(g["n"] * scale))
    phases = pack(gs, u_max or tab.get("uMax", U_MAX))
    ph = []
    for k, p in enumerate(phases):
        rates = {}
        for g, r in p["groups"]:
            for t, f in g["members"].items():
                rates[t] = round(rates.get(t, 0.0) + r * f, 3)
        ph.append({"name": f"burst{k + 1}", "duration": round(p["duration"] + 0.5), "rates": rates})
    ph.append({"name": "settle", "duration": tab.get("settleS", SETTLE_S), "rates": {}})
    return {"name": name, "config": "any", "block": "warm", "rateLevel": "burst", "phases": ph,
            "durationS": sum(x["duration"] for x in ph),
            "groups": [{"name": g["name"], "n": g["n"], "rate": round(r, 3), "apps": g["apps"],
                        "peakUtil": {c: round(v, 3) for c, v in sorted(p["load"].items(), key=lambda kv: -kv[1])[:3]}}
                       for p in phases for g, r in p["groups"]],
            "types": sorted({t for g in gs for t in g["members"]})}


def estimate(tab, types, u_max=None, scale=1.0):
    p = plan(tab, types, u_max=u_max, scale=scale)
    return p["durationS"] if p else 0.0


# ---------------------------------------------------------------------------------------------- warm state
class WarmState:
    def __init__(self, path=STATE):
        self.path = path
        try:
            self.d = json.load(open(path))
        except Exception:
            self.d = {}

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        json.dump(self.d, open(self.path, "w"), indent=1)

    def warm(self, t, starts):
        rec = self.d.get(t)
        return bool(rec) and all(starts.get(c) == s for c, s in rec["starts"].items())

    def cold(self, tab, types, starts):
        """The types of `types` that need a burst and are not warm under the current JVM starts."""
        return [t for t in types if tab["types"].get(t, {}).get("need") and not self.warm(t, starts)]

    def mark(self, tab, types, starts):
        """After a burst: the apps of each type with their current start."""
        for t in types:
            apps = tab["types"].get(t, {}).get("apps") or []
            self.d[t] = {"t": time.time(), "starts": {c: starts.get(c) for c in (f"misarch-kotlin-{a}-1" for a in apps)
                                                      if starts.get(c)}}
        self.save()

    def restarted(self, starts):
        """Types whose recorded apps have restarted since their burst."""
        return sorted(t for t in self.d if not self.warm(t, starts))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["plan", "estimate", "state"])
    ap.add_argument("--table")
    ap.add_argument("--types", default="")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.cmd == "state":
        import stackctl
        st, ws = stackctl.starts(), WarmState()
        for t in sorted(ws.d):
            print(f"{t:45s} {'warm' if ws.warm(t, st) else 'cold'}")
        return
    tab = load(a.table)
    types = [x for x in a.types.split(",") if x] or list(tab["types"])
    p = plan(tab, types)
    if a.cmd == "estimate":
        print(f"{(p['durationS'] if p else 0) / 60:.1f} min for {len(p['types']) if p else 0} types")
        return
    s = json.dumps(p, indent=1)
    if a.out:
        open(a.out, "w").write(s)
    print(s if not a.out else a.out)


if __name__ == "__main__":
    main()
