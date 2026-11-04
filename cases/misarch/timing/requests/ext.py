"""Executors for all request types of the timing campaign, on top of loadgen.py (read-only, reused by import).

- `ExtGen` subclasses loadgen's `Gen`. Round-2 types go to loadgen's own `do()` (identical to round 2); the other
  types (reqs.REQUESTS kind "ext", the anonymous variants and the order-path factorial) are executed here.
  `install()` makes loadgen.run_plan (and so measure.py, which calls it) use ExtGen.
- Executors take an `Actor` (who sends the request, plus session context: cart lines, order, tracked order). In an
  isolation run each request gets a fresh actor that satisfies its preconditions; sessiongen.py keeps one actor per
  session, so a session's createOrder orders its own cart lines, placeOrder places its own order, etc.
- Extra pools (returned orders, coupon registrations, created wishlists, created shipment methods, returnable
  orders) persist in timing/state/pools-ext.json; setup data (factorial buyers and products, coupon codes, sink
  category/discount) in timing/state/setup.json (run.py setup).
"""
import asyncio
import collections
import json
import os
import random
import time
import uuid

import aiohttp

from reqs import L  # noqa: F401  (loadgen, imported with MISARCH_STACK=kotlin)
import reqs as R

TIMING = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.environ.get("TIMING_STATE") or os.path.join(TIMING, "state")
SETUP = os.path.join(STATE_DIR, "setup.json")
XPOOLS = os.path.join(STATE_DIR, "pools-ext.json")
XTOKENS = os.path.join(STATE_DIR, "tokens-ext.json")
KC_BASE = L.TOKEN_URL.split("/realms/")[0]
BATCH_SIZE = int(os.environ.get("TIMING_BATCH_SIZE", "20"))     # createProductItemBatch: items per batch
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082") + os.urandom(1024)
RATINGS = (["ONE_STARS", "TWO_STARS", "THREE_STARS", "FOUR_STARS", "FIVE_STARS"], [0.05, 0.07, 0.15, 0.33, 0.40])


def load_json(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


class Actor:
    """Who sends a request, and the context a session carries between its requests."""

    def __init__(self, user=None, token=None, cls="iso"):
        self.user, self.token, self.cls = user, token, cls
        self.product = None          # last viewed product (Gatling adds its default variant to the cart)
        self.cart = []               # this session's cart line ids
        self.order = None            # created, not yet placed
        self.track = None            # (orderId, [orderItemIds]) of the last tracked order
        self.track_oid = None        # order the session will track (chosen with the user)
        self.qty = lambda: 1         # quantity per new cart line
        self.coupons = 0             # coupons per order
        self.method = None           # payment method of the order (None: Gatling's paymentInformations[0])


class ExtGen(L.Gen):
    def __init__(self, state, rng_seed, writer, run_t0):
        super().__init__(state, rng_seed, writer, run_t0)
        self.setup = load_json(SETUP, {})
        self.fbuyers = self.setup.get("fbuyers", [])
        xp = load_json(XPOOLS, {})
        self.returned = set(xp.get("returned", []))
        self.coupon_regs = set(tuple(x) for x in xp.get("couponRegs", []))
        self.extra_wl = xp.get("wishlists", {})                 # username -> [wishlistId] created by createWishlist
        self.created_sms = xp.get("shipmentMethods", [])         # created by createShipmentMethod (cleanup archives)
        self.returnable = xp.get("returnable", [])              # [username, orderId, [orderItemIds]]
        self.kc_admin = (None, 0.0)
        self.http = None
        self.fo = FoState()
        self.by_name.update({b["username"]: b for b in self.fbuyers})
        c0 = self.setup.get("coupon0", {}).get("category")
        self.coupon_products = [p for p in self.products if c0 in p["categories"]]
        self.placed_by_user = collections.defaultdict(list)
        for u, oid in self.placed[-5000:]:
            self.placed_by_user[u].append(oid)

    # ------------------------------------------------------------------ pools / tokens
    def save_pools(self):
        super().save_pools()
        os.makedirs(STATE_DIR, exist_ok=True)
        json.dump({"returned": sorted(self.returned)[-20000:], "couponRegs": sorted(self.coupon_regs),
                   "wishlists": self.extra_wl, "shipmentMethods": self.created_sms,
                   "returnable": self.returnable[-5000:]}, open(XPOOLS, "w"))

    async def prefetch_tokens(self, session, min_valid_s=1500):
        n = await super().prefetch_tokens(session, min_valid_s)
        if self.fbuyers:
            cache = load_json(XTOKENS, {})
            now = time.time()
            need = [b["username"] for b in self.fbuyers if cache.get(b["username"], [None, 0])[1] - now < min_valid_s]
            sem = asyncio.Semaphore(8)

            async def one(u):
                async with sem:
                    data = {"client_id": "frontend", "grant_type": "password", "username": u, "password": "123"}
                    async with session.post(L.TOKEN_URL, data=data) as r:
                        js = await r.json(content_type=None)
                        cache[u] = [js["access_token"], time.time() + js.get("expires_in", 1800)]
            await asyncio.gather(*(one(u) for u in need))
            os.makedirs(STATE_DIR, exist_ok=True)
            json.dump(cache, open(XTOKENS, "w"))
            self.tokens.update({u: v[0] for u, v in cache.items()})
            n += len(need)
        return n

    async def kc_admin_token(self, session):
        tok, exp = self.kc_admin
        if tok and exp - time.time() > 10:
            return tok
        data = {"client_id": "admin-cli", "grant_type": "password", "username": "admin", "password": "admin"}
        async with session.post(f"{KC_BASE}/realms/master/protocol/openid-connect/token", data=data) as r:
            js = await r.json(content_type=None)
        self.kc_admin = (js["access_token"], time.time() + js.get("expires_in", 60))
        return js["access_token"]

    async def xtimed(self, session, rtype, method, url, data, headers, ok_status, t_sched):
        """A timed non-GraphQL request (Keycloak REST), same CSV row as loadgen's timed()."""
        t_send = time.time()
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        p0 = time.perf_counter()
        status, msg = 0, ""
        try:
            async with session.request(method, url, data=data, headers=headers) as r:
                raw = await r.read()
                status = r.status
            if status not in ok_status:
                msg = f"http {status}: {raw[:120].decode(errors='replace')}"
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:200]
        finally:
            self.inflight -= 1
        lat = time.perf_counter() - p0
        ok = int(status in ok_status)
        self.w.writerow([rtype, self.phase, f"{(t_sched if t_sched is not None else t_send) - self.t0:.4f}",
                         f"{t_send - self.t0:.4f}", f"{t_send:.4f}", f"{lat * 1000:.2f}", status, ok, 0,
                         msg.replace("\n", " ")])
        return ok

    # ------------------------------------------------------------------ actors for isolation runs
    def buyer_actor(self, pred=None, pool=None):
        cands = pool if pool is not None else self.buyers
        if pred:
            cands = [b for b in cands if pred(b)]
        if not cands:
            raise L.Skip()
        b = self.rng.choice(cands)
        return Actor(b, self.tokens.get(b["username"]))

    def admin_actor(self):
        return Actor(self.st["admin"], self.admin_tok)

    def actor_for(self, rtype):
        role = (R.REQUESTS.get(rtype) or R.MECH_REQUESTS.get(rtype) or {}).get("role", "buyer")
        if role == "employee":
            return self.admin_actor()
        if role == "anonymous":
            return Actor()
        if rtype in ("wishlistView", "addToWishlist"):
            return self.buyer_actor(lambda b: self.wishlists_of(b))
        if rtype == "orderTracking":
            return self.buyer_actor(lambda b: self.placed_by_user.get(b["username"]))
        return self.buyer_actor()

    # ------------------------------------------------------------------ dispatch
    async def do(self, session, rtype, t_sched=None):
        self.http = session
        if rtype in LOADGEN_NATIVE:
            return await super().do(session, rtype, t_sched)
        kind, _, cell = rtype.partition(".")
        if kind in R.FO_KINDS:
            return await FO_EXEC[kind](self, R.parse_cell(cell), cell, rtype, t_sched)
        ex = EXEC.get(rtype)
        if ex is None:
            raise ValueError(f"unknown request type {rtype}")
        return await ex(self, self.actor_for(rtype), rtype, t_sched)

    async def run_session_call(self, key, actor, t_sched=None):
        """Session step `call key` (sessiongen): every type through the executors here (with the actor's context)."""
        return await EXEC[key](self, actor, key, t_sched)

    # ------------------------------------------------------------------ helpers
    def wishlists_of(self, b):
        return list(b.get("wishlists", [])) + self.extra_wl.get(b["username"], [])

    def gql(self, rtype, a, query, variables=None, check=None, t_sched=None):
        return self.post_gql(self.http, rtype, query, variables, token=a.token, check=check, t_sched=t_sched)

    def pi_of(self, b, method):
        pis = b["paymentInformations"]
        if method is None:
            return pis[0]["id"]        # Gatling: paymentInformations.nodes[0]
        for p in pis:
            if p["paymentMethod"] == method:
                return p["id"]
        return None

    def version_input(self, p, n):
        return {"name": f"Product {p['idx']:04d} cal-{n}", "description": "calibration version",
                "retailPrice": max(1, int(p["price"] * self.rng.uniform(0.9, 1.1))), "weight": 1.0,
                "canBeReturnedForDays": 30, "taxRateId": p["taxRateId"], "mediaIds": [],
                "categoricalCharacteristicValues": [{"characteristicId": c["brand"], "value": "Acme"} for c in p["charCats"]],
                "numericalCharacteristicValues": [{"characteristicId": c["size"], "value": 42.0} for c in p["charCats"]]}


def now_iso(days=0):
    import datetime as dt
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ====================================================================================================================
# executors: async (g, actor, rtype, t_sched) -> ok
EXEC = {}


def ex(name):
    def deco(f):
        EXEC[name] = f
        return f
    return deco


@ex("login")
async def ex_login(g, a, rtype, t):
    if a.user is None:
        a.user = g.rand_buyer()
    data = {"client_id": "frontend", "grant_type": "password", "username": a.user["username"], "password": "123"}
    ok, js = await g.timed(g.http, rtype, L.TOKEN_URL, aiohttp.FormData(data), {}, lambda j: "access_token" in j, t)
    if ok:
        a.token = js["access_token"]
    return ok


@ex("registration")
async def ex_registration(g, a, rtype, t):
    atok = await g.kc_admin_token(g.http)
    u = "reg-" + uuid.uuid4().hex[:12]
    payload = {"username": u, "firstName": "Reg", "lastName": "User", "enabled": True, "email": f"{u}@example.org",
               "emailVerified": True, "credentials": [{"type": "password", "value": "123", "temporary": False}]}
    return await g.xtimed(g.http, rtype, "POST", f"{KC_BASE}/admin/realms/Misarch/users", json.dumps(payload),
                          {"Authorization": f"Bearer {atok}", "Content-Type": "application/json"}, (201,), t)


async def _products(g, a, rtype, t):
    skip = 10 * g.rng.randrange(max(1, len(g.products) // 10))
    anon = a.token is None
    q = (R.Q_PRODUCTS_ANON if anon else L.Q_PRODUCTS) % skip
    ok, _ = await g.gql("products.anon" if anon and rtype == "products" else rtype, a, q,
                        check=lambda j: bool(j["data"]["products"]["nodes"]), t_sched=t)
    return ok


async def _product(g, a, rtype, t):
    # a session that will order with a coupon views (and puts into its cart) a product the coupon applies to: MiSArch
    # fails createOrder when a coupon names an item its discount does not apply to (discount: query_discounts empty)
    p = g.rng.choice(g.coupon_products if (a.coupons and not a.cart and g.coupon_products) else g.products)
    a.product = p
    anon = a.token is None
    q = (R.Q_PRODUCT_ANON if anon else L.Q_PRODUCT) % p["id"]
    ok, _ = await g.gql("product.anon" if anon and rtype == "product" else rtype, a, q,
                        check=lambda j: j["data"]["product"]["defaultVariant"]["id"] is not None, t_sched=t)
    return ok


EXEC.update({"products": _products, "product": _product, "products.anon": _products, "product.anon": _product})


@ex("users")
async def ex_users(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, L.Q_USER, check=lambda j: j["data"]["currentUser"]["id"] == a.user["id"], t_sched=t)
    return ok


@ex("address")
async def ex_address(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, L.Q_ADDRESS, check=lambda j: bool(j["data"]["currentUser"]["addresses"]["nodes"]),
                        t_sched=t)
    return ok


@ex("notifications")
async def ex_notifications(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, R.Q_NOTIFICATIONS,
                        check=lambda j: j["data"]["currentUser"]["notifications"]["totalCount"] >= 0, t_sched=t)
    return ok


@ex("shipmentMethods")
async def ex_shipment_methods(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, L.Q_SHIPMENT_METHODS, check=lambda j: bool(j["data"]["shipmentMethods"]["nodes"]),
                        t_sched=t)
    return ok


@ex("paymentInformations")
async def ex_payment_infos(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, L.Q_PAYMENT_INFOS,
                        check=lambda j: bool(j["data"]["currentUser"]["paymentInformations"]["nodes"]), t_sched=t)
    return ok


@ex("createShoppingcartItem")
async def ex_cart(g, a, rtype, t):
    p = a.product or g.rng.choice(g.products)
    v = p["variants"][0]                         # Gatling adds the product's default variant
    # Two live sessions of one user must never hold the same cart line: re-adding a variant returns the existing line,
    # and the first session's placeOrder then deletes it under the other ("not in cart"). If another live session of
    # this user holds the variant, this session adds another product's default variant (counted in g.cart_swaps).
    held = g.__dict__.setdefault("cart_held", {})        # (userId, variantId) -> id(actor)
    uid = a.user["id"]
    for _ in range(50):
        if held.get((uid, v), id(a)) == id(a):
            break
        g.cart_swaps = g.__dict__.get("cart_swaps", 0) + 1
        v = g.rng.choice(g.products)["variants"][0]
    q = a.qty()
    ok, js = await g.gql(rtype, a, R.Q_CART_N % (a.user["id"], q, v),
                         check=lambda j: j["data"]["createShoppingcartItem"]["id"] is not None, t_sched=t)
    if ok:
        cid = js["data"]["createShoppingcartItem"]["id"]
        if cid not in a.cart:                    # re-adding a variant still in the cart returns the existing line
            a.cart.append(cid)
        held[(uid, v)] = id(a)
        a.__dict__.setdefault("held", []).append((uid, v))
    return ok


def release_cart(g, a):
    """Session end (sessiongen): the session's (user, variant) holds are released."""
    held = g.__dict__.get("cart_held", {})
    for k in a.__dict__.get("held", []):
        if held.get(k) == id(a):
            del held[k]


def order_text(user_id, lines, sm, addr, pi):
    """Gatling's createOrder text; several items as a list. lines = [(cartItemId, [couponIds])]."""
    if len(lines) == 1 and not lines[0][1]:
        return L.Q_CREATE_ORDER % (user_id, lines[0][0], sm, addr, addr, pi)
    items = ", ".join('{ shoppingCartItemId: "%s" couponIds: [%s] shipmentMethodId: "%s" }'
                      % (c, " ".join(f'"{x}"' for x in cps), sm) for c, cps in lines)
    return (L.Q_CREATE_ORDER.replace('orderItemInputs: { shoppingCartItemId: "%s" couponIds: [] shipmentMethodId: "%s" }',
                                     "orderItemInputs: [ " + items.replace("%", "%%") + " ]")
            % (user_id, addr, addr, pi))


@ex("createOrder")
async def ex_create_order(g, a, rtype, t):
    if not a.cart:
        raise L.Skip()
    b = a.user
    pi = g.pi_of(b, a.method) or g.pi_of(b, None)
    coupon = g.setup.get("coupon0", {}).get("id")
    lines = [(c, [coupon] if (a.coupons and k == 0 and coupon) else []) for k, c in enumerate(a.cart)]
    q = order_text(b["id"], lines, g.rng.choice(g.sms), b["addresses"][0], pi)
    ok, js = await g.gql(rtype, a, q, check=lambda j: j["data"]["createOrder"]["id"] is not None, t_sched=t)
    if ok:
        a.order = js["data"]["createOrder"]["id"]
        g.used.update(a.cart)
    return ok


@ex("placeOrder")
async def ex_place_order(g, a, rtype, t):
    if not a.order:
        raise L.Skip()
    oid = a.order
    ok, _ = await g.gql(rtype, a, L.Q_PLACE_ORDER % oid, check=lambda j: j["data"]["placeOrder"]["id"] == oid, t_sched=t)
    if ok:
        g.placed.append([a.user["username"], oid])
        g.placed_by_user[a.user["username"]].append(oid)
        a.order = None
    return ok


@ex("orderTracking")
async def ex_order_tracking(g, a, rtype, t):
    oid = a.track_oid or (g.rng.choice(g.placed_by_user[a.user["username"]][-50:])
                          if g.placed_by_user.get(a.user["username"]) else None)
    if not oid:
        raise L.Skip()
    ok, js = await g.gql(rtype, a, L.Q_ORDER_TRACKING % oid, check=lambda j: j["data"]["order"]["id"] == oid, t_sched=t)
    if ok:
        a.track = (oid, [n["id"] for n in js["data"]["order"]["orderItems"]["nodes"]])
    return ok


@ex("wishlistView")
async def ex_wishlist_view(g, a, rtype, t):
    wls = g.wishlists_of(a.user)
    if not wls:
        raise L.Skip()
    wid = g.rng.choice(wls)
    ok, _ = await g.gql(rtype, a, L.Q_WISHLIST_VIEW % wid, check=lambda j: j["data"]["wishlist"]["id"] == wid, t_sched=t)
    return ok


@ex("addToWishlist")
async def ex_add_to_wishlist(g, a, rtype, t):
    wls = g.wishlists_of(a.user)
    if not wls:
        raise L.Skip()
    wid = g.rng.choice(wls)
    vs = [v for _, v in g.rng.sample(g.all_variants, g.rng.randint(2, 6))]
    ok, _ = await g.gql(rtype, a, L.Q_WISHLIST_ADD, {"i": {"id": wid, "productVariantIds": vs}},
                        check=lambda j: j["data"]["updateWishlist"]["id"] == wid, t_sched=t)
    return ok


@ex("wishlist.createWishlist")
async def ex_create_wishlist(g, a, rtype, t):
    vs = [v for _, v in g.rng.sample(g.all_variants, g.rng.randint(1, 5))]
    ok, js = await g.gql(rtype, a, R.Q_CREATE_WISHLIST,
                         {"input": {"userId": a.user["id"], "productVariantIds": vs, "name": f"T{g.rng.randrange(10**6)}"}},
                         check=lambda j: j["data"]["createWishlist"]["id"] is not None, t_sched=t)
    if ok:
        g.extra_wl.setdefault(a.user["username"], []).append(js["data"]["createWishlist"]["id"])
    return ok


@ex("createReview")
async def ex_create_review(g, a, rtype, t):
    for _ in range(50):     # one review per (user, variant)
        _, v = g.rng.choice(g.all_variants)
        if (a.user["id"], v) not in g.reviewed:
            g.reviewed.add((a.user["id"], v))
            break
    else:
        raise L.Skip()
    rating = g.rng.choices(*RATINGS)[0]
    ok, _ = await g.gql(rtype, a, L.Q_REVIEW, {"i": {"userId": a.user["id"], "productVariantId": v,
                                                       "body": "Calibration review text, about 60 characters long.",
                                                       "rating": rating, "isVisible": True}},
                        check=lambda j: j["data"]["createReview"]["id"] is not None, t_sched=t)
    return ok


@ex("return.createReturn")
async def ex_create_return(g, a, rtype, t):
    if a.track and a.track[0] not in g.returned and a.cls != "iso":
        oid, items = a.track
    else:     # isolation: the returnable pool (run.py prep-returns), this actor becomes the order's buyer
        while g.returnable and g.returnable[0][1] in g.returned:
            g.returnable.pop(0)
        if not g.returnable:
            raise L.Skip()
        u, oid, items = g.returnable.pop(0)
        a.user, a.token = g.by_name[u], g.tokens.get(u)
    g.returned.add(oid)
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_RETURN, {"i": {"orderItemIds": items, "reason": "timing campaign return"}},
                        check=lambda j: j["data"]["createReturn"]["id"] is not None, t_sched=t)
    return ok


@ex("user.updateUser")
async def ex_update_user(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, R.Q_UPDATE_USER,
                        {"i": {"id": a.user["id"], "firstName": g.rng.choice(["Anna", "Ben", "Clara", "David", "Eva"])}},
                        check=lambda j: j["data"]["updateUser"]["id"] == a.user["id"], t_sched=t)
    return ok


@ex("address.createUserAddress")
async def ex_create_user_address(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_USER_ADDRESS,
                        {"input": {"userId": a.user["id"], "city": "Stuttgart", "postalCode": "70569", "country": "Germany",
                                   "street1": f"Hauptstrasse {g.rng.randint(1, 200)}", "street2": "", "companyName": None,
                                   "name": {"firstName": "Timing", "lastName": "User"}}},
                        check=lambda j: j["data"]["createUserAddress"]["id"] is not None, t_sched=t)
    return ok


@ex("payment.createCreditCardPaymentInformation")
async def ex_create_cc(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_CC,
                        {"input": {"cardHolder": "Timing User", "cardNumber": "4111111111111111", "expirationDate": "12/30"}},
                        check=lambda j: j["data"]["createCreditCardPaymentInformation"]["id"] is not None, t_sched=t)
    return ok


@ex("discount.registerCoupon")
async def ex_register_coupon(g, a, rtype, t):
    coupons = g.setup.get("regCoupons", [])
    for _ in range(50):
        c = g.rng.choice(coupons) if coupons else None
        if c and (c["id"], a.user["id"]) not in g.coupon_regs:
            break
    else:
        raise L.Skip()
    g.coupon_regs.add((c["id"], a.user["id"]))
    ok, _ = await g.gql(rtype, a, R.Q_REGISTER_COUPON, {"i": {"code": c["code"], "userId": a.user["id"]}},
                        check=lambda j: j["data"]["registerCoupon"]["id"] == c["id"], t_sched=t)
    return ok


# ---- employee requests
@ex("adminUpdateProduct")
async def ex_admin_update_product(g, a, rtype, t):
    p = g.rng.choice(g.products)
    g.counter += 1
    ok, _ = await g.gql(rtype, a, L.Q_ADMIN_UPDATE_PRODUCT, {"i": {"id": p["id"], "internalName": f"P{p['idx']:04d}-u{g.counter}"}},
                        check=lambda j: j["data"]["updateProduct"]["id"] == p["id"], t_sched=t)
    return ok


@ex("adminNewPrice")
async def ex_admin_new_price(g, a, rtype, t):
    p = g.rng.choice(g.products)
    g.counter += 1
    ok, _ = await g.gql(rtype, a, L.Q_ADMIN_NEW_PRICE, {"i": dict(g.version_input(p, g.counter), productVariantId=p["variants"][0])},
                        check=lambda j: j["data"]["createProductVariantVersion"]["id"] is not None, t_sched=t)
    return ok


@ex("adminCreateVariant")
async def ex_admin_create_variant(g, a, rtype, t):
    p = g.rng.choice(g.products)
    g.counter += 1
    ok, _ = await g.gql(rtype, a, L.Q_ADMIN_CREATE_VARIANT,
                        {"i": {"productId": p["id"], "isPubliclyVisible": True, "initialVersion": g.version_input(p, g.counter)}},
                        check=lambda j: j["data"]["createProductVariant"]["id"] is not None, t_sched=t)
    return ok


@ex("adminCreateProduct")
async def ex_admin_create_product(g, a, rtype, t):
    p = g.rng.choice(g.products)
    g.counter += 1
    ok, _ = await g.gql(rtype, a, L.Q_ADMIN_CREATE_PRODUCT,
                        {"i": {"internalName": f"CAL{g.counter}", "isPubliclyVisible": True, "categoryIds": p["categories"],
                               "defaultVariant": {"isPubliclyVisible": True, "initialVersion": g.version_input(p, g.counter)}}},
                        check=lambda j: j["data"]["createProduct"]["id"] is not None, t_sched=t)
    return ok


@ex("inventory.createProductItemBatch")
async def ex_item_batch(g, a, rtype, t):
    _, v = g.rng.choice(g.all_variants)
    ok, _ = await g.gql(rtype, a, R.Q_ITEM_BATCH, {"input": {"productVariantId": v, "number": BATCH_SIZE}},
                        check=lambda j: len(j["data"]["createProductItemBatch"]) == BATCH_SIZE, t_sched=t)
    return ok


@ex("catalog.updateProductVariant")
async def ex_update_variant(g, a, rtype, t):
    _, v = g.rng.choice(g.all_variants)
    ok, _ = await g.gql(rtype, a, R.Q_UPDATE_VARIANT, {"i": {"id": v, "isPubliclyVisible": True}},
                        check=lambda j: j["data"]["updateProductVariant"]["id"] == v, t_sched=t)
    return ok


@ex("media.uploadMedia")
async def ex_upload_media(g, a, rtype, t):
    fd = aiohttp.FormData()
    fd.add_field("operations", json.dumps({"query": R.Q_UPLOAD_MEDIA, "variables": {"file": None}}))
    fd.add_field("map", json.dumps({"0": ["variables.file"]}))
    fd.add_field("0", PNG, filename="timing.png", content_type="image/png")
    h = {"Authorization": "Bearer " + a.token, "Apollo-Require-Preflight": "true"}
    ok, _ = await g.timed(g.http, rtype, L.GATEWAY, fd, h, lambda j: bool(j["data"]["uploadMedia"]), t)
    return ok


@ex("discount.createDiscount")
async def ex_create_discount(g, a, rtype, t):
    sink = g.setup.get("sinkCategory")
    if not sink:
        raise L.Skip()
    inp = {"discount": 0.05, "maxUsagesPerUser": 1000, "minOrderAmount": 0, "validFrom": now_iso(-1),
           "validUntil": now_iso(730), "discountAppliesToCategoryIds": [sink], "discountAppliesToProductIds": [],
           "discountAppliesToProductVariantIds": []}
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_DISCOUNT, {"i": inp}, check=lambda j: j["data"]["createDiscount"]["id"] is not None,
                        t_sched=t)
    return ok


@ex("discount.createCoupon")
async def ex_create_coupon(g, a, rtype, t):
    d = g.setup.get("sinkDiscount")
    if not d:
        raise L.Skip()
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_COUPON,
                        {"i": {"code": "T" + uuid.uuid4().hex[:10], "discountId": d, "maxUsages": 1000000,
                               "validFrom": now_iso(-1), "validUntil": now_iso(730)}},
                        check=lambda j: j["data"]["createCoupon"]["id"] is not None, t_sched=t)
    return ok


@ex("catalog.createCategory")
async def ex_create_category(g, a, rtype, t):
    name = "T-" + uuid.uuid4().hex[:8]
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_CATEGORY,
                        {"input": {"name": name, "description": f"All about {name}",
                                   "categoricalCharacteristics": [{"name": "Brand", "description": "Brand"}],
                                   "numericalCharacteristics": [{"name": "Size", "description": "Size", "unit": "cm"}]}},
                        check=lambda j: j["data"]["createCategory"]["id"] is not None, t_sched=t)
    return ok


@ex("tax.createTaxRate")
async def ex_create_tax_rate(g, a, rtype, t):
    name = "T-" + uuid.uuid4().hex[:8]
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_TAX_RATE,
                        {"input": {"name": name, "description": name, "initialVersion": {"rate": 19.0}}},
                        check=lambda j: j["data"]["createTaxRate"]["id"] is not None, t_sched=t)
    return ok


TAX_RATES = (19.0, 7.0, 0.0)     # seed.py's order of state["taxRates"]


@ex("tax.createTaxRateVersion")
async def ex_create_tax_rate_version(g, a, rtype, t):
    k = g.rng.randrange(len(g.st["taxRates"]))
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_TAX_RATE_VERSION,
                        {"input": {"taxRateId": g.st["taxRates"][k], "rate": TAX_RATES[k]}},
                        check=lambda j: j["data"]["createTaxRateVersion"]["id"] is not None, t_sched=t)
    return ok


@ex("shipment.createShipmentMethod")
async def ex_create_shipment_method(g, a, rtype, t):
    ok, js = await g.gql(rtype, a, R.Q_CREATE_SHIPMENT_METHOD,
                         {"i": {"name": "T-" + uuid.uuid4().hex[:6], "description": "timing method", "externalReference": "",
                                "baseFees": 5, "feesPerItem": 1, "feesPerKg": 5}},
                         check=lambda j: j["data"]["createShipmentMethod"]["id"] is not None, t_sched=t)
    if ok:
        g.created_sms.append(js["data"]["createShipmentMethod"]["id"])
    return ok


@ex("address.createVendorAddress")
async def ex_create_vendor_address(g, a, rtype, t):
    ok, _ = await g.gql(rtype, a, R.Q_CREATE_VENDOR_ADDRESS,
                        {"i": {"city": "Stuttgart", "companyName": "MiSArch Shop GmbH", "country": "Germany",
                               "postalCode": "70569", "street1": "Universitaetsstrasse", "street2": "38",
                               "name": {"firstName": "Shop", "lastName": "Owner"}}},
                        check=lambda j: j["data"]["createVendorAddress"]["id"] is not None, t_sched=t)
    return ok


# ---- block 6 (README.md §4.1): response cache with controlled key sets, and the copy-writing events without a type
MECH_HOT_KEYS = int(os.environ.get("TIMING_MECH_HOT_KEYS", "4"))


def mech_keys(g, base):
    """(hot keys, cold iterator) for a cache type, built once per generator (window): hot = MECH_HOT_KEYS keys,
    cold = every other key once, in random order (wraps around only if the pool runs out)."""
    st = g.__dict__.setdefault("mech_state", {})
    if base not in st:
        rng = random.Random(f"mech-{base}-{g.rng.random()}")
        if base == "orderTracking":     # the window's own createOrder orders first (after a data reset the pools
            # hold only the baseline's 200 placed orders); Order.shipments is fetched from shipment for every order
            pairs = list(dict.fromkeys([(x[0], x[1]) for x in g.created if g.tokens.get(x[0])] +
                                       [(u, oid) for u, oid in g.placed[-5000:] if g.tokens.get(u)]))
        else:
            pairs = list(dict.fromkeys((b["username"], w) for b in list(g.buyers) + list(g.fbuyers)
                                       for w in g.wishlists_of(b) if g.tokens.get(b["username"])))
        rng.shuffle(pairs)
        hot, cold = pairs[:MECH_HOT_KEYS], pairs[MECH_HOT_KEYS:]
        st[base] = {"hot": hot, "cold": cold, "i": 0, "wrapped": 0}
    return st[base]


def mech_next_cold(k):
    if not k["cold"]:
        raise L.Skip()
    if k["i"] >= len(k["cold"]):
        k["i"], k["wrapped"] = 0, k["wrapped"] + 1
    x = k["cold"][k["i"]]
    k["i"] += 1
    return x


async def _mech_cache(g, rtype, t, base, hot):
    k = mech_keys(g, base)
    if hot and not k["hot"]:
        raise L.Skip()
    u, key = g.rng.choice(k["hot"]) if hot else mech_next_cold(k)
    a = Actor(g.by_name.get(u), g.tokens.get(u))
    if base == "orderTracking":
        ok, _ = await g.gql(rtype, a, L.Q_ORDER_TRACKING % key, check=lambda j: j["data"]["order"]["id"] == key, t_sched=t)
    else:
        ok, _ = await g.gql(rtype, a, L.Q_WISHLIST_VIEW % key, check=lambda j: j["data"]["wishlist"]["id"] == key,
                            t_sched=t)
    return ok


for _base in ("orderTracking", "wishlistView"):
    for _hot in (True, False):
        EXEC[f"{_base}.{'hot' if _hot else 'cold'}"] = (
            lambda base, hot: (lambda g, a, rtype, t: _mech_cache(g, rtype, t, base, hot)))(_base, _hot)


async def _caller_hot_keys(g, t):
    """4 (buyer, cart line, shipment method) triples for createOrder.hot, created once per generator (window): a fresh
    cart line of a random product's default variant per buyer (quantity 1). They are never placed, so shoppingcart
    keeps them; the orders stay PENDING (the data reset removes them)."""
    st = g.__dict__.setdefault("caller_hot", {"keys": [], "lock": asyncio.Lock()})
    async with st["lock"]:
        if not st["keys"]:
            rng = random.Random(f"caller-hot-{g.rng.random()}")
            for b in rng.sample(list(g.buyers), MECH_HOT_KEYS):
                v = rng.choice(g.products)["variants"][0]
                ok, js = await g.post_gql(g.http, "createOrder.hot:setup", R.Q_CART_N % (b["id"], 1, v),
                                          token=g.tokens.get(b["username"]),
                                          check=lambda j: j["data"]["createShoppingcartItem"]["id"] is not None,
                                          t_sched=t)
                if ok:
                    st["keys"].append((b, js["data"]["createShoppingcartItem"]["id"], rng.choice(g.sms)))
    return st["keys"]


@ex("createOrder.hot")
async def ex_create_order_hot(g, a, rtype, t):
    keys = await _caller_hot_keys(g, t)
    if not keys:
        raise L.Skip()
    b, cid, sm = g.rng.choice(keys)
    q = order_text(b["id"], [(cid, [])], sm, b["addresses"][0], g.pi_of(b, None))
    ok, _ = await g.post_gql(g.http, rtype, q, token=g.tokens.get(b["username"]),
                             check=lambda j: j["data"]["createOrder"]["id"] is not None, t_sched=t)
    return ok


@ex("discount.updateDiscount")
async def ex_update_discount(g, a, rtype, t):
    d = g.setup.get("sinkDiscount")
    if not d:
        raise L.Skip()
    ok, _ = await g.gql(rtype, a, R.Q_UPDATE_DISCOUNT, {"i": {"id": d, "validUntil": now_iso(730)}},
                        check=lambda j: j["data"]["updateDiscount"]["id"] == d, t_sched=t)
    return ok


@ex("shipment.archiveShipmentMethod")
async def ex_archive_shipment_method(g, a, rtype, t):
    if not g.created_sms:
        raise L.Skip()
    sm = g.created_sms.pop()          # newest first: the methods created earlier in this window
    ok, _ = await g.gql(rtype, a, R.Q_ARCHIVE_SHIPMENT_METHOD, {"i": {"id": sm}},
                        check=lambda j: j["data"]["archiveShipmentMethod"]["id"] == sm, t_sched=t)
    return ok


assert set(EXEC) >= set(R.MECH_REQUESTS), set(R.MECH_REQUESTS) - set(EXEC)

LOADGEN_NATIVE = {k for k, v in R.REQUESTS.items() if v["kind"] == "loadgen" and k != "login"} | set(L.TYPES) | set(L.HOP_URLS) \
    | {"eventUserCreate"}
assert set(EXEC) >= set(R.REQUESTS), set(R.REQUESTS) - set(EXEC)


# ====================================================================================================================
# order-path factorial (§3.6): per cell foCart (fill: one order's cart lines), foOrder (createOrder), foPlace (placeOrder)
class FoState:
    def __init__(self):
        self.kits = collections.defaultdict(collections.deque)      # cell -> deque[(buyer, [cartItemIds])]
        self.created = collections.defaultdict(collections.deque)   # cell -> deque[(buyer, orderId, [cartItemIds])]
        self.busy = set()                                           # usernames with an open kit or unplaced order
        self.cell = None


async def fo_cleanup(g, cell, t):
    """Lines of other cells' kits / unplaced orders are deleted (the next cell's buyers start with empty carts)."""
    fo = g.fo
    for c in [c for c in list(fo.kits) + list(fo.created) if c != cell]:
        for entry in list(fo.kits.pop(c, [])) + list(fo.created.pop(c, [])):
            b, lines = entry[0], entry[-1]
            for cid in lines:
                await g.post_gql(g.http, "foCleanup", R.Q_DELETE_CART_ITEM, {"id": cid}, token=g.tokens.get(b["username"]),
                                 t_sched=t)
            fo.busy.discard(b["username"])


async def fo_cart(g, c, cell, rtype, t):
    fo = g.fo
    if fo.cell != cell:
        fo.cell = cell
        await fo_cleanup(g, cell, t)
    group = g.setup.get("foVariants", {}).get(f"s{c['stock']}", [])
    free = [b for b in g.fbuyers if b["username"] not in fo.busy]
    if len(group) < c["items"] or not free:
        raise L.Skip()
    b = g.rng.choice(free)
    fo.busy.add(b["username"])
    lines = []
    for v in g.rng.sample(group, c["items"]):
        ok, js = await g.post_gql(g.http, rtype, R.Q_CART_N % (b["id"], c["qty"], v), token=g.tokens.get(b["username"]),
                                  check=lambda j: j["data"]["createShoppingcartItem"]["id"] is not None, t_sched=t)
        if ok:
            lines.append(js["data"]["createShoppingcartItem"]["id"])
    if len(lines) == c["items"]:
        fo.kits[cell].append((b, lines))
    else:
        fo.kits["broken"].append((b, lines))     # deleted by the next cleanup
    return True


async def fo_order(g, c, cell, rtype, t):
    fo = g.fo
    if not fo.kits[cell]:
        raise L.Skip()
    b, lines = fo.kits[cell].popleft()
    coupon = g.setup.get("coupon0", {}).get("id") if c["coupon"] else None
    pi = g.pi_of(b, c["method"])
    q = order_text(b["id"], [(cid, [coupon] if coupon else []) for cid in lines], g.sms[0], b["addresses"][0], pi)
    ok, js = await g.post_gql(g.http, rtype, q, token=g.tokens.get(b["username"]),
                              check=lambda j: j["data"]["createOrder"]["id"] is not None, t_sched=t)
    if ok:
        fo.created[cell].append((b, js["data"]["createOrder"]["id"], lines))
    else:
        fo.kits["broken"].append((b, lines))
    return ok


async def fo_place(g, c, cell, rtype, t):
    fo = g.fo
    if not fo.created[cell]:
        raise L.Skip()
    b, oid, lines = fo.created[cell].popleft()
    ok, _ = await g.post_gql(g.http, rtype, L.Q_PLACE_ORDER % oid, token=g.tokens.get(b["username"]),
                             check=lambda j: j["data"]["placeOrder"]["id"] == oid, t_sched=t)
    if ok:
        fo.busy.discard(b["username"])     # shoppingcart deletes the placed lines
    else:
        fo.kits["broken"].append((b, lines))
    return ok


FO_EXEC = {"foCart": fo_cart, "foOrder": fo_order, "foPlace": fo_place}


def install():
    """Make loadgen.run_plan (and measure.py, which calls it) use ExtGen."""
    L.Gen = ExtGen
    return L
