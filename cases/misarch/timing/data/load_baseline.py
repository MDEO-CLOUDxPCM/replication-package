#!/usr/bin/env python3
"""Load the timing campaign's data baseline into misarch-kotlin (README.md in this directory).

Starts from empty service databases on which the load generators' pool was created through the API (seed.py via
kseed.py, then `requests/run.py setup`). Creates the rest of profile.json:

  api        small/reference classes through the GraphQL API (events fill the copies): tax rates + versions,
             shipment methods, categories with characteristics, media uploads (RustFS objects + catalog's copy)
  catalog    bulk COPY: products, product-category links, variants, versions, characteristic values, media links,
             stock (IN_STORAGE items), and every copy: discount, inventory, order, review, shoppingcart, wishlist,
             return, shipment
  users      bulk COPY: users, addresses, payment informations, and the copies in address, discount, invoice,
             notification, order, review, shoppingcart, wishlist, shipment
  discounts  discounts and coupons through the API; coupon redemptions by bulk COPY (+ coupon usages)
  orders     bulk COPY: order history (orders, items, item discounts) and its copies in payment (payments, open
             orders), invoice, shipment (shipments, items, links), return (orders, items, shipments), inventory
             (sold items), discount (usages); returns with their return shipments
  misc       bulk COPY: reviews, wishlists, notifications, open carts
  pools      the load generators' pools that refer to baseline data (pools.json `placed`: recent delivered orders of
             the seed buyers), then `run.py prep` (returnable pool)
  finish     wait for the event queues, VACUUM (FREEZE, ANALYZE) every database
  all        everything above, in this order

    load_baseline.py all|api|catalog|users|discounts|orders|misc|pools|finish [--profile profile.json]

Run with the calibration venv (aiohttp). Every bulk stage writes TSV files to $BASELINE_TSV (default: a tsv/
directory next to this script, not committed) and COPYs them with session_replication_role=replica (no triggers, no
FK checks); check_baseline.py verifies the result. Stages are not idempotent: rerun from empty databases.
"""
import argparse
import asyncio
import datetime as dt
import json
import math
import os
import random
import subprocess
import sys
import time
import uuid
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
TIMING = os.path.dirname(HERE)
CAL = os.path.join(TIMING, "calibration")
sys.path.insert(0, os.path.join(CAL, "scripts"))
PREFIX = "misarch-kotlin-"
TSV = os.environ.get("BASELINE_TSV") or os.path.join(HERE, "tsv")
BASE = os.path.join(HERE, "baseline")
SEED_STATE = os.path.join(CAL, "results-kotlin", "seed", "state.json")
SETUP = os.path.join(TIMING, "state", "setup.json")
SERVICES = ["address", "catalog", "discount", "inventory", "invoice", "notification", "order", "payment", "return",
            "review", "shipment", "shoppingcart", "tax", "user", "wishlist"]
NOW = time.time()
DAY = 86400.0

FIRST = ["Anna", "Ben", "Clara", "David", "Eva", "Felix", "Greta", "Hannah", "Jonas", "Lea", "Max", "Mia", "Noah",
         "Paul", "Sophie", "Tim", "Lena", "Emil", "Ida", "Karl", "Luca", "Marie", "Finn", "Emma", "Leon", "Lina",
         "Elias", "Ella", "Henry", "Frieda", "Oskar", "Mila", "Theo", "Lotta", "Anton", "Nora", "Jakob", "Clara"]
LAST = ["Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann",
        "Koch", "Bauer", "Richter", "Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Zimmermann", "Braun",
        "Krüger", "Hofmann", "Hartmann", "Lange", "Schmitt", "Werner", "Krause", "Meier", "Lehmann", "Schmid"]
CITIES = [("Stuttgart", "70569"), ("Berlin", "10115"), ("Hamburg", "20095"), ("München", "80331"), ("Köln", "50667"),
          ("Leipzig", "04109"), ("Dresden", "01067"), ("Freiburg", "79098"), ("Frankfurt am Main", "60311"),
          ("Düsseldorf", "40213"), ("Hannover", "30159"), ("Nürnberg", "90402"), ("Bremen", "28195"),
          ("Essen", "45127"), ("Dortmund", "44137"), ("Bonn", "53111"), ("Mannheim", "68159"), ("Karlsruhe", "76133"),
          ("Ulm", "89073"), ("Heidelberg", "69117")]
STREETS = ["Hauptstrasse", "Bahnhofstrasse", "Schulstrasse", "Gartenstrasse", "Dorfstrasse", "Bergstrasse",
           "Lindenstrasse", "Kirchstrasse", "Waldstrasse", "Ringstrasse", "Am Markt", "Schillerstrasse",
           "Goethestrasse", "Mozartstrasse", "Wiesenweg"]
BRANDS = ["Acme", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Hooli", "Vandelay", "Wonka", "Tyrell",
          "Cyberdyne", "Soylent", "Oscorp", "Aperture", "Gringotts", "Monarch", "Nakatomi", "Massive", "Dunder", "Wernham"]
COLORS = ["black", "white", "red", "blue", "green", "grey", "yellow", "brown", "silver", "pink"]
MATERIALS = ["cotton", "wood", "steel", "aluminium", "plastic", "glass", "leather", "paper", "ceramic", "wool"]
WORDS = ["Classic", "Pro", "Eco", "Smart", "Mini", "Max", "Ultra", "Basic", "Premium", "Travel", "Home", "Outdoor",
         "Comfort", "Sport", "Studio", "Kids", "Urban", "Vintage", "Fresh", "Compact"]
CAT_TOPICS = ["Books", "CDs", "Vinyl", "Movies", "Games", "Electronics", "Phones", "Laptops", "Cameras", "Audio",
              "Kitchen", "Garden", "Tools", "Toys", "Sports", "Outdoor", "Fashion", "Shoes", "Beauty", "Health",
              "Office", "Pets", "Baby", "Grocery", "Music Instruments", "Automotive", "Furniture", "Lighting",
              "Jewelry", "Watches", "Bags", "Bikes", "Camping", "Fitness", "Crafts", "Party", "Stationery", "Drinks",
              "Coffee", "Tea", "Wine", "Software", "Printers", "Storage", "Networking", "Smart Home", "Bath",
              "Bedding", "Decor", "Cleaning"]
CAT_SUFFIX = ["", " Accessories", " Deals", " Essentials", " Premium", " Kids", " Pro", " Classics", " Outlet"]
# review's stored ratings: the GraphQL enum constants (review V3; `stars` is generated from them)
RATINGS = (["ONE_STARS", "TWO_STARS", "THREE_STARS", "FOUR_STARS", "FIVE_STARS"], [0.05, 0.07, 0.15, 0.33, 0.40])
REVIEW_TEXT = ["Works as expected.", "Great value for the money, would buy again.", "Arrived quickly, well packed.",
               "Quality is okay, but the colour differs from the picture.", "Exactly what I was looking for!",
               "Stopped working after a few weeks.", "Nice product, the size runs a little small.",
               "Good, but delivery took longer than announced."]
NOTIF = [("Your order has shipped", "Your order is on its way and will arrive in 2-3 days."),
         ("Your order was delivered", "Your parcel has been delivered. Enjoy your purchase!"),
         ("New coupons for you", "Check out this week's coupons in your account."),
         ("Price drop on your wishlist", "An item on your wishlist is now cheaper."),
         ("Rate your purchase", "Tell other customers what you think of your recent purchase."),
         ("Welcome to MiSArch", "Thanks for signing up. Have fun shopping!")]
VAT = "AB1234"


# ---------------------------------------------------------------------------------------------------- helpers
def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Rng(random.Random):
    def uid(self):
        return str(uuid.UUID(int=self.getrandbits(128), version=4))


def ts(t):
    """timestamptz literal (UTC, microseconds)."""
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f+00")


def iso_ms(t):
    """Jackson's ISO instant with milliseconds, as in the services' event payloads."""
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(t * 1000) % 1000:03d}Z"


def now_iso(days=0.0):
    return dt.datetime.fromtimestamp(NOW + days * DAY, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def esc(v):
    """COPY text format field."""
    if v is None:
        return "\\N"
    if v is True:
        return "t"
    if v is False:
        return "f"
    s = str(v)
    if "\\" in s or "\t" in s or "\n" in s or "\r" in s:
        s = s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")
    return s


def psql(svc, sql, check=True):
    db = svc if svc != "keycloak" else "postgres"
    r = subprocess.run(["docker", "exec", "-i", f"{PREFIX}{svc}-db-1", "psql", "-q", "-X", "-U", "postgres", "-d", db,
                        "-v", "ON_ERROR_STOP=1", "-tA"], input=sql, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"{svc}: {r.stderr[-800:]}")
    return r.stdout


_COLUMNS = {}


def table_columns(svc, table):
    """The columns of a table of a service database (lower case), from the live schema."""
    k = (svc, table)
    if k not in _COLUMNS:
        _COLUMNS[k] = set(psql(svc, "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' "
                                    f"AND table_name = '{table.lower()}'").split())
        if not _COLUMNS[k]:
            raise RuntimeError(f"{svc}: no table {table}")
    return _COLUMNS[k]


def rows(svc, sql):
    """Query result as tuples of strings (None for NULL), via COPY ... TO STDOUT."""
    out = psql(svc, f"COPY ({sql}) TO STDOUT")
    res = []
    for line in out.splitlines():
        res.append(tuple(None if f == "\\N" else f for f in line.split("\t")))
    return res


class Tsv:
    """Per-table TSV writers of one stage; load() COPYs them (parallel across services).

    A column named `?col` is written only if the table has it (the link tables' surrogate `id`, dropped by later
    migrations: the loader works on either schema; its value is still generated, so the random stream, and with it
    the rest of the data, stays the same). Any other column the table lacks is an error before anything is written."""

    def __init__(self, stage):
        self.dir = os.path.join(TSV, stage)
        os.makedirs(self.dir, exist_ok=True)
        for f in os.listdir(self.dir):
            os.remove(os.path.join(self.dir, f))
        self.files, self.cols, self.keep, self.n = {}, {}, {}, defaultdict(int)

    def w(self, svc, table, cols, *vals):
        k = (svc, table)
        f = self.files.get(k)
        if f is None:
            have = table_columns(svc, table)
            missing = [c for c in cols if not c.startswith("?") and c not in have]
            if missing:
                raise RuntimeError(f"{svc}.{table} has no column(s) {missing} (columns: {sorted(have)})")
            self.keep[k] = [i for i, c in enumerate(cols) if c.lstrip("?") in have]
            f = self.files[k] = open(os.path.join(self.dir, f"{svc}.{table}.tsv"), "w", buffering=1 << 20)
            self.cols[k] = cols
        assert self.cols[k] == cols, f"{k}: column lists differ"
        f.write("\t".join(esc(vals[i]) for i in self.keep[k]) + "\n")
        self.n[k] += 1

    def close(self):
        for f in self.files.values():
            f.close()

    def load(self, par=8):
        self.close()
        by_svc = defaultdict(list)
        for k in self.files:
            by_svc[k[0]].append(k)
        t0 = time.time()

        def load_svc(svc):
            for k in by_svc[svc]:
                path = os.path.join(self.dir, f"{svc}.{k[1]}.tsv")
                with open(path) as f:
                    r = subprocess.run(["docker", "exec", "-i", "-e", "PGOPTIONS=-c session_replication_role=replica",
                                        f"{PREFIX}{svc}-db-1", "psql", "-q", "-X", "-U", "postgres", "-d", svc, "-v",
                                        "ON_ERROR_STOP=1", "-c",
                                        f"COPY {k[1]} ({','.join(self.cols[k][i].lstrip('?') for i in self.keep[k])}) "
                                        "FROM STDIN"],
                                       stdin=f, capture_output=True, text=True)
                if r.returncode:
                    raise RuntimeError(f"COPY {svc}.{k[1]}: {r.stderr[-800:]}")
            return svc
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(par) as ex:
            list(ex.map(load_svc, list(by_svc)))
        tot = sum(self.n.values())
        log(f"  COPY {tot:,} rows into {len(self.files)} tables in {time.time() - t0:.0f}s:",
            ", ".join(f"{s}.{t}={n:,}" for (s, t), n in sorted(self.n.items())))
        return dict((f"{s}.{t}", n) for (s, t), n in self.n.items())


def load_json(p, default=None):
    try:
        return json.load(open(p))
    except Exception:
        return default


def save_api(api):
    json.dump(api, open(os.path.join(BASE, "api.json"), "w"), indent=1)


def record(stage, info):
    p = os.path.join(BASE, "load-log.json")
    d = load_json(p, {})
    d[stage] = info
    json.dump(d, open(p, "w"), indent=1)


def count(svc, table, where=""):
    return int(psql(svc, f"SELECT count(*) FROM {table} {where}").strip())


def wait_for(desc, fn, target, timeout=900):
    t0 = time.time()
    while True:
        v = fn()
        if v >= target:
            log(f"  {desc}: {v} (after {time.time() - t0:.0f}s)")
            return v
        if time.time() - t0 > timeout:
            raise RuntimeError(f"{desc}: {v} < {target} after {timeout}s")
        time.sleep(3)


# ---------------------------------------------------------------------------------------------------- API helpers
async def gql(s, q, v, tok):
    import mclient
    for i in range(5):
        try:
            d, err, _, _ = await mclient.gql(s, q, v, tok, raise_errors=False)
            if err:
                raise RuntimeError(str(err)[:300])
            return d
        except Exception as e:  # noqa: PERF203
            if i == 4:
                raise
            log("  retry:", str(e)[:200])
            await asyncio.sleep(1 + i)


async def gather_limited(n, coros):
    sem = asyncio.Semaphore(n)

    async def run(c):
        async with sem:
            return await c
    return await asyncio.gather(*(run(c) for c in coros))


# ---------------------------------------------------------------------------------------------------- stage: api
TAX_EXTRA = [("VAT standard (AT)", "Austrian standard rate", 20.0, [18.0, 20.0]),
             ("VAT reduced (AT)", "Austrian reduced rate", 10.0, [12.0, 10.0]),
             ("VAT super-reduced", "Super-reduced rate", 5.0, [7.0, 5.0])]
TAX_SEED_HISTORY = {19.0: [16.0, 19.0], 7.0: [5.0, 7.0], 0.0: [0.0, 0.0]}
SM_EXTRA = [("UPS Standard", 6, 1, 5), ("UPS Express", 14, 2, 8), ("GLS", 4, 1, 5), ("Hermes", 4, 1, 4),
            ("DHL Express", 15, 2, 9), ("DHL Packstation", 4, 1, 5), ("DPD Express", 12, 2, 7), ("FedEx", 16, 2, 9),
            ("Deutsche Post Warenpost", 3, 0, 3), ("Spedition", 39, 0, 2), ("Same Day Courier", 19, 3, 6),
            ("Click & Collect", 0, 0, 0)]


async def stage_api(P):
    import aiohttp
    import mclient
    st = json.load(open(SEED_STATE))
    api = load_json(os.path.join(BASE, "api.json"), {})
    t0 = time.time()
    async with mclient.new_session(limit=64) as s:
        tok = await mclient.user_token(s, "gatling")
        # tax rates: 3 more (6), each with ~3 versions; the last version keeps today's rate (prices unchanged)
        if "taxRates" not in api:
            ids = []
            for name, desc, rate, hist in TAX_EXTRA[:max(0, P["taxRates"]["count"] - len(st["taxRates"]))]:
                d = await gql(s, "mutation($i: CreateTaxRateInput!) { createTaxRate(input: $i) { id } }",
                              {"i": {"name": name, "description": desc, "initialVersion": {"rate": rate}}}, tok)
                ids.append((d["createTaxRate"]["id"], hist))
            for tid, rate in zip(st["taxRates"], (19.0, 7.0, 0.0)):
                ids.append((tid, TAX_SEED_HISTORY[rate]))
            nv = P["taxRates"]["versionsPerRate"] - 1
            for tid, hist in ids:
                for r in hist[-nv:] if nv > 0 else []:
                    await gql(s, "mutation($i: CreateTaxRateVersionInput!) { createTaxRateVersion(input: $i) { id } }",
                              {"i": {"taxRateId": tid, "rate": r}}, tok)
            api["taxRates"] = [t for t, _ in ids]
            save_api(api)
            log(f"  tax rates: {len(ids)} ({nv} extra versions each)")
        if "shipmentMethods" not in api:
            ids = []
            for name, b, pi, pk in SM_EXTRA[:max(0, P["shipmentMethods"] - len(st["shipmentMethods"]))]:
                d = await gql(s, "mutation($i: CreateShipmentMethodInput!) { createShipmentMethod(input: $i) { id } }",
                              {"i": {"name": name, "description": f"{name} shipping", "externalReference": name.upper()[:8],
                                     "baseFees": b, "feesPerItem": pi, "feesPerKg": pk}}, tok)
                ids.append(d["createShipmentMethod"]["id"])
            api["shipmentMethods"] = ids
            save_api(api)
            log(f"  shipment methods: +{len(ids)}")
        if "categories" not in api:
            have = count("catalog", "categoryentity")
            n = max(0, P["categories"]["count"] - have)
            names = [t + suf for suf in CAT_SUFFIX for t in CAT_TOPICS]
            used = {r[0] for r in rows("catalog", "SELECT name FROM categoryentity")}
            names = [x for x in names if x not in used][:n]
            nchar = P["categories"]["characteristicsPerCategory"]
            cats = [{"name": "Brand", "description": "Brand"}, {"name": "Colour", "description": "Colour"},
                    {"name": "Material", "description": "Material"}]
            nums = [{"name": "Size", "description": "Size", "unit": "cm"},
                    {"name": "Weight", "description": "Net weight", "unit": "kg"}]
            ncat = min(len(cats), (nchar + 1) // 2)

            async def mk(name):
                d = await gql(s, "mutation($i: CreateCategoryInput!) { createCategory(input: $i) { id } }",
                              {"i": {"name": name, "description": f"All about {name}",
                                     "categoricalCharacteristics": cats[:ncat],
                                     "numericalCharacteristics": nums[:nchar - ncat]}}, tok)
                return d["createCategory"]["id"]
            api["categories"] = await gather_limited(8, [mk(x) for x in names])
            save_api(api)
            log(f"  categories: +{len(api['categories'])}")
        if "media" not in api:
            n = max(0, P["products"]["count"] - count("catalog", "productentity")) * P["mediaPerProduct"]
            png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                                "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")
            rng = Rng(P["seed"] + 7)

            async def up(k):
                fd = aiohttp.FormData()
                fd.add_field("operations", json.dumps({"query": "mutation($file: Upload!) { uploadMedia(mediaFile: $file) }",
                                                       "variables": {"file": None}}))
                fd.add_field("map", json.dumps({"0": ["variables.file"]}))
                fd.add_field("0", png + rng.randbytes(rng.randint(2000, 12000)), filename=f"product{k}.png",
                             content_type="image/png")
                h = {"Authorization": "Bearer " + tok, "Apollo-Require-Preflight": "true"}
                for i in range(5):
                    try:
                        async with s.post(mclient.GATEWAY, data=fd, headers=h) as r:
                            js = await r.json(content_type=None)
                        if js.get("data") and js["data"].get("uploadMedia"):
                            return js["data"]["uploadMedia"]
                        raise RuntimeError(str(js)[:200])
                    except Exception as e:  # noqa: PERF203
                        if i == 4:
                            raise
                        await asyncio.sleep(1 + i)
                        fd = aiohttp.FormData()
                        fd.add_field("operations", json.dumps({"query": "mutation($file: Upload!) { uploadMedia(mediaFile: $file) }",
                                                               "variables": {"file": None}}))
                        fd.add_field("map", json.dumps({"0": ["variables.file"]}))
                        fd.add_field("0", png, filename=f"product{k}.png", content_type="image/png")
                        log("  media retry", k, str(e)[:100])
            media = []
            for i in range(0, n, 2000):
                media += await gather_limited(24, [up(k) for k in range(i, min(n, i + 2000))])
                if (i // 2000) % 5 == 4:
                    log(f"  media {len(media)}/{n}")
            api["media"] = media
            save_api(api)
            log(f"  media: +{len(media)}")
    # the copies (events): catalog.taxrateentity, order.taxrateentity/shipmentmethodentity, discount.categoryentity,
    # catalog.mediaentity
    wait_for("catalog.mediaentity", lambda: count("catalog", "mediaentity"), len(api["media"]))
    wait_for("discount.categoryentity", lambda: count("discount", "categoryentity"), count("catalog", "categoryentity"))
    wait_for("order.shipmentmethodentity", lambda: count("order", "shipmentmethodentity"),
             count("shipment", "shipmentmethodentity"))
    wait_for("catalog.taxrateentity", lambda: count("catalog", "taxrateentity"), count("tax", "taxrateentity"))
    cur = {r[0] for r in rows("tax", "SELECT currentversionid FROM taxrateentity")}
    wait_for("order.taxrateentity current", lambda: len(cur & {r[0] for r in rows("order", "SELECT currentversionid FROM taxrateentity")}),
             len(cur))
    record("api", {"durationS": round(time.time() - t0), "taxRates": len(api["taxRates"]),
                   "shipmentMethodsAdded": len(api["shipmentMethods"]), "categoriesAdded": len(api["categories"]),
                   "media": len(api["media"])})


# ---------------------------------------------------------------------------------------------------- stage: catalog
def char_values(rng, chars, i, v):
    """chars: [(charId, discriminator, name)] of the product's categories -> value rows (discr, str, double)."""
    out = []
    for cid, disc, name in chars:
        if disc == "CATEGORICAL":
            pool = COLORS if name == "Colour" else MATERIALS if name == "Material" else BRANDS
            out.append((cid, disc, pool[(i * 7 + v * 3 + len(name)) % len(pool)], None))
        else:
            val = float(10 + (i * 7 + v) % 90) if name != "Weight" else round(0.1 + ((i * 13 + v) % 500) / 100, 2)
            out.append((cid, disc, None, val))
    return out


def stage_catalog(P):
    t0 = time.time()
    rng = Rng(P["seed"] + 1)
    api = json.load(open(os.path.join(BASE, "api.json")))
    su = load_json(SETUP, {})
    sink = su.get("sinkCategory")
    st = json.load(open(SEED_STATE))
    seed_cats = {c["id"] for c in st["categories"]}
    cats = [r[0] for r in rows("catalog", "SELECT id FROM categoryentity") if r[0] != sink]
    chars = defaultdict(list)
    for cid, disc, name, cat in rows("catalog", "SELECT id, discriminator, name, categoryid FROM categorycharacteristicentity"):
        chars[cat].append((cid, disc, name))
    taxes = [r[0] for r in rows("tax", "SELECT id FROM taxrateentity ORDER BY name")]
    tax_named = {r[1]: r[0] for r in rows("tax", "SELECT id, name FROM taxrateentity")}
    tax_w = [(tax_named.get("VAT standard"), 0.62), (tax_named.get("VAT reduced"), 0.2), (tax_named.get("VAT zero"), 0.03),
             (tax_named.get("VAT standard (AT)"), 0.1), (tax_named.get("VAT reduced (AT)"), 0.04),
             (tax_named.get("VAT super-reduced"), 0.01)]
    tax_w = [(t, w) for t, w in tax_w if t] or [(t, 1) for t in taxes]
    tax_ids, tax_ws = [t for t, _ in tax_w], [w for _, w in tax_w]
    media = list(api["media"])
    n = max(0, P["products"]["count"] - count("catalog", "productentity"))
    pp = P["products"]
    vk = sorted(pp["variantsPerProduct"])
    vw = [pp["variantsPerProduct"][k] for k in vk]
    stock = P["stockPerVariant"]
    T = Tsv("catalog")
    nvar = nver = 0
    PV = ["id", "name", "description", "version", "retailprice", "createdat", "canbereturnedfordays",
          "productvariantid", "taxrateid", "weight"]
    for i in range(n):
        pid = rng.uid()
        # categories: the 275 new ones mostly; seed categories (the pool's) get a share as in a real shop
        k = 2 if rng.random() < pp["pTwoCategories"] else 1
        pc = rng.sample(cats, k)
        nv = int(rng.choices(vk, vw)[0])
        base = min(pp["priceMax"], max(pp["priceMin"], int(round(math.exp(math.log(pp["priceMedian"]) +
                                                                         pp["priceSigma"] * rng.gauss(0, 1))))))
        weight = round(rng.uniform(0.1, 5.0), 2)
        ret = rng.choice([14, 30])
        tax = rng.choices(tax_ids, tax_ws)[0]
        t_created = NOW - rng.uniform(400, 1000) * DAY
        word = rng.choice(WORDS)
        brand = rng.choice(BRANDS)
        pchars = [c for cat in pc for c in chars.get(cat, [])]
        vids = []
        for v in range(nv):
            vid = rng.uid()
            vids.append(vid)
            vers = []
            nvers = pp["versionsPerVariant"]
            for ver in range(1, nvers + 1):
                vers.append(rng.uid())
            cur = vers[-1]
            T.w("catalog", "productvariantentity", ["id", "ispubliclyvisible", "productid", "currentversion"],
                vid, True, pid, cur)
            t_v = t_created + v * rng.uniform(0, 30) * DAY
            price = None
            for ver, verid in enumerate(vers, 1):
                price = max(1, int(round(base * (1 + 0.15 * v) * rng.uniform(0.85, 1.15))))
                created = t_v if ver == 1 else min(NOW - 2 * DAY, t_v + rng.uniform(20, 380) * DAY)
                t_v = created
                T.w("catalog", "productvariantversionentity", PV, verid, f"{brand} {word} {i:05d} variant {v}",
                    f"{word} product {i} by {brand}, variant {v}", ver, price, ts(created), ret, vid, tax, weight)
                for cid, disc, sv, dv in char_values(rng, pchars, i, v):
                    T.w("catalog", "categorycharacteristicvalueentity",
                        ["id", "discriminator", "stringvalue", "doublevalue", "categorycharacteristicid",
                         "productvariantversionid"], rng.uid(), disc, sv, dv, cid, verid)
                if v == 0 and media and P["mediaPerProduct"] > 0:
                    T.w("catalog", "productvariantversiontomediaentity", ["?id", "productvariantversionid", "mediaid"],
                        rng.uid(), verid, media[i % len(media)])
                T.w("return", "productvariantversionentity", ["id", "canbereturnedfordays"], verid, ret)
                T.w("shipment", "productvariantversionentity", ["id", "weight"], verid, weight)
                nver += 1
            T.w("order", "productvariantentity", ["id", "currentversionid", "currentversionprice",
                                                  "currentversiontaxrateid", "ispubliclyvisible"],
                vid, cur, price, tax, True)
            T.w("discount", "productvariantentity", ["id", "productid"], vid, pid)
            T.w("review", "productvariantentity", ["id", "productid"], vid, pid)
            T.w("inventory", "productvariantentity", ["id"], vid)
            T.w("shoppingcart", "productvariantentity", ["id"], vid)
            T.w("wishlist", "productvariantentity", ["id"], vid)
            for _ in range(stock):
                T.w("inventory", "productitementity", ["id", "productvariantid", "inventorystatus"], rng.uid(), vid,
                    "IN_STORAGE")
            nvar += 1
        T.w("catalog", "productentity", ["id", "internalname", "ispubliclyvisible", "defaultvariantid"],
            pid, f"B{i:05d}", True, vids[0])
        T.w("discount", "productentity", ["id"], pid)
        T.w("review", "productentity", ["id"], pid)
        for cat in pc:
            T.w("catalog", "producttocategoryentity", ["?id", "productid", "categoryid"], rng.uid(), pid, cat)
            T.w("discount", "producttocategoryentity", ["?id", "productid", "categoryid"], rng.uid(), pid, cat)
    log(f"  generated {n} products, {nvar} variants, {nver} versions in {time.time() - t0:.0f}s")
    rowsn = T.load()
    record("catalog", {"durationS": round(time.time() - t0), "products": n, "variants": nvar, "versions": nver,
                       "rows": rowsn, "seedCategoriesShare": round(sum(1 for c in cats if c in seed_cats) / len(cats), 3)})


# ---------------------------------------------------------------------------------------------------- stage: users
def stage_users(P):
    t0 = time.time()
    rng = Rng(P["seed"] + 2)
    have = count("user", "userentity")
    n = max(0, P["users"]["count"] - have)
    ver = int(psql("address", "SELECT coalesce(max(version), 0) FROM addressentity").strip())
    T = Tsv("users")
    na = npi = 0
    acols = ["id", "street1", "street2", "city", "postalcode", "country", "companyname", "userid", "archivedat", "version",
             "firstname", "lastname"]
    for i in range(n):
        uid = rng.uid()
        first, last = rng.choice(FIRST), rng.choice(LAST)
        joined = NOW - rng.uniform(30, 1100) * DAY
        T.w("user", "userentity", ["id", "username", "firstname", "lastname", "datejoined"],
            uid, f"user{i + 1:06d}", first, last, ts(joined))
        for svc, tab in (("address", "userentity"), ("discount", "userentity"), ("notification", "userentity"),
                         ("review", "userentity"), ("wishlist", "userentity")):
            T.w(svc, tab, ["id"], uid)
        T.w("shoppingcart", "userentity", ["id", "shoppingcartlastupdatedat"], uid, ts(joined + 1))
        T.w("invoice", "userentity", ["id", "firstname", "lastname"], uid, first, last)
        r = rng.random()
        nad = 1 if r < 0.75 else 2 if r < 0.95 else 3
        aids = []
        for _ in range(nad):
            aid = rng.uid()
            aids.append(aid)
            city, plz = rng.choice(CITIES)
            street = f"{rng.choice(STREETS)} {rng.randint(1, 250)}"
            ver += 1
            T.w("address", "addressentity", acols, aid, street, "", city, plz, "Germany", None, uid, None, ver, first, last)
            T.w("invoice", "useraddressentity", ["id", "userid", "street1", "street2", "city", "postalcode", "country",
                                                 "companyname", "firstname", "lastname", "isarchived"],
                aid, uid, street, "", city, plz, "Germany", None, first, last, False)
            T.w("shipment", "addressentity", ["id", "userid", "street1", "street2", "city", "postalcode", "country",
                                              "companyname", "version"], aid, uid, street, "", city, plz, "Germany", None, ver)
            na += 1
        T.w("order", "userentity", ["id"], uid)
        for aid in aids:
            T.w("order", "useraddressentity", ["userid", "id"], uid, aid)
        picols = ["id", "paymentmethod", "publicmethoddetails", "secretmethoddetails", "userid"]
        T.w("payment", "paymentinformationentity", picols, rng.uid(), "PREPAYMENT", None, None, uid)
        T.w("payment", "paymentinformationentity", picols, rng.uid(), "INVOICE", None, None, uid)
        npi += 2
        if rng.random() < P["users"]["creditCardShare"]:
            num = f"4{rng.randrange(10 ** 14, 10 ** 15)}"
            exp = f"{rng.randint(1, 12):02d}/{rng.randint(27, 31)}"
            pub = json.dumps({"cardHolder": f"{first} {last}", "cardNumber": "*" * 12 + num[-4:], "expirationDate": exp},
                             ensure_ascii=False)
            sec = json.dumps({"cardHolder": f"{first} {last}", "cardNumber": num, "expirationDate": exp}, ensure_ascii=False)
            T.w("payment", "paymentinformationentity", picols, rng.uid(), "CREDIT_CARD", pub, sec, uid)
            npi += 1
    log(f"  generated {n} users, {na} addresses, {npi} payment informations in {time.time() - t0:.0f}s")
    rowsn = T.load()
    psql("address", f"SELECT setval('addressentity_version_seq', {ver});")
    record("users", {"durationS": round(time.time() - t0), "users": n, "addresses": na, "paymentInformations": npi,
                     "rows": rowsn})


# ---------------------------------------------------------------------------------------------------- stage: discounts
async def stage_discounts(P):
    import mclient
    t0 = time.time()
    rng = Rng(P["seed"] + 3)
    api = json.load(open(os.path.join(BASE, "api.json")))
    D = P["discounts"]
    have = count("discount", "discountentity")
    su = load_json(SETUP, {})
    # the profile's discounts exclude the requests' sink discount (it only exists for createDiscount/createCoupon)
    n = max(0, D["count"] - (have - (1 if su.get("sinkDiscount") else 0)))
    new_cats = list(api["categories"])
    bulk_products = [r[0] for r in rows("catalog", "SELECT id FROM productentity WHERE internalname LIKE 'B%'")]
    if "discounts" not in api:
        ids = []
        async with mclient.new_session(limit=32) as s:
            tok = await mclient.user_token(s, "gatling")
            ncat = int(round(n * D["onCategoriesShare"]))
            for k in range(n):
                on_cat = k < ncat
                inp = {"discount": rng.choice([0.05, 0.1, 0.1, 0.15, 0.2]), "maxUsagesPerUser": 1000, "minOrderAmount": 0,
                       "validFrom": now_iso(-400), "validUntil": now_iso(730),
                       "discountAppliesToCategoryIds": [rng.choice(new_cats)] if on_cat else [],
                       "discountAppliesToProductIds": [] if on_cat else rng.sample(bulk_products, rng.randint(1, 3)),
                       "discountAppliesToProductVariantIds": []}
                d = await gql(s, "mutation($i: CreateDiscountInput!) { createDiscount(input: $i) { id } }", {"i": inp}, tok)
                ids.append(d["createDiscount"]["id"])
            api["discounts"] = ids
            save_api(api)
            log(f"  discounts: +{len(ids)}")
            # coupons: on the first `couponBound` new discounts (they then apply only with a redeemed coupon)
            bound = ids[:D["couponBound"]]
            nc = max(0, P["coupons"]["count"] - count("discount", "couponentity"))

            async def mk(k):
                code = f"SHOP{k:04d}{rng.getrandbits(24):06x}".upper()
                d = await gql(s, "mutation($i: CreateCouponInput!) { createCoupon(input: $i) { id } }",
                              {"i": {"code": code, "discountId": bound[k % len(bound)], "maxUsages": 100000,
                                     "validFrom": now_iso(-400), "validUntil": now_iso(730)}}, tok)
                return d["createCoupon"]["id"]
            api["coupons"] = await gather_limited(8, [mk(k) for k in range(nc)]) if bound else []
            save_api(api)
            log(f"  coupons: +{len(api['coupons'])}")
    wait_for("order.couponentity", lambda: count("order", "couponentity"), count("discount", "couponentity"))
    # redemptions of the new coupons by bulk users (registerCoupon's trigger would count usages; COPY skips triggers)
    T = Tsv("discounts")
    users = [r[0] for r in rows("user", "SELECT id FROM userentity WHERE username LIKE 'user%'")]
    red = defaultdict(int)
    for c in api["coupons"]:
        k = min(len(users), max(0, int(rng.gauss(P["coupons"]["redemptionsPerCoupon"], 6))))
        for u in rng.sample(users, k):
            T.w("discount", "couponredemptionentity", ["?id", "couponid", "userid"], rng.uid(), c, u)
            red[c] += 1
    rowsn = T.load()
    if red:
        vals = ",".join(f"('{c}',{n})" for c, n in red.items())
        psql("discount", f"UPDATE couponentity c SET usages = c.usages + v.n FROM (VALUES {vals}) v(id, n) "
                         f"WHERE c.id = v.id::uuid;")
    record("discounts", {"durationS": round(time.time() - t0), "discountsAdded": len(api["discounts"]),
                         "couponsAdded": len(api["coupons"]), "rows": rowsn})


# ---------------------------------------------------------------------------------------------------- stage: orders
INVOICE_TMPL = """
# Invoice

### Company information:
{vcompany}
{vstreet1}, {vstreet2}
{vcity}, {vcountry}

VAT number: {vat}

### Customer information:
ID: {uid}
Name: {first}, {last}
Address:

{street1}, {street2}
{city}, {country}

### Invoice ID: {iid}, issued at: {issued}

Terms and conditions: This invoice is created according the the companies terms and conditions specified on the website.

---

Purchased items overview:

| Item UUID | Product variant UUID | count | Compensatable amount |
| --- | --- | --- | --- |
{items}

---

Total compensatable amount: {total}
"""


def stage_orders(P):
    t0 = time.time()
    rng = Rng(P["seed"] + 4)
    O = P["orders"]
    st = json.load(open(SEED_STATE))
    su = load_json(SETUP, {})
    fo_vars = {v for g in su.get("foVariants", {}).values() for v in g}
    # --- read the current state
    users = rows("user", "SELECT id, username, firstname, lastname FROM userentity")
    uinfo = {u[0]: u for u in users}
    addr = defaultdict(list)
    adata = {}
    for a in rows("address", "SELECT id, userid, street1, coalesce(street2, ''), city, postalcode, country, companyname "
                             "FROM addressentity WHERE archivedat IS NULL"):
        adata[a[0]] = a
        if a[1]:
            addr[a[1]].append(a[0])
    vendor = adata[st["vendorAddress"]]
    pinfo = defaultdict(dict)
    for pid, meth, uid in rows("payment", "SELECT id, paymentmethod, userid FROM paymentinformationentity"):
        pinfo[uid].setdefault(meth, pid)
    vers = defaultdict(list)
    for pv, ver, price, created, weight, ret, tax in rows(
            "catalog", "SELECT productvariantid, id, retailprice, extract(epoch from createdat), weight, "
                       "coalesce(canbereturnedfordays, 14), taxrateid FROM productvariantversionentity ORDER BY version"):
        vers[pv].append((ver, int(price), float(created), float(weight or 0), int(ret), tax))
    variants = [(v, p) for v, p in rows("catalog", "SELECT id, productid FROM productvariantentity") if v not in fo_vars]
    rng.shuffle(variants)
    pcats = defaultdict(set)
    for p, c in rows("catalog", "SELECT productid, categoryid FROM producttocategoryentity"):
        pcats[p].add(c)
    taxv = {t: (v, float(r), int(n)) for t, v, r, n in rows("tax", "SELECT t.id, v.id, v.rate, v.version FROM taxrateentity t "
                                                                    "JOIN taxrateversionentity v ON v.id = t.currentversionid")}
    sms = [(i, int(b), int(pi), int(pk)) for i, b, pi, pk in rows(
        "shipment", "SELECT id, basefees, feesperitem, feesperkg FROM shipmentmethodentity WHERE archivedat IS NULL")]
    sm_w = [5 if s[0] in st["shipmentMethods"] else 1 for s in sms]
    # automatic discounts (no coupon): by product and by category, with their validity start
    coupon_d = {r[0] for r in rows("discount", "SELECT DISTINCT discountid FROM couponentity")}
    dval = {d: (float(x), float(vf), float(vu)) for d, x, vf, vu in rows(
        "discount", "SELECT id, discount, extract(epoch from validfrom), extract(epoch from validuntil) FROM discountentity")}
    d_prod, d_cat = defaultdict(list), defaultdict(list)
    for d, p in rows("discount", "SELECT discountid, productid FROM discounttoproductentity"):
        if d not in coupon_d:
            d_prod[p].append(d)
    for d, c in rows("discount", "SELECT discountid, categoryid FROM discounttocategoryentity"):
        if d not in coupon_d:
            d_cat[c].append(d)
    log(f"  read state: {len(users)} users, {len(variants)} variants, {len(sms)} shipment methods, "
        f"{len(dval) - len(coupon_d)} automatic discounts ({time.time() - t0:.0f}s)")
    # --- who orders: N orders over all users (multinomial = Poisson(perUser) per user); every seed buyer gets one
    # recent delivered order (pools: orderTracking, createReturn)
    seed_buyers = {b["id"] for b in st["buyers"]}
    uids = [u[0] for u in users if addr.get(u[0]) and pinfo.get(u[0])]
    N = int(round(O["perUser"] * P["users"]["count"]))
    plan = [(u, True) for u in sorted(seed_buyers) if u in uinfo]
    plan += [(uids[rng.randrange(len(uids))], False) for _ in range(N - len(plan))]
    rng.shuffle(plan)
    T = Tsv("orders")
    OCOLS = ["id", "userid", "createdat", "orderstatus", "placedat", "rejectionreason", "shipmentaddressid",
             "invoiceaddressid", "compensatableorderamount", "paymentinformationid", "vatnumber"]
    ICOLS = ["id", "orderid", "position", "createdat", "productvariantid", "productvariantispubliclyvisible",
             "productvariantversionid", "productvariantversionprice", "productvariantversiontaxrateid",
             "taxrateversionid", "taxrateversionrate", "taxrateversionversion", "shoppingcartitemid", "count",
             "compensatableamount", "shipmentmethodid"]
    usage = defaultdict(int)
    placed_pool = []
    stats = defaultdict(int)
    nv = len(variants)
    for uid, recent in plan:
        u = uinfo[uid]
        oid = rng.uid()
        created = NOW - (rng.uniform(1, O["recentDaysForPool"]) if recent else rng.uniform(1, O["historyDays"])) * DAY
        pending = (not recent) and rng.random() < O["pendingShare"]
        r = rng.random()
        k = 1 if r < 0.8 else 2 if r < 0.95 else 3
        sm = sms[rng.choices(range(len(sms)), sm_w)[0]]
        aid = rng.choice(addr[uid])
        pis = pinfo[uid]
        meth = "CREDIT_CARD" if "CREDIT_CARD" in pis and rng.random() < 0.5 else rng.choice(["PREPAYMENT", "INVOICE"])
        pi = pis.get(meth) or next(iter(pis.values()))
        items, chosen = [], set()
        for pos in range(k):
            for _ in range(10):
                vid, pid = variants[int(nv * rng.random() ** 1.6)]
                if vid not in chosen:
                    break
            chosen.add(vid)
            vl = vers[vid]
            ver = vl[0]
            for x in vl:
                if x[2] <= created:
                    ver = x
            cnt = rng.randint(O["quantity"][0], O["quantity"][1])
            ds = [d for d in set(d_prod.get(pid, []) + [d for c in pcats.get(pid, ()) for d in d_cat.get(c, [])])
                  if dval[d][1] <= created <= dval[d][2]]
            amount = ver[1] * cnt
            for d in ds:
                amount = int(round(amount * (1 - dval[d][0])))
            tv = taxv[ver[5]]
            items.append(dict(id=rng.uid(), pos=pos, vid=vid, ver=ver, cnt=cnt, amount=amount, ds=ds, tv=tv, tax=ver[5]))
        fee = sm[1] + sm[2] * sum(i["cnt"] for i in items) + int(round(sm[3] * sum(i["ver"][3] * i["cnt"] for i in items)))
        total = sum(i["amount"] for i in items) + fee
        placed = None if pending else created + rng.uniform(5, 600)
        T.w("order", "orderentity", OCOLS, oid, uid, ts(created), "PENDING" if pending else "PLACED",
            ts(placed) if placed else None, None, aid, aid, total, pi, VAT)
        for it in items:
            T.w("order", "orderitementity", ICOLS, it["id"], oid, it["pos"], ts(created), it["vid"], True, it["ver"][0],
                it["ver"][1], it["tax"], it["tv"][0], it["tv"][1], it["tv"][2], rng.uid(), it["cnt"], it["amount"], sm[0])
            for d in it["ds"]:
                T.w("order", "orderitemtodiscountentity", ["orderitemid", "discountid", "discount"], it["id"], d, dval[d][0])
        stats["orders"] += 1
        stats["items"] += len(items)
        if pending:
            stats["pending"] += 1
            continue
        for it in items:
            for d in it["ds"]:
                usage[(d, uid)] += it["cnt"]
        # payment (succeeded) + the saga's order copy
        pay = rng.uid()
        payed = placed + rng.uniform(1, 30)
        T.w("payment", "paymententity", ["id", "totalamount", "status", "paymentinformationid", "payedat",
                                         "numberofretries", "createdat", "updatedat"], pay, total, "SUCCEEDED", pi, ts(payed), 0, ts(placed),
            ts(payed))
        oj = {"id": oid, "userId": uid, "placedAt": iso_ms(placed), "createdAt": iso_ms(created), "vatNumber": VAT,
              "orderItems": [{"id": it["id"], "count": it["cnt"], "createdAt": iso_ms(created), "discountIds": it["ds"],
                              "productVariantId": it["vid"], "shipmentMethodId": sm[0], "taxRateVersionId": it["tv"][0],
                              "shoppingCartItemId": rng.uid(), "compensatableAmount": it["amount"],
                              "productVariantVersionId": it["ver"][0]} for it in items],
              "orderStatus": "PLACED", "invoiceAddressId": aid, "shipmentAddressId": aid,
              "paymentInformationId": pi, "compensatableOrderAmount": total}
        if meth == "CREDIT_CARD":
            oj["paymentAuthorization"] = {"cvc": 123}
        T.w("payment", "openorderentity", ["paymentid", "orderdata", "orderid"], pay, json.dumps(oj), oid)
        # invoice
        a = adata[aid]
        iid = rng.uid()
        issued = placed + rng.uniform(0.05, 2)
        content = INVOICE_TMPL.format(
            vcompany=vendor[7] or "", vstreet1=vendor[2], vstreet2=vendor[3], vcity=vendor[4], vcountry=vendor[6], vat=VAT,
            uid=uid, first=u[2], last=u[3], street1=a[2], street2=a[3], city=a[4], country=a[6], iid=iid,
            issued=dt.datetime.fromtimestamp(issued, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            items="\n".join(f"| {it['id']} | {it['vid']} | {it['cnt']} | {it['amount']} |" for it in items), total=total)
        T.w("invoice", "invoiceentity", ["id", "orderid", "issuedat", "content", "useraddressid", "vendoraddressid",
                                         "vatnumber"], iid, oid, ts(issued), content, aid, vendor[0], VAT)
        # shipment (one per order: all items share the shipment method), delivered or failed (items lost)
        shid = rng.uid()
        failed = (not recent) and rng.random() < O["failedShipmentShare"]
        delivered = None if failed else payed + rng.uniform(1, 4) * DAY
        if delivered and delivered > NOW - 3600:
            delivered = NOW - rng.uniform(3600, 2 * 3600)
        SHCOLS = ["id", "status", "shipmentmethodid", "shipmentaddressid", "orderid", "returnid"]
        T.w("shipment", "shipmententity", SHCOLS, shid, "FAILED" if failed else "DELIVERED", sm[0], aid, oid, None)
        T.w("return", "orderentity", ["id", "userid"], oid, uid)
        T.w("return", "shipmententity", ["id", "deliveredat"], shid, ts(delivered) if delivered else None)
        returned = (not failed) and (not recent) and rng.random() < O["returnShare"]
        rid = rng.uid() if returned else None
        for it in items:
            T.w("shipment", "orderitementity", ["id", "sentwithid", "quantity", "productvariantversionid"],
                it["id"], shid, it["cnt"], it["ver"][0])
            T.w("shipment", "shipmenttoorderitementity", ["?id", "shipmentid", "orderitemid"], rng.uid(), shid, it["id"])
            T.w("return", "orderitementity", ["id", "returnedwithid", "sentwithid", "orderid", "compensatableamount",
                                              "productvariantversionid"], it["id"], rid, shid, oid, it["amount"], it["ver"][0])
            for _ in range(it["cnt"]):
                T.w("inventory", "productitementity", ["id", "productvariantid", "inventorystatus", "orderid"],
                    rng.uid(), it["vid"], "LOST" if failed else "DELIVERED", oid)
        stats["failedShipments"] += failed
        if returned:
            rt = min(NOW - 3600, delivered + rng.uniform(1, 12) * DAY)
            T.w("return", "returnentity", ["id", "reason", "orderid", "refundedamount", "createdat"],
                rid, rng.choice(["Does not fit", "Damaged on arrival", "Changed my mind", "Wrong item delivered",
                                 "Quality not as expected"]), oid, sum(it["amount"] for it in items), ts(rt))
            rsh = rng.uid()
            T.w("shipment", "shipmententity", SHCOLS, rsh, "DELIVERED", sm[0], vendor[0], None, rid)
            for it in items:
                T.w("shipment", "shipmenttoorderitementity", ["?id", "shipmentid", "orderitemid"], rng.uid(), rsh, it["id"])
            stats["returns"] += 1
        if recent:
            placed_pool.append([u[1], oid])
    for (d, uid), n in usage.items():
        T.w("discount", "discountusageentity", ["id", "discountid", "userid", "usages"], rng.uid(), d, uid, n)
    log(f"  generated {dict(stats)} in {time.time() - t0:.0f}s")
    rowsn = T.load()
    json.dump(placed_pool, open(os.path.join(BASE, "placed-pool.json"), "w"))
    record("orders", {"durationS": round(time.time() - t0), **stats, "discountUsages": len(usage),
                      "seedBuyerRecentOrders": len(placed_pool), "rows": rowsn})


# ---------------------------------------------------------------------------------------------------- stage: misc
def stage_misc(P):
    t0 = time.time()
    rng = Rng(P["seed"] + 5)
    allu = rows("user", "SELECT id, username, extract(epoch from datejoined) FROM userentity")
    bulk = [(u, float(j)) for u, n, j in allu if n.startswith("user")]
    variants = [(v, p) for v, p in rows("catalog", "SELECT id, productid FROM productvariantentity pv WHERE EXISTS "
                                                   "(SELECT 1 FROM productentity p WHERE p.id = pv.productid AND "
                                                   "p.internalname LIKE 'B%')")]
    rng.shuffle(variants)
    nv = len(variants)
    T = Tsv("misc")
    # reviews (bulk users; unique per user and variant; popular variants get more)
    nrev = max(0, P["reviews"] - count("review", "reviewentity"))
    seen = set()
    rv_cols = ["id", "userid", "productvariantid", "productid", "body", "rating", "createdat", "lastupdatedat",
               "isvisible"]
    while len(seen) < nrev:
        u, j = bulk[rng.randrange(len(bulk))]
        v, p = variants[int(nv * rng.random() ** 1.6)]
        if (u, v) in seen:
            continue
        seen.add((u, v))
        t = rng.uniform(max(j, NOW - 700 * DAY), NOW - DAY)
        T.w("review", "reviewentity", rv_cols, rng.uid(), u, v, p, rng.choice(REVIEW_TEXT), rng.choices(*RATINGS)[0], ts(t), ts(t),
            True)
    # wishlists
    nwl = max(0, P["wishlists"]["count"] - count("wishlist", "wishlistentity"))
    m = P["wishlists"]["entriesMean"]
    for k in range(nwl):
        u, j = bulk[rng.randrange(len(bulk))]
        ne = max(1, min(30, int(round(rng.gauss(m, 3)))))
        vs = list({variants[int(nv * rng.random() ** 1.3)][0] for _ in range(ne)})
        t = rng.uniform(max(j, NOW - 700 * DAY), NOW - DAY)
        t2 = rng.uniform(t, NOW - 3600)
        wid = rng.uid()
        T.w("wishlist", "wishlistentity", ["id", "userid", "name", "createdat", "lastupdatedat"],
            wid, u, rng.choice(["Wishlist", "Birthday", "Christmas", "Later", "Gift ideas", "Home"]) + f" {k % 7 + 1}",
            ts(t), ts(t2))
        for v in vs:
            T.w("wishlist", "wishlisttoproductvariantentity", ["wishlistid", "productvariantid"], wid, v)
    # notifications: Poisson(mean) per user, all users
    lam = P["notificationsPerUser"]
    nn = 0
    for u, _, j in allu:
        L, kk, p = math.exp(-lam), 0, 1.0
        while True:
            p *= rng.random()
            if p <= L:
                break
            kk += 1
        for _ in range(kk):
            title, body = rng.choice(NOTIF)
            t = rng.uniform(max(float(j), NOW - 365 * DAY), NOW - 600)
            T.w("notification", "notificationentity", ["id", "datesent", "dateread", "title", "body", "userid"],
                rng.uid(), ts(t), ts(t + rng.uniform(60, 5 * DAY)) if rng.random() < 0.6 else None, title, body, u)
            nn += 1
    # open carts (bulk users only: the pool's carts stay the generators' own)
    C = P["openCarts"]
    cart_users = rng.sample(bulk, min(len(bulk), C["users"]))
    nl = 0
    upd = []
    for u, _ in cart_users:
        k = max(1, min(6, int(round(rng.gauss(C["linesMean"], 1)))))
        vs = {variants[int(nv * rng.random() ** 1.6)][0] for _ in range(k)}
        last = 0
        for v in vs:
            t = NOW - rng.uniform(600, 20 * DAY)
            last = max(last, t)
            T.w("shoppingcart", "shoppingcartitementity", ["id", "userid", "count", "addedat", "productvariantid"],
                rng.uid(), u, rng.choice([1, 1, 1, 2, 3]), ts(t), v)
            nl += 1
        upd.append((u, last))
    rowsn = T.load()
    if upd:
        psql("shoppingcart", "CREATE TEMP TABLE cu (id uuid, t timestamptz);\n"
                             "COPY cu FROM STDIN;\n" + "\n".join(f"{u}\t{ts(t)}" for u, t in upd) + "\n\\.\n"
                             "UPDATE userentity e SET shoppingcartlastupdatedat = cu.t FROM cu WHERE e.id = cu.id;")
    record("misc", {"durationS": round(time.time() - t0), "reviews": len(seen), "wishlists": nwl, "notifications": nn,
                    "cartUsers": len(cart_users), "cartLines": nl, "rows": rowsn})


# ---------------------------------------------------------------------------------------------------- stage: pools
def stage_pools(P):
    """pools.json `placed` = the seed buyers' recent delivered orders; then run.py prep (returnable + reviewed)."""
    pools_path = os.path.join(CAL, "results-kotlin", "pools.json")
    pools = load_json(pools_path, {}) or {}
    placed = json.load(open(os.path.join(BASE, "placed-pool.json")))
    pools.update({"carts": {}, "created": [], "placed": placed, "usedCartItems": pools.get("usedCartItems", [])})
    pools.setdefault("reviewed", [])
    json.dump(pools, open(pools_path, "w"))
    py = os.path.join(CAL, ".venv", "bin", "python")
    r = subprocess.run([py, os.path.join(TIMING, "requests", "run.py"), "prep", "--n", "400"], capture_output=True,
                       text=True, env={**os.environ, "MISARCH_STACK": "kotlin"})
    log("  run.py prep:", r.stdout.strip()[-300:], r.stderr.strip()[-300:])
    record("pools", {"placed": len(placed), "prep": r.stdout.strip()[-300:]})


# ---------------------------------------------------------------------------------------------------- stage: finish
def stage_finish(P):
    t0 = time.time()
    py = os.path.join(CAL, ".venv", "bin", "python")
    env = {**os.environ, "MISARCH_STACK": "kotlin"}
    for i in range(60):
        out = subprocess.run([py, os.path.join(CAL, "scripts", "redisq.py"), "pending"], capture_output=True, text=True,
                             env=env).stdout.strip()
        if out in ("{}", ""):
            break
        time.sleep(5)
    log("  redis pending:", out)
    log("  redis trim:", subprocess.run([py, os.path.join(CAL, "scripts", "redisq.py"), "trim"], capture_output=True,
                                        text=True, env=env).stdout.strip()[-200:])
    from concurrent.futures import ThreadPoolExecutor

    def vac(svc):
        # PARALLEL 0: a parallel index vacuum allocates its dead-tuple store in /dev/shm (64 MB in the containers);
        # with the full profile inventory needs more ("could not resize shared memory segment")
        psql(svc, "VACUUM (FREEZE, ANALYZE, PARALLEL 0);")
        return svc
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(vac, SERVICES))
    log(f"  VACUUM (FREEZE, ANALYZE) done in {time.time() - t0:.0f}s")
    record("finish", {"durationS": round(time.time() - t0), "pending": out})


STAGES = ["api", "catalog", "users", "discounts", "orders", "misc", "pools", "finish"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=STAGES + ["all"])
    ap.add_argument("--profile", default=os.path.join(HERE, "profile.json"))
    a = ap.parse_args()
    P = json.load(open(a.profile))
    os.makedirs(BASE, exist_ok=True)
    for st in (STAGES if a.stage == "all" else [a.stage]):
        t0 = time.time()
        log(f"stage {st}")
        fn = globals()[f"stage_{st}"]
        if asyncio.iscoroutinefunction(fn):
            asyncio.run(fn(P))
        else:
            fn(P)
        log(f"stage {st} done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
