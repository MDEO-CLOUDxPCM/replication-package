#!/usr/bin/env python3
"""Consistency check of the baseline: every copy table against its owner, the order history's copies against the
orders, and exact row counts of every table.

    check_baseline.py [--counts OUT.json]      exit 1 if a check fails; --counts writes the per-table row counts
    check_baseline.py --compare baseline_counts.json   after a reset: the counts must equal the baseline's

Uses the same psql/COPY helpers as load_baseline.py (docker exec into misarch-kotlin-<svc>-db-1).
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_baseline import SERVICES, psql, rows  # noqa: E402


def ids(svc, sql):
    return set(rows(svc, sql))


CHECKS = [
    # (name, owner (svc, sql), copy (svc, sql))  - compared as sets of tuples
    ("address.userentity = users", ("user", "SELECT id FROM userentity"), ("address", "SELECT id FROM userentity")),
    ("discount.userentity = users", ("user", "SELECT id FROM userentity"), ("discount", "SELECT id FROM userentity")),
    ("notification.userentity = users", ("user", "SELECT id FROM userentity"), ("notification", "SELECT id FROM userentity")),
    ("review.userentity = users", ("user", "SELECT id FROM userentity"), ("review", "SELECT id FROM userentity")),
    ("wishlist.userentity = users", ("user", "SELECT id FROM userentity"), ("wishlist", "SELECT id FROM userentity")),
    ("shoppingcart.userentity = users", ("user", "SELECT id FROM userentity"), ("shoppingcart", "SELECT id FROM userentity")),
    ("order.userentity = users", ("user", "SELECT id FROM userentity"), ("order", "SELECT id FROM userentity")),
    ("invoice.userentity = users", ("user", "SELECT id FROM userentity"), ("invoice", "SELECT id FROM userentity")),
    ("invoice.useraddressentity = user addresses",
     ("address", "SELECT id, userid, street1, coalesce(street2,''), city, postalcode, country FROM addressentity "
                 "WHERE userid IS NOT NULL"),
     ("invoice", "SELECT id, userid, street1, street2, city, postalcode, country FROM useraddressentity")),
    ("invoice.vendoraddressentity = vendor addresses",
     ("address", "SELECT id, street1, city FROM addressentity WHERE userid IS NULL"),
     ("invoice", "SELECT id, street1, city FROM vendoraddressentity")),
    ("shipment.addressentity = addresses",
     ("address", "SELECT id, userid, street1, coalesce(street2,''), city, postalcode FROM addressentity"),
     ("shipment", "SELECT id, userid, street1, street2, city, postalcode FROM addressentity")),
    ("order.useraddressentity = active addresses",
     ("address", "SELECT userid, id FROM addressentity WHERE userid IS NOT NULL AND archivedat IS NULL"),
     ("order", "SELECT userid, id FROM useraddressentity")),
    ("catalog.taxrateentity = tax rates", ("tax", "SELECT id FROM taxrateentity"), ("catalog", "SELECT id FROM taxrateentity")),
    ("order.taxrateentity = current tax versions",
     ("tax", "SELECT t.id, v.id, v.rate::text, v.version FROM taxrateentity t JOIN taxrateversionentity v "
             "ON v.id = t.currentversionid"),
     ("order", "SELECT id, currentversionid, currentversionrate::text, currentversionversion FROM taxrateentity")),
    ("discount.categoryentity = categories", ("catalog", "SELECT id FROM categoryentity"),
     ("discount", "SELECT id FROM categoryentity")),
    ("discount.productentity = products", ("catalog", "SELECT id FROM productentity"), ("discount", "SELECT id FROM productentity")),
    ("review.productentity = products", ("catalog", "SELECT id FROM productentity"), ("review", "SELECT id FROM productentity")),
    ("discount.producttocategoryentity = product categories",
     ("catalog", "SELECT productid, categoryid FROM producttocategoryentity"),
     ("discount", "SELECT productid, categoryid FROM producttocategoryentity")),
    ("discount.productvariantentity = variants", ("catalog", "SELECT id, productid FROM productvariantentity"),
     ("discount", "SELECT id, productid FROM productvariantentity")),
    ("review.productvariantentity = variants", ("catalog", "SELECT id, productid FROM productvariantentity"),
     ("review", "SELECT id, productid FROM productvariantentity")),
    ("inventory.productvariantentity = variants", ("catalog", "SELECT id FROM productvariantentity"),
     ("inventory", "SELECT id FROM productvariantentity")),
    ("shoppingcart.productvariantentity = variants", ("catalog", "SELECT id FROM productvariantentity"),
     ("shoppingcart", "SELECT id FROM productvariantentity")),
    ("wishlist.productvariantentity = variants", ("catalog", "SELECT id FROM productvariantentity"),
     ("wishlist", "SELECT id FROM productvariantentity")),
    ("order.productvariantentity = variants with current version",
     ("catalog", "SELECT pv.id, v.id, v.retailprice, v.taxrateid FROM productvariantentity pv "
                 "JOIN productvariantversionentity v ON v.id = pv.currentversion"),
     ("order", "SELECT id, currentversionid, currentversionprice, currentversiontaxrateid FROM productvariantentity")),
    ("return.productvariantversionentity = versions",
     ("catalog", "SELECT id, canbereturnedfordays FROM productvariantversionentity"),
     ("return", "SELECT id, canbereturnedfordays FROM productvariantversionentity")),
    ("shipment.productvariantversionentity = versions", ("catalog", "SELECT id, weight FROM productvariantversionentity"),
     ("shipment", "SELECT id, weight FROM productvariantversionentity")),
    ("order.shipmentmethodentity = shipment methods", ("shipment", "SELECT id FROM shipmentmethodentity"),
     ("order", "SELECT id FROM shipmentmethodentity")),
    ("order.couponentity = coupons", ("discount", "SELECT id FROM couponentity"), ("order", "SELECT id FROM couponentity")),
    ("catalog.mediaentity = media links target", ("catalog", "SELECT DISTINCT mediaid FROM productvariantversiontomediaentity"),
     None),
    # order history
    ("payment.openorderentity = placed orders", ("order", "SELECT id FROM orderentity WHERE orderstatus = 'PLACED'"),
     ("payment", "SELECT orderid FROM openorderentity")),
    ("invoice.invoiceentity = placed orders", ("order", "SELECT id FROM orderentity WHERE orderstatus = 'PLACED'"),
     ("invoice", "SELECT orderid FROM invoiceentity")),
    ("shipment order shipments = placed orders", ("order", "SELECT id FROM orderentity WHERE orderstatus = 'PLACED'"),
     ("shipment", "SELECT DISTINCT orderid FROM shipmententity WHERE orderid IS NOT NULL")),
    ("shipment.orderitementity = placed items",
     ("order", "SELECT i.id, i.count, i.productvariantversionid FROM orderitementity i JOIN orderentity o ON o.id = i.orderid "
               "WHERE o.orderstatus = 'PLACED'"),
     ("shipment", "SELECT id, quantity, productvariantversionid FROM orderitementity")),
    ("return.orderentity = placed orders", ("order", "SELECT id, userid FROM orderentity WHERE orderstatus = 'PLACED'"),
     ("return", "SELECT id, userid FROM orderentity")),
    ("return.orderitementity = placed items",
     ("order", "SELECT i.id, i.orderid, i.compensatableamount, i.productvariantversionid FROM orderitementity i "
               "JOIN orderentity o ON o.id = i.orderid WHERE o.orderstatus = 'PLACED'"),
     ("return", "SELECT id, orderid, compensatableamount, productvariantversionid FROM orderitementity")),
    ("return.shipmententity = order shipments", ("shipment", "SELECT id FROM shipmententity WHERE orderid IS NOT NULL"),
     ("return", "SELECT id FROM shipmententity")),
    ("inventory sold items = placed item counts",
     ("order", "SELECT o.id, sum(i.count)::text FROM orderitementity i JOIN orderentity o ON o.id = i.orderid "
               "WHERE o.orderstatus = 'PLACED' GROUP BY o.id"),
     ("inventory", "SELECT orderid, count(*)::text FROM productitementity WHERE orderid IS NOT NULL GROUP BY orderid")),
    ("payment.paymententity amount = order amount",
     ("order", "SELECT paymentinformationid, compensatableorderamount::text FROM orderentity WHERE orderstatus = 'PLACED'"),
     None),
]


def run_checks():
    res, bad = {}, 0

    def one(c):
        name, own, cp = c
        a = ids(*own)
        if cp is None:
            if name.startswith("catalog.mediaentity"):
                b = ids("catalog", "SELECT id FROM mediaentity")
                miss = a - b
                return name, {"owner": len(a), "missing": len(miss), "ok": not miss}
            return name, {"owner": len(a), "ok": True}
        b = ids(*cp)
        miss, extra = a - b, b - a
        return name, {"owner": len(a), "copy": len(b), "missing": len(miss), "extra": len(extra),
                      "ok": not miss and not extra, "sample": [list(x) for x in list(miss)[:2] + list(extra)[:2]]}
    with ThreadPoolExecutor(6) as ex:
        for name, r in ex.map(one, CHECKS):
            res[name] = r
            bad += not r["ok"]
            print(("OK  " if r["ok"] else "FAIL"), name, {k: v for k, v in r.items() if k not in ("ok",) and v})
    # payments: amount equals the order's, one per placed order
    pa = rows("payment", "SELECT o.orderid, p.totalamount::bigint::text FROM openorderentity o "
                         "JOIN paymententity p ON p.id = o.paymentid")
    oa = rows("order", "SELECT id, compensatableorderamount::text FROM orderentity WHERE orderstatus = 'PLACED'")
    ok = set(pa) == set(oa)
    res["payment amounts = order amounts"] = {"ok": ok, "n": len(pa)}
    bad += not ok
    print("OK  " if ok else "FAIL", "payment amounts = order amounts", len(pa))
    # discount usages = sum of discounted item counts per (discount, user)
    du = rows("discount", "SELECT discountid, userid, usages::text FROM discountusageentity")
    od = rows("order", "SELECT d.discountid, o.userid, sum(i.count)::text FROM orderitemtodiscountentity d "
                       "JOIN orderitementity i ON i.id = d.orderitemid JOIN orderentity o ON o.id = i.orderid "
                       "WHERE o.orderstatus = 'PLACED' GROUP BY 1, 2")
    ok = set(od) <= set(du)
    res["discount usages >= history"] = {"ok": ok, "usages": len(du), "history": len(od)}
    bad += not ok
    print("OK  " if ok else "FAIL", "discount usages cover the history", len(du), len(od))
    return res, bad


def counts():
    def one(svc):
        tabs = [r[0] for r in rows(svc, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")]
        q = " UNION ALL ".join(f"SELECT '{t}', count(*) FROM \"{t}\"" for t in tabs)
        return svc, {t: int(n) for t, n in rows(svc, q)} if tabs else {}
    with ThreadPoolExecutor(8) as ex:
        return dict(ex.map(one, SERVICES))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--counts")
    ap.add_argument("--compare")
    ap.add_argument("--no-checks", action="store_true")
    a = ap.parse_args()
    bad = 0
    out = {}
    if not a.no_checks:
        out["checks"], bad = run_checks()
    c = counts()
    if a.counts:
        json.dump(c, open(a.counts, "w"), indent=1, sort_keys=True)
    if a.compare:
        ref = json.load(open(a.compare))
        diff = {f"{s}.{t}": [ref.get(s, {}).get(t), c.get(s, {}).get(t)] for s in set(ref) | set(c)
                for t in set(ref.get(s, {})) | set(c.get(s, {})) if ref.get(s, {}).get(t) != c.get(s, {}).get(t)}
        print("counts equal to baseline" if not diff else f"COUNT DIFF {diff}")
        bad += bool(diff)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
