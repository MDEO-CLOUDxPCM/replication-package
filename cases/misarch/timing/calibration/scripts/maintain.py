#!/usr/bin/env python3
"""Between-window maintenance (outside measurement windows) to keep the data set stationary.

  1. remove abandoned shopping-cart items (aborted sessions never order them; createOrder reads the whole cart of the
     user, so unbounded carts would make createOrder cost drift). Items still in the generator's cart pool are kept.
  2. restock: every product variant whose inventoryCount (IN_STORAGE items) is below --min gets --add new items
  3. ack failed deliveries of the known functional defects (see redisq.py) so Dapr does not redeliver them
     (none for the Kotlin stack: its defects are fixed; pending entries are only reported)
  4. print data-set sizes

  --stack kotlin: misarch-kotlin-* containers, Postgres instead of MongoDB, results-kotlin/ pools and state.

    maintain.py [--min 30 --add 60] [--no-carts] [--no-restock]
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CAL = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from mclient import gql, new_session, user_token  # noqa: E402
from stack import KOTLIN, POOLS, STATE, cname, live  # noqa: E402  (--stack kotlin: Postgres DBs, results-kotlin/)


def mongo(container, db, js):
    out = subprocess.run(["docker", "exec", "-i", container, "mongosh", "--quiet", db], input=js, capture_output=True,
                         text=True)
    return (out.stdout.strip().splitlines() or [out.stderr[-300:]])[-1]


def psql(svc, sql):
    """Kotlin stack: every service has its own Postgres 16 (database = service name)."""
    out = subprocess.run(["docker", "exec", "-i", live(f"{svc}-db"), "psql", "-q", "-t", "-A", "-U", "postgres", "-d",
                          svc, "-v", "ON_ERROR_STOP=1"], input=sql, capture_output=True, text=True)
    return (out.stdout.strip().splitlines() or [out.stderr[-300:]])[-1]


def clean_carts():
    """Remove all cart items (every window creates the cart items it orders) and empty the generator's cart pool."""
    try:
        pools = json.load(open(POOLS))
    except Exception:
        pools = {}
    pools["carts"] = {}
    json.dump(pools, open(POOLS, "w"))
    if KOTLIN:   # shoppingcart port: Postgres table ShoppingCartItemEntity (cart = rows of the user)
        return psql("shoppingcart", "WITH d AS (DELETE FROM ShoppingCartItemEntity RETURNING 1) "
                                    "SELECT json_build_object('removed', count(*), 'kept', 0) FROM d;")
    keep = []
    keep_js = ",".join(f"'{k.replace('-', '')}'" for k in keep)
    js = (f"const keep=new Set([{keep_js}]); let removed=0, kept=0; "
          "db.users.find({'shoppingcart.internal_shoppingcart_items.0': {$exists: true}}).forEach(u => { "
          " const items=u.shoppingcart.internal_shoppingcart_items; "
          " const nk=items.filter(i => keep.has(i._id.toString('hex'))); removed += items.length-nk.length; kept += nk.length; "
          " if (nk.length != items.length) db.users.updateOne({_id: u._id}, {$set: {'shoppingcart.internal_shoppingcart_items': nk}}); }); "
          "print(JSON.stringify({removed: removed, kept: kept}))")
    return mongo(cname("shoppingcart-db"), "shoppingcart-database", js)


async def restock(minimum, add):
    st = json.load(open(STATE))
    vids = [v for p in st["products"] for v in p["variants"]]
    async with new_session(limit=16) as s:
        tok = await user_token(s, "gatling")
        low = []
        for i in range(0, len(vids), 50):
            chunk = vids[i:i + 50]
            q = "query { " + " ".join(f'v{j}: productItems(first: 1, filter: {{productVariant: "{v}", '
                                       f'inventoryStatus: IN_STORAGE}}) {{ totalCount }}' for j, v in enumerate(chunk)) + " }"
            d, err, _, _ = await gql(s, q, token=tok, raise_errors=False)
            if err or not d:
                # fall back to inventoryCount via product queries
                return {"error": str(err)[:300]}
            for j, v in enumerate(chunk):
                if d[f"v{j}"]["totalCount"] < minimum:
                    low.append((v, d[f"v{j}"]["totalCount"]))
        for v, _ in low:
            await gql(s, "mutation($i: CreateProductItemBatchInput!) { createProductItemBatch(input: $i) { id } }",
                      {"i": {"productVariantId": v, "number": add}}, token=tok)
        return {"variants": len(vids), "restocked": len(low), "lowest": sorted(c for _, c in low)[:5]}


def main():
    import time
    lock = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(CAL)))), "MEASURING.lock")   # the repository root (CAL = cases/misarch/timing/calibration)
    while os.path.exists(lock):   # never touch the system during a measurement window
        time.sleep(15)
    ap = argparse.ArgumentParser()
    # Kotlin stack: the load curves run up to ~100 sessions/s (~20k orders per window, ~70 items per default
    # variant), so the stock is kept at >= 150 items per variant
    ap.add_argument("--min", type=int, default=300 if KOTLIN else 30)   # a 21-vCPU curve places ~37k orders
    ap.add_argument("--add", type=int, default=300 if KOTLIN else 60)
    ap.add_argument("--no-carts", action="store_true")
    ap.add_argument("--no-restock", action="store_true")
    ap.add_argument("--stack", help="original|kotlin (see stack.py)")
    a = ap.parse_args()
    res = {}
    if not a.no_carts:
        res["carts"] = clean_carts()
    if not a.no_restock:
        res["restock"] = asyncio.run(restock(a.min, a.add))
    res["acked"] = subprocess.run([sys.executable, os.path.join(HERE, "redisq.py"), "ack-known"], capture_output=True,
                                  text=True).stdout.strip()
    res["pending"] = subprocess.run([sys.executable, os.path.join(HERE, "redisq.py"), "pending"], capture_output=True,
                                    text=True).stdout.strip()
    if KOTLIN:   # acknowledged stream entries only (redisq.py trim); keeps dapr-redis' memory and RDB saves small
        res["trimmed"] = subprocess.run([sys.executable, os.path.join(HERE, "redisq.py"), "trim"], capture_output=True,
                                        text=True).stdout.strip()
    if KOTLIN:
        res["orders"] = psql("order", "SELECT count(*) FROM OrderEntity;")
        res["invoices"] = psql("invoice", "SELECT count(*) FROM InvoiceEntity;")
    else:
        res["orders"] = mongo(cname("order-db"), "order-database", "print(db.orders.countDocuments())")
    print(json.dumps(res))


if __name__ == "__main__":
    main()
