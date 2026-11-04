"""Unit tests of the pure parts of the timing analyses (stdlib unittest; no stack needed).

    python3 -m unittest discover -s timing/analysis/tests -v
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import common  # noqa: E402
import parts  # noqa: E402
import profile_buckets  # noqa: E402
import queries  # noqa: E402

FIX = os.path.join(HERE, "fixtures")


class SqlParsing(unittest.TestCase):
    def check(self, sql, kind, tables, writes=(), lock=False):
        p = queries.parse_sql(sql)
        self.assertEqual(p["kind"], kind, sql)
        self.assertEqual(p["tables"], list(tables), sql)
        self.assertEqual(p["writes"], list(writes), sql)
        self.assertEqual(p["lock"], lock, sql)

    def test_select_join_and_quotes(self):
        self.check('SELECT o.* FROM "OrderEntity" o JOIN OrderItemEntity i ON i.orderId = o.id WHERE o.id = $1',
                   "read", ["orderentity", "orderitementity"])

    def test_spring_data_r2dbc_insert(self):
        self.check('INSERT INTO ShoppingCartItemEntity (id, count, shoppingCartId) VALUES ($1, $2, $3)',
                   "write", ["shoppingcartitementity"], ["shoppingcartitementity"])

    def test_upsert_do_update_is_one_write(self):
        self.check("INSERT INTO UserEntity (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id",
                   "write", ["userentity"], ["userentity"])

    def test_for_update_skip_locked_is_locking_read(self):
        self.check("SELECT * FROM ProductItemEntity WHERE productVariantId = $1 AND inventoryStatus = $2 "
                   "LIMIT $3 FOR UPDATE SKIP LOCKED", "read", ["productitementity"], lock=True)

    def test_update_and_delete(self):
        self.check("UPDATE ProductItemEntity SET inventoryStatus = $1 WHERE id = ANY($2)", "write",
                   ["productitementity"], ["productitementity"])
        self.check("DELETE FROM ShoppingCartItemEntity WHERE id = $1", "write",
                   ["shoppingcartitementity"], ["shoppingcartitementity"])

    def test_cte_names_are_not_tables(self):
        self.check("WITH picked AS (SELECT id FROM ProductItemEntity LIMIT $1) UPDATE ProductItemEntity p SET "
                   "orderId = $2 FROM picked WHERE p.id = picked.id", "write", ["productitementity"],
                   ["productitementity"])

    def test_extract_from_and_comma_join(self):
        self.check("SELECT a.x FROM A a, B b WHERE extract(epoch from a.t) > $1", "read", ["a", "b"])

    def test_schema_and_template_suffix(self):
        self.check("SELECT COUNT(*) FROM public.ProductItemEntity$where", "read", ["productitementity"])

    def test_statement_op(self):
        for sql, op in (("SELECT COUNT(t.id) FROM a t WHERE t.p = $1", "count"), ("SELECT 1 FROM a WHERE id = $1", "exists"),
                        ("SELECT * FROM a WHERE id IN ($1)", "select"), ("SELECT * FROM a FOR UPDATE SKIP LOCKED", "lock"),
                        ("INSERT INTO a (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", "upsert"),
                        ("UPDATE a SET x = $1", "update"), ("DELETE FROM a WHERE id = $1", "delete")):
            self.assertEqual(queries.parse_sql(sql)["op"], op, sql)

    def test_tx_statements(self):
        for s in ("BEGIN", "COMMIT", "ROLLBACK", "SET LOCAL statement_timeout = 0"):
            self.assertEqual(queries.parse_sql(s)["kind"], "tx", s)

    def test_skeleton_matches_named_and_positional_params(self):
        a = queries.skeleton("SELECT * FROM AddressEntity WHERE userId = :userId LIMIT 1")
        b = queries.skeleton("SELECT * FROM AddressEntity WHERE userId = $1 LIMIT $2")
        self.assertEqual(a, b)


class AlphaBetaFit(unittest.TestCase):
    def test_exact_recovery(self):
        pts = [(c, r, 0.4 * c + 0.02 * r) for c, r in [(1, 10), (2, 1), (5, 40), (3, 3)]]
        a, b, res = parts.fit_alpha_beta(pts)
        self.assertAlmostEqual(a, 0.4, places=6)
        self.assertAlmostEqual(b, 0.02, places=6)
        self.assertTrue(all(abs(x) < 1e-9 for x in res))

    def test_negative_beta_is_clamped(self):
        # rows make P smaller in the data: the unconstrained beta is negative -> beta = 0, alpha alone
        pts = [(1, 0, 1.0), (2, 10, 1.9), (3, 20, 2.8)]
        a, b, _ = parts.fit_alpha_beta(pts)
        self.assertEqual(b, 0.0)
        self.assertGreater(a, 0)

    def test_negative_alpha_is_clamped(self):
        pts = [(1, 10, 0.5), (2, 10, 0.45), (1, 20, 1.0)]
        a, b, _ = parts.fit_alpha_beta(pts)
        self.assertGreaterEqual(a, 0.0)
        self.assertGreaterEqual(b, 0.0)

    def test_collinear_points(self):
        pts = [(1, 2, 1.0), (2, 4, 2.0)]
        a, b, res = parts.fit_alpha_beta(pts)
        self.assertGreaterEqual(min(a, b), 0.0)
        self.assertTrue(all(abs(x) < 1e-6 for x in res))

    def test_no_data(self):
        self.assertEqual(parts.fit_alpha_beta([(0, 0, 1.0)])[:2], (0.0, 0.0))

    def test_effective_shares_spread_overhead(self):
        acc, mw, own = parts.effective_shares({"db-driver": 0.2, "mapping": 0.1, "dapr-client": 0.1, "graphql": 0.2,
                                               "resolver": 0.1, "gc+jit": 0.2, "unmatched": 0.1})
        self.assertAlmostEqual(acc + mw + own, 1.0)
        self.assertAlmostEqual(acc, 0.3 / 0.7)


class AccessCpuFit(unittest.TestCase):
    """Real data (block 3): one alpha left most residuals above 20 %; writes cost 2-4x a read statement."""

    def test_nnls_exact_and_clamped(self):
        X = [[1, 0], [0, 1], [1, 1], [2, 1]]
        self.assertEqual([round(v, 6) for v in parts.nnls(X, [0.5 * a + 0.2 * b for a, b in X])], [0.5, 0.2])
        c = parts.nnls([[1, 1], [2, 1], [3, 1]], [1.0, 0.9, 0.8])      # unconstrained slope < 0
        self.assertGreaterEqual(min(c), 0.0)

    def test_read_write_alphas_recovered(self):
        pts = [(cr, cw, r, 0.15 * cr + 0.5 * cw + 0.01 * r)
               for cr, cw, r in [(3, 0, 12), (1, 1, 2), (2, 3, 5), (5, 0, 40), (0, 2, 2), (4, 1, 8)]]
        f, res = parts.fit_access_cpu(pts)
        self.assertAlmostEqual(f["alphaRead"], 0.15, places=5)
        self.assertAlmostEqual(f["alphaWrite"], 0.5, places=5)
        self.assertAlmostEqual(f["beta"], 0.01, places=5)
        self.assertTrue(all(abs(x) < 1e-6 for x in res))

    def test_few_points_tie_the_alphas(self):
        f, res = parts.fit_access_cpu([(1, 1, 2, 1.0), (2, 0, 2, 0.8)])
        self.assertEqual(f["alphaRead"], f["alphaWrite"])
        self.assertIn("few points", f["model"])
        self.assertEqual(len(res), 2)

    def test_relative_weighting(self):
        # one large and several small points: relative weights keep the small ones near their values
        pts = [(1, 0, 0, 0.2), (2, 0, 0, 0.4), (1, 0, 0, 0.2), (10, 0, 0, 6.0)]
        f, res = parts.fit_access_cpu(pts)
        self.assertLess(abs(res[0]), 0.2)

    def test_access_weight_by_mode(self):
        f = {"alphaRead": 0.1, "alphaWrite": 0.4, "beta": 0.01}
        self.assertAlmostEqual(parts.access_weight(f, "write", 2, 10), 0.9)
        self.assertAlmostEqual(parts.access_weight(f, "read", 2, 10), 0.3)


class OverheadAndSplits(unittest.TestCase):
    def test_container_roles(self):
        for c, r in (("catalog", "app"), ("catalog-db", "db"), ("catalog-dapr", "dapr"), ("order-ecs", "ecs"),
                     ("gateway", "other"), ("zipkin-all-in-one", "other"), ("placement", "other"),
                     ("experiment-config", "other"), ("simulation", "app")):
            self.assertEqual(parts.container_role(c), r, c)

    def test_overhead_pooled_and_role_fallback(self):
        off = {"a": {"D": {"x": 2.0, "x-db": 1.0, "y": 4.0}}, "b": {"D": {"x": 8.0, "x-db": 1.0}}}
        on = {"a": {"D": {"x": 2.4, "x-db": 1.2, "y": 3.0}}, "b": {"D": {"x": 9.6, "x-db": 1.3}},
              "c": {"D": {"z": 5.0, "z-db": 2.0}}}
        r, info, r_role, r_all = parts.overhead_ratios(off, on)
        self.assertAlmostEqual(r["x"], 10.0 / 12.0)                 # pooled, 2 pairs
        self.assertEqual(info["y"]["n"], 1)
        self.assertAlmostEqual(r["y"], r_role["app"], places=3)      # one pair only -> app role median
        self.assertAlmostEqual(r["z"], r_role["app"], places=3)      # on-only container
        self.assertAlmostEqual(r["z-db"], r_role["db"], places=3)
        self.assertAlmostEqual(info["x"]["overheadPooled"], 0.2, places=3)

    def test_split_own_entry_then_leftover(self):
        out = parts.split_own(10.0, ["a", "b", "c"], {"a": 10}, 100, {"a": 1.0, "b": 1.0})
        self.assertAlmostEqual(out["a"], 1.0 + 4.5)                  # 10 % direct + half the leftover
        self.assertAlmostEqual(out["b"], 4.5)
        self.assertAlmostEqual(out["c"], 0.0)
        self.assertAlmostEqual(sum(out.values()), 10.0)

    def test_fetcher_weights_keep_handlers(self):
        w, how = parts.fetcher_weights(["q1", "q2", "h"], {"q1": "f1", "q2": "f2", "h": None}, {"f1": 3.0, "f2": 1.0})
        self.assertAlmostEqual(w["h"], 1.0)                          # event handler: its equal share
        self.assertAlmostEqual(w["q1"] + w["q2"], 2.0)
        self.assertAlmostEqual(w["q1"] / w["q2"], 3.0)
        w, _ = parts.fetcher_weights(["q1", "h"], {"q1": "f1", "h": None}, {"f1": 3.0})
        self.assertEqual(w, {"q1": 1.0, "h": 1.0})

    def test_share_weights(self):
        self.assertEqual(parts.share_weights(["a", "b"], {"a": 1.0, "b": 0.0}), {"a": 1.0, "b": 0.0})
        self.assertEqual(parts.share_weights(["a", "b"], {}), {"a": 0.5, "b": 0.5})
        self.assertEqual(parts.share_weights(["a", "b"], {"a": 0.0, "b": 0.0}), {"a": 0.5, "b": 0.5})


class DomainPaths(unittest.TestCase):
    def test_stub_callbacks_are_follow_ups_of_place_order(self):
        mp = queries.Mapping()
        ops = dict(mp.request_ops("placeOrder"))
        self.assertEqual(ops.get("payment.http:/payment/update-payment-status"), "callback")
        self.assertEqual(ops.get("shipment.http:/shipment/{id}/status"), "callback")
        self.assertEqual(mp.stub_callbacks("catalog.something"), [])

    def test_reach_probabilities(self):
        mp = queries.Mapping()
        pr = mp.reach_probs("placeOrder")
        self.assertEqual(pr["order.placeOrder"], 1.0)
        self.assertLess(pr["inventory.on:payment/payment/payment-failed"], 0.05)   # only via the stub's callback
        self.assertGreater(pr["inventory.on:order/order/created"], 0.9)

    def test_pg_catalog_and_background_statements(self):
        self.assertTrue(all(t.startswith("pg_") for t in queries.parse_sql(
            "SELECT oid, * FROM pg_catalog.pg_type WHERE typname IN ($1,$2)")["tables"]))
        self.assertLess(queries.BACKGROUND_CALLS_PER_REQ, 0.02)


class AtLoadAndFactorial(unittest.TestCase):
    def test_slope_rule(self):
        import atload
        xs = [20, 40, 60]
        us = [0.1 + 0.002 * x for x in xs]
        ps = [0.004 * x for x in xs]
        k, how, u0, d, dp, r2 = atload.scale(xs, us, ps)
        self.assertEqual(how, "slope")
        self.assertAlmostEqual(k, 0.5)
        k, how, *_ = atload.scale(xs[:2], us[:2], ps[:2], idle=0.1)      # two levels: ratio rule
        self.assertEqual(how, "ratio top-2 levels")
        self.assertAlmostEqual(k, 0.5)

    def test_cpu_limits_parse(self):
        import json
        import tempfile
        import atload
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "containers.json"), "w") as fh:
                json.dump({"containers": {"misarch-kotlin-catalog-1": {"cpu.max": "50000 100000"},
                                          "misarch-kotlin-catalog-db-1": {"cpu.max": "max 100000"}}}, fh)
            self.assertEqual(atload.cpu_limits(d), {"misarch-kotlin-catalog-1": 0.5})

    def test_factorial_design_recovery(self):
        import factorial
        cells = ["i1q1c0INVs60", "i1q1c1PREs60", "i1q1c0CCs60", "i1q3c1INVs60", "i1q3c0PREs60", "i1q3c1CCs60",
                 "i3q1c0INVs60", "i3q1c1PREs60", "i3q1c0CCs60", "i3q3c1INVs60", "i3q3c0PREs60", "i3q3c1CCs60",
                 "i1q1c0INVs600", "i3q3c0INVs600"]
        truth = [10.0, 4.0, 0.5, 2.0, 1.0, 3.0, 0.0]
        X = [factorial.design_row(factorial.cell_params(c)) for c in cells]
        y = [sum(a * b for a, b in zip(truth, x)) for x in X]
        coef, sd, se = factorial.ols(X, y)
        for a, b in zip(coef, truth):
            self.assertAlmostEqual(a, b, places=6)
        self.assertIsNone(factorial.cell_params("i1q1"))


class Buckets(unittest.TestCase):
    def test_rules_file_parses(self):
        y = common.load_yaml(profile_buckets.RULES)
        names = [b["name"] for b in y["buckets"]]
        for n in ("db-driver", "mapping", "dapr-client", "graphql", "resolver", "serialisation", "http", "jit", "gc"):
            self.assertIn(n, names)
        self.assertTrue(all(isinstance(p, str) for b in y["buckets"] for p in b["frames"]))

    def test_classification_of_fixture(self):
        cl = profile_buckets.Classifier()
        b, unm = profile_buckets.classify_file(cl, os.path.join(FIX, "sample.collapsed"), top=5)
        self.assertEqual(b["http"], 5)            # bare event loop (weak netty)
        self.assertEqual(b["resolver"], 7)        # JDK leaf under a resolver
        self.assertEqual(b["mapping"], 4)         # Kotlin reflection under Spring Data mapping
        self.assertEqual(b["db-driver"], 6)       # Netty buffer under the R2DBC client
        self.assertEqual(b["serialisation"], 3)
        self.assertEqual(b["jit"], 9)             # C2 compiler thread (apart from GC)
        self.assertEqual(b["gc"], 4)              # G1 worker thread
        self.assertEqual(b["dapr-client"], 2)     # Netty write under the WebClient
        self.assertEqual(b["instrumentation"], 2)
        self.assertEqual(b["unmatched"], 2)       # [unknown_Java], a JDK-only timer thread

    def test_real_profile_unmatched_below_5_percent(self):
        f = os.path.join(FIX, "catalog_graphql_jdk25.collapsed.gz")
        if not os.path.exists(f):
            self.skipTest("no real profile fixture")
        b, _ = profile_buckets.classify_file(profile_buckets.Classifier(), f)
        self.assertLess(b["unmatched"] / sum(b.values()), 0.05)


class SmokeFixtures(unittest.TestCase):
    """Samples of a smoke run (timing images, product request, 60 s steady at 5/s)."""

    def test_smoke_profile_unmatched_below_5_percent(self):
        b, _ = profile_buckets.classify_file(profile_buckets.Classifier(),
                                             os.path.join(FIX, "smoke_product_catalog.collapsed.gz"))
        self.assertLess(b["unmatched"] / sum(b.values()), 0.05)
        self.assertGreater(b["db-driver"] + b["mapping"], 0)

    def test_smoke_statements_map_to_classes_and_operations(self):
        import gzip
        import json
        # the smoke run's statements belong to the code before the unification: map them with that code's domain
        mp = queries.Mapping(dom=json.load(gzip.open(os.path.join(FIX, "domain_201e2e7.json.gz"))))
        ops = mp.request_ops("product")
        dump = json.load(open(os.path.join(FIX, "smoke_pgstat_product.json")))
        seen = set()
        for c, v in dump.items():
            for r in v["rows"]:
                p = queries.parse_sql(r["query"])
                if p["kind"] == "tx" or not p["tables"]:
                    continue
                cls, how, cands = mp.classify(r["datname"], p["tables"][0], p["kind"], ops, p["op"])
                self.assertEqual(how, "access", r["query"])
                seen.add((r["datname"], cls))
        self.assertEqual(seen, {("catalog", "Product"), ("catalog", "ProductVariant"), ("catalog", "Category"),
                                ("review", "Review"), ("review", "ProductVariant")})


class YamlReader(unittest.TestCase):
    def test_nested(self):
        p = os.path.join(FIX, "mini.yaml")
        with open(p, "w") as f:
            f.write("a: 1\nb:\n  - name: x\n    frames:\n      - \"p::q\"\n      - ~r\n  - name: y\n    k: 'v'\n")
        self.assertEqual(common.load_yaml(p), {"a": 1, "b": [{"name": "x", "frames": ["p::q", "~r"]},
                                                             {"name": "y", "k": "v"}]})
        os.remove(p)


class Analysis(unittest.TestCase):
    """Speed regime, cardinality term, mechanisms, rate sensitivity, volumes, own split."""

    def test_gateway_speed_factor(self):
        import speed
        self.assertEqual(speed.gateway_factor(None, 5.0), 1.0)
        self.assertEqual(speed.gateway_factor(75.0, 10.0), 1.0)          # fast: never below 1
        self.assertAlmostEqual(speed.gateway_factor(129.0, 10.0), 1.7)   # (129 - 10) / 70
        self.assertEqual(speed.regime(28.0), "fast")
        self.assertEqual(speed.regime(35.0), "slow")
        self.assertIsNone(speed.regime(None))

    def test_factorial_robust_fit_downweights_a_disturbed_cell(self):
        import factorial
        true = {"b0": 70.0, "item": 4.0, "unit": 0.0, "coupon": 2.0, "PRE": 1.0, "CC": 3.0, "s600": 0.0}
        noise = [0.3, -0.2, 0.1, -0.4, 0.2, 0.0, -0.1, 0.4, -0.3, 0.1, 0.2, -0.2, 0.3, -0.1, 0.0, 0.2]
        cells = {}
        for i, cell in enumerate(["i1q1c0INVs60", "i1q1c1PREs60", "i1q1c0CCs60", "i1q3c1INVs60", "i1q3c0PREs60",
                                  "i1q3c1CCs60", "i3q1c0INVs60", "i3q1c1PREs60", "i3q1c0CCs60", "i3q3c1INVs60",
                                  "i3q3c0PREs60", "i3q3c1CCs60", "i1q1c0INVs600", "i3q3c0INVs600", "i1q1c1INVs60",
                                  "i3q1c1INVs60"]):
            p = factorial.cell_params(cell)
            y = sum(c * x for c, x in zip(true.values(), factorial.design_row(p))) + noise[i]
            if cell == "i1q3c0PREs60":
                y *= 1.9                                       # one cell hit by a host-side disturbance
            cells[cell] = {"params": p, "speed": 1.0, "cpuPerOrderMs": {"order": y}, "db": {},
                           "latencyP50": {"createOrder": 1.0, "placeOrder": 1.0},
                           "reservation": {"execMsPerCall": 0.1}}
        raw = factorial.fit_all(cells)["cpu:order"]["coef"]
        rob = factorial.fit_all(cells, robust=True)["cpu:order"]["coef"]
        self.assertGreater(abs(raw["PRE"] - 1.0), 10.0)
        self.assertAlmostEqual(rob["PRE"], 1.0, delta=1.0)
        self.assertAlmostEqual(rob["item"], 4.0, delta=0.5)

    def test_scheduled_mask(self):
        sys.path.insert(0, common.CAL_SCRIPTS)
        import cpuan
        # 2026-10-31 14:45:00 UTC is a quarter hour: a 2-s burst of 500 ms/s on 10 ms/s
        t0 = 1793457900 - 30
        ts = [float(t0 + i) for i in range(61)]
        inc = [10_000 if not (30 <= i < 32) else 510_000 for i in range(60)]
        us = [0]
        for x in inc:
            us.append(us[-1] + x)
        inst = cpuan.cron_instants("0 */15 * * * *", ts[0], ts[-1])
        self.assertEqual(inst, [1793457900])
        cum, n, removed = cpuan.mask_instants(ts, us, inst, 3)
        self.assertEqual(n, 1)
        self.assertEqual(removed, 1_000_000)
        self.assertEqual(cum[-1], 60 * 10_000)

    def test_scheduled_guard(self):
        """With loadgen's holds no firing falls into a measured phase, whatever the start time; a session
        plan holds only before its first phase."""
        sys.path.insert(0, common.CAL_SCRIPTS)
        import cronjobs
        cron = ["0 */15 * * * *"]
        seg = lambda s: [{"name": f"{s}:pre", "duration": 15}, {"name": f"{s}:warm", "duration": 20},  # noqa: E731
                         {"name": f"{s}:steady", "duration": 75}, {"name": f"{s}:drain", "duration": 15}]
        req = {"phases": [{"name": "idle", "duration": 60}] + [p for s in "abcdefghijkl" for p in seg(s)]
               + [{"name": "idle_end", "duration": 30}]}
        ses = {"kind": "sessions", "phases": [{"name": f"L{x}:{k}", "duration": d} for x in (1, 2, 3, 4, 5, 6)
                                              for k, d in (("trans", 40), ("steady", 150))]}
        for plan in (req, ses):
            p = cronjobs.guard_plan(plan, cron, 2, 6)
            sessions = p.get("kind") == "sessions"
            for off in range(0, 900, 7):
                t, tl, holds = 1793457900.0 + off + 0.3, [], 0
                for i, ph in enumerate(p["phases"]):
                    while h := cronjobs.clear_hold(ph, t):
                        t, holds = t + h, holds + 1
                        self.assertTrue(i == 0 or not sessions)
                    tl.append((ph["name"], t, t + ph["duration"]))
                    t += ph["duration"]
                fire = cronjobs.cron_instants(cron[0], tl[0][1] - 60, t + 60)
                for n, a, b in tl:
                    k = n.rpartition(":")[2]
                    if (k == "steady") if sessions else (k in cronjobs.GUARDED or n in ("idle", "idle_end")):
                        self.assertFalse([f for f in fire if a - 6 < f < b + 2], (off, n))

    def test_cardinality_delta(self):
        import atload
        fits = {"cpu:inventory": {"coef": {"item": 1.4, "unit": -0.3, "coupon": 0.1, "PRE": 0.0, "CC": 0.0, "s600": 0.0},
                                  "se": {"item": 0.4, "unit": 0.2, "coupon": 0.7, "PRE": 0.8, "CC": 0.8, "s600": 1.0}},
                "cpu:apps": {"coef": {"item": 9.0}, "se": {"item": 1.0}}}
        d = atload.cardinality_delta(fits, {"inventory": 0.9})
        # only the item term is significant (and in the default terms): 1.4 x (0.25 - 0) x r_c 0.9
        self.assertEqual(set(d), {"inventory"})
        self.assertAlmostEqual(d["inventory"], 1.4 * 0.25 * 0.9)

    def test_cache_per_lookup(self):
        import mechanisms
        hit, miss = mechanisms.per_lookup(d_hot=1.5, d_cold=5.0, hit_ratio=0.99)
        self.assertAlmostEqual(miss, 5.0)
        self.assertAlmostEqual(0.99 * hit + 0.01 * miss, 1.5)
        self.assertEqual(mechanisms.per_lookup(1.0, 4.0, None), (None, 4.0))
        self.assertIsNone(mechanisms.per_event(1.0, 0))
        self.assertAlmostEqual(mechanisms.per_event(3.0, 3), 1.0)
        s = mechanisms.stack_cost({"discount": 3.8, "discount-db": 0.4, "discount-dapr": 1.2, "discount-ecs": 1.1},
                                  "discount")
        self.assertAlmostEqual(s["total"], 6.5)

    def test_inverse_rate_fit(self):
        import sensitivity
        pts = [(x, 20.0 + 30.0 / x) for x in (1.0, 2.5, 8.0)]
        a, b = sensitivity.fit_inverse(pts)
        self.assertAlmostEqual(a, 20.0)
        self.assertAlmostEqual(b, 30.0)
        self.assertEqual(sensitivity.fit_inverse([(2.0, 5.0)]), (5.0, 0.0))
        self.assertEqual(sensitivity.fit_inverse([]), (None, None))
        path = sensitivity.path_containers({"containers": {"order": {}}}, via_gateway=False)
        self.assertEqual(path, {"order", "order-db", "order-dapr", "order-ecs"})
        on, off = sensitivity.sums({"order": 2.0, "order-db": 1.0, "catalog": 0.5, "zipkin-all-in-one": 3.0}, path)
        self.assertEqual((on, off), (3.0, 0.5))

    def test_volume_growth_after_template_reset(self):
        import volumes
        # n_live_tup restarts at 0 after the template copy: net inserts, or the analyser's estimate
        self.assertEqual(volumes.growth(0, 120, 4071), (120, "net inserts - deletes since the reset"))
        g, how = volumes.growth(0, 34236, 34236)
        self.assertEqual(g, 0)
        self.assertTrue(how.startswith("analysed"))
        self.assertEqual(volumes.growth(0, 1323, 300)[0], 1023)
        self.assertEqual(volumes.growth(40000, 40010, 40000)[0], 10)
        vol = {"dbs": {"c": {"x_baseline": {"error": "not accepting"}, "x": {"size": 1, "tables": {"t": 5}}}}}
        self.assertEqual(volumes.tables(vol), {("x", "t"): 5})
        # order's shipment method copy under its old (approx3 windows) and its unified name
        for t in ("shipment_methods", "shipmentmethodentity"):
            self.assertEqual(volumes.small_growth({f"order.{t}": {"growth": 3}})["order: shipment method copies"], 3)

    def test_entry_frames_of_resolver_classes(self):
        """unify's federation entries are one-line resolver classes of libs/common (no `fun`): their frames are the
        base class's resolve (and the loader's own class); a function entry keeps its own frames."""
        res = ["package org.misarch.review.graphql.federation", "",
               "import org.misarch.common.graphql.DataLoaderEntityResolver",
               "import org.misarch.review.graphql.dataloader.ProductDataLoader", "", "@Component",
               "class ProductResolver : DataLoaderEntityResolver<Product>(Product::class, ProductDataLoader::class)"]
        ref = ["package org.misarch.address.graphql.federation", "import org.misarch.common.graphql.ReferenceEntityResolver",
               "@Component", "class UserResolver : ReferenceEntityResolver<User>(User::class, ::User)"]
        fun = ["package org.misarch.order.event", "class EventController(", "    private val s: S", ") {",
               "    suspend fun onPaymentEnabled(", "        @RequestBody e: CloudEvent<X>", "    ) {}", "}"]
        srcs = {"r.kt": res, "u.kt": ref, "e.kt": fun}
        orig = parts._entry_source
        try:
            parts._entry_source = lambda entry, commit: (
                srcs[entry.split(":")[0]][0].split()[1], srcs[entry.split(":")[0]], int(entry.split(":")[1]) - 1)
            parts._ENTRY_CACHE.clear()
            self.assertEqual(parts.entry_frames("r.kt:7", "c"), [
                "org/misarch/common/graphql/DataLoaderEntityResolver.resolve",
                "org/misarch/common/graphql/DataLoaderEntityResolver$resolve$",
                "org/misarch/review/graphql/dataloader/ProductDataLoader.",
                "org/misarch/review/graphql/dataloader/ProductDataLoader$"])
            self.assertEqual(parts.entry_dataloader("r.kt:7", "c"), "ProductDataLoader")
            self.assertEqual(parts.entry_frames("u.kt:4", "c"), [
                "org/misarch/common/graphql/ReferenceEntityResolver.resolve",
                "org/misarch/common/graphql/ReferenceEntityResolver$resolve$"])
            self.assertIsNone(parts.entry_dataloader("u.kt:4", "c"))
            self.assertEqual(parts.entry_frames("e.kt:5", "c"), [
                "org/misarch/order/event/EventController.onPaymentEnabled",
                "org/misarch/order/event/EventController$onPaymentEnabled$"])
            self.assertIsNone(parts.entry_dataloader("e.kt:5", "c"))
        finally:
            parts._entry_source = orig
            parts._ENTRY_CACHE.clear()

    def test_entry_cpu_splits_a_shared_frame(self):
        import tempfile
        base = "org/misarch/common/graphql/DataLoaderEntityResolver.resolve"
        folded = (f"graphql/execution/Execution.run;{base};graphql/Foo.bar 4\n"
                  "graphql/execution/Execution.run;org/misarch/review/graphql/Query.reviews 2\n")
        with tempfile.NamedTemporaryFile("w", suffix=".collapsed", delete=False) as f:
            f.write(folded)
        try:
            cnt, own = parts.entry_cpu(f.name, {"r._entities.Product": [base], "r._entities.User": [base],
                                                "r.reviews": ["org/misarch/review/graphql/Query.reviews"]},
                                       profile_buckets.Classifier())
        finally:
            os.remove(f.name)
        self.assertEqual(own, 6)
        self.assertEqual(dict(cnt), {"r._entities.Product": 2, "r._entities.User": 2, "r.reviews": 2})

    def test_copy_tables_old_and_unified(self):
        import mechanisms
        for t in ("local_copy_discounts", "LocalCopyDiscountEntity", "localcopyproductvariantversionentity"):
            self.assertTrue(mechanisms.is_copy_table(t), t)
        self.assertFalse(mechanisms.is_copy_table("orderentity"))
        self.assertEqual(mechanisms.COPY_TABLES["localcopycouponentity"][0], "Coupon")

    def test_ran_operations_by_fetcher_spans(self):
        ops = ["inv._entities.PV", "inv.PV.inventoryCount", "inv.on:x"]
        fields = {"inv._entities.PV": "_entities", "inv.PV.inventoryCount": "inventoryCount", "inv.on:x": None}
        acc = [{"ops": ["inv.PV.inventoryCount"]}]
        self.assertEqual(parts.ran_operations(ops, set(), {}, acc, fields, {}), ["inv.PV.inventoryCount"])
        self.assertEqual(parts.ran_operations(ops, set(), {}, acc, fields, {"_entities": 7.2}),
                         ["inv._entities.PV", "inv.PV.inventoryCount"])


class PerExecution(unittest.TestCase):
    """parts per execution of the operation, from the counters' executions."""

    def test_executions(self):
        calls = {"h.ok": 1.0168, "h.rare": 0.0201}
        self.assertEqual(parts.executions("root", {"root"}, calls, 1.0168, {"graphql": "Mutation.x"}), (1.0, "plan"))
        x, how = parts.executions("h.rare", {"root"}, calls, 1.0168, {"topic": "t"})
        self.assertAlmostEqual(x, 0.0201 / 1.0168)
        self.assertEqual(how, "counters")
        self.assertEqual(parts.executions("h.none", {"root"}, calls, 1.0168, {"topic": "t"})[0], 0.0)
        self.assertIsNone(parts.executions("f.none", {"root"}, calls, 1.0168, {"graphql": "A.b"})[0])

    def test_counter_calls_dataloader_only_without_other_key(self):
        pr = {"operations": [{"key": "_entities.User", "kind": "entities", "callsPerReq": 1.0},
                             {"key": "UserDataLoader", "kind": "dataloader", "callsPerReq": 1.0}]}
        ops = {"s._entities.User": {"trigger": {"graphql": "_entities(User)"}}}
        c = parts.counter_calls(pr, ops, {"s._entities.User": "UserDataLoader"})
        self.assertEqual(c["s._entities.User"], 1.0)

    def test_exec_weights(self):
        # a shape four handlers share: the one that did not run gets nothing, the rare one its executions
        w = parts.exec_weights(["a", "b", "c", "never"], {"a": 1.0, "b": 0.98, "c": 0.02, "never": 0.0},
                               {"a": 1.0, "b": 1.0, "c": 1.0, "never": 1.0}, {})
        self.assertEqual(w["never"], 0.0)
        self.assertAlmostEqual(w["c"], 0.02 / 2.0)
        self.assertAlmostEqual(sum(w.values()), 1.0)
        # no measured executions: A's reach
        self.assertEqual(parts.exec_weights(["a", "b"], {"a": 0, "b": 0}, {"a": 1, "b": 1}, {"a": 1.0, "b": 0.0}),
                         {"a": 1.0, "b": 0.0})

    def test_statements_of_the_shape_kind(self):
        # createProduct's lock and exists of ProductVariant are shapes of their own, not of the select
        op = {"accesses": [{"table": "ProductVariantEntity", "mode": "read", "today": "local", "op": k, "statements": 1}
                           for k in ("lock", "select", "exists")]}
        self.assertEqual(parts.statements_of(op, ["productvariantentity"], "read", {"select"}), 1.0)
        self.assertEqual(parts.statements_of(op, ["productvariantentity"], "read", {"count"}), 3.0)   # none: all
        self.assertEqual(parts.statements_of(op, ["productvariantentity"], "read"), 3.0)

    def test_no_measured_access_dropped(self):
        xof = {"ran": 1.0, "never": 0.0, "plan": 1.0}.get
        # the only target did not run: the access goes to the fallback (conservation by construction)
        self.assertEqual(parts.shape_shares(["never"], {"never": 1.0}, xof, "plan"), {"plan": 1.0})
        sh = parts.shape_shares(["ran", "never"], {"ran": 0.4, "never": 0.6}, xof, "plan")
        self.assertEqual(sh, {"ran": 1.0})
        self.assertEqual(parts.fallback_op(["never"], ["never", "ran"], xof), "ran")
        self.assertEqual(parts.fallback_op(["never"], ["never"], xof), "never")   # held with 1 assumed
        self.assertEqual(parts.per_exec(0.5, 1.0), 0.5)

    def test_counter_statements_same_shape(self):
        # counter SQL (`?`, `(?...)`) against pg's (`$n`, one entry per IN-list length)
        k = parts.stmt_key('SELECT "p".* FROM "p" WHERE "p"."id" IN (?...)')
        self.assertEqual(k, parts.stmt_key('SELECT "p".* FROM "p" WHERE "p"."id" IN ($1, $2, $3)'))
        self.assertEqual(parts.stmt_key("UPDATE t SET a = ?, b = NULL WHERE c = ?"),
                         parts.stmt_key("UPDATE t SET a = $2, b = $3 WHERE c = $1"))
        keys = {parts.stmt_key('INSERT INTO "categoryentity" ("name", "description") VALUES ($1, $2) RETURNING id'): 1}
        self.assertIsNotNone(parts.find_key(parts.stmt_key('INSERT INTO "categoryentity" ("name", "description") VALUES (?...)'), keys))
        acc = [{"service": "s", "class": "C", "mode": "read", "tables": ["p"], "ops": ["o"], "callsPerReq": 2.0}]
        rows = [{"service": "s", "class": "C", "kind": "read", "table": "p", "ops": ["o"], "callsPerReq": c,
                 "query": f'SELECT "p".* FROM "p" WHERE "p"."id" IN ({", ".join(f"${i + 1}" for i in range(n))})'}
                for n, c in ((1, 1.2), (2, 0.8))]
        ctr = [{"sql": 'SELECT "p".* FROM "p" WHERE "p"."id" IN (?)', "callsPerReq": 1.25, "rowsPerReq": 1.25},
               {"sql": 'SELECT "p".* FROM "p" WHERE "p"."id" IN (?...)', "callsPerReq": 0.78, "rowsPerReq": 2.0}]
        out = parts.counter_statements(acc, rows, ctr)
        self.assertAlmostEqual(out[0][0], 2.03)
        self.assertAlmostEqual(out[0][1], 3.25)
        self.assertEqual(parts.counter_statements(acc, rows, []), [None])

    def test_statement_cpu_by_shape(self):
        # a count and a select of one table and mode keep their own mapping CPU
        acc = [{"service": "s", "class": "C", "mode": "read", "tables": ["p"], "ops": ["a"]},
               {"service": "s", "class": "C", "mode": "read", "tables": ["p"], "ops": ["a", "b"]}]
        rows = [{"service": "s", "class": "C", "kind": "read", "table": "p", "ops": ["a"], "callsPerReq": 1.0,
                 "query": 'SELECT COUNT(t.id) FROM "p" t WHERE t.x = $1'},
                {"service": "s", "class": "C", "kind": "read", "table": "p", "ops": ["a", "b"], "callsPerReq": 1.0,
                 "query": 'SELECT "p".* FROM "p" WHERE "p"."x" = $1'}]
        st = [{"sql": 'SELECT COUNT(t.id) FROM "p" t WHERE t.x = ?', "driverCpuMs": 0.1, "mappingCpuMs": 0.0},
              {"sql": 'SELECT "p".* FROM "p" WHERE "p"."x" = ?', "driverCpuMs": 0.2, "mappingCpuMs": 0.1},
              {"sql": 'SELECT "p".id FROM "p" WHERE "p"."y" = ?', "driverCpuMs": 0.05, "mappingCpuMs": 0.0},
              {"sql": "SELECT ? FROM pg_advisory_xact_lock(hashtext(?))", "driverCpuMs": 0.01, "mappingCpuMs": 0.0}]
        by_table = lambda x: 0 if '"p"' in x["sql"] else None
        out, tab, left = parts.statement_cpu(acc, rows, st, 2.0, by_table)
        self.assertAlmostEqual(out[0], 0.2 + 0.1)        # its count, and the shape-less statement by table
        self.assertAlmostEqual(out[1], 0.6)
        self.assertAlmostEqual(tab, 0.1)
        self.assertAlmostEqual(left, 0.02)

    def test_per_exec_and_back(self):
        self.assertEqual(parts.per_exec(0.01444, 1.0), 0.0144)
        v = parts.per_exec(0.0144, 0.01978)
        self.assertAlmostEqual(v * 0.01978, 0.0144, places=6)
        e = {"ownCpuMs": 9.0, "accesses": [], "byRequest": {"T": {"ownCpuMs": v, "executionsPerRequest": 0.01978,
                                                                  "accesses": [{"calls": 1.0, "dbMs": None}]}}}
        r = common.request_parts(e, "T")
        self.assertAlmostEqual(r["ownCpuMs"], 0.0144, places=6)
        self.assertEqual(r["accesses"][0], {"calls": 0.01978, "dbMs": None})
        self.assertEqual(common.request_parts(e, "U")["ownCpuMs"], 9.0)


class EnvelopeClassifier(unittest.TestCase):
    """envelope.py: marker frames from the leaf up to the first business frame decide (README.md §6.2)."""

    def setUp(self):
        import envelope
        self.ec = envelope.EnvelopeClassifier()

    def c(self, *frames):
        return self.ec.stack(list(frames))

    def test_parts(self):
        netty = "io/netty/channel/epoll/EpollIoHandler.run"
        srv = "reactor/netty/http/server/HttpServerOperations.onInboundNext"
        self.assertEqual(self.c(netty, srv), "dispatch")
        self.assertEqual(self.c(netty, "org/springframework/http/codec/AbstractJacksonDecoder.decode",
                                "tools/jackson/databind/ObjectReader.readValue"), "decode")
        self.assertEqual(self.c(netty, "org/misarch/common/nest/NestRest.parseBody",
                                "tools/jackson/databind/ObjectMapper.readTree"), "decode")
        self.assertEqual(self.c(netty, "io/r2dbc/pool/PooledConnection.commitTransaction",
                                "io/r2dbc/postgresql/client/ReactorNettyClient.send"), "tx")
        # business code resumed under a commit stays work
        self.assertEqual(self.c(netty, "io/r2dbc/pool/PooledConnection.commitTransaction",
                                "org/misarch/inventory/service/InventoryService.reserve"), "work")
        self.assertEqual(self.c("org/misarch/inventory/event/EventController.orderCreated",
                                "org/misarch/common/event/EventPublisher.publishEvent",
                                "tools/jackson/databind/ObjectMapper.writeValueAsBytes"), "publish")
        # a WebClient response decode is the client, not the inbound decode
        self.assertEqual(self.c(netty, "reactor/netty/http/client/HttpClientOperations.onInboundNext",
                                "org/springframework/core/codec/AbstractDataBufferDecoder.decode"), "client")
        self.assertEqual(self.c("org/misarch/order/service/OrderService.create",
                                "io/r2dbc/postgresql/PostgresqlStatement.execute"), "work")
        self.assertEqual(self.c("CompileBroker::compiler_thread_loop"), "jit")
        self.assertEqual(self.c(srv, "io/opentelemetry/javaagent/Foo.bar"), "instrumentation")

    def test_unified_event_frames(self):
        """misarch-kotlin unify: EventController bodies are CloudEvent<DTO>s decoded by Spring's Jackson decoder and
        published by EventPublisher/EventJson; their data classes are not business frames."""
        netty = "io/netty/channel/epoll/EpollIoHandler.run"
        dec = "org/springframework/http/codec/AbstractJacksonDecoder.decode"
        self.assertEqual(self.c(netty, dec, "tools/jackson/databind/deser/BeanDeserializer.deserialize",
                                "org/misarch/common/event/CloudEvent.<init>"), "decode")
        self.assertEqual(self.c(netty, dec, "tools/jackson/databind/deser/BeanDeserializer.deserialize",
                                "org/misarch/review/event/model/ProductVariantDTO.<init>"), "decode")
        self.assertEqual(self.c("org/misarch/shipment/service/ShipmentRegistrationService.register",
                                "org/misarch/common/event/EventPublisher.publishEvent",
                                "org/misarch/common/event/EventJson.toBytes",
                                "tools/jackson/databind/ser/BeanSerializer.serialize",
                                "org/misarch/shipment/event/model/ShipmentDTO.getId"), "publish")
        # the handler and its statements (ConditionQueries is mapping, not business) stay work
        self.assertEqual(self.c(netty, "org/misarch/review/event/EventController.onUserCreated",
                                "org/misarch/common/persistence/ConditionQueries.findAll",
                                "io/r2dbc/postgresql/PostgresqlStatement.execute"), "work")
        self.assertEqual(self.c("org/misarch/order/client/CheckoutClient.shipmentFees",
                                "org/misarch/common/event/DaprServiceInvoker.graphql",
                                "reactor/netty/http/client/HttpClientOperations.onInboundNext"), "invoke")

    def test_shares_split_client(self):
        import envelope
        sh = envelope.shares({"publish": 1.0, "invoke": 1.0, "client": 2.0, "work": 6.0})
        self.assertAlmostEqual(sh["publish"], 0.2)
        self.assertAlmostEqual(sh["invoke"], 0.2)
        self.assertNotIn("client", sh)


class EnvelopeRequestTraces(unittest.TestCase):
    """envelope.py: the gateway leaves one trace per subgraph fetch, so a two-fetch request (address: user + address)
    is two request traces; per_operation scales the per-trace counts by the plan's fetches to one inbound request per
    plan container per request, and check_inbound rejects the per-trace counts."""

    def window(self, d, n_req=20):
        import gzip
        import json
        t0 = 1000.0
        json.dump({"log": [{"kind": "start", "seg": "address:steady", "tRequested": t0, "tDone": t0},
                           {"kind": "stop", "seg": "address:steady", "tRequested": t0 + 100}]},
                  open(os.path.join(d, "hooks.json"), "w"))
        spans, k = [], 0
        for i in range(n_req):
            for app in ("user", "address"):        # one trace per fetch: gateway sidecar -> app sidecar -> app
                k += 1
                ts = (t0 + 1 + i) * 1e6 + k
                dapr = {"otel.library.name": "dapr-diagnostics"}
                spans += [{"id": f"g{k}", "traceId": f"t{k}", "kind": "CLIENT", "name": f"/v1.0/invoke/{app}/graphql",
                           "timestamp": ts, "duration": 900, "localEndpoint": {"serviceName": "gateway"},
                           "tags": dapr},
                          {"id": f"d{k}", "traceId": f"t{k}", "parentId": f"g{k}", "kind": "SERVER",
                           "name": "/graphql", "timestamp": ts + 50, "duration": 800,
                           "localEndpoint": {"serviceName": app}, "tags": dapr},
                          {"id": f"a{k}", "traceId": f"t{k}", "parentId": f"d{k}", "kind": "SERVER",
                           "name": "POST /graphql", "timestamp": ts + 100, "duration": 700,
                           "localEndpoint": {"serviceName": app}, "tags": {}}]
        with gzip.open(os.path.join(d, "spans.json.gz"), "wt") as f:
            json.dump(spans, f)

    def test_two_fetches_one_inbound_each(self):
        import tempfile
        import envelope
        with tempfile.TemporaryDirectory() as d:
            self.window(d)
            sp = envelope.span_stats(d)["types"]["address"]
        self.assertEqual(sp["requestTraces"], 40)            # 20 requests, 2 fetch traces each
        self.assertEqual(sp["otherInboundPerReq"], {"address": 0.5, "user": 0.5})
        win = {"profileParts": {"address:steady": {c: {"dispatch": 200.0, "work": 800.0} for c in ("address", "user")}},
               "types": {"address": sp}}
        pj = {"requests": {"address": {"containers": {"address": {"D": 2.0}, "user": {"D": 1.5}}}}, "operations": {}}
        plan = lambda t: {"address", "user"}                  # noqa: E731
        _, _, rows = envelope.per_operation([win], pj, {}, plan, lambda t: 2)
        self.assertEqual({r["container"]: r["inboundPerReq"] for r in rows}, {"address": 1.0, "user": 1.0})
        self.assertEqual(envelope.check_inbound(rows, plan, lambda t: 2), [])
        with self.assertRaises(ValueError):                   # counted per trace instead of per fetch
            envelope.per_operation([win], pj, {}, plan, lambda t: 1)

    def test_fetches_from_plan(self):
        import envelope
        f = envelope.fetches_of(queries.Mapping())
        self.assertEqual([f(t) for t in ("address", "product", "wishlistView", "products", "createOrder")],
                         [2, 2, 2, 1, 1])


class SegmentOffset(unittest.TestCase):
    """the shift a segment shares across a role's containers, from the ones it does not touch."""
    SVC = ["a", "b", "c", "d", "e"]

    def test_median_of_untouched_per_role(self):
        net = {"a": 0.9, "b": 0.002, "c": 0.004, "d": 0.003, "e": 0.010,
               "a-db": 0.5, "b-db": 0.001, "c-db": -0.002, "d-db": 0.0015, "e-db": 0.05,
               "a-dapr": 0.1, "b-dapr": 0.0, "c-dapr": 0.0}
        o = common.segment_offsets(net, {"a", "e"}, self.SVC)
        self.assertAlmostEqual(o["app"][0], 0.003)
        self.assertEqual(o["app"][1], 3)
        self.assertAlmostEqual(o["db"][0], 0.001)
        self.assertEqual(o["dapr"], (0.0, 2))         # two untouched sidecars: below the minimum, no offset

    def test_roles(self):
        svc = {"user", "order"}
        self.assertEqual(common.offset_role("user", svc), "app")
        self.assertEqual(common.offset_role("user-db", svc), "db")
        self.assertEqual(common.offset_role("order-dapr", svc), "dapr")
        self.assertIsNone(common.offset_role("order-ecs", svc))
        self.assertIsNone(common.offset_role("gateway", svc))

    def test_worked_containers(self):
        ctr_ = {"order": {"statements": [], "operations": [{"key": "POST /", "class": "own", "callsPerReq": 1.0}]},
                "catalog": {"statements": [], "operations": [{"key": "GET /health", "class": "background",
                                                              "callsPerReq": 0.0003}]}}
        q = {"statements": [{"service": "order", "table": "orderentity", "kind": "write"},
                            {"service": "catalog", "kind": "read"},                  # the health check: no table
                            {"service": "postgres", "table": "pg_stat_wal", "kind": "read", "background": True}]}
        w = parts.worked_containers(ctr_, q)
        self.assertEqual(w, {"order", "order-dapr", "order-ecs", "order-db"})
        svc = ["order", "catalog"]
        self.assertTrue(parts.idle_in({"T": w}, "T", "catalog-db", svc))
        self.assertFalse(parts.idle_in({"T": w}, "T", "order-dapr", svc))
        self.assertFalse(parts.idle_in({"T": w}, "T", "gateway", svc))          # not a service container
        self.assertFalse(parts.idle_in({"T": None}, "T", "catalog", svc))       # no counters: every one counts

    def test_touched_services(self):
        class M:
            ops = {"x.q": {"service": "x"}, "y.on": {"service": "y"}}

            def request_ops(self, t):
                return [("x.q", "plan"), ("y.on", "followUp")] if t == "q" else []
        self.assertEqual(common.touched_services(M(), "q"), {"x", "y"})
        self.assertIsNone(common.touched_services(M(), "unknown"))


if __name__ == "__main__":
    unittest.main()


# ------------------------------------------------------------------------------- counters, checks, bursts, factorial
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "harness"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "plans"))
import counters  # noqa: E402

SNAP0 = {"enabled": True, "t": 1000, "threadCpuNsTotal": 5_000_000_000,
         "statements": [{"key": "s1", "sql": "SELECT * FROM OrderEntity WHERE id = $1", "entity": "OrderEntity",
                         "mode": "read", "calls": 100, "rows": 100, "driverCpuNs": 10_000_000, "mappingCpuNs": 20_000_000}],
         "operations": [{"key": "Query.order", "kind": "graphql", "calls": 100, "cpuNs": 50_000_000}]}
SNAP1 = {"enabled": True, "t": 61000, "threadCpuNsTotal": 5_600_000_000,
         "statements": [{"key": "s1", "sql": "SELECT * FROM OrderEntity WHERE id = $1", "entity": "OrderEntity",
                         "mode": "read", "calls": 1100, "rows": 1100, "driverCpuNs": 110_000_000,
                         "mappingCpuNs": 220_000_000},
                        {"key": "s2", "sql": "INSERT INTO OrderItemEntity (id) VALUES ($1)", "entity": "OrderItemEntity",
                         "mode": "write", "calls": 500, "rows": 500, "driverCpuNs": 50_000_000, "mappingCpuNs": 50_000_000}],
         "operations": [{"key": "Query.order", "kind": "graphql", "calls": 1100, "cpuNs": 550_000_000},
                        {"key": "dataloader OrderItem", "kind": "dataloader", "calls": 1000, "cpuNs": 100_000_000}]}


class Counters(unittest.TestCase):
    def delta(self):
        import stackctl
        return stackctl.counter_delta(SNAP0, SNAP1)

    def test_delta_and_new_keys(self):
        d = self.delta()
        self.assertEqual(d["seconds"], 60.0)
        self.assertEqual(d["threadCpuNs"], 600_000_000)
        self.assertEqual(d["statements"]["s1"]["calls"], 1000)
        self.assertEqual(d["statements"]["s2"]["calls"], 500)            # new key counts from 0
        self.assertEqual(d["operations"]["Query.order"]["cpuNs"], 500_000_000)
        self.assertFalse(d["reset"])

    def test_restarted_app_counts_from_zero(self):
        import stackctl
        d = stackctl.counter_delta(SNAP1, SNAP0)       # counters went down: the JVM restarted
        self.assertTrue(d["reset"])
        self.assertEqual(d["statements"]["s1"]["calls"], 100)

    def test_per_request_and_shares(self):
        pr = counters.per_request(self.delta(), 1000)
        self.assertAlmostEqual(pr["accessCpuMs"], 0.4)        # (100 + 200 + 100) ms / 1000
        self.assertAlmostEqual(pr["operationsCpuMs"], 0.6)
        self.assertAlmostEqual(pr["threadCpuMs"], 0.6)
        s1 = next(x for x in pr["statements"] if x["key"] == "s1")
        self.assertAlmostEqual(s1["cpuMsPerCall"], 0.3)
        sh = counters.shares(pr, d_on=1.5, instr_share=0.2, mw_share=0.05)   # base 1.2 ms without instrumentation
        self.assertAlmostEqual(sh["access"], 0.4 / 1.2)
        self.assertAlmostEqual(sh["operations"]["Query.order"], 0.5 / 1.2)
        self.assertAlmostEqual(sh["remainder"], 1 - 1.0 / 1.2 - 0.05)
        self.assertAlmostEqual(sh["coverage"], 1.0 / 1.2)
        self.assertAlmostEqual(sh["threadCoverage"], 0.4)
        self.assertAlmostEqual(sh["attributedOfThread"], 1.0 / 0.6)
        self.assertFalse(sh["over"])
        over = counters.shares(pr, d_on=0.9)            # counters above the cgroup CPU: flagged, remainder 0
        self.assertTrue(over["over"])
        self.assertEqual(over["remainder"], 0.0)
        self.assertIsNone(counters.shares(pr, d_on=0))

    def test_match_operation(self):
        ops = {"order.order": {"trigger": {"graphql": "Query.order"}},
               "order._entities.Order": {"trigger": {"graphql": "_entities(Order)"}},
               "order.on:x": {"trigger": {"topic": "payment/payment/enabled"}},
               "order.Order.items": {"trigger": {"graphql": "Order.orderItems"}}}
        self.assertEqual(counters.match_operation("Query.order", "graphql", ops), ["order.order"])
        self.assertEqual(counters.match_operation("order", "graphql", ops), ["order.order"])
        self.assertEqual(counters.match_operation("Order.orderItems", "graphql", ops), ["order.Order.items"])
        self.assertEqual(counters.match_operation("_entities.Order", "entities", ops), ["order._entities.Order"])
        self.assertEqual(counters.match_operation("_entities.Order+User", "entities", ops), ["order._entities.Order"])
        self.assertEqual(counters.match_operation("payment/payment/enabled", "event", ops), ["order.on:x"])
        self.assertEqual(counters.match_operation("a/b|payment/payment/enabled", "event", ops), ["order.on:x"])
        self.assertEqual(counters.op_class({"kind": "http", "key": "POST /graphql"}), "engine")
        self.assertEqual(counters.op_class({"kind": "http", "key": "GET /health"}), "background")
        self.assertEqual(counters.op_class({"kind": "graphql", "key": "Query.order"}), "own")
        self.assertEqual(counters.match_operation("dataloader OrderItem", "dataloader", ops), [])
        # unify: a data loader key goes to the operations whose entry is a DataLoaderEntityResolver over it
        loaders = {"order._entities.Order": "OrderDataLoader", "order.order": None}
        self.assertEqual(counters.match_operation("OrderDataLoader", "dataloader", ops, loaders), ["order._entities.Order"])
        self.assertEqual(counters.match_operation("OrderItemDataLoader", "dataloader", ops, loaders), [])

    def test_match_access(self):
        acc = [{"mode": "read", "tables": ["orderentity"]}, {"mode": "write", "tables": ["orderitementity"]}]
        pr = counters.per_request(self.delta(), 1000)
        idx = {x["key"]: counters.match_access(x, acc, queries.parse_sql) for x in pr["statements"]}
        self.assertEqual(idx, {"s1": 0, "s2": 1})
        self.assertIsNone(counters.match_access({"sql": "BEGIN", "mode": None}, acc, queries.parse_sql))


class Checks(unittest.TestCase):
    def test_scan_suspects(self):
        r = {"calls": 10, "shared_blks_hit": 9000, "shared_blks_read": 2000}
        self.assertEqual(queries.shared_blocks_per_call(r), 1100.0)
        rows = [{"db": "n-db", "service": "notification", "queryid": 1, "table": "t", "calls": 10, "execMs": 70.0,
                 "sharedBlksPerCall": 1100.0, "query": "SELECT"},
                {"db": "n-db", "service": "notification", "queryid": 2, "table": "t", "calls": 10, "execMs": 1.0,
                 "sharedBlksPerCall": 4.0, "query": "SELECT"}]
        s = queries.scan_suspects(rows)
        self.assertEqual([x["queryid"] for x in s], [1])
        self.assertAlmostEqual(s[0]["execMsPerCall"], 7.0)

    def test_flyway_checksum(self):
        import zlib
        import migrations
        c = zlib.crc32(b"b", zlib.crc32(b"a"))
        signed = c - (1 << 32) if c >= (1 << 31) else c
        self.assertEqual(migrations.flyway_checksum("a\r\nb\n"), signed)
        self.assertEqual(migrations.flyway_checksum("﻿a\nb"), signed)
        self.assertEqual(migrations.parse_name("V2__local_copies.sql")["description"], "local copies")
        self.assertEqual(migrations.parse_name("V1_6__fix.sql")["version"], "1.6")

    def test_speed_rule(self):
        import speedprobe as sp
        self.assertEqual(sp.regime_of({"medianMsPerS": 35.0}, {"ratio": 1.0}), "slow")    # placement decides
        self.assertEqual(sp.regime_of({"medianMsPerS": 28.0}, {"ratio": 2.0}), "fast")
        self.assertEqual(sp.regime_of(None, {"ratio": 1.4}), "slow")                     # no stack: the bench
        self.assertIsNone(sp.regime_of(None, None))

    def test_burst_packing_respects_limits(self):
        import bursts
        tab = {"uMax": 0.6, "types": {
            "a": {"need": True, "n": 1000, "maxRate": 10.0, "util": {"x": 0.05}, "apps": ["x"]},
            "b": {"need": True, "n": 1000, "maxRate": 20.0, "util": {"x": 0.025}, "apps": ["x"]},
            "c": {"need": True, "n": 500, "maxRate": 50.0, "util": {"y": 0.01}, "apps": ["y"]},
            "d": {"need": False, "n": 1000, "maxRate": 50.0, "util": {"y": 0.01}, "apps": ["y"]}}}
        p = bursts.plan(tab, ["a", "b", "c", "d"])
        self.assertEqual(p["types"], ["a", "b", "c"])
        # a alone fills x to 0.5 at 10/s for 100 s; b (x 0.025/rps at 10/s = 0.25) does not fit, c fits
        first = p["phases"][0]
        self.assertEqual(first["duration"], 100)
        self.assertEqual(set(first["rates"]), {"a", "c"})
        for ph in p["phases"][:-1]:
            load = sum(r * tab["types"][t]["util"].get("x", 0) for t, r in ph["rates"].items())
            self.assertLessEqual(load, 0.6 + 1e-9)
        self.assertEqual(p["phases"][-1]["name"], "settle")
        self.assertIsNone(bursts.plan(tab, ["d"]))

    def test_burst_chain_and_warm_state(self):
        import tempfile
        import bursts
        tab = {"types": {t: {"need": True, "n": 100, "maxRate": 10.0, "util": {}, "apps": ["order"]}
                         for t in ("createOrder", "placeOrder", "createShoppingcartItem")}}
        g = bursts.groups(tab, ["placeOrder"])
        self.assertEqual(set(g[0]["members"]), {"createOrder", "createShoppingcartItem", "placeOrder"})
        ws = bursts.WarmState(os.path.join(tempfile.mkdtemp(), "w.json"))
        st = {"misarch-kotlin-order-1": "t1 0"}
        self.assertEqual(ws.cold(tab, ["createOrder"], st), ["createOrder"])
        ws.mark(tab, ["createOrder"], st)
        self.assertEqual(ws.cold(tab, ["createOrder"], st), [])
        self.assertEqual(ws.cold(tab, ["createOrder"], {"misarch-kotlin-order-1": "t2 0"}), ["createOrder"])

    def test_factorial_cells(self):
        import factorial
        import gen_plans
        cells = gen_plans.fo_cells()
        self.assertEqual(len(cells), 22)
        self.assertEqual(len(set(cells)), 22)
        for m, n in (("PRE", 8), ("CC", 8), ("INV", 6)):
            self.assertEqual(sum(1 for c in cells if f"{m}s" in c), n)
        X = [factorial.design_row(factorial.cell_params(c)) for c in cells]
        self.assertIsNotNone(factorial.ols(X, [1.0] * len(X))[0])     # the 7 coefficients stay identifiable

    def test_caller_cache_arithmetic(self):
        import mechanisms
        D = lambda **kw: {"X": 10.0, "n": 750, "errRate": 0, "segmentValid": True, "D": kw, "se": {}}  # noqa: E731
        T = {"off": {"createOrder.hot": D(order=6.0, **{"order-dapr": 3.0, "shipment": 2.0, "shipment-db": 0.4}),
                     "createOrder": D(order=6.0, **{"order-dapr": 3.0, "shipment": 2.0, "shipment-db": 0.4})},
             "on": {"createOrder.hot": D(order=5.5, **{"order-dapr": 2.0, "shipment": 0.1, "shipment-db": 0.02}),
                    "createOrder": D(order=6.5, **{"order-dapr": 3.0, "shipment": 2.0, "shipment-db": 0.4})}}
        counts = {"createOrder.hot:steady": {"order": {"seconds": 75, "byTarget": {
                      "shipment": {"hits": 712, "misses": 38, "hitRatio": 0.9493}}}},
                  "createOrder:steady": {"order": {"seconds": 75, "byTarget": {
                      "shipment": {"hits": 0, "misses": 750, "hitRatio": 0.0}}}}}
        orig = (mechanisms.parts.iso_totals, mechanisms.common.load_json, mechanisms.speed.window_regime,
                mechanisms.common.window_dir)
        try:
            mechanisms.common.window_dir = lambda w: w
            mechanisms.parts.iso_totals = lambda d: (T[d], True)
            mechanisms.common.load_json = lambda d, n, default=None: counts if n == "cache_counts.json" else default
            mechanisms.speed.window_regime = lambda w: {"regime": "fast"}
            r = mechanisms.caller_cache("off", "on")
        finally:
            (mechanisms.parts.iso_totals, mechanisms.common.load_json, mechanisms.speed.window_regime,
             mechanisms.common.window_dir) = orig
        s = r["targets"]["shipment"]
        self.assertAlmostEqual(s["lookupsPerRequest"], 1.0)
        self.assertAlmostEqual(s["provider"]["app"]["savingPerHit"], round(1.9 / 0.9493, 3), places=3)
        # hot: -0.5 = 0.9493 perHit + 0.0507 missOverhead, cold: 0.5 = 1.0 missOverhead
        self.assertAlmostEqual(r["caller"]["order"]["perHit"], round((-0.5 - 0.0507 * 0.5) / 0.9493, 3), places=3)
        self.assertAlmostEqual(r["caller"]["order"]["missOverhead"], 0.5)
        self.assertAlmostEqual(r["caller"]["order-dapr"]["perHit"], round(-1.0 / 0.9493, 3), places=3)
        # a cold set with hits (repeated bodies): the joint solution, not (D_on_cold - D_off_cold) / misses
        counts["createOrder:steady"]["order"]["byTarget"]["shipment"] = {"hits": 375, "misses": 375, "hitRatio": 0.5}
        T["on"]["createOrder"]["D"]["order"] = 6.0 + 0.5 * -0.4 + 0.5 * 0.6
        T["on"]["createOrder.hot"]["D"]["order"] = 6.0 + 0.9493 * -0.4 + 0.0507 * 0.6
        try:
            mechanisms.common.window_dir = lambda w: w
            mechanisms.parts.iso_totals = lambda d: (T[d], True)
            mechanisms.common.load_json = lambda d, n, default=None: counts if n == "cache_counts.json" else default
            mechanisms.speed.window_regime = lambda w: {"regime": "fast"}
            r = mechanisms.caller_cache("off", "on")
        finally:
            (mechanisms.parts.iso_totals, mechanisms.common.load_json, mechanisms.speed.window_regime,
             mechanisms.common.window_dir) = orig
        self.assertAlmostEqual(r["caller"]["order"]["perHit"], -0.4, places=3)
        self.assertAlmostEqual(r["caller"]["order"]["missOverhead"], 0.6, places=3)

    def test_placement_probe_ends(self):
        import speedprobe as sp
        orig = (sp._cg_path, sp._usage_usec)
        vals = iter(range(0, 10 ** 9, 280))
        try:
            sp._cg_path = lambda n: "/x"
            sp._usage_usec = lambda p: next(vals)
            r = sp.placement(seconds=0.05, step=0.01)        # the loop must end after ~5 bins (it hung once)
        finally:
            sp._cg_path, sp._usage_usec = orig
        self.assertGreaterEqual(len(r["binsMsPerS"]), 4)
        self.assertLessEqual(len(r["binsMsPerS"]), 6)
