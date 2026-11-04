#!/usr/bin/env python3
"""Per-site hit ratios and per-key staleness of a TTL cache, offline over the session model's key
streams (DESIGN.md AB33.2). For every call site of the derived models that allows a cache
(CachedCall or a gateway join with a cache; reads, request fields and, since AB60, calls of operations), as if
that site used a cache:

    hitRatio   = hits / lookups of a TTL cache (Consistency.cacheTtlSeconds, 60 s, no invalidation:
                 MiSArch's knee entity cache);
    staleShare = the share of the hits whose key was written after the entry was stored (a write to
                 any data the cached answer depends on, in (stored, hit]): the per-key staleness that
                 replaces O4's class-level min(1, w x TTL) for that site's hits.

    cache_hits.py [--popularity zipf|uniform|pool] [--zipf-s 1.0] [--seed 1]
                  [--out mdeo/models/domain-cache-hits.json] [--all]   (--all: the three popularities into
                  one file; the models read popularity zipf, runs["day/zipf"])

Sessions: the realistic workload of workload/sessions.json with the phases and rates of the models'
profile (derive.PROFILE, C4's compressed day; timing/sessiongen.py's class_rates and path
sampling, the load generator's own code), arrivals Poisson per session class, the path (loops,
branches, think times) drawn at the session's start.
Keys (an assumption, DESIGN.md AB33.2): the load generator draws products uniformly from its small
seeded pool (300 products, timing/requests/ext.py `rng.choice(g.products)`), which says nothing
about production popularity, so the default is Zipf(s) over the baseline catalog (20 000 products,
timing/data/profile.json; variants 1/2/3 with p .5/.3/.2, the first the default variant); uniform
over the catalog and the load generator's pool (300) are sensitivities. Users uniform over the
baseline's 40 000 (a session is one user; anonymous pages too). User-owned data (cart, addresses,
payment informations, notifications, wishlist, orders and their items, shipments, invoices,
payments, discount usages and coupon redemptions) is keyed by its user or order, so its cache
entries are per user (the joinCache's per-user scope) and only that user's requests hit them;
public data (products, variants, versions, categories, ratings) is keyed by entity and shared
across users (backend caches are shared). Writes: admin edits of existing entities uniformly over
the catalog (adminUpdateProduct, adminNewPrice, catalog.updateProductVariant; created entities are
new keys), buyers' writes on their own data, reviews on a variant drawn by popularity. Events and
saga steps run 0.1 s after their trigger (one step after another), at the trigger's keys.
Request plans, operations, accesses and site names come from A's domain via core/generator/derive.py.
"""
import argparse
import bisect
import collections
import heapq
import itertools
import json
import os
import math
import random
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
P = HERE.parents[2]                                  # the repository root
sys.path.insert(0, str(P / "core" / "generator"))
os.environ.setdefault("ARCH_CASE", "misarch")
import derive as G  # noqa: E402  (the core's derivation: the domain, the profile, the TTL)
sys.path.insert(0, str(G.C.dir / "timing"))

TTL = G.CACHE_TTL_S
PRODUCTS, USERS, POOL = 20000, 40000, 300
VARIANTS = ((1, 0.5), (2, 0.3), (3, 0.2))
EVENT_DELAY = 0.1
TAXRATES, SHIPMENT_METHODS, DISCOUNTS = 6, 15, 51

USER_OWNED = {"User", "UserAddress", "PaymentInformation", "Notification", "ShoppingCart", "ShoppingCartItem",
              "Wishlist", "DiscountUsage", "CouponRedemption"}
ORDER_OWNED = {"Order", "OrderItem", "OrderCompensation", "Shipment", "Invoice", "Payment",
               "Return"}
VARIANT_KEYED = {"ProductVariant", "ProductVariantVersion", "Review", "ProductItem", "CategoryCharacteristicValue"}
PRODUCT_KEYED = {"Product", "Media"}
CATEGORY_KEYED = {"Category", "CategoryCharacteristic"}
GLOBAL = {"Discount": DISCOUNTS, "Coupon": 20, "TaxRate": TAXRATES, "TaxRateVersion": TAXRATES,
          "ShipmentMethod": SHIPMENT_METHODS, "VendorAddress": 1}
NEW_ENTITY = {  # request types that create the entity they then work on (fresh keys)
    "adminCreateProduct": "product", "registration": "user", "createOrder": "order"}
ADMIN_UNIFORM = {"adminUpdateProduct", "adminNewPrice", "catalog.updateProductVariant", "adminCreateVariant"}


class Catalog:
    def __init__(self, popularity, s, rng):
        self.n = POOL if popularity == "pool" else PRODUCTS
        self.popularity = popularity
        if popularity == "zipf":
            w = [1.0 / (r ** s) for r in range(1, self.n + 1)]
            tot = sum(w)
            self.cum = list(itertools.accumulate(x / tot for x in w))
        r2 = random.Random(7)
        self.nvar = [r2.choices([k for k, _ in VARIANTS], [p for _, p in VARIANTS])[0] for _ in range(self.n)]
        self.cats = [tuple(sorted(r2.sample(range(300), 2 if r2.random() < 0.3 else 1))) for _ in range(self.n)]
        self.rng = rng
        self.fresh = itertools.count(10 ** 9)

    def product(self):
        if self.popularity == "zipf":
            return min(bisect.bisect_left(self.cum, self.rng.random()), self.n - 1)
        return self.rng.randrange(self.n)

    def uniform(self):
        return self.rng.randrange(self.n)

    def variants(self, p):
        return [(p, i) for i in range(self.nvar[p] if 0 <= p < self.n else 1)]


class Ctx:
    __slots__ = ("u", "p", "o", "cart", "wl", "orders")

    def __init__(self, u):
        self.u, self.p, self.o, self.cart, self.wl, self.orders = u, None, None, [], None, []


def type_of(op):
    """The GraphQL parent type of a field or entity resolver: catalog.Product.categories -> Product,
    review._entities.ProductVariant -> ProductVariant; None for a root operation."""
    m = re.match(r"\w+\._entities\.(\w+)$", op) or re.match(r"\w+\.([A-Z]\w*)\.\w+$", op)
    return m.group(1) if m else None


class Sim:
    def __init__(self, dom, catalog, rng, sites):
        self.dom, self.cat, self.rng = dom, catalog, rng
        # the ids a cache lookup draws (a GLOBAL class's random id) come from a stream of their own per site (DESIGN.md
        # AB60, AB63), so that a site added to the model does not move the key streams of the others
        self.lookup_seed = None                             # simulate(): the run's seed
        self.lookup_rngs = {}                               # site -> its lookups' stream
        self.lookup_rng = None                              # the stream of the site being looked up
        self.in_lookup = False
        self.home = {x: dom.home(x) for x in dom.reached}
        self.sites = sites                                  # names of the cache sites in the model
        self.cache = collections.defaultdict(dict)          # site -> key -> stored time
        self.stats = collections.defaultdict(lambda: [0, 0, 0])   # site -> [lookups, hits, stale hits]
        self.writes = collections.defaultdict(list)         # (data, id) -> write times (ascending); data: a class's
                                                            # rows or a reference's links (G.Domain.data, AB42)
        self.events = []                                    # (t, seq, op, ctx snapshot, base)
        self.seq = itertools.count()
        self.users_wl = {}
        self.window = (0.0, math.inf)
        self.unknown = collections.Counter()

    # --- keys
    def wishlist(self, u):
        if u not in self.users_wl:
            r = random.Random(u * 7919 + 1)
            k = r.randint(1, 6)
            ps = [self.cat.product() for _ in range(k)]
            self.users_wl[u] = [(p, 0) for p in ps]
        return self.users_wl[u]

    def ids(self, cls, ctx, entity=None):
        """The ids of `cls` that an access in context ctx (or behind the entity key `entity`) touches."""
        if entity is not None:
            kind, e = entity
            if kind == "variant":
                if cls in VARIANT_KEYED:
                    return [e]
                if cls in PRODUCT_KEYED:
                    return [e[0]]
                if cls in CATEGORY_KEYED:
                    return list(self.cat.cats[e[0]]) if 0 <= e[0] < self.cat.n else []
            if kind == "product":
                if cls in PRODUCT_KEYED:
                    return [e]
                if cls in VARIANT_KEYED:
                    return self.cat.variants(e)
                if cls in CATEGORY_KEYED:
                    return list(self.cat.cats[e]) if 0 <= e < self.cat.n else []
            if kind == "wishlist" and cls in VARIANT_KEYED:
                return self.wishlist(e)
        if cls in USER_OWNED:
            return [("u", ctx.u)]
        if cls in ORDER_OWNED:
            return [("o", ctx.o if ctx.o is not None else ("hist", ctx.u))]
        if cls in PRODUCT_KEYED:
            return [ctx.p] if ctx.p is not None else []
        if cls in VARIANT_KEYED:
            if ctx.p is None:
                return []
            return [(ctx.p, 0)]
        if cls in CATEGORY_KEYED:
            return list(self.cat.cats[ctx.p]) if ctx.p is not None and 0 <= ctx.p < self.cat.n else []
        if cls in GLOBAL:
            return [(self.lookup_rng if self.in_lookup else self.rng).randrange(GLOBAL[cls])]
        self.unknown[cls] += 1
        return []

    def entity_keys(self, callee, ctx):
        """The cache keys of a call of a field or entity resolver: (kind, id) per looked-up entity."""
        t = type_of(callee)
        if t in ("ProductVariant",):
            if callee.startswith("catalog._entities") or callee.startswith("wishlist"):
                pass
            if ctx.wl is not None:          # the wishlist's variants (wishlistView)
                return [("variant", v) for v in ctx.wl]
            return [("variant", (ctx.p, 0))] if ctx.p is not None else []
        if t == "Product":
            return [("product", ctx.p)] if ctx.p is not None else []
        if t == "Wishlist":
            return [("wishlist", ctx.u)]
        if t == "User" or t == "ShoppingCart":
            return [("user", ctx.u)]
        if t == "Order":
            return [("order", ctx.o if ctx.o is not None else ("hist", ctx.u))]
        return [("op", callee)]

    def call_keys(self, callee, caller, ctx):
        """The cache keys of a call of an operation (DESIGN.md AB60: a call that is neither strict nor an effect may
        be cached), by the rules of entity_keys: an entity or field resolver per looked-up entity (createOrder's calls
        look up the variants of the user's cart: the cart lines are its input), a root operation (a query with
        input) one key per input, here built from the caller's user and cart (createOrder's discount and fee
        queries: the user, the variants and their counts)."""
        if type_of(callee) is not None:
            if caller == "order.createOrder" and type_of(callee) == "ProductVariant":
                return [("variant", v) for v in sorted(set(ctx.cart))]
            return self.entity_keys(callee, ctx)
        return [("call", callee, ctx.u, tuple(sorted(ctx.cart)))]

    def deps(self, read_data, key, ctx):
        """The (data, id) a cached answer depends on; read_data: (data name, the class whose ids key it)."""
        out = set()
        for d, c in sorted(read_data):
            for i in self.ids(c, ctx, key if key[0] in ("variant", "product", "wishlist") else None):
                out.add((d, i))
        return out

    # --- the cache of one site
    def begin_lookup(self, site):
        self.in_lookup = True
        if site not in self.lookup_rngs:
            self.lookup_rngs[site] = random.Random(f"lookup:{self.lookup_seed}:{site}")
        self.lookup_rng = self.lookup_rngs[site]

    def lookup(self, site, key, deps, t):
        st = self.stats[site]
        measured = self.window[0] <= t <= self.window[1]
        c = self.cache[site]
        t0 = c.get(key)
        if t0 is not None and t - t0 < TTL:
            if measured:
                st[0] += 1
                st[1] += 1
                stale = False
                for d in deps:
                    w = self.writes.get(d)
                    if w and w[-1] > t0:
                        stale = True
                        break
                if stale:
                    st[2] += 1
            return
        c[key] = t
        if measured:
            st[0] += 1

    def write(self, cls, data, ctx, t):
        for i in self.ids(cls, ctx):
            for dt in data:
                self.writes[(G.Domain.data_name(dt), i)].append(t)

    # --- operations
    def read_data(self, op, seen=None):
        """(data name, class) of what op and the operations it calls read."""
        seen = seen or set()
        if op in seen or op not in self.dom.ops:
            return set()
        seen.add(op)
        # (own data in a copy is the home class's rows, DESIGN.md AB67: keyed by that class)
        out = {(G.Domain.data_name(dt), dt[1] if dt[0] == "rows" else a["class"])
               for a in self.dom.ops[op]["accesses"] if a["mode"] == "read" and G.statements(a) > 0
               for dt in [self.dom.data(a, op)]}
        for t in self.dom.targets(op):
            if t[1] == "call":
                for x in [t[0]] + [y for y, _ in G.Domain.nested(t[4])]:
                    out |= self.read_data(x, seen)
        return out

    def run_op(self, op, t, ctx, base):
        """One execution of `op` at t in SEFF `base` (its reads at its cache sites, its writes, its
        calls synchronously, its events later)."""
        if op not in self.home:
            return
        h = self.home[op]
        for c, mode, g in self.dom.access_groups(op, timed=False):
            if mode == "write":
                self.write(c, g["data"], ctx, t)
            elif c != h:
                site = f"site_{base}_read{c}"
                if site in self.sites:
                    self.begin_lookup(site)
                    for i in self.ids(c, ctx):
                        self.lookup(site, (c, i), {(G.Domain.data_name(dt), i) for dt in g["data"]}, t)
                    self.in_lookup = False
        names = set()
        for tg in self.dom.targets(op):
            callee, kind, prob = tg[0], tg[1], tg[2]
            if callee not in self.home:
                continue
            local = f"{kind}{G.upper(G.ident(callee))}"
            k = 2
            while local in names:
                local = f"{kind}{G.upper(G.ident(callee))}{k}"
                k += 1
            names.add(local)
            if prob < 1.0 and self.rng.random() >= prob:
                continue
            cbase = f"{self.home[callee]}_{G.ident(callee)}"
            if kind == "call":
                self.lookup_call(f"site_{base}_{local}", callee, op, ctx, t, tg[4])
                if tg[4]:
                    cbase += f"_call_{G.ident(op)}"
                self.run_op(callee, t, ctx, cbase)
                self.run_nested(tg[4], cbase, op, t, ctx)
            else:
                snap = Ctx(ctx.u)
                snap.p, snap.o, snap.cart, snap.wl = ctx.p, ctx.o, list(ctx.cart), ctx.wl
                heapq.heappush(self.events, (t + EVENT_DELAY, next(self.seq), callee, snap, cbase))

    def lookup_call(self, site, callee, caller, ctx, t, fields=()):
        """A call's cache site (DESIGN.md AB60), if the model has one: a lookup per key, the answer depending on what
        the callee, the operations it calls and the fields its invocation resolves on its objects (AB55) read."""
        if site in self.sites:
            self.begin_lookup(site)
            rc = self.read_data(callee)
            for y, _ in G.Domain.nested(fields):
                rc |= self.read_data(y)
            for k in self.call_keys(callee, caller, ctx):
                self.lookup(site, k, self.deps(rc, k, ctx), t)
            self.in_lookup = False

    def run_nested(self, fields, base, caller, t, ctx):
        """The fields a call of `caller` resolves on the objects of the SEFF `base` (DESIGN.md AB55): each in its own
        SEFF, which for a field with fields of its own is its SEFF for that call; a field's call site (as derive
        names it) gets its lookups when the call may be cached (AB60)."""
        names = set()
        for y, kids in fields:
            if y not in self.home:
                continue
            local = f"call{G.upper(G.ident(y))}"
            k = 2
            while local in names:
                local = f"call{G.upper(G.ident(y))}{k}"
                k += 1
            names.add(local)
            self.lookup_call(f"site_{base}_{local}", y, caller, ctx, t, kids)
            ybase = f"{self.home[y]}_{G.ident(y)}" + (f"_call_{G.ident(caller)}" if kids else "")
            self.run_op(y, t, ctx, ybase)
            self.run_nested(kids, ybase, caller, t, ctx)

    def run_request(self, key, t, ctx):
        r = self.dom.requests.get(key)
        if r is None:
            return
        # the request's context (keys)
        ctx.wl = None
        if key in ("product",):
            ctx.p = self.cat.product()
        elif key in ("createShoppingcartItem",):
            if ctx.p is None:
                ctx.p = self.cat.product()
            ctx.cart.append((ctx.p, 0))
        elif key == "createOrder":
            ctx.o = ("new", next(self.seq))
            ctx.orders.append(ctx.o)
        elif key == "orderTracking":
            ctx.o = ctx.orders[-1] if ctx.orders else ("hist", ctx.u)
        elif key == "wishlistView":
            ctx.wl = self.wishlist(ctx.u)
        elif key == "createReview":
            ctx.p = self.cat.product()
        elif key in ADMIN_UNIFORM:
            ctx.p = self.cat.uniform()
        elif key in NEW_ENTITY:
            if NEW_ENTITY[key] == "product":
                ctx.p = next(self.cat.fresh)
            elif NEW_ENTITY[key] == "user":
                ctx.u = next(self.cat.fresh)
        root = r["plan"][0][0]
        base = f"{self.home[root]}_req_{G.ident(key)}"
        self.run_op(root, t, ctx, base)
        self.run_fields(self.dom.tree(key), base, key, ctx, t)
        ctx.wl = None

    def run_fields(self, fields, base, key, ctx, t):
        """A request's fields resolved on the objects of the SEFF `base` (the plan's tree, DESIGN.md AB44): their
        cache sites in it, then each field in its own SEFF, which for a field with fields of its own is its SEFF for
        this request."""
        for x, via, kids in fields:
            if x not in self.home:
                continue
            site = f"site_{base}_field{G.upper(G.ident(x))}"
            if site in self.sites:
                self.begin_lookup(site)
                rc = self.read_data(x)
                for k in self.entity_keys(x, ctx):
                    self.lookup(site, k, self.deps(rc, k, ctx), t)
                self.in_lookup = False
            xbase = f"{self.home[x]}_{G.ident(x)}" + (f"_req_{G.ident(key)}" if kids else "")
            self.run_op(x, t, ctx, xbase)
            self.run_fields(kids, xbase, key, ctx, t)

    def drain(self, until):
        while self.events and self.events[0][0] <= until:
            t, _, op, ctx, base = heapq.heappop(self.events)
            self.run_op(op, t, ctx, base)


def simulate(popularity, s, seed):
    import sessiongen as SG
    dom = G.Domain(json.loads(G.DOMAIN.read_text()), json.loads(G.SESSIONS.read_text()))
    model_text = (G.C.path("mdeo.models") / "domain-today.m").read_text()
    sites = set(re.findall(r"^(site_\w+) : CallSite", model_text, re.M))
    allowed = collections.defaultdict(set)
    for sname, m in re.findall(r"^(site_\w+)\.allowed -- (\w+)$", model_text, re.M):
        allowed[sname].add(m)
    cache_sites = {x for x in sites if allowed[x] & {"cache", "joinCache"}}
    rng = random.Random(seed)
    cat = Catalog(popularity, s, rng)
    sim = Sim(dom, cat, rng, cache_sites)
    sim.lookup_seed = seed
    prof = SG.MODEL["profiles"][G.PROFILE]
    warm, end = float(prof["warmUpSeconds"]), float(prof["endSeconds"])
    sim.window = (warm, end)
    phases = prof["phases"]
    # session arrivals per class and phase (Poisson), the path drawn at the start
    arrivals = []
    for i, ph in enumerate(phases):
        t0 = float(ph["from"])
        t1 = float(phases[i + 1]["from"]) if i + 1 < len(phases) else end
        rates, _ = SG.class_rates("realistic", ph["mix"], ph["volume"])
        for cls, lam in rates.items():
            if lam <= 0:
                continue
            t = t0 + rng.expovariate(lam)
            while t < t1:
                arrivals.append((t, cls))
                t += rng.expovariate(lam)
    arrivals.sort()
    reqs = []
    for t, cls in arrivals:
        steps = SG.expand(SG.MODEL["classes"][cls]["steps"], rng)
        ctx = Ctx(rng.randrange(USERS))
        for x in steps:
            if x[0] == "think":
                t += x[1]
            elif t < end:
                reqs.append((t, next(sim.seq), x[1], ctx))
    reqs.sort(key=lambda r: (r[0], r[1]))
    for t, _, key, ctx in reqs:
        sim.drain(t)
        sim.run_request(key, t, ctx)
    sim.drain(end)
    out = {}
    for site in sorted(cache_sites):
        n, h, st = sim.stats[site]
        out[site] = dict(lookups=n, hits=h, staleHits=st, hitRatio=(h / n if n else 0.0),
                         staleShare=(st / h if h else 0.0))
    return out, dict(sessions=len(arrivals), requests=len(reqs), window=[warm, end], unknownClasses=dict(sim.unknown))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--popularity", default="zipf", choices=["zipf", "uniform", "pool"])
    ap.add_argument("--zipf-s", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", default=str(G.C.path("cacheHits")))
    a = ap.parse_args()
    pops = ("zipf", "uniform", "pool") if a.all else (a.popularity,)
    res = {"about": ("Per call site that allows a cache: hit ratio and the share of stale hits of a TTL cache "
                     f"({TTL:g} s) over the session model's key streams, {Path(__file__).resolve().relative_to(P)} (DESIGN.md AB33.2). "
                     "Keys: products by popularity (zipf: Zipf(s) over the 20 000-product baseline catalog, the "
                     "default and an assumption; uniform: uniform over the catalog; pool: uniform over the load "
                     "generator's 300 seeded products), users uniform over 40 000, user-owned data per user."),
           "ttlSeconds": TTL, "zipfS": a.zipf_s, "seed": a.seed, "runs": {}}
    for pop in pops:
        sites, meta = simulate(pop, a.zipf_s, a.seed)
        res["runs"][f"{G.PROFILE}/{pop}"] = dict(meta=meta, sites=sites)
        print(f"{G.PROFILE}/{pop}: {meta}")
        for k, v in sites.items():
            print(f"  {k:80s} n={v['lookups']:7d} hit={v['hitRatio']:.3f} stale={v['staleShare']:.3f}")
    Path(a.out).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
