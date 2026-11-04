#!/usr/bin/env python3
"""Open-loop load generator for MiSArch (Poisson arrivals per request type).

Every request type is an independent Poisson stream with its own rate; requests are sent at their scheduled time
whether or not earlier ones have finished (open loop). Requests replay the Gatling buy-process requests of Ceres
(experiment-executor/src/main/resources/templates/template_buyProcessScenario.kt) one by one, byte-identical query
text, plus additional user journeys and admin operations. State that a request needs from earlier steps (cart items
for createOrder, created orders for placeOrder, placed orders for order tracking) comes from pools that are filled by
the corresponding request types and persisted between runs (results/pools.json; results-kotlin/pools.json with
--stack kotlin, see stack.py).

Usage:
    loadgen.py --plan plan.json --out DIR          # plan = {"name", "phases":[{"name","duration","rates":{type:rps}}]}
    loadgen.py --rates products=2,product=2 --duration 60 --out DIR
    loadgen.py --session buy --out DIR             # one sequential Gatling buy session (smoke test)

Output in DIR: requests.csv (one row per request), meta.json (phase boundaries in epoch seconds, settings, summary).

A phase with "clear": {"cron": [Spring cron], "spanS", "beforeS", "afterS"} starts an interval of spanS seconds that
must not hold a firing of these scheduled jobs: when one falls into it, a zero-load phase `<segment>:hold` runs first,
until afterS past the firing (clear_hold).
"""
import argparse
import asyncio
import csv
import json
import math
import os
import random
import queue
import subprocess
import sys
import threading
import time

import aiohttp

HERE = os.path.dirname(os.path.abspath(__file__))
CAL = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from cronjobs import clear_hold  # noqa: E402
from stack import POOLS, STATE, TOKENS, live as cname  # noqa: E402  (--stack kotlin / MISARCH_STACK; env overrides as before)


def container_ip(name):
    out = subprocess.run(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name],
                         capture_output=True, text=True).stdout.strip()
    return out


# Target the containers directly (not the published host ports) so that docker-proxy is not in the path
GW_IP = os.environ.get("GW_IP") or container_ip(cname("gateway"))
KC_IP = os.environ.get("KC_IP") or container_ip(cname("keycloak"))
GATEWAY = f"http://{GW_IP}:8080/graphql"
TOKEN_URL = f"http://{KC_IP}:80/keycloak/realms/Misarch/protocol/openid-connect/token"

# ---------------------------------------------------------------------------------------------------------------
# GraphQL request texts. The first nine are verbatim from Ceres' template_buyProcessScenario.kt (only the ids and,
# for `products`, the skip offset differ).
Q_PRODUCTS = ('query { products(filter: { isPubliclyVisible: true }, first: 10, orderBy: { direction: ASC, field: ID }, '
              'skip: %d) { hasNextPage nodes { id internalName isPubliclyVisible } totalCount } }')
Q_PRODUCT = ('query { product(id: "%s") { categories { hasNextPage  totalCount } defaultVariant { id isPubliclyVisible '
             'averageRating } id internalName isPubliclyVisible variants { hasNextPage  totalCount } } }')
Q_USER = 'query getCurrentUser { currentUser { id } }'
Q_ADDRESS = ('query getActiveAddressesOfCurrentUser($orderBy: UserAddressOrderInput = {}) { currentUser { '
             'addresses(orderBy: $orderBy, filter: { isArchived: false }) { totalCount nodes { id city companyName '
             'country name { firstName lastName } postalCode street1 street2 } } } }')
Q_CART = ('mutation { createShoppingcartItem( input: { id: "%s" shoppingCartItem: { count: 1 productVariantId: "%s" } } ) '
          '{ id } }')
Q_SHIPMENT_METHODS = ('query getShipmentMethods($isArchived: Boolean = false) { shipmentMethods(filter: { isArchived: '
                      '$isArchived }) { totalCount nodes { id baseFees description feesPerItem feesPerKg name } } } ')
Q_PAYMENT_INFOS = ('query getPaymentInformationOfCurrentUser($paymentMethod: PaymentMethod) { currentUser { id '
                   'paymentInformations(filter:{ paymentMethod: $paymentMethod }) { totalCount nodes { id paymentMethod '
                   'publicMethodDetails } } } }')
Q_CREATE_ORDER = ('mutation { createOrder( input: { userId: "%s" orderItemInputs: { shoppingCartItemId: "%s" couponIds: [] '
                  'shipmentMethodId: "%s" } vatNumber: "AB1234" invoiceAddressId: "%s" shipmentAddressId: "%s" '
                  'paymentInformationId: "%s" } ) { id paymentInformationId placedAt } }')
Q_PLACE_ORDER = 'mutation { placeOrder(input: { id: "%s", paymentAuthorization: { cvc: 123 } }) { id } }'
# Additional journeys (docs/image-sources/diagrams/user-journeys: check order status, wishlist, write review, admin)
Q_ORDER_TRACKING = ('query { order(id: "%s") { id orderStatus placedAt compensatableOrderAmount orderItems { nodes { id '
                    'count compensatableAmount } } shipments { nodes { id status } } } }')
Q_WISHLIST_VIEW = ('query { wishlist(id: "%s") { id name createdAt lastUpdatedAt productVariants(first: 10) { totalCount '
                   'nodes { id isPubliclyVisible currentVersion { id name description retailPrice canBeReturnedForDays '
                   'version createdAt } product { id } } } } }')
Q_WISHLIST_ADD = 'mutation($i: UpdateWishlistInput!) { updateWishlist(input: $i) { id } }'
Q_REVIEW = 'mutation($i: CreateReviewInput!) { createReview(input: $i) { id } }'
Q_ADMIN_UPDATE_PRODUCT = 'mutation($i: UpdateProductInput!) { updateProduct(input: $i) { id } }'
Q_ADMIN_NEW_PRICE = 'mutation($i: CreateProductVariantVersionInput!) { createProductVariantVersion(input: $i) { id } }'
Q_ADMIN_CREATE_VARIANT = 'mutation($i: CreateProductVariantInput!) { createProductVariant(input: $i) { id } }'
Q_ADMIN_CREATE_PRODUCT = 'mutation($i: CreateProductInput!) { createProduct(input: $i) { id defaultVariant { id } } }'

# Micro-benchmarks (not user requests): GET /health of shipment through increasingly long sidecar chains, and a
# direct publish of Keycloak's user/user/create event (user -> user/user/created fan-out to 9 services)
HOP_TARGET = "shipment"
HOP_IP = os.environ.get("HOP_IP") or container_ip(cname(HOP_TARGET))
CALLER_IP = GW_IP   # gateway's daprd acts as the caller sidecar
USER_DAPR_IP = os.environ.get("USER_IP") or container_ip(cname("user"))
HOP_URLS = {"hopApp": f"http://{HOP_IP}:8080/health",                                     # app only
            "hopEcs": f"http://{HOP_IP}:5000/health",                                     # ECS -> app
            "hopLocalDapr": f"http://{HOP_IP}:3500/v1.0/invoke/{HOP_TARGET}/method/health",  # callee daprd -> ECS -> app
            "hopRemoteDapr": f"http://{CALLER_IP}:3500/v1.0/invoke/{HOP_TARGET}/method/health"}  # caller daprd -> ...

TYPES = ["token", "products", "product", "users", "address", "createShoppingcartItem", "shipmentMethods",
         "paymentInformations", "createOrder", "placeOrder", "orderTracking", "wishlistView", "addToWishlist",
         "createReview", "adminUpdateProduct", "adminNewPrice", "adminCreateVariant", "adminCreateProduct"]


class Skip(Exception):
    """No input available for this request (e.g. empty cart pool); counted, not sent."""


class Gen:
    def __init__(self, state, rng_seed, writer, run_t0):
        self.st = state
        self.rng = random.Random(rng_seed)
        self.w = writer
        self.t0 = run_t0
        self.phase = "init"
        self.buyers = state["buyers"]
        self.by_name = {b["username"]: b for b in self.buyers}
        self.products = state["products"]
        self.default_variants = [(p, p["variants"][0]) for p in self.products]
        self.all_variants = [(p, v) for p in self.products for v in p["variants"]]
        self.sms = state["shipmentMethods"]
        self.tokens = {}
        self.admin_tok = None
        self.counter = 0
        self.inflight = 0
        self.max_inflight = 0
        self.lag = []
        self.skipped = {}
        self.load_pools()

    # ------------------------------------------------------------------ pools
    def load_pools(self):
        try:
            p = json.load(open(POOLS))
        except Exception:
            p = {}
        self.reviewed = set(tuple(x) for x in p.get("reviewed", [])) | set(tuple(x) for x in self.st.get("reviews", []))
        self.carts = p.get("carts", {})            # username -> [cartItemId, ...]  (not yet ordered)
        # cart item ids already handed to createOrder. Since the shoppingcart fix (Kotlin stack), re-adding a variant
        # that is still in the user's cart returns the existing item id; such an id must enter the pool only once,
        # and never again after an order consumed it (shoppingcart deletes the item when that order is placed, and a
        # later createOrder with it fails). The original stack never returns an existing id, so nothing changes there.
        self.used_list = p.get("usedCartItems", [])
        self.used = set(self.used_list)
        self.cart_dupes = 0
        self.created = p.get("created", [])        # [[username, orderId], ...]     (created, not placed)
        self.placed = p.get("placed", [])          # [[username, orderId], ...]     (placed; for tracking)

    def save_pools(self):
        self.placed = self.placed[-5000:]
        self.used_list = self.used_list[-20000:]
        json.dump({"carts": self.carts, "created": self.created, "placed": self.placed,
                   "reviewed": sorted(self.reviewed), "usedCartItems": self.used_list}, open(POOLS, "w"))

    # ------------------------------------------------------------------ tokens
    async def prefetch_tokens(self, session, min_valid_s=1500):
        try:
            cache = json.load(open(TOKENS))
        except Exception:
            cache = {}
        now = time.time()
        need = [b["username"] for b in self.buyers if cache.get(b["username"], [None, 0])[1] - now < min_valid_s]
        if cache.get("gatling", [None, 0])[1] - now < min_valid_s:
            need.append("gatling")
        sem = asyncio.Semaphore(8)

        async def one(u):
            async with sem:
                data = {"client_id": "frontend", "grant_type": "password", "username": u, "password": "123"}
                async with session.post(TOKEN_URL, data=data) as r:
                    js = await r.json(content_type=None)
                    cache[u] = [js["access_token"], time.time() + js.get("expires_in", 1800)]
        await asyncio.gather(*(one(u) for u in need))
        json.dump(cache, open(TOKENS, "w"))
        self.tokens = {u: v[0] for u, v in cache.items() if u != "gatling"}
        self.admin_tok = cache["gatling"][0]
        return len(need)

    def rand_buyer(self):
        return self.rng.choice(self.buyers)

    # ------------------------------------------------------------------ request execution
    async def post_gql(self, session, rtype, query, variables=None, token=None, check=None, t_sched=None):
        body = {"query": query}
        if variables is not None:
            body["variables"] = variables
        h = {"Content-Type": "application/json"}
        if token:
            h["Authorization"] = "Bearer " + token
        return await self.timed(session, rtype, GATEWAY, json.dumps(body), h, check, t_sched)

    async def timed(self, session, rtype, url, data, headers, check, t_sched, method="POST"):
        t_send = time.time()
        phase = self.phase
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        p0 = time.perf_counter()
        status, ok, nerr, msg, js = 0, 0, 0, "", None
        try:
            async with session.request(method, url, data=data, headers=headers) as r:
                raw = await r.read()
                status = r.status
            lat = time.perf_counter() - p0
            try:
                js = json.loads(raw)
            except Exception:
                js = None
                msg = "non-json: " + raw[:120].decode(errors="replace")
            if js is None and status in (200, 204) and not raw:
                js, msg = {}, ""     # empty body (dapr publish answers 204)
            if js is not None and isinstance(js, dict):
                errs = js.get("errors") or []
                nerr = len(errs)
                if errs:
                    msg = str(errs[0].get("message", errs[0]))[:200]
            ok = int(status in (200, 204) and nerr == 0 and js is not None and (check is None or check(js)))
            if not ok and not msg:
                msg = f"check failed: {json.dumps(js)[:160]}"
        except asyncio.TimeoutError:
            lat = time.perf_counter() - p0
            msg = "timeout"
        except Exception as e:  # connection errors etc.
            lat = time.perf_counter() - p0
            msg = f"{type(e).__name__}: {e}"[:200]
        finally:
            self.inflight -= 1
        self.w.writerow([rtype, phase, f"{(t_sched if t_sched is not None else t_send) - self.t0:.4f}",
                         f"{t_send - self.t0:.4f}", f"{t_send:.4f}", f"{lat * 1000:.2f}", status, ok, nerr,
                         msg.replace("\n", " ")])
        return ok, js

    async def do(self, session, rtype, t_sched=None):
        rng = self.rng
        if rtype == "token":
            b = self.rand_buyer()
            data = {"client_id": "frontend", "grant_type": "password", "username": b["username"], "password": "123"}
            form = aiohttp.FormData(data)
            ok, js = await self.timed(session, rtype, TOKEN_URL, form, {}, lambda j: "access_token" in j, t_sched)
            if ok:
                self.tokens[b["username"]] = js["access_token"]
            return
        if rtype in HOP_URLS:
            await self.timed(session, rtype, HOP_URLS[rtype], None, {}, lambda j: j.get("status") == "UP", t_sched,
                             method="GET")
            return
        if rtype == "eventUserCreate":
            import uuid
            uid = str(uuid.uuid4())
            body = json.dumps({"id": uid, "username": "evt-" + uid[:8], "firstName": "Event", "lastName": "User"})
            await self.timed(session, rtype, f"http://{USER_DAPR_IP}:3500/v1.0/publish/pubsub/user/user/create", body,
                             {"Content-Type": "application/json"}, None, t_sched)
            return
        if rtype == "products":
            skip = 10 * rng.randrange(max(1, len(self.products) // 10))
            await self.post_gql(session, rtype, Q_PRODUCTS % skip, token=self.tokens[self.rand_buyer()["username"]],
                                check=lambda j: bool(j["data"]["products"]["nodes"]), t_sched=t_sched)
            return
        if rtype == "product":
            p = rng.choice(self.products)
            await self.post_gql(session, rtype, Q_PRODUCT % p["id"], token=self.tokens[self.rand_buyer()["username"]],
                                check=lambda j: j["data"]["product"]["defaultVariant"]["id"] is not None, t_sched=t_sched)
            return
        if rtype == "users":
            b = self.rand_buyer()
            await self.post_gql(session, rtype, Q_USER, token=self.tokens[b["username"]],
                                check=lambda j: j["data"]["currentUser"]["id"] == b["id"], t_sched=t_sched)
            return
        if rtype == "address":
            b = self.rand_buyer()
            await self.post_gql(session, rtype, Q_ADDRESS, token=self.tokens[b["username"]],
                                check=lambda j: bool(j["data"]["currentUser"]["addresses"]["nodes"]), t_sched=t_sched)
            return
        if rtype == "createShoppingcartItem":
            b = self.rand_buyer()
            p, v = rng.choice(self.default_variants)   # Gatling adds the product's default variant
            ok, js = await self.post_gql(session, rtype, Q_CART % (b["id"], v), token=self.tokens[b["username"]],
                                         check=lambda j: j["data"]["createShoppingcartItem"]["id"] is not None,
                                         t_sched=t_sched)
            if ok:
                cid = js["data"]["createShoppingcartItem"]["id"]
                pool = self.carts.setdefault(b["username"], [])
                if cid in self.used or cid in pool:
                    self.cart_dupes += 1     # existing item returned (variant already in the cart): pool it once
                else:
                    pool.append(cid)
            return
        if rtype == "shipmentMethods":
            await self.post_gql(session, rtype, Q_SHIPMENT_METHODS, token=self.tokens[self.rand_buyer()["username"]],
                                check=lambda j: bool(j["data"]["shipmentMethods"]["nodes"]), t_sched=t_sched)
            return
        if rtype == "paymentInformations":
            b = self.rand_buyer()
            await self.post_gql(session, rtype, Q_PAYMENT_INFOS, token=self.tokens[b["username"]],
                                check=lambda j: bool(j["data"]["currentUser"]["paymentInformations"]["nodes"]),
                                t_sched=t_sched)
            return
        if rtype == "createOrder":
            users = [u for u, items in self.carts.items() if items]
            if not users:
                raise Skip()
            u = rng.choice(users)
            b = self.by_name[u]
            cid = self.carts[u].pop(0)
            self.used.add(cid)
            self.used_list.append(cid)
            pi = b["paymentInformations"][0]["id"]       # Gatling: paymentInformations.nodes[0] (default order: id asc)
            sm = rng.choice(self.sms)
            addr = b["addresses"][0]                       # Gatling: addresses.nodes[0]
            ok, js = await self.post_gql(session, rtype, Q_CREATE_ORDER % (b["id"], cid, sm, addr, addr, pi),
                                         token=self.tokens[u],
                                         check=lambda j: j["data"]["createOrder"]["id"] is not None, t_sched=t_sched)
            if ok:
                self.created.append([u, js["data"]["createOrder"]["id"], time.time()])
            return
        if rtype == "placeOrder":
            # order rejects placement of orders that are PENDING for more than 1 h: drop stale ones (> 50 min)
            while self.created and (len(self.created[0]) < 3 or time.time() - self.created[0][2] > 3000):
                self.created.pop(0)
            if not self.created:
                raise Skip()
            u, oid, _ = self.created.pop(0)
            ok, js = await self.post_gql(session, rtype, Q_PLACE_ORDER % oid, token=self.tokens[u],
                                         check=lambda j: j["data"]["placeOrder"]["id"] == oid, t_sched=t_sched)
            if ok:
                self.placed.append([u, oid])
            return
        if rtype == "orderTracking":
            if not self.placed:
                raise Skip()
            u, oid = rng.choice(self.placed[-2000:])
            await self.post_gql(session, rtype, Q_ORDER_TRACKING % oid, token=self.tokens[u],
                                check=lambda j: j["data"]["order"]["id"] == oid, t_sched=t_sched)
            return
        if rtype in ("wishlistView", "addToWishlist"):
            cands = [b for b in self.buyers if b.get("wishlists")]
            if not cands:
                raise Skip()
            b = rng.choice(cands)
            wid = rng.choice(b["wishlists"])
            if rtype == "wishlistView":
                await self.post_gql(session, rtype, Q_WISHLIST_VIEW % wid, token=self.tokens[b["username"]],
                                    check=lambda j: j["data"]["wishlist"]["id"] == wid, t_sched=t_sched)
            else:
                vs = [v for _, v in rng.sample(self.all_variants, rng.randint(2, 6))]
                await self.post_gql(session, rtype, Q_WISHLIST_ADD, {"i": {"id": wid, "productVariantIds": vs}},
                                    token=self.tokens[b["username"]],
                                    check=lambda j: j["data"]["updateWishlist"]["id"] == wid, t_sched=t_sched)
            return
        if rtype == "createReview":
            while True:   # MiSArch allows one review per (user, variant)
                b = self.rand_buyer()
                p, v = rng.choice(self.all_variants)
                if (b["id"], v) not in self.reviewed:
                    self.reviewed.add((b["id"], v))
                    break
            rating = rng.choices(["ONE_STARS", "TWO_STARS", "THREE_STARS", "FOUR_STARS", "FIVE_STARS"],
                                 [0.05, 0.07, 0.15, 0.33, 0.40])[0]
            await self.post_gql(session, rtype, Q_REVIEW, {"i": {"userId": b["id"], "productVariantId": v,
                                                                 "body": "Calibration review text, about 60 characters long.",
                                                                 "rating": rating, "isVisible": True}},
                                token=self.tokens[b["username"]],
                                check=lambda j: j["data"]["createReview"]["id"] is not None, t_sched=t_sched)
            return
        # ---- admin operations (user `gatling`, roles admin/employee/buyer)
        self.counter += 1
        n = self.counter
        if rtype == "adminUpdateProduct":
            p = rng.choice(self.products)
            await self.post_gql(session, rtype, Q_ADMIN_UPDATE_PRODUCT,
                                {"i": {"id": p["id"], "internalName": f"P{p['idx']:04d}-u{n}"}}, token=self.admin_tok,
                                check=lambda j: j["data"]["updateProduct"]["id"] == p["id"], t_sched=t_sched)
            return
        p = rng.choice(self.products)
        version = {"name": f"Product {p['idx']:04d} cal-{n}", "description": "calibration version",
                   "retailPrice": max(1, int(p["price"] * rng.uniform(0.9, 1.1))), "weight": 1.0,
                   "canBeReturnedForDays": 30, "taxRateId": p["taxRateId"], "mediaIds": [],
                   "categoricalCharacteristicValues": [{"characteristicId": c["brand"], "value": "Acme"}
                                                       for c in p["charCats"]],
                   "numericalCharacteristicValues": [{"characteristicId": c["size"], "value": 42.0}
                                                     for c in p["charCats"]]}
        if rtype == "adminNewPrice":
            v = p["variants"][0]
            await self.post_gql(session, rtype, Q_ADMIN_NEW_PRICE, {"i": dict(version, productVariantId=v)},
                                token=self.admin_tok,
                                check=lambda j: j["data"]["createProductVariantVersion"]["id"] is not None,
                                t_sched=t_sched)
        elif rtype == "adminCreateVariant":
            await self.post_gql(session, rtype, Q_ADMIN_CREATE_VARIANT,
                                {"i": {"productId": p["id"], "isPubliclyVisible": True, "initialVersion": version}},
                                token=self.admin_tok,
                                check=lambda j: j["data"]["createProductVariant"]["id"] is not None, t_sched=t_sched)
        elif rtype == "adminCreateProduct":
            await self.post_gql(session, rtype, Q_ADMIN_CREATE_PRODUCT,
                                {"i": {"internalName": f"CAL{n}", "isPubliclyVisible": True,
                                       "categoryIds": p["categories"],
                                       "defaultVariant": {"isPubliclyVisible": True, "initialVersion": version}}},
                                token=self.admin_tok,
                                check=lambda j: j["data"]["createProduct"]["id"] is not None, t_sched=t_sched)
        else:
            raise ValueError(rtype)

    async def stream(self, session, rtype, rate, t_start, t_end, tasks, deterministic=False):
        """Poisson (or, for probes, deterministic) arrivals of one request type in [t_start, t_end)."""
        rng = random.Random(self.rng.random())
        t = t_start - (0.5 / rate if deterministic else 0)
        while True:
            t += (1.0 / rate) if deterministic else rng.expovariate(rate)
            if t >= t_end:
                return
            now = time.time()
            if t > now:
                await asyncio.sleep(t - now)
            self.lag.append(time.time() - t)
            try:
                tk = asyncio.create_task(self.safe_do(session, rtype, t))
                tasks.add(tk)
                tk.add_done_callback(tasks.discard)
            except Exception:
                pass

    async def safe_do(self, session, rtype, t_sched):
        try:
            await self.do(session, rtype, t_sched)
        except Skip:
            self.skipped[rtype] = self.skipped.get(rtype, 0) + 1
        except Exception as e:
            self.w.writerow([rtype, self.phase, f"{t_sched - self.t0:.4f}", "", "", "", -1, 0, 0,
                             f"generator error {type(e).__name__}: {e}"[:200]])


async def hold(g, session, meta, ph, t, h, remaining_s, **empty):
    """Zero load for h seconds as phase `<segment>:hold` before ph. Tokens that would not last the rest of the plan
    (remaining_s, plus 400 s for further holds and the tail) are fetched again here, and the hold then lasts at least
    10 s past the fetch. Returns the end of the hold (the caller checks clear_hold again)."""
    name = ph["name"].split(":")[0] + ":hold"
    g.phase = name
    print(f"[{time.strftime('%H:%M:%S')}] phase {name} {h:.1f}s (scheduled job before {ph['name']})", flush=True)
    n = await g.prefetch_tokens(session, min_valid_s=h + remaining_s + 400)
    t_end = max(t + h, time.time() + 10) if n else t + h
    meta["phases"].append({"name": name, "start": t, "end": t_end, "hold": True, "tokensFetched": n, **empty})
    now = time.time()
    if t_end > now:
        await asyncio.sleep(t_end - now)
    return t_end


def summarize(csv_path, phases=None):
    rows = list(csv.reader(open(csv_path)))[1:]
    out = {}
    for r in rows:
        rtype, phase = r[0], r[1]
        if phases and phase not in phases:
            continue
        d = out.setdefault(phase, {}).setdefault(rtype, {"n": 0, "ok": 0, "lat": [], "err": {}})
        d["n"] += 1
        if r[7] == "1":
            d["ok"] += 1
            d["lat"].append(float(r[5]))
        else:
            d["err"][r[9][:80]] = d["err"].get(r[9][:80], 0) + 1
    res = {}
    for ph, types in out.items():
        for t, d in types.items():
            lat = sorted(d["lat"])

            def pct(q):
                return round(lat[min(len(lat) - 1, int(math.ceil(q * len(lat))) - 1)], 1) if lat else None
            res.setdefault(ph, {})[t] = {"n": d["n"], "ok": d["ok"], "errRate": round(1 - d["ok"] / d["n"], 4),
                                         "mean": round(sum(lat) / len(lat), 1) if lat else None, "p50": pct(.5),
                                         "p95": pct(.95), "p99": pct(.99), "max": lat[-1] if lat else None,
                                         "errors": dict(sorted(d["err"].items(), key=lambda x: -x[1])[:5])}
    return res


class BackgroundCsvWriter:
    """csv.writer replacement for requests.csv: rows go into a queue and a thread writes them. A write() on the event
    loop thread can block for 0.5-4.6 s when other processes fsync heavily on the same ext4 file system (Postgres of
    the stack under load: journal commits); every request in flight then got the stall added to its latency and the
    arrivals came late in a burst (21 vCPU: 62 of 151 10-s bins at 70 sessions/s had a stall > 0.3 s)."""

    def __init__(self, path, header):
        self.f = open(path, "w", newline="")
        self.w = csv.writer(self.f)
        self.w.writerow(header)
        self.q = queue.SimpleQueue()
        self.t = threading.Thread(target=self._run, name="csv-writer", daemon=True)
        self.t.start()

    def writerow(self, row):
        self.q.put(row)

    def _run(self):
        while True:
            rows = [self.q.get()]
            while True:
                try:
                    rows.append(self.q.get_nowait())
                except queue.Empty:
                    break
            done = rows[-1] is None
            self.w.writerows(r for r in rows if r is not None)
            if done:
                self.f.close()
                return

    def close(self):
        self.q.put(None)
        self.t.join()


class LoopWatchdog(threading.Thread):
    """Diagnostics (LOADGEN_WATCHDOG=1): pings the event loop every 50 ms from a thread; when a ping is not processed
    within 300 ms, the main thread's Python stack is appended to <out>/watchdog.txt (where the loop is stuck)."""

    def __init__(self, loop, path):
        super().__init__(name="loop-watchdog", daemon=True)
        self.loop, self.path, self.stop = loop, path, threading.Event()
        self.main = threading.main_thread().ident
        self.last = time.monotonic()

    def _pong(self):
        self.last = time.monotonic()

    def run(self):
        import traceback
        dumped = False
        with open(self.path, "a") as f:
            while not self.stop.wait(0.05):
                self.loop.call_soon_threadsafe(self._pong)
                behind = time.monotonic() - self.last
                if behind > 0.3 and not dumped:
                    fr = sys._current_frames().get(self.main)
                    f.write(f"--- {time.strftime('%H:%M:%S')} loop {behind:.2f}s behind\n"
                            + "".join(traceback.format_stack(fr)[-12:]) + "\n")
                    f.flush()
                    dumped = True
                elif behind < 0.1:
                    dumped = False


async def run_plan(plan, out_dir, seed):
    state = json.load(open(STATE))
    os.makedirs(out_dir, exist_ok=True)
    w = BackgroundCsvWriter(os.path.join(out_dir, "requests.csv"),
                            ["type", "phase", "t_sched", "t_send", "epoch_send", "latency_ms", "http", "ok",
                             "n_errors", "error"])
    conn = aiohttp.TCPConnector(limit=4000, limit_per_host=4000, ttl_dns_cache=300)
    meta = {"plan": plan, "seed": seed, "gateway": GATEWAY, "token_url": TOKEN_URL, "phases": []}
    wd = None
    if os.environ.get("LOADGEN_WATCHDOG"):
        wd = LoopWatchdog(asyncio.get_running_loop(), os.path.join(out_dir, "watchdog.txt"))
        wd.start()
        import gc
        gcf = open(os.path.join(out_dir, "gc.txt"), "a")
        gct = {}

        def gccb(phase, info):
            if phase == "start":
                gct["t"] = time.perf_counter()
            else:
                d = time.perf_counter() - gct.get("t", time.perf_counter())
                if d > 0.05:
                    gcf.write(f"{time.strftime('%H:%M:%S')} gen{info['generation']} {d:.3f}s collected "
                              f"{info['collected']} objects {len(gc.get_objects(info['generation']))}\n")
                    gcf.flush()
        gc.callbacks.append(gccb)
    async with aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=60)) as session:
        t0 = time.time()
        g = Gen(state, seed, w, t0)
        # tokens must stay valid for the whole plan (Keycloak access tokens live 1800 s; a 27-min window with tokens
        # fetched by an earlier run lost them near its end)
        dur = sum(p["duration"] for p in plan["phases"]) + plan.get("settle", 0)
        meta["tokens_fetched"] = await g.prefetch_tokens(session, min_valid_s=max(1500, dur + 120))
        await asyncio.sleep(plan.get("settle", 0))
        tasks = set()
        g.t0 = t0 = time.time()
        meta["t0"] = t0
        t = t0
        for i, ph in enumerate(plan["phases"]):
            while h := clear_hold(ph, t):
                t = await hold(g, session, meta, ph, t, h, sum(p["duration"] for p in plan["phases"][i:]), rates={})
            g.phase = ph["name"]
            t_end = t + ph["duration"]
            meta["phases"].append({"name": ph["name"], "start": t, "end": t_end, "rates": ph.get("rates", {})})
            print(f"[{time.strftime('%H:%M:%S')}] phase {ph['name']} {ph['duration']}s rates={ph.get('rates', {})}",
                  flush=True)
            streams = [g.stream(session, rt, r, t, t_end, tasks, ph.get("deterministic", False))
                       for rt, r in ph.get("rates", {}).items() if r > 0]
            await asyncio.gather(*streams)
            now = time.time()
            if t_end > now:
                await asyncio.sleep(t_end - now)
            t = t_end
        g.phase = "tail"
        if tasks:
            await asyncio.wait(tasks, timeout=70)
        meta["t_end"] = time.time()
    g.save_pools()
    w.close()
    if wd:
        wd.stop.set()
    lag = sorted(g.lag)
    meta["scheduler_lag_ms"] = {"n": len(lag), "mean": round(1000 * sum(lag) / len(lag), 2) if lag else None,
                                "p99": round(1000 * lag[int(0.99 * (len(lag) - 1))], 2) if lag else None,
                                "max": round(1000 * lag[-1], 2) if lag else None}
    meta["max_inflight"] = g.max_inflight
    meta["skipped"] = g.skipped
    meta["cartItemDuplicates"] = g.cart_dupes
    meta["pools_after"] = {"carts": sum(len(v) for v in g.carts.values()), "created": len(g.created),
                           "placed": len(g.placed)}
    meta["summary"] = summarize(os.path.join(out_dir, "requests.csv"))
    json.dump(meta, open(os.path.join(out_dir, "meta.json"), "w"), indent=1)
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan")
    ap.add_argument("--rates")
    ap.add_argument("--duration", type=float, default=60)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=int(time.time()))
    ap.add_argument("--stack", help="original|kotlin (see stack.py; read before argparse)")
    a = ap.parse_args()
    if a.plan:
        plan = json.load(open(a.plan))
    else:
        rates = {k: float(v) for k, v in (kv.split("=") for kv in a.rates.split(","))}
        plan = {"name": "adhoc", "phases": [{"name": "steady", "duration": a.duration, "rates": rates}]}
    meta = asyncio.run(run_plan(plan, a.out, a.seed))
    for ph, types in meta["summary"].items():
        for t, d in sorted(types.items()):
            print(f"{ph:10s} {t:24s} n={d['n']:5d} err={d['errRate']:.3f} mean={d['mean']} p50={d['p50']} "
                  f"p95={d['p95']} p99={d['p99']} {list(d['errors'].items())[:2]}")
    print("lag", meta["scheduler_lag_ms"], "max_inflight", meta["max_inflight"], "skipped", meta["skipped"],
          "pools", meta["pools_after"], "cartItemDuplicates", meta["cartItemDuplicates"])


if __name__ == "__main__":
    main()
