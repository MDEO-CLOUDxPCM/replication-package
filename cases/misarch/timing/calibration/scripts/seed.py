#!/usr/bin/env python3
"""Seed MiSArch with a realistic but small data set through the public APIs (Keycloak admin API + GraphQL gateway).

Everything goes through the same paths a real deployment uses, so all replication events fire
(user/user/created to 9 services, product/variant events to discount, inventory, review, shoppingcart,
wishlist, order, shipment, ...). Deterministic (random seed), sizes configurable.

    seed.py --out ../results/seed/state.json [--users 200 --products 300 --categories 24 ...]

Data model (defaults):
  tax rates 3 (19 %, 7 %, 0 %); shipment methods 3; 1 vendor address
  categories 24, each 1 categorical ("Brand") + 1 numerical ("Size", cm) characteristic
  products 300, 1-2 categories each, variants per product 1/2/3 with p = .5/.3/.2 (mean 1.7)
     price ~ lognormal(median 30, sigma .9) clipped [3, 900]; weight U(0.1, 5) kg; returnable 14 or 30 days
  stock: --stock items per variant (createProductItemBatch)
  discounts 8 (4 on categories, 4 on products, 5-15 %, maxUsagesPerUser 1000), 2 coupons
  buyers N ("buyer0001".., password 123, realm role buyer); 1 address (70 %) or 2 (30 %);
     default PREPAYMENT + INVOICE payment infos are created by payment on user/user/created;
     40 % additionally get a CREDIT_CARD payment info
  reviews --reviews (random buyer x random variant, rating skewed to 4-5 stars); wishlists --wishlists
  admin "gatling" / 123 with roles buyer, admin, employee (as Ceres' create-gatling-user.sh)
"""
import argparse
import asyncio
import datetime as dt
import json
import math
import os
import random
import sys
import subprocess
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mclient import (GqlError, admin_token, gather_limited, gql, kc_create_user, new_session, publish,  # noqa: E402
                     user_token)

# Ceres ran every virtual user as `gatling` with roles buyer+admin+employee; the Gatling queries need employee
# (Product.internalName), so load users get the same three roles to keep the request texts verbatim.
BUYER_ROLES = ("buyer", "admin", "employee")
CATS = ["Books", "CDs", "Vinyl", "Movies", "Games", "Electronics", "Phones", "Laptops", "Cameras", "Audio", "Kitchen",
        "Garden", "Tools", "Toys", "Sports", "Outdoor", "Fashion", "Shoes", "Beauty", "Health", "Office", "Pets", "Baby",
        "Grocery", "Music Instruments", "Automotive", "Furniture", "Lighting", "Jewelry", "Watches"]
BRANDS = ["Acme", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Hooli", "Vandelay", "Wonka", "Tyrell"]
FIRST = ["Anna", "Ben", "Clara", "David", "Eva", "Felix", "Greta", "Hannah", "Jonas", "Lea", "Max", "Mia", "Noah",
         "Paul", "Sophie", "Tim", "Lena", "Emil", "Ida", "Karl"]
LAST = ["Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann"]
CITIES = [("Stuttgart", "70569"), ("Berlin", "10115"), ("Hamburg", "20095"), ("München", "80331"), ("Köln", "50667"),
          ("Leipzig", "04109"), ("Dresden", "01067"), ("Freiburg", "79098")]


def review_variant_workaround(prods):
    """Functional defect: review subscribes catalog/product-variant/created to its generic /on-topic-event route,
    which answers 500 for that topic, so review never stores variants and createReview always fails. Data-level
    workaround (no code change): write exactly the documents the dedicated handler would write
    ({_id: variantId, product_id: productId}, UUID binary subtype 4) into review-database.product_variants."""
    docs = ",".join(f"{{_id: UUID('{v}'), product_id: UUID('{p['id']}')}}" for p in prods for v in p["variants"])
    js = f"const d=[{docs}]; let n=0; for (const x of d) {{ if (!db.product_variants.findOne({{_id: x._id}})) " \
         f"{{ db.product_variants.insertOne(x); n++; }} }}; print(n)"
    out = subprocess.run(["docker", "exec", "-i", "misarch-review-db-1", "mongosh", "--quiet", "review-database"],
                         input=js, capture_output=True, text=True)
    return out.stdout.strip().splitlines()[-1] if out.stdout.strip() else out.stderr[-300:]


def apply_sql_workarounds():
    """Schema-level workaround for the discount usage defect (see README, workarounds/discount_usage_columns.sql)."""
    sql = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "workarounds",
                            "discount_usage_columns.sql")).read()
    out = subprocess.run(["docker", "exec", "-i", "misarch-discount-db-1", "psql", "-U", "postgres", "-d", "discount"],
                         input=sql, capture_output=True, text=True)
    return out.returncode


def ack_known_defects():
    here = os.path.dirname(os.path.abspath(__file__))
    return subprocess.run([sys.executable, os.path.join(here, "redisq.py"), "ack-known"], capture_output=True,
                          text=True).stdout.strip()


def now_iso(days=0):
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Seeder:
    def __init__(self, args):
        self.a = args
        self.rng = random.Random(args.seed)
        self.state = {"created": time.strftime("%Y-%m-%dT%H:%M:%S"), "params": vars(args)}
        if args.resume and os.path.exists(args.out):
            self.state = json.load(open(args.out))
            self.state["resumed"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.errors = []
        self.calls = 0

    async def q(self, query, variables=None, token=None, tries=3):
        for i in range(tries):
            try:
                self.calls += 1
                d, _, _, _ = await gql(self.s, query, variables, token or self.admin)
                return d
            except (GqlError, asyncio.TimeoutError, OSError) as e:  # noqa: PERF203
                if i == tries - 1:
                    self.errors.append(str(e)[:300])
                    raise
                await asyncio.sleep(1 + i)

    async def wait_user_replicated(self, uid, tok, timeout=60):
        """Wait until the user is visible in user + address + payment (default payment infos created)."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                d, err, _, _ = await gql(self.s, "{ currentUser { id paymentInformations { totalCount } "
                                                 "addresses { totalCount } shoppingcart { lastUpdatedAt } wishlists { totalCount } } }",
                                         token=tok, raise_errors=False)
                cu = (d or {}).get("currentUser")
                if not err and cu and cu["paymentInformations"] and cu["paymentInformations"]["totalCount"] >= 2:
                    return True
            except Exception:
                pass
            await asyncio.sleep(1)
        return False

    async def create_user(self, username, first, last, roles):
        uid = await kc_create_user(self.s, await admin_token(self.s), username, first, last, roles=roles)
        tok = await user_token(self.s, username)
        d, err, _, _ = await gql(self.s, "{ currentUser { id } }", token=tok, raise_errors=False)
        if not (d and d.get("currentUser")):
            # not yet known to the user service: publish the creation event like create-gatling-user.sh
            await publish(self.s, "user/user/create", {"id": uid, "username": username, "firstName": first,
                                                         "lastName": last})
        ok = await self.wait_user_replicated(uid, tok)
        if not ok:
            raise RuntimeError(f"user {username} not replicated")
        return uid, tok

    async def run(self):
        a = self.a
        async with new_session(limit=64) as s:
            self.s = s
            self.atok = await admin_token(s)
            t0 = time.time()
            print("discount schema workaround applied, rc =", apply_sql_workarounds(), flush=True)
            gid, self.admin = await self.create_user("gatling", "gatling", "gatling", ("buyer", "admin", "employee"))
            self.state.setdefault("admin", {}).update({"username": "gatling", "id": gid})
            print(f"[{time.time()-t0:6.1f}s] admin user ok", flush=True)

            if "discounts" not in self.state:   # catalogue part (skipped when resuming)
                # --- tax rates, shipment methods, vendor address
                taxes = []
                for name, rate in [("VAT standard", 19.0), ("VAT reduced", 7.0), ("VAT zero", 0.0)][:a.taxrates]:
                    d = await self.q("mutation($i: CreateTaxRateInput!) { createTaxRate(input: $i) { id } }",
                                     {"i": {"name": name, "description": name, "initialVersion": {"rate": rate}}})
                    taxes.append(d["createTaxRate"]["id"])
                sms = []
                for name, b, pi, pk in [("DHL", 5, 1, 5), ("DPD", 4, 1, 6), ("Express", 12, 2, 8)][:a.shipmentmethods]:
                    d = await self.q("mutation($i: CreateShipmentMethodInput!) { createShipmentMethod(input: $i) { id } }",
                                     {"i": {"name": name, "description": f"{name} shipping", "externalReference": "",
                                            "baseFees": b, "feesPerItem": pi, "feesPerKg": pk}})
                    sms.append(d["createShipmentMethod"]["id"])
                d = await self.q("mutation($i: CreateVendorAddressInput!) { createVendorAddress(input: $i) { id } }",
                                 {"i": {"city": "Stuttgart", "companyName": "MiSArch Shop GmbH", "country": "Germany",
                                        "postalCode": "70569", "street1": "Universitaetsstrasse", "street2": "38",
                                        "name": {"firstName": "Shop", "lastName": "Owner"}}})
                self.state.update(taxRates=taxes, shipmentMethods=sms, vendorAddress=d["createVendorAddress"]["id"])
                print(f"[{time.time()-t0:6.1f}s] taxes/shipment methods/vendor ok", flush=True)

                # --- categories
                async def mk_cat(i):
                    name = CATS[i % len(CATS)] + ("" if i < len(CATS) else f" {i // len(CATS)}")
                    d = await self.q("mutation($i: CreateCategoryInput!) { createCategory(input: $i) { id "
                                     "characteristics { nodes { id name } } } }",
                                     {"i": {"name": name, "description": f"All about {name}",
                                            "categoricalCharacteristics": [{"name": "Brand", "description": "Brand"}],
                                            "numericalCharacteristics": [{"name": "Size", "description": "Size",
                                                                          "unit": "cm"}]}})
                    c = d["createCategory"]
                    ch = {n["name"]: n["id"] for n in c["characteristics"]["nodes"]}
                    return {"id": c["id"], "name": name, "brand": ch.get("Brand"), "size": ch.get("Size")}
                cats = await gather_limited(a.par, [mk_cat(i) for i in range(a.categories)])
                self.state["categories"] = cats
                print(f"[{time.time()-t0:6.1f}s] {len(cats)} categories ok", flush=True)

                # --- products + variants
                rng = self.rng
                plan = []
                for i in range(a.products):
                    pc = rng.sample(cats, 2 if rng.random() < 0.3 else 1)
                    nv = rng.choices([1, 2, 3], [0.5, 0.3, 0.2])[0]
                    base = min(900, max(3, int(round(math.exp(math.log(30) + 0.9 * rng.gauss(0, 1))))))
                    plan.append((i, pc, nv, base, rng.uniform(0.1, 5.0), rng.choice([14, 30]), rng.choice(taxes[:2])))

                def version(i, v, pc, base, weight, ret, tax):
                    return {"name": f"Product {i:04d} variant {v}", "description": f"Description of product {i} / {v}",
                            "retailPrice": max(1, int(base * (1 + 0.15 * v))), "weight": round(weight, 2),
                            "canBeReturnedForDays": ret, "taxRateId": tax, "mediaIds": [],
                            "categoricalCharacteristicValues": [{"characteristicId": c["brand"],
                                                                 "value": BRANDS[(i + v) % len(BRANDS)]} for c in pc],
                            "numericalCharacteristicValues": [{"characteristicId": c["size"],
                                                               "value": float(10 + (i * 7 + v) % 90)} for c in pc]}

                async def mk_product(p):
                    i, pc, nv, base, weight, ret, tax = p
                    d = await self.q("mutation($i: CreateProductInput!) { createProduct(input: $i) { id defaultVariant { id } } }",
                                     {"i": {"internalName": f"P{i:04d}", "isPubliclyVisible": True,
                                            "categoryIds": [c["id"] for c in pc],
                                            "defaultVariant": {"isPubliclyVisible": True,
                                                               "initialVersion": version(i, 0, pc, base, weight, ret, tax)}}})
                    pid = d["createProduct"]["id"]
                    variants = [d["createProduct"]["defaultVariant"]["id"]]
                    for v in range(1, nv):
                        d = await self.q("mutation($i: CreateProductVariantInput!) { createProductVariant(input: $i) { id } }",
                                         {"i": {"productId": pid, "isPubliclyVisible": True,
                                                "initialVersion": version(i, v, pc, base, weight, ret, tax)}})
                        variants.append(d["createProductVariant"]["id"])
                    return {"id": pid, "idx": i, "categories": [c["id"] for c in pc], "variants": variants,
                            "price": base, "taxRateId": tax, "charCats": [{"brand": c["brand"], "size": c["size"]} for c in pc]}
                prods = await gather_limited(a.par, [mk_product(p) for p in plan])
                self.state["products"] = prods
                nvar = sum(len(p["variants"]) for p in prods)
                print(f"[{time.time()-t0:6.1f}s] {len(prods)} products / {nvar} variants ok", flush=True)

                # --- stock
                async def stock(vid):
                    await self.q("mutation($i: CreateProductItemBatchInput!) { createProductItemBatch(input: $i) { id } }",
                                 {"i": {"productVariantId": vid, "number": a.stock}})
                await asyncio.sleep(3)  # let inventory receive product-variant/created
                await gather_limited(a.par, [stock(v) for p in prods for v in p["variants"]])
                print(f"[{time.time()-t0:6.1f}s] stock {a.stock}/variant ok", flush=True)

                # --- discounts + coupons
                discounts = []
                for k in range(a.discounts):
                    on_cat = k % 2 == 0
                    inp = {"discount": round(rng.choice([0.05, 0.1, 0.15]), 2), "maxUsagesPerUser": 1000,
                           "minOrderAmount": 0, "validFrom": now_iso(-1), "validUntil": now_iso(730),
                           "discountAppliesToCategoryIds": [rng.choice(cats)["id"]] if on_cat else [],
                           "discountAppliesToProductIds": [] if on_cat else [rng.choice(prods)["id"]],
                           "discountAppliesToProductVariantIds": []}
                    d = await self.q("mutation($i: CreateDiscountInput!) { createDiscount(input: $i) { id } }", {"i": inp})
                    discounts.append(d["createDiscount"]["id"])
                coupons = []
                for k in range(min(2, len(discounts))):
                    d = await self.q("mutation($i: CreateCouponInput!) { createCoupon(input: $i) { id } }",
                                     {"i": {"code": f"CAL{k}-{int(time.time()) % 1000000}", "discountId": discounts[k], "maxUsages": 100000,
                                            "validFrom": now_iso(-1), "validUntil": now_iso(730)}})
                    coupons.append(d["createCoupon"]["id"])
                self.state.update(discounts=discounts, coupons=coupons)
                print(f"[{time.time()-t0:6.1f}s] {len(discounts)} discounts, {len(coupons)} coupons ok", flush=True)

            else:
                taxes, sms, cats, prods = (self.state["taxRates"], self.state["shipmentMethods"],
                                           self.state["categories"], self.state["products"])
                rng = self.rng
                print(f"[{time.time()-t0:6.1f}s] resumed catalogue from state file", flush=True)

            # --- buyers
            existing = {b["username"]: b for b in self.state.get("buyers", [])}

            async def mk_buyer(n):
                r = random.Random(a.seed * 1000 + n)
                first, last = r.choice(FIRST), r.choice(LAST)
                uname = f"buyer{n:04d}"
                if uname in existing:          # resume: already complete
                    return existing[uname]
                uid, tok = await self.create_user(uname, first, last, BUYER_ROLES)
                addrs = []
                for k in range(2 if r.random() < 0.3 else 1):
                    city, plz = r.choice(CITIES)
                    d = await self.q("mutation($i: CreateUserAddressInput!) { createUserAddress(input: $i) { id } }",
                                     {"i": {"userId": uid, "city": city, "postalCode": plz, "country": "Germany",
                                            "street1": f"Hauptstrasse {r.randint(1, 200)}", "street2": "",
                                            "companyName": None, "name": {"firstName": first, "lastName": last}}},
                                     token=tok)
                    addrs.append(d["createUserAddress"]["id"])
                if r.random() < 0.4:
                    await self.q("mutation($i: CreateCreditCardInformationInput!) { "
                                 "createCreditCardPaymentInformation(input: $i) { id } }",
                                 {"i": {"cardHolder": f"{first} {last}", "cardNumber": "4111111111111111",
                                        "expirationDate": "12/30"}}, token=tok)
                d = await self.q("{ currentUser { paymentInformations { nodes { id paymentMethod } } } }", token=tok)
                pis = d["currentUser"]["paymentInformations"]["nodes"]
                return {"username": uname, "id": uid, "addresses": addrs, "paymentInformations": pis}
            buyers = await gather_limited(a.par, [mk_buyer(n) for n in range(1, a.users + 1)])
            self.state["buyers"] = buyers
            print(f"[{time.time()-t0:6.1f}s] {len(buyers)} buyers ok", flush=True)
            # gatling (admin) also needs an address to be usable as buyer
            if not self.state["admin"].get("addresses"):
              d = await self.q("mutation($i: CreateUserAddressInput!) { createUserAddress(input: $i) { id } }",
                             {"i": {"userId": gid, "city": "Stuttgart", "postalCode": "70569", "country": "Germany",
                                    "street1": "Universitaetsstrasse", "street2": "38",
                                    "companyName": "University of Stuttgart"}})
              self.state["admin"]["addresses"] = [d["createUserAddress"]["id"]]

            # --- reviews + wishlists (as the buyers themselves)
            toks = {}

            async def tok_for(b):
                if b["username"] not in toks:
                    toks[b["username"]] = await user_token(s, b["username"])
                return toks[b["username"]]
            allv = [v for p in prods for v in p["variants"]]
            for b in buyers:
                await tok_for(b)

            if "reviews" in self.state and "wishlistsDone" in self.state:
                print("reviews/wishlists already seeded; done", flush=True)
                self.state["seedDurationS"] = round(time.time() - t0, 1)
                return
            print(f"[{time.time()-t0:6.1f}s] review variant workaround inserted:", review_variant_workaround(prods),
                  "acked:", ack_known_defects(), flush=True)

            reviewed = set()

            async def mk_review(k):
                while True:
                    b = rng.choice(buyers)
                    v = rng.choice(allv)
                    if (b["id"], v) not in reviewed:
                        reviewed.add((b["id"], v))
                        break
                rating = rng.choices(["ONE_STARS", "TWO_STARS", "THREE_STARS", "FOUR_STARS", "FIVE_STARS"],
                                     [0.05, 0.07, 0.15, 0.33, 0.40])[0]
                await self.q("mutation($i: CreateReviewInput!) { createReview(input: $i) { id } }",
                             {"i": {"userId": b["id"], "productVariantId": v, "body": f"Review {k}: works as expected.",
                                    "rating": rating, "isVisible": True}}, token=toks[b["username"]])
            await gather_limited(a.par, [mk_review(k) for k in range(a.reviews)])
            self.state["reviews"] = sorted(reviewed)
            print(f"[{time.time()-t0:6.1f}s] {a.reviews} reviews ok", flush=True)

            async def mk_wish(k):
                b = buyers[k % len(buyers)]
                vs = rng.sample(allv, rng.randint(1, 5))
                d = await self.q("mutation($i: CreateWishlistInput!) { createWishlist(input: $i) { id } }",
                                 {"i": {"userId": b["id"], "productVariantIds": vs, "name": f"Wishlist {k}"}},
                                 token=toks[b["username"]])
                b.setdefault("wishlists", []).append(d["createWishlist"]["id"])
            await gather_limited(a.par, [mk_wish(k) for k in range(a.wishlists)])
            print(f"[{time.time()-t0:6.1f}s] {a.wishlists} wishlists ok; {self.calls} GraphQL calls, "
                  f"{len(self.errors)} retried errors", flush=True)
            self.state["wishlistsDone"] = True
            self.state["seedDurationS"] = round(time.time() - t0, 1)
            self.state["graphqlCalls"] = self.calls
            self.state["errors"] = self.errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--users", type=int, default=200)
    ap.add_argument("--products", type=int, default=300)
    ap.add_argument("--categories", type=int, default=24)
    ap.add_argument("--stock", type=int, default=60)
    ap.add_argument("--taxrates", type=int, default=3)
    ap.add_argument("--shipmentmethods", type=int, default=3)
    ap.add_argument("--discounts", type=int, default=8)
    ap.add_argument("--reviews", type=int, default=600)
    ap.add_argument("--wishlists", type=int, default=80)
    ap.add_argument("--par", type=int, default=8)
    ap.add_argument("--resume", action="store_true", help="reuse the catalogue part of an existing --out state file")
    args = ap.parse_args()
    sd = Seeder(args)
    try:
        asyncio.run(sd.run())
    finally:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            json.dump(sd.state, f, indent=1)
        print("state written to", args.out, "errors:", len(sd.errors))
        for e in sd.errors[:10]:
            print("  ", e)


if __name__ == "__main__":
    main()
