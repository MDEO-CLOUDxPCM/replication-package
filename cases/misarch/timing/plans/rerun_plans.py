#!/usr/bin/env python3
"""Re-run plans for the pass's disturbed segments (host-side slow episodes, README.md §4.2, RESULTS.md §9): the
segments of approx3's windows named in RERUN, cut out of their plans with every phase they consist of (pre, warm,
steady, drain, and a fill phase where the type needs one), in their original order, between a new idle and idle_end.

    rerun_plans.py [--out timing/plans/rerun4]

Writes <out>/approx3/ (manifest.json, one plan per re-run window, bursts.json and the warm-up plans copied from
plans/approx3), so `campaign.py --plans <out>` runs them like the pass (windows approx4_rerun_*,
the scheduled-job guard, bursts, data reset, migrations, counters) and leaves every approx4_* window as it is.
parts.py takes the later window of a type (`off.update`, `on.update`): list the re-run window last in --off / --on.

Dependencies kept: placeOrder needs createOrder's pool (createOrder < 50 min ago, requests/reqs.py), wishlistView needs
the wishlist fill, the .cold cache segments follow their .hot one.
"""
import argparse
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "approx3")

# re-run window -> [(source window, [segment base names])]; a segment's phases are <base>:<phase>
RERUN = {
    "rerun_off": [   # off_w1 10:00-10:05 (products, products.anon), off_w3 <=11:02-11:05 (createUserAddress)
        ("off_w1", ["products", "products.anon"]),
        ("off_w3", ["address.createUserAddress"]),
    ],
    "rerun_on": [    # on_w2 16:00-16:10, plus createOrder for placeOrder's pool
        ("on_w2", ["user.updateUser", "adminUpdateProduct", "catalog.updateProductVariant", "registration",
                   "createShoppingcartItem", "createOrder", "placeOrder"]),
    ],
    "rerun_off2": [  # off_w1: product's pre (its local baseline) and the first 35 % of its steady in the 10:00 episode
        ("off_w1", ["product"]),
    ],
    "rerun_mech_on": [   # mech_on_w2 14:15-14:20, with the wishlist fill and the hot segment before the cold one
        ("mech_on_w2", ["wishlist.createWishlist", "wishlistView.hot", "wishlistView.cold",
                        "discount.createDiscount", "discount.updateDiscount"]),
    ],
}
COPY = ("bursts.json", "warm_timing.json", "warm_mech.json")


def segment_phases(plan, base):
    ph = [p for p in plan["phases"] if p["name"].split(":")[0] == base]
    if not ph:
        raise SystemExit(f"{plan['name']}: no phases of {base}")
    return ph


def build(name, parts, manifest):
    src_entries = {w["name"]: w for w in manifest["windows"]}
    first = src_entries[parts[0][0]]
    for w, _ in parts[1:]:      # one stack mode, prep and warm-up per window
        e = src_entries[w]
        for k in ("config", "block", "prep", "warm", "mechanisms"):
            if e.get(k) != first.get(k):
                raise SystemExit(f"{name}: {w} differs from {parts[0][0]} in {k}")
    phases, types, base_types, burst = [], [], {}, []
    idle = idle_end = None
    for w, bases in parts:
        plan = json.load(open(os.path.join(SRC, src_entries[w]["plan"])))
        idle = idle or next(p for p in plan["phases"] if p["name"] == "idle")
        idle_end = idle_end or next(p for p in plan["phases"] if p["name"] == "idle_end")
        for b in bases:
            phases += segment_phases(plan, b)
            if b in plan["types"]:
                types.append(b)
                if plan.get("baseTypes"):
                    base_types[b] = plan["baseTypes"][b]
            if b in (src_entries[w].get("burstTypes") or []):
                burst.append(b)
        extra = {k: plan[k] for k in ("mechanisms", "warm", "burstScale") if k in plan}
    phases = [idle] + phases + [idle_end]
    dur = sum(p["duration"] for p in phases)
    plan = dict(name=name, config=first["config"], block=first["block"], rateLevel=first.get("rateLevel"),
                types=types, prep=first.get("prep"), durationS=dur, phases=phases, burstTypes=burst, **extra)
    if base_types:
        plan["baseTypes"] = base_types
    entry = {k: v for k, v in first.items() if k not in ("plan", "name", "durationS", "burstTypes")}
    entry.update(plan=f"{name}.json", name=name, durationS=dur, burstTypes=burst,
                 rerunOf={w: bases for w, bases in parts})
    return plan, entry


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(HERE, "rerun4"))
    a = ap.parse_args()
    manifest = json.load(open(os.path.join(SRC, "manifest.json")))
    out = os.path.join(a.out, "approx3")     # campaign.py reads approx4's plans from <plans>/approx3/
    os.makedirs(out, exist_ok=True)
    entries = []
    for name, parts in RERUN.items():
        plan, entry = build(name, parts, manifest)
        json.dump(plan, open(os.path.join(out, f"{name}.json"), "w"), indent=1)
        entries.append(entry)
        print(f"{name}: {len(plan['types'])} types, {plan['durationS']} s ({', '.join(plan['types'])})")
    json.dump({"source": "timing/plans/rerun_plans.py", "windows": entries},
              open(os.path.join(out, "manifest.json"), "w"), indent=1)
    for f in COPY:
        shutil.copy(os.path.join(SRC, f), os.path.join(out, f))
    print(f"-> {out}")


if __name__ == "__main__":
    main()
