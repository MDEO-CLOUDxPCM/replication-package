#!/usr/bin/env python3
"""Timing campaign request tooling (wraps calibration/scripts/loadgen.py and measure.py without modifying them).

Run with the calibration venv, from timing/requests/: PY=../calibration/.venv/bin/python

    $PY run.py setup [--fbuyers 150 --s60-products 60 --s600-products 20]   one-time data setup (idempotent)
    $PY run.py stock [--s60 60 --s600 600]          top the factorial variant groups up to their stock (outside windows)
    $PY run.py prep [--n 400]                       before a window: returnable-order pool, reviewed pool from the DB
    $PY run.py cleanup                              archive shipment methods created by createShipmentMethod
    $PY run.py smoke --out DIR [--types a,b] [--n 3] [--cells all|c1,c2]   every type n times, sequentially
    $PY run.py plan --plan P.json --out DIR         a loadgen plan with all request types (loadgen's run_plan + ExtGen)
    $PY run.py measure --name W --plan P.json [measure.py options]
                                                    measure.py window (lock protocol) with all request types; plans
                                                    with "kind": "sessions" run sessiongen instead of loadgen
"""
import argparse
import asyncio
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import reqs as R  # noqa: E402
import ext as X  # noqa: E402
from reqs import L  # noqa: E402


def install():
    """ExtGen for request plans; session plans ("kind": "sessions") go to sessiongen."""
    X.install()
    orig = L.run_plan

    async def run_plan(plan, out_dir, seed):
        if plan.get("kind") == "sessions":
            import sessiongen
            return await sessiongen.run_plan(plan, out_dir, seed)
        return await orig(plan, out_dir, seed)
    if getattr(L.run_plan, "__name__", "") != "run_plan_dispatch":
        run_plan.__name__ = "run_plan_dispatch"
        L.run_plan = run_plan


def print_summary(meta):
    for ph, types in meta["summary"].items():
        for t, d in sorted(types.items()):
            print(f"{ph:28s} {t:44s} n={d['n']:4d} ok={d['ok']:4d} mean={d['mean']} p95={d['p95']} "
                  f"{list(d['errors'].items())[:2]}")
    print("skipped", meta.get("skipped"), "pools", meta.get("pools_after"))


# ---------------------------------------------------------------------------------------------- GraphQL helper
async def gql(s, q, v=None, token=None):
    body = {"query": q}
    if v is not None:
        body["variables"] = v
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    async with s.post(L.GATEWAY, data=json.dumps(body), headers=h) as r:
        js = await r.json(content_type=None)
    if js.get("errors"):
        raise RuntimeError(f"{q[:60]}: {js['errors'][0].get('message')}")
    return js["data"]


async def token(s, user):
    data = {"client_id": "frontend", "grant_type": "password", "username": user, "password": "123"}
    async with s.post(L.TOKEN_URL, data=data) as r:
        return (await r.json(content_type=None))["access_token"]


def new_gen(out_dir, seed=1):
    os.makedirs(out_dir, exist_ok=True)
    w = L.BackgroundCsvWriter(os.path.join(out_dir, "requests.csv"),
                              ["type", "phase", "t_sched", "t_send", "epoch_send", "latency_ms", "http", "ok",
                               "n_errors", "error"])
    return X.ExtGen(json.load(open(L.STATE)), seed, w, time.time()), w


def session():
    import aiohttp
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=64),
                                 timeout=aiohttp.ClientTimeout(total=120))


# ---------------------------------------------------------------------------------------------- setup
async def setup(a):
    import mclient
    st = json.load(open(L.STATE))
    su = X.load_json(X.SETUP, {})
    async with session() as s:
        adm = await token(s, "gatling")
        # coupon 0 of the seed (on a category discount): its code and the category (factorial items come from it)
        if "coupon0" not in su:
            cid = st["coupons"][0]
            d = await gql(s, "query($id: UUID!) { coupon(id: $id) { id code discount { id discountAppliesToCategories "
                             "{ nodes { id } } } } }", {"id": cid}, adm)
            c = d["coupon"]
            su["coupon0"] = {"id": c["id"], "code": c["code"], "discount": c["discount"]["id"],
                             "category": c["discount"]["discountAppliesToCategories"]["nodes"][0]["id"]}
            print("coupon0", su["coupon0"], flush=True)
        # sink category + discount (createDiscount / createCoupon target it; nothing seeded is in it) and the
        # coupons that registerCoupon registers
        if "sinkCategory" not in su:
            d = await gql(s, R.Q_CREATE_CATEGORY, {"input": {"name": "Timing sink", "description": "timing campaign sink",
                                                             "categoricalCharacteristics": [], "numericalCharacteristics": []}}, adm)
            su["sinkCategory"] = d["createCategory"]["id"]
            await asyncio.sleep(3)
        if "sinkDiscount" not in su:
            d = await gql(s, R.Q_CREATE_DISCOUNT, {"i": {
                "discount": 0.05, "maxUsagesPerUser": 1000, "minOrderAmount": 0, "validFrom": X.now_iso(-1),
                "validUntil": X.now_iso(730), "discountAppliesToCategoryIds": [su["sinkCategory"]],
                "discountAppliesToProductIds": [], "discountAppliesToProductVariantIds": []}}, adm)
            su["sinkDiscount"] = d["createDiscount"]["id"]
        if len(su.get("regCoupons", [])) < a.reg_coupons:
            for _ in range(a.reg_coupons - len(su.get("regCoupons", []))):
                code = "TREG" + os.urandom(4).hex()
                d = await gql(s, R.Q_CREATE_COUPON, {"i": {"code": code, "discountId": su["sinkDiscount"], "maxUsages": 1000000,
                                                         "validFrom": X.now_iso(-1), "validUntil": X.now_iso(730)}}, adm)
                su.setdefault("regCoupons", []).append({"id": d["createCoupon"]["id"], "code": code})
        json.dump(su, open(X.SETUP, "w"), indent=1)
        # factorial buyers: role buyer, 1 address, PREPAYMENT + INVOICE (created on user/user/created) + CREDIT_CARD
        fb = {b["username"]: b for b in su.get("fbuyers", [])}
        mclient.GATEWAY = L.GATEWAY

        async def mk_fbuyer(n):
            u = f"fbuyer{n:04d}"
            if u in fb:
                return fb[u]
            atok = await mclient.admin_token(s)
            uid = await mclient.kc_create_user(s, atok, u, "Fact", f"Buyer{n}", roles=("buyer",))
            tok = await token(s, u)
            for k in range(90):
                d, err, _, _ = await mclient.gql(s, "{ currentUser { id paymentInformations { totalCount } } }", token=tok,
                                                 raise_errors=False)
                cu = (d or {}).get("currentUser")
                if not err and cu and cu["paymentInformations"]["totalCount"] >= 2:
                    break
                if k == 15:
                    await mclient.publish(s, "user/user/create", {"id": uid, "username": u, "firstName": "Fact",
                                                                  "lastName": f"Buyer{n}"})
                await asyncio.sleep(1)
            else:
                raise RuntimeError(f"{u} not replicated")
            d = await gql(s, R.Q_CREATE_USER_ADDRESS, {"input": {
                "userId": uid, "city": "Stuttgart", "postalCode": "70569", "country": "Germany", "street1": "Hauptstrasse 1",
                "street2": "", "companyName": None, "name": {"firstName": "Fact", "lastName": f"Buyer{n}"}}}, tok)
            addr = d["createUserAddress"]["id"]
            await gql(s, R.Q_CREATE_CC, {"input": {"cardHolder": f"Fact Buyer{n}", "cardNumber": "4111111111111111",
                                                   "expirationDate": "12/30"}}, tok)
            d = await gql(s, "{ currentUser { paymentInformations { nodes { id paymentMethod } } } }", None, tok)
            return {"username": u, "id": uid, "addresses": [addr],
                    "paymentInformations": d["currentUser"]["paymentInformations"]["nodes"]}
        sem = asyncio.Semaphore(6)

        async def lim(n):
            async with sem:
                return await mk_fbuyer(n)
        su["fbuyers"] = await asyncio.gather(*(lim(n) for n in range(1, a.fbuyers + 1)))
        json.dump(su, open(X.SETUP, "w"), indent=1)
        print(f"{len(su['fbuyers'])} factorial buyers", flush=True)
        # coupon 0 registered for every seed buyer and factorial buyer (coupon orders of sessions and the factorial;
        # a coupon-bound discount applies only when the order names the coupon, so other orders are unchanged)
        done = set(su.get("coupon0Registered", []))
        for b in st["buyers"] + su["fbuyers"]:
            if b["id"] in done:
                continue
            try:
                await gql(s, R.Q_REGISTER_COUPON, {"i": {"code": su["coupon0"]["code"], "userId": b["id"]}}, adm)
            except RuntimeError as e:
                if "duplicate" not in str(e).lower() and "unique" not in str(e).lower():
                    raise
            done.add(b["id"])
        su["coupon0Registered"] = sorted(done)
        json.dump(su, open(X.SETUP, "w"), indent=1)
        print(f"coupon0 registered for {len(done)} users", flush=True)
        # factorial products in coupon0's category: groups s60 / s600 (3 variants each)
        cat = next(c for c in st["categories"] if c["id"] == su["coupon0"]["category"])
        tax = st["taxRates"][0]

        def version(n, v):
            return {"name": f"Factorial {n} v{v}", "description": "timing factorial", "retailPrice": 20 + v,
                    "weight": 1.0, "canBeReturnedForDays": 30, "taxRateId": tax, "mediaIds": [],
                    "categoricalCharacteristicValues": [{"characteristicId": cat["brand"], "value": "Acme"}],
                    "numericalCharacteristicValues": [{"characteristicId": cat["size"], "value": 42.0}]}
        fv = su.setdefault("foVariants", {})
        for grp, nprod in (("s60", a.s60_products), ("s600", a.s600_products)):
            have = fv.get(grp, [])
            for n in range(len(have) // 3, nprod):
                d = await gql(s, L.Q_ADMIN_CREATE_PRODUCT, {"i": {
                    "internalName": f"FO-{grp}-{n}", "isPubliclyVisible": True, "categoryIds": [cat["id"]],
                    "defaultVariant": {"isPubliclyVisible": True, "initialVersion": version(n, 0)}}}, adm)
                pid = d["createProduct"]["id"]
                vs = [d["createProduct"]["defaultVariant"]["id"]]
                for v in (1, 2):
                    d = await gql(s, L.Q_ADMIN_CREATE_VARIANT, {"i": {"productId": pid, "isPubliclyVisible": True,
                                                                      "initialVersion": version(n, v)}}, adm)
                    vs.append(d["createProductVariant"]["id"])
                have += vs
            fv[grp] = have
        json.dump(su, open(X.SETUP, "w"), indent=1)
        print("factorial variants", {k: len(v) for k, v in fv.items()}, flush=True)
    await asyncio.sleep(3)
    await stock(argparse.Namespace(s60=60, s600=600))


async def stock(a):
    """Top the factorial groups up to their stock (IN_STORAGE items per variant); only adds."""
    su = X.load_json(X.SETUP, {})
    async with session() as s:
        adm = await token(s, "gatling")
        res = {}
        for grp, target in (("s60", a.s60), ("s600", a.s600)):
            vids = su.get("foVariants", {}).get(grp, [])
            added, counts = 0, []
            for i in range(0, len(vids), 50):
                chunk = vids[i:i + 50]
                q = "query { " + " ".join(f'v{j}: productItems(first: 1, filter: {{productVariant: "{v}", '
                                           f'inventoryStatus: IN_STORAGE}}) {{ totalCount }}' for j, v in enumerate(chunk)) + " }"
                d = await gql(s, q, None, adm)
                for j, v in enumerate(chunk):
                    c = d[f"v{j}"]["totalCount"]
                    counts.append(c)
                    if c < target:
                        await gql(s, R.Q_ITEM_BATCH, {"input": {"productVariantId": v, "number": target - c}}, adm)
                        added += target - c
            res[grp] = {"variants": len(vids), "added": added, "minBefore": min(counts) if counts else None,
                        "maxBefore": max(counts) if counts else None}
        print(json.dumps(res))
        return res


def sync_reviews(g):
    """loadgen's `reviewed` pool from the review DB (round 2's pools file lost part of it): createReview then never
    picks a (user, variant) that already has a review."""
    import subprocess
    out = subprocess.run(["docker", "exec", "-i", L.cname("review-db"), "psql", "-q", "-t", "-A", "-F", ",", "-U",
                          "postgres", "-d", "review", "-c", "SELECT userId, productVariantId FROM ReviewEntity"],
                         capture_output=True, text=True).stdout
    n0 = len(g.reviewed)
    g.reviewed |= {tuple(x.split(",")) for x in out.split() if "," in x}
    return len(g.reviewed) - n0


async def prep_returns(a):
    """Before a window: the returnable pool (recently placed seed-buyer orders whose shipments are delivered and that
    are not returned) and loadgen's reviewed pool (synced from the review DB)."""
    g, w = new_gen(os.path.join(X.STATE_DIR, "prep"))
    added_reviews = sync_reviews(g)
    async with session() as s:
        await g.prefetch_tokens(s)
        have = {x[1] for x in g.returnable}
        found, looked = 0, 0
        for u, oid in reversed(g.placed[-3000:]):
            if found >= a.n:
                break
            if oid in g.returned or oid in have:
                continue
            looked += 1
            try:
                d = await gql(s, R.Q_ORDER_ITEMS, {"id": oid}, g.tokens[u])
            except Exception:
                continue
            o = d["order"]
            sh = o["shipments"]["nodes"]
            if sh and all(x["status"] == "DELIVERED" for x in sh) and o["orderItems"]["nodes"]:
                g.returnable.append([u, oid, [n["id"] for n in o["orderItems"]["nodes"]]])
                found += 1
        g.save_pools()
    w.close()
    print(json.dumps({"looked": looked, "added": found, "returnable": len(g.returnable), "reviewedAdded": added_reviews}))


async def cleanup(a):
    g, w = new_gen(os.path.join(X.STATE_DIR, "prep"))
    async with session() as s:
        adm = await token(s, "gatling")
        n = 0
        for sm in g.created_sms:
            try:
                await gql(s, R.Q_ARCHIVE_SHIPMENT_METHOD, {"i": {"id": sm}}, adm)
                n += 1
            except Exception as e:
                print("archive", sm, e)
        g.created_sms = []
        g.save_pools()
    w.close()
    print(json.dumps({"archivedShipmentMethods": n}))


# ---------------------------------------------------------------------------------------------- smoke
async def smoke(a):
    types = [t for t in (a.types.split(",") if a.types else list(R.REQUESTS)) if t]
    cells = [] if a.cells in (None, "", "none") else (R.factorial_cells(60) + R.factorial_cells(600)
                                                      if a.cells == "all" else a.cells.split(","))
    g, w = new_gen(a.out, a.seed)
    import aiohttp
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=64),
                                     timeout=aiohttp.ClientTimeout(total=60)) as s:
        g.http = s
        await g.prefetch_tokens(s)
        g.t0 = time.time()
        for t in types:
            g.phase = f"{t}:smoke"
            if t == "placeOrder" and not g.created:       # loadgen's pools: make an order to place
                for _ in range(a.n):
                    await g.safe_do(s, "createShoppingcartItem", time.time())
                    await g.safe_do(s, "createOrder", time.time())
            if t == "createOrder" and not any(g.carts.values()):
                for _ in range(a.n):
                    await g.safe_do(s, "createShoppingcartItem", time.time())
            for _ in range(a.n):
                await g.safe_do(s, t, time.time())
        for c in cells:
            g.phase = f"{c}:smoke"
            for _ in range(a.n):
                await g.safe_do(s, f"foCart.{c}", time.time())
            for _ in range(a.n):
                await g.safe_do(s, f"foOrder.{c}", time.time())
                await g.safe_do(s, f"foPlace.{c}", time.time())
        g.phase = "cleanup"
        await X.fo_cleanup(g, None, time.time())
    g.save_pools()
    w.close()
    summ = L.summarize(os.path.join(a.out, "requests.csv"))
    json.dump({"summary": summ, "skipped": g.skipped}, open(os.path.join(a.out, "smoke.json"), "w"), indent=1)
    bad = 0
    for ph, ts in summ.items():
        for t, d in sorted(ts.items()):
            flag = "" if d["ok"] == d["n"] else "  <-- " + str(list(d["errors"].items())[:2])
            bad += d["n"] - d["ok"]
            print(f"{ph:36s} {t:44s} {d['ok']}/{d['n']} mean={d['mean']}ms{flag}")
    print("skipped", g.skipped, "failed", bad)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "measure":
        install()
        import measure
        sys.argv = ["measure.py"] + sys.argv[2:]
        return measure.main()
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("setup")
    p.add_argument("--fbuyers", type=int, default=150)
    p.add_argument("--s60-products", type=int, default=60)
    p.add_argument("--s600-products", type=int, default=20)
    p.add_argument("--reg-coupons", type=int, default=20)
    p = sp.add_parser("stock")
    p.add_argument("--s60", type=int, default=60)
    p.add_argument("--s600", type=int, default=600)
    p = sp.add_parser("prep", aliases=["prep-returns"])
    p.add_argument("--n", type=int, default=400)
    sp.add_parser("cleanup")
    p = sp.add_parser("smoke")
    p.add_argument("--out", required=True)
    p.add_argument("--types")
    p.add_argument("--cells", default="none")
    p.add_argument("--n", type=int, default=3)
    p.add_argument("--seed", type=int, default=7)
    p = sp.add_parser("plan")
    p.add_argument("--plan", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--seed", type=int, default=int(time.time()))
    a = ap.parse_args()
    os.makedirs(X.STATE_DIR, exist_ok=True)
    if a.cmd == "plan":
        install()
        meta = asyncio.run(L.run_plan(json.load(open(a.plan)), a.out, a.seed))
        print_summary(meta)
        return
    asyncio.run({"setup": setup, "stock": stock, "prep": prep_returns, "prep-returns": prep_returns, "cleanup": cleanup,
                 "smoke": smoke}[a.cmd](a))


if __name__ == "__main__":
    main()
