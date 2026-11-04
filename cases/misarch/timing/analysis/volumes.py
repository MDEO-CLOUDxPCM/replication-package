#!/usr/bin/env python3
"""Data volumes per window: what volume_before.json / volume_after.json really say after a reset.

    volumes.py WINDOW [WINDOW ...] [--baseline timing/data/baseline_counts.json] [--out timing/raw/volumes.json]

The harness counts rows with pg_stat_user_tables.n_live_tup (harness/stackctl.py). After the reset
(`CREATE DATABASE ... TEMPLATE <svc>_baseline`) the cumulative statistics of the new database start empty:
n_live_tup is 0 for every table, and then counts inserted minus deleted rows, until an autovacuum or autoanalyze
of the table sets it to the estimated real count. So `before = 0` right after a reset is not an empty table, and
`after` is either the net change (table not analysed in the window) or the real count (analysed). Per table:
- analysed in the window when after >= ANALYSED_SHARE x baseline (baseline > 0): growth ~ after - baseline
  (an estimate: n_live_tup is then the analyser's estimate);
- else growth = after - before (exact net inserts minus deletes; deletes of baseline rows give negative values).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

ANALYSED_SHARE = 0.5
BASELINE = os.path.join(common.TIMING, "data", "baseline_counts.json")
SMALL = {("shipment", "shipmentmethodentity"): "shipment methods", ("discount", "discountentity"): "discounts",
         ("discount", "couponentity"): "coupons", ("catalog", "categoryentity"): "categories",
         ("tax", "taxrateentity"): "tax rates", ("tax", "taxrateversionentity"): "tax rate versions",
         ("catalog", "categorycharacteristicentity"): "category characteristics",
         ("order", "shipmentmethodentity"): "order: shipment method copies",
         # the same copy before the unified schema (order V4__kotlin_naming; the windows up to approx3)
         ("order", "shipment_methods"): "order: shipment method copies"}


def small_growth(rows):
    """{label: growth} of the SMALL tables; a label with several tables (old and unified names) takes the one the
    window has."""
    out = {}
    for k, label in SMALL.items():
        g = rows.get(f"{k[0]}.{k[1]}", {}).get("growth")
        if out.get(label) is None:
            out[label] = g
    return out


def tables(vol):
    """{(db, table): n_live_tup} from a volume_*.json (the <svc>_baseline template databases are skipped)."""
    out = {}
    for _c, dbs in (vol or {}).get("dbs", {}).items():
        for db, v in dbs.items():
            if db.endswith("_baseline") or "tables" not in v:
                continue
            for t, n in v["tables"].items():
                out[(db, t)] = n
    return out


def growth(before, after, baseline):
    """-> (growth, how) for one table."""
    if after is None:
        return None, "missing"
    if baseline and after >= ANALYSED_SHARE * baseline and (before or 0) < ANALYSED_SHARE * baseline:
        return after - baseline, "analysed in the window (estimate)"
    if baseline and (before or 0) >= ANALYSED_SHARE * baseline:
        return after - before, "counted (statistics valid at the start)"
    return after - (before or 0), "net inserts - deletes since the reset"


def analyse(windows, baseline_path=BASELINE):
    base = {}
    for db, ts in json.load(open(baseline_path)).items():
        for t, n in ts.items():
            base[(db, t)] = n
    out = {}
    for w in windows:
        d = common.window_dir(w)
        b = tables(common.load_json(d, "volume_before.json"))
        a = tables(common.load_json(d, "volume_after.json"))
        if not b and not a:
            continue
        zero_before = sum(1 for k, v in b.items() if v == 0 and base.get(k))
        rows = {}
        for k in sorted(set(a) | set(b)):
            g, how = growth(b.get(k), a.get(k), base.get(k))
            rows[f"{k[0]}.{k[1]}"] = {"baseline": base.get(k), "before": b.get(k), "after": a.get(k), "growth": g,
                                      "how": how}
        small = small_growth(rows)
        out[os.path.basename(d)] = {"tablesWithBaselineRows": sum(1 for k in b if base.get(k)),
                                    "zeroBeforeWithBaselineRows": zero_before, "small": small,
                                    "largestGrowth": sorted(((r["growth"], t) for t, r in rows.items()
                                                             if r["growth"] is not None), reverse=True)[:8],
                                    "tables": rows}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("windows", nargs="+")
    ap.add_argument("--baseline", default=BASELINE)
    ap.add_argument("--out", default=os.path.join(common.RAW, "volumes.json"))
    a = ap.parse_args()
    r = analyse(a.windows, a.baseline)
    json.dump(r, open(a.out, "w"), indent=1)
    for w, v in r.items():
        print(f"{w:22s} zero before (of {v['tablesWithBaselineRows']} with baseline rows): "
              f"{v['zeroBeforeWithBaselineRows']}; small: " + ", ".join(f"{k} {x:+d}" if x is not None else f"{k} -"
                                                                       for k, x in v["small"].items()))
        print("    largest:", ", ".join(f"{t} {g:+d}" for g, t in v["largestGrowth"][:6]))
    print(a.out)


if __name__ == "__main__":
    main()
