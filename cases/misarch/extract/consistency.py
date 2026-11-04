"""The consistency levels of the strong reads and calls (curated/consistency.yaml; levels: docs/model.md §2) and the
lock reads' check: matched to the operations' accesses and calls by their curated identity, never by index.

Each entry of curated/consistency.yaml names one strong read access of its operation by `class` and `assoc` (absent =
an access without one) plus as few of `op`, `via`, `at`, `table`, `shape`, `when`, `topic` as are needed, or one
strong call by `call` (the callee, a call into nested fields by its first field; `at` if the operation calls it
twice). Every strong read and strong call gets `consistency: {level, rules, reason}`. Errors: a strong read or call
without an entry, an entry that matches nothing (or only reads or calls that are not strong), an entry that matches
several, two entries for one, an unknown operation, level or rule, a missing reason, an entry for an effect call.

A statement that only locks (`op: lock`: SELECT ... FOR UPDATE without a data change, an advisory lock) is a strict
read of the locked class (a statement that changes data and locks is its write): mode read, strong,
level strict, and the operation writes the locked class, in its one transaction that holds the class
(the accesses do not name their transaction: of two transactions holding the class, the lock's line must lie in
the function of exactly one). `op: lock` is
provenance only; nothing downstream treats it specially.
"""
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
FILE = HERE / "curated" / "consistency.yaml"
LEVELS = ("strict", "stale-ok", "immutable")
KEYS = ("class", "assoc", "op", "via", "at", "table", "shape", "when", "topic")
ENTRY = set(KEYS) | {"call", "level", "rules", "reason"}


def _first(to):
    return to[0] if isinstance(to, list) else to


def _matches(e, a):
    """Whether entry e names access a (its curated form): every key it gives equal, `assoc` always (absent = none)."""
    return all(a.get(k) == e[k] for k in KEYS if k in e) and ("assoc" in e or not a.get("assoc"))


def check_locks(oid, op, probs):
    """A statement that only locks is a strict read of the locked class, whose write it serialises: the operation
    writes that class in a transaction that holds it."""
    txs = op.get("transaction")
    txs = txs if isinstance(txs, list) else [txs] if txs else []
    for i, a in enumerate(op.get("accesses") or []):
        if a.get("op") != "lock":
            continue
        w = f"{oid}.accesses[{i}]"
        if a.get("mode") != "read":
            probs.error(w, "a statement that only locks is a read of the locked class; one that "
                           "also changes data is its write (op update)")
        if not a.get("strong"):
            probs.error(w, "a lock read is strong (strict: a lock is taken on the current row)")
        written = any(b.get("mode") == "write" and b.get("class") == a.get("class") and b.get("op") != "lock"
                      for b in op.get("accesses") or [])
        held = [t for t in txs if a.get("class") in (t.get("classes") or [])]
        if not (written and held):
            probs.error(w, f"a lock read without a write of the locked class ({a.get('class')}) in its transaction")
        elif len(held) > 1 and sum(_inside(a.get("_at"), t.get("_at")) for t in held) != 1:
            # the accesses do not say which transaction they run in: with one transaction holding the class, the
            # operation's write of it is in that transaction; with several, the lock's line must lie in the function
            # of exactly one of them
            probs.error(w, f"{len(held)} transactions of the operation hold {a.get('class')}: which one the lock and "
                           "the write are in cannot be checked")


def _inside(at, tx_at):
    """Whether evidence `at` (`path:line`) lies in the function annotated at `tx_at` (`path:line` of its
    @Transactional: the first function declared from that line on)."""
    if not at or not tx_at:
        return False
    import gitsrc
    import kt
    (p1, l1), (p2, l2) = (e.rsplit(":", 1) for e in (at, tx_at))
    if p1 != p2:
        return False
    l1, l2 = int(l1.split("-")[0]), int(l2.split("-")[0])
    fns = sorted((gitsrc.line_of(p1, f["start"]), gitsrc.line_of(p1, f["end"])) for f in kt.functions(p1))
    fn = next(((a, b) for a, b in fns if a >= l2), None)
    return fn is not None and fn[0] <= l1 <= fn[1]


def apply(curated, ops, probs, doc=None):
    """Puts `consistency` on every strong read and strong call of `ops` (the output operations, whose accesses and
    calls are the curated ones in the same order); returns the levels and rules for the output's meta. `doc`: the
    parsed consistency file (default curated/consistency.yaml)."""
    doc = doc if doc is not None else yaml.safe_load(FILE.read_text())
    rules = doc.get("rules") or {}
    entries = doc.get("operations") or {}
    cur = {op["id"]: op for d in curated.values() for op in d.get("operations") or []}
    for oid in entries:
        if oid not in cur:
            probs.error(f"consistency.{oid}", "no such operation")
    for o in ops:
        oid = o["id"]
        op = cur[oid]
        check_locks(oid, op, probs)
        accs = op.get("accesses") or []
        calls = op.get("calls") or []
        reads = [i for i, a in enumerate(accs) if a.get("mode") == "read" and a.get("strong")]
        strong_calls = [i for i, c in enumerate(calls) if c.get("strong")]
        got = {}
        for k, e in enumerate(entries.get(oid) or []):
            w = f"consistency.{oid}[{k}]"
            bad = set(e) - ENTRY
            if bad:
                probs.error(w, f"unknown keys {sorted(bad)}")
            if e.get("level") not in LEVELS:
                probs.error(w, f"level {e.get('level')!r} (one of {', '.join(LEVELS)})")
            if not e.get("rules") or any(r not in rules for r in e["rules"]):
                probs.error(w, f"rules {e.get('rules')!r}: known rule ids of the file's `rules`")
            if not isinstance(e.get("reason"), str) or not e["reason"].strip():
                probs.error(w, "no reason")
            if "call" in e:
                if set(e) & (set(KEYS) - {"at"}):
                    probs.error(w, "a call entry names the call by `call` (and `at`) only")
                m = [("call", i) for i in strong_calls if _first(calls[i]["to"]) == e["call"] and
                     ("at" not in e or calls[i].get("at") == e["at"])]
                if not m and any(_first(c["to"]) == e["call"] and c.get("effect") for c in calls):
                    probs.error(w, f"{e['call']} is an effect call: it reads nothing, no level")
                    continue
                alls = [i for i, c in enumerate(calls) if _first(c["to"]) == e["call"]]
            else:
                if "class" not in e:
                    probs.error(w, "an access entry names its class")
                    continue
                m = [("access", i) for i in reads if _matches(e, accs[i])]
                alls = [i for i, a in enumerate(accs) if a.get("mode") == "read" and _matches(e, a)]
            if not m:
                probs.error(w, f"matches nothing{' strong (only a read or call that is not strong)' if alls else ''}: "
                               f"{ {x: v for x, v in e.items() if x not in ('level', 'rules', 'reason')} }")
                continue
            if len(m) > 1:
                probs.error(w, f"ambiguous: matches {len(m)} strong {m[0][0]}{"es" if m[0][0] == "access" else "s"} ({[i for _, i in m]}); add a key")
                continue
            if m[0] in got:
                probs.error(w, f"{m[0][0]} {m[0][1]} has two entries ({got[m[0]]} and {k})")
                continue
            got[m[0]] = k
            target = (o["accesses"] if m[0][0] == "access" else o["calls"])[m[0][1]]
            target["consistency"] = {"level": e.get("level"), "rules": list(e.get("rules") or []),
                                     "reason": e.get("reason")}
            if m[0][0] == "access" and accs[m[0][1]].get("op") == "lock" and e.get("level") != "strict":
                probs.error(w, "a lock read is strict (a lock is always taken on the current row)")
        for i in reads:
            if ("access", i) not in got:
                a = accs[i]
                probs.error(f"{oid}.accesses[{i}]", f"strong read of {a.get('class')}"
                                                    f"{' (assoc ' + a['assoc'] + ')' if a.get('assoc') else ''} "
                                                    f"without a consistency level (curated/consistency.yaml)")
        for i in strong_calls:
            if ("call", i) not in got:
                probs.error(f"{oid}.calls[{i}]", f"strong call of {_first(calls[i]['to'])} without a consistency level "
                                                 "(curated/consistency.yaml)")
    return {"source": "cases/misarch/extract/curated/consistency.yaml (DESIGN.md AB60)",
            "levels": doc.get("levels"), "rules": rules}
