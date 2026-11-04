#!/usr/bin/env python3
"""Block 6 (README.md §4.1): fill order's local copies (misarch-kotlin timing-mechanisms, V2__local_copies.sql,
docs/MECHANISMS.md) from the
source databases, so that a stack whose data was seeded with the switch off answers createOrder from the copies.

    mech_backfill.py [--check]

The copies are normally fed by events (only while MISARCH_LOCAL_COPIES is on). This is a preparation step outside
the windows (campaign.py runs it after switching the copies on): it upserts, in one transaction per run, exactly what
the events would have written:
  LocalCopyDiscountEntity               <- discount-db  DiscountEntity + DiscountTo{ProductVariant,Product,Category}Entity
  LocalCopyCouponEntity                 <- discount-db  CouponEntity (id, discountId)
  LocalCopyProductEntity                <- discount-db  ProductEntity + ProductToCategoryEntity (discount's own copy of catalog)
  LocalCopyProductVariantEntity         <- discount-db  ProductVariantEntity (id, productId)
  LocalCopyShipmentMethodEntity         <- shipment-db  ShipmentMethodEntity (fees, archivedAt IS NOT NULL)
  LocalCopyProductVariantVersionEntity  <- shipment-db  ProductVariantVersionEntity (id, weight; shipment's copy of catalog)
Upserts only (nothing is deleted; the sources never delete these rows). --check prints source and copy counts.
"""
import argparse
import json
import sys
import time

import stackctl as S

P = S.PREFIX
SRC = {"discount": (f"{P}discount-db-1", "discount"), "shipment": (f"{P}shipment-db-1", "shipment")}
ORDER = (f"{P}order-db-1", "order")

# (copy table, source, select, temp columns, upsert)
COPIES = [
    ("LocalCopyDiscountEntity", "discount",
     """SELECT d.id, d.discount, d.validfrom, d.validuntil, d.minorderamount,
          coalesce((SELECT array_agg(x.productvariantid) FROM discounttoproductvariantentity x WHERE x.discountid = d.id), '{}'),
          coalesce((SELECT array_agg(x.productid) FROM discounttoproductentity x WHERE x.discountid = d.id), '{}'),
          coalesce((SELECT array_agg(x.categoryid) FROM discounttocategoryentity x WHERE x.discountid = d.id), '{}')
        FROM discountentity d""",
     "id uuid, discount double precision, vf timestamptz, vu timestamptz, min bigint, v uuid[], p uuid[], c uuid[]",
     """INSERT INTO LocalCopyDiscountEntity (id, discount, validFrom, validUntil, minOrderAmount, appliesVariantIds,
          appliesProductIds, appliesCategoryIds) SELECT id, discount, vf, vu, min, v, p, c FROM t
        ON CONFLICT (id) DO UPDATE SET discount = EXCLUDED.discount, validFrom = EXCLUDED.validFrom,
          validUntil = EXCLUDED.validUntil, minOrderAmount = EXCLUDED.minOrderAmount,
          appliesVariantIds = EXCLUDED.appliesVariantIds, appliesProductIds = EXCLUDED.appliesProductIds,
          appliesCategoryIds = EXCLUDED.appliesCategoryIds"""),
    ("LocalCopyCouponEntity", "discount", "SELECT id, discountid FROM couponentity",
     "id uuid, d uuid",
     "INSERT INTO LocalCopyCouponEntity (id, discountId) SELECT id, d FROM t ON CONFLICT DO NOTHING"),
    ("LocalCopyProductEntity", "discount",
     """SELECT p.id, coalesce(array_agg(pc.categoryid) FILTER (WHERE pc.categoryid IS NOT NULL), '{}')
        FROM productentity p LEFT JOIN producttocategoryentity pc ON pc.productid = p.id GROUP BY p.id""",
     "id uuid, c uuid[]",
     """INSERT INTO LocalCopyProductEntity (id, categoryIds) SELECT id, c FROM t
        ON CONFLICT (id) DO UPDATE SET categoryIds = EXCLUDED.categoryIds"""),
    ("LocalCopyProductVariantEntity", "discount", "SELECT id, productid FROM productvariantentity",
     "id uuid, p uuid",
     "INSERT INTO LocalCopyProductVariantEntity (id, productId) SELECT id, p FROM t ON CONFLICT DO NOTHING"),
    ("LocalCopyShipmentMethodEntity", "shipment",
     "SELECT id, basefees, feesperitem, feesperkg, archivedat IS NOT NULL FROM shipmentmethodentity",
     "id uuid, b bigint, i bigint, k bigint, a boolean",
     """INSERT INTO LocalCopyShipmentMethodEntity (id, baseFees, feesPerItem, feesPerKg, archived)
          SELECT id, b, i, k, a FROM t
        ON CONFLICT (id) DO UPDATE SET baseFees = EXCLUDED.baseFees, feesPerItem = EXCLUDED.feesPerItem,
          feesPerKg = EXCLUDED.feesPerKg, archived = EXCLUDED.archived"""),
    ("LocalCopyProductVariantVersionEntity", "shipment", "SELECT id, weight FROM productvariantversionentity",
     "id uuid, w double precision",
     "INSERT INTO LocalCopyProductVariantVersionEntity (id, weight) SELECT id, w FROM t ON CONFLICT DO NOTHING"),
]


def run(c, db, sql, timeout=300):
    rc, out, err = S.psql(c, sql, db, timeout=timeout)
    if rc:
        raise SystemExit(f"{c}/{db}: {err.strip()[-500:]}")
    return out


def export(src, select):
    c, db = SRC[src]
    sql = "\\copy (" + " ".join(select.split()) + ") TO STDOUT WITH (FORMAT csv)\n"
    return run(c, db, sql)


def count(c, db, table):
    return int(run(c, db, f"SELECT count(*) FROM {table};").strip())


def check():
    res = {}
    for table, src, select, _, _ in COPIES:
        c, db = SRC[src]
        n_src = int(run(c, db, f"SELECT count(*) FROM ({' '.join(select.split())}) x;").strip())
        res[table] = {"source": n_src, "copy": count(*ORDER, table)}
    return res


def backfill():
    t0 = time.time()
    script = ["\\set ON_ERROR_STOP 1", "BEGIN;"]
    rows = {}
    for table, src, select, cols, upsert in COPIES:
        data = export(src, select)
        rows[table] = data.count("\n")
        script += ["DROP TABLE IF EXISTS t;", f"CREATE TEMP TABLE t ({cols});", "COPY t FROM STDIN WITH (FORMAT csv);",
                   data.rstrip("\n"), "\\.", upsert + ";"]
    script += ["DROP TABLE IF EXISTS t;", "COMMIT;"]
    run(*ORDER, "\n".join(script) + "\n", timeout=600)
    return {"exported": rows, "seconds": round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    out = {} if a.check else backfill()
    out["counts"] = check()
    print(json.dumps(out, indent=1))
    bad = {k: v for k, v in out["counts"].items() if v["copy"] < v["source"]}
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
