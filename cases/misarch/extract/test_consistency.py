#!/usr/bin/env python3
"""Tests of the consistency levels' matching and the lock reads' check (consistency.py), on synthetic
operations, plus the committed extraction's invariants. `python3 -m unittest test_consistency` in this directory (no
misarch-kotlin needed)."""
import copy
import json
import unittest
from pathlib import Path

import build
import consistency

HERE = Path(__file__).resolve().parent
RULES = {"S1": "", "S5": "", "I1": "", "R1": ""}


class Probs:
    def __init__(self):
        self.errors, self.warnings = [], []

    def error(self, where, msg):
        self.errors.append(f"{where}: {msg}")

    def warn(self, where, msg):
        self.warnings.append(f"{where}: {msg}")


def acc(cls, mode="read", strong=True, **kw):
    return {"class": cls, "mode": mode, "shape": "one", "today": "local", **({"strong": True} if strong else {}), **kw}


def run(accesses, entries, calls=(), transaction=None):
    op = {"id": "s.op", "accesses": accesses, "calls": list(calls)}
    if transaction:
        op["transaction"] = transaction
    curated = {"s": {"operations": [op]}}
    out = [{"id": "s.op", "accesses": copy.deepcopy(accesses), "calls": copy.deepcopy(list(calls))}]
    probs = Probs()
    consistency.apply(curated, out, probs, doc={"rules": RULES, "operations": {"s.op": entries}})
    return out[0], probs.errors


def entry(level="stale-ok", rules=("R1",), reason="why", **keys):
    return {**keys, "level": level, "rules": list(rules), "reason": reason}


class Matching(unittest.TestCase):
    def test_level_and_reason_go_to_the_access(self):
        o, err = run([acc("A"), acc("B", strong=False)], [entry(**{"class": "A"}, level="immutable", rules=["I1"])])
        self.assertEqual(err, [])
        self.assertEqual(o["accesses"][0]["consistency"], {"level": "immutable", "rules": ["I1"], "reason": "why"})
        self.assertNotIn("consistency", o["accesses"][1])

    def test_strong_read_without_entry(self):
        _, err = run([acc("A"), acc("B")], [entry(**{"class": "A"})])
        self.assertTrue(any("accesses[1]" in e and "without a consistency level" in e for e in err), err)

    def test_entry_matching_nothing(self):
        _, err = run([acc("A")], [entry(**{"class": "A"}), entry(**{"class": "C"})])
        self.assertTrue(any("matches nothing" in e for e in err), err)

    def test_entry_matching_only_a_read_that_is_not_strong(self):
        _, err = run([acc("A"), acc("B", strong=False)], [entry(**{"class": "A"}), entry(**{"class": "B"})])
        self.assertTrue(any("matches nothing strong" in e for e in err), err)

    def test_ambiguous_entry_and_its_fix(self):
        two = [acc("A", op="select", via="R.find"), acc("A", op="exists", via="R.exists")]
        _, err = run(two, [entry(**{"class": "A"})])
        self.assertTrue(any("ambiguous" in e for e in err), err)
        _, err = run(two, [entry(**{"class": "A", "op": "select"}), entry(**{"class": "A", "op": "exists"})])
        self.assertEqual(err, [])

    def test_assoc_is_identity(self):
        # an entry without assoc names the access without one; with assoc the association's
        two = [acc("A"), acc("A", assoc="B")]
        o, err = run(two, [entry(**{"class": "A"}, level="immutable", rules=["I1"]),
                           entry(**{"class": "A", "assoc": "B"}, level="strict", rules=["S1"])])
        self.assertEqual(err, [])
        self.assertEqual([a["consistency"]["level"] for a in o["accesses"]], ["immutable", "strict"])

    def test_two_entries_for_one_access(self):
        _, err = run([acc("A", op="select")], [entry(**{"class": "A"}), entry(**{"class": "A", "op": "select"})])
        self.assertTrue(any("two entries" in e for e in err), err)

    def test_unknown_level_rule_key_and_missing_reason(self):
        _, err = run([acc("A")], [{"class": "A", "level": "eventual", "rules": ["X9"], "colour": "red"}])
        self.assertTrue(any("level 'eventual'" in e for e in err), err)
        self.assertTrue(any("rules" in e for e in err), err)
        self.assertTrue(any("unknown keys" in e for e in err), err)
        self.assertTrue(any("no reason" in e for e in err), err)

    def test_calls(self):
        calls = [{"to": ["x.f", "x.g"], "strong": True}, {"to": "y.h", "strong": True},
                 {"to": "simulation.p.register", "effect": True}]
        o, err = run([], [entry(call="x.f", level="strict", rules=["S1"]), entry(call="y.h")], calls=calls)
        self.assertEqual(err, [])
        self.assertEqual(o["calls"][0]["consistency"]["level"], "strict")
        self.assertNotIn("consistency", o["calls"][2])
        _, err = run([], [entry(call="x.f")], calls=calls)
        self.assertTrue(any("calls[1]" in e and "without a consistency level" in e for e in err), err)
        _, err = run([], [entry(call="x.f"), entry(call="y.h"), entry(call="simulation.p.register")], calls=calls)
        self.assertTrue(any("effect call" in e for e in err), err)


class WriteFlags(unittest.TestCase):
    def test_strong_on_a_write(self):
        # build.py's check: `strong` is a read's flag, an atomic conditional update has none
        for strong, n in ((True, 1), (False, 1), (None, 0)):
            probs = Probs()
            a = acc("A", mode="write", strong=False, op="update")
            if strong is not None:
                a["strong"] = strong
            build.check_write_flags(a, "s.op.accesses[0]", probs)
            self.assertEqual(len(probs.errors), n, (strong, probs.errors))
        probs = Probs()
        build.check_write_flags(acc("A"), "s.op.accesses[0]", probs)
        self.assertEqual(probs.errors, [])


class Locks(unittest.TestCase):
    TX = {"classes": ["A"]}

    def test_lock_read_with_its_write(self):
        _, err = run([acc("A", op="lock"), acc("A", mode="write", strong=False, op="insert")],
                     [entry(**{"class": "A"}, level="strict", rules=["S5"])], transaction=self.TX)
        self.assertEqual(err, [])

    def test_lock_read_without_a_write_of_its_class(self):
        _, err = run([acc("A", op="lock"), acc("B", mode="write", strong=False, op="insert")],
                     [entry(**{"class": "A"}, level="strict", rules=["S5"])], transaction={"classes": ["A", "B"]})
        self.assertTrue(any("a lock read without a write of the locked class" in e for e in err), err)

    def test_lock_read_outside_the_writes_transaction(self):
        _, err = run([acc("A", op="lock"), acc("A", mode="write", strong=False, op="insert")],
                     [entry(**{"class": "A"}, level="strict", rules=["S5"])], transaction={"classes": ["B"]})
        self.assertTrue(any("a lock read without a write" in e for e in err), err)

    def test_lock_with_two_transactions_holding_its_class(self):
        _, err = run([acc("A", op="lock"), acc("A", mode="write", strong=False, op="insert")],
                     [entry(**{"class": "A"}, level="strict", rules=["S5"])],
                     transaction=[{"classes": ["A"]}, {"classes": ["A", "B"]}])
        self.assertTrue(any("cannot be checked" in e for e in err), err)

    def test_lock_in_one_of_two_transactions_holding_its_class(self):
        from test_extract import ROOT, sources
        path = ROOT + "service/S.kt"
        src = ("class S {\n    @Transactional\n    suspend fun store() {\n        repository.lock()\n"
               "        repository.save()\n    }\n\n    @Transactional\n    suspend fun discard() {\n"
               "        repository.delete()\n    }\n}\n")
        txs = [{"classes": ["A"], "_at": f"{path}:2"}, {"classes": ["A"], "_at": f"{path}:8"}]
        with sources({path: src}):
            _, err = run([acc("A", op="lock", _at=f"{path}:4"), acc("A", mode="write", strong=False, op="insert")],
                         [entry(**{"class": "A"}, level="strict", rules=["S5"])], transaction=txs)
            self.assertEqual(err, [])
            _, err = run([acc("A", op="lock", _at=f"{path}:12"), acc("A", mode="write", strong=False, op="insert")],
                         [entry(**{"class": "A"}, level="strict", rules=["S5"])], transaction=txs)
            self.assertTrue(any("cannot be checked" in e for e in err), err)

    def test_lock_is_a_strict_read(self):
        _, err = run([acc("A", mode="write", op="lock"), acc("A", mode="write", strong=False, op="insert")], [],
                     transaction=self.TX)
        self.assertTrue(any("only locks is a read" in e for e in err), err)
        _, err = run([acc("A", op="lock"), acc("A", mode="write", strong=False, op="insert")],
                     [entry(**{"class": "A"}, level="immutable", rules=["I1"])], transaction=self.TX)
        self.assertTrue(any("a lock read is strict" in e for e in err), err)


class Committed(unittest.TestCase):
    """The committed extraction (domain/misarch-domain.json): its consistency levels and write flags."""

    @classmethod
    def setUpClass(cls):
        cls.d = json.loads((HERE.parent / "domain" / "misarch-domain.json").read_text())
        cls.ops = {o["id"]: o for o in cls.d["operations"]}

    def test_every_strong_read_and_call_has_a_level(self):
        for o in self.d["operations"]:
            for x in [a for a in o.get("accesses", []) if a["mode"] == "read"] + o.get("calls", []):
                self.assertEqual(bool(x.get("strong")), "consistency" in x, (o["id"], x.get("class"), x.get("to")))

    def test_no_write_is_strong(self):
        for o in self.d["operations"]:
            for a in o.get("accesses", []):
                if a["mode"] == "write":
                    self.assertNotIn("strong", a, (o["id"], a["class"]))

    def test_provider_calls_are_effects(self):
        for o in self.d["operations"]:
            for c in o.get("calls", []):
                ext = str(c["to"]).startswith("simulation.")
                self.assertEqual(ext, bool(c.get("effect")), (o["id"], c["to"]))
                if ext:
                    self.assertNotIn("strong", c)

    def test_locks_are_strict_reads(self):
        locks = [(o["id"], a) for o in self.d["operations"] for a in o.get("accesses", []) if a.get("op") == "lock"]
        self.assertGreaterEqual(len(locks), 8)
        reasons = {a["consistency"]["reason"] for _, a in locks}
        self.assertEqual(len(reasons), 1)
        for oid, a in locks:
            self.assertEqual((a["mode"], a["consistency"]["level"], a["consistency"]["rules"]), ("read", "strict", ["S5"]), oid)

    def test_create_return_split(self):
        acc = self.ops["return.createReturn"]["accesses"]
        self.assertEqual([(a["class"], a.get("reference"), a["consistency"]["level"]) for a in acc[:2]],
                         [("OrderItem", None, "immutable"), ("OrderItem", "OrderItem.returnedWith", "strict")])
        self.assertEqual(acc[0]["via"], acc[1]["via"])

    def test_own_write_rereads_are_strict(self):
        # the open order re-read inside update-payment-status's transaction (by identity, not index)
        oid = "payment.http:/payment/update-payment-status"
        for cls in ("Order", "OrderItem"):
            c = next(a["consistency"] for a in self.ops[oid]["accesses"] if a["class"] == cls and a["mode"] == "read"
                     and "consistency" in a)
            self.assertEqual((c["level"], c["rules"]), ("strict", ["S5"]), (oid, cls))


if __name__ == "__main__":
    unittest.main()
