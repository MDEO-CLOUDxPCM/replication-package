#!/usr/bin/env python3
"""Assemble domain/misarch-domain.json from misarch-kotlin `main` and the curated files.

    build.py                 validate everything, write ../domain/misarch-domain.json and print the summary
    build.py --out PATH      as build.py, writing PATH instead (an experiment's output, e.g. against another ref)
    build.py --check SVC...  validate the curated files of some services only (no output written)

Automatic (from the code on `main`, via git): tables, columns, keys, indexes, triggers and row
sizes (sql_schema.py), GraphQL operations and federation (sdl.py), persistence methods and their
SQL (persistence.py), subscriptions and publish sites (events.py), reachability (callgraph.py).
Curated (curated/<service>.yaml, one per service, plus curated/global.yaml): what the code means.

Curated service file
--------------------
service: <svc>
tables:                          every table of the service's migrations, exactly once
  <Table>: {kind: class, class: C | classes: [C1, C2], refs: [...], note}
         | {kind: join, joins: [A, B], field: f, inverse: g}   (the reference A.f, the field B.g its other end)
         | {kind: copy, copyOf: {Class: [attrs]}, fedBy: [topics], process: bool, own: {col: meaning}}
  refs: [{attr, to: Class, kind: composition|association, mult: "1"|"0..1"|"*", snapshot: bool, of: Class,
          field: f, inverse: g}]   reference <class>.<field or attr>; a copy's ref only with `of` (an association
                                   the copy's service owns, held in the copy's rows)
operations:
  - id: <svc>.<name>             <svc>.<rootField> | <svc>.<Type>.<field> | <svc>._entities.<Type> |
                                 <svc>.on:<topic>[:<branch>] | <svc>.http:<route> | <svc>.job:<name>
    kind: query | command | reaction
    trigger: {graphql: Query.x | Mutation.x | Type.field | _entities(Type)} | {topic: t} | {http: route} | {schedule: text}
    entry: <anchor>              the function (or route lambda) where the operation starts
    feature: F<n>                msa feature code (curated/global.yaml lists them, N<n> = new ones)
    mechanism: copy              the operation only maintains a local copy (not a domain operation)
    trivial: true                no access, no call, no publish
    sagaStep: {saga: Buy, step: <n>, role: step | compensation}
    transaction: {at: <anchor>, classes: [..], publishInside: bool, note}   (or a list of them)
    accesses:
      - class: C                 domain class (alt: C2 when either type may be read)
        assoc: D                 the access is to the association C-D (a join table, or the column of C's rows
                                 that holds it); the output names its reference (`reference`)
        mode: read | write
        op: select | count | exists | lock | insert | update | upsert | delete
                                 lock: a statement that only locks (SELECT ... FOR UPDATE without a data change, an
                                 advisory lock): a strong read of the locked class, whose write the operation makes in
                                 a transaction holding it; a statement that changes data and locks is its write
                                 (update); see consistency.py
        shape: one | optional | list | batch | perItem    (statements x rows, see REPORT.md)
        rows: <expr>             rows per statement (list/batch)
        per: <expr>              perItem: the collection iterated
        times: <n>               statements per execution when a constant > 1
        prob: <0..1> | when: <condition text>
        strong: bool             the operation needs current data (reads that decide a write/answer); its
                                 consistency level (strict | stale-ok | immutable) is curated in
                                 curated/consistency.yaml; never on a write
        today: local | copy | payload | call | gateway
        own: true                (today copy) the access touches only its service's own data in the copy table: its
                                 own columns and the id, or the service's own record (docs/model.md §3); the output's
                                 `own` names the copy, also for an access of a reference held in the copy (`of`) and
                                 for the write of an event-carried copy (`process`) on the message that feeds it
        table, via: <persistence method>, at: <anchor>, topic: <payload topic>, note
    calls:
      - {to: <operation id>, how: dapr-invoke | http | gateway, at, shape, rows, strong, effect, purpose}
        strong: bool             the caller needs current answers (a read call); its level is curated in
                                 curated/consistency.yaml
        effect: true             the call makes a change outside and reads nothing (a registration with an external
                                 provider, `simulation.*`): sync only, never cached or copied; required on every
                                 `simulation.*` call, never together with `strong`
        to: [<op>, <op>, ...]    one invocation whose query selects fields of fields (S20: _entities(User)
                                 { shoppingcart { shoppingcartItems } }), in the document's order, the first the
                                 field the caller calls; the output adds `parents` (per entry the earlier entry whose
                                 objects it is resolved on, from the subgraph schema's field types)
    publishes:
      - {topic, at, payload: [classes], prob | when}
    notReached: [methods]        callgraph false positives (reachable by name, never executed), with
    notReachedReason: text       the reason
    note: text
excluded:                         SDL fields / subscriptions intentionally not modelled
  - {trigger: ..., reason: ...}

Consistency file (curated/consistency.yaml; levels: docs/model.md §2): `levels`, `rules` (id: text) and per operation id the
entries {class, assoc, op | via | at | table | shape | when | topic, level, rules, reason} (one strong read each,
by its curated identity) or {call: <callee>, at, level, rules, reason}; consistency.py matches them and writes each
strong read's and strong call's `consistency` {level, rules, reason}.

Anchors: `path#text[@n]` (n-th line containing text) or `path:line`, path relative to the service's
Kotlin package, to the service directory, or to the repository.
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import yaml

import callgraph
import events
import gitsrc
import persistence
import sdl
import sql_schema

HERE = Path(__file__).resolve().parent
CURATED = HERE / "curated"
OUT = HERE.parent / "domain" / "misarch-domain.json"

SERVICES = ["address", "catalog", "discount", "inventory", "invoice", "media", "notification", "order",
            "payment", "return", "review", "shipment", "shoppingcart", "tax", "user", "wishlist"]
KINDS = {"query", "command", "reaction"}
MODES = {"read", "write"}
OPS = {"select", "count", "exists", "lock", "insert", "update", "upsert", "delete"}
SHAPES = {"one", "optional", "list", "batch", "perItem"}
TODAY = {"local", "copy", "payload", "call", "gateway"}


class Problems:
    def __init__(self):
        self.errors, self.warnings = [], []

    def error(self, where, msg):
        self.errors.append(f"{where}: {msg}")

    def warn(self, where, msg):
        self.warnings.append(f"{where}: {msg}")


def load(svc):
    p = CURATED / f"{svc}.yaml"
    return yaml.safe_load(p.read_text()) if p.exists() else None


def ev(anchor, svc, probs, where):
    if anchor is None:
        return None
    try:
        return gitsrc.resolve(str(anchor), svc)
    except (gitsrc.AnchorError, KeyError) as e:
        probs.error(where, str(e))
        return None


def domain_classes(curated):
    """{class: {service, table, ...}} from the `kind: class` tables of all services."""
    res = {}
    for svc, doc in curated.items():
        for table, d in (doc.get("tables") or {}).items():
            if d.get("kind") == "class":
                for c in d.get("classes") or [d.get("class")]:
                    res[c] = {"service": svc, "table": table}
    return res


def check_write_flags(a, where, probs):
    """`strong` is a read's flag (the read decides a write or a check; its level in curated/consistency.yaml): a write
    has none, also not one whose check is inside the write (an atomic conditional update)."""
    if a.get("mode") == "write" and "strong" in a:
        probs.error(where, "a write has no `strong` (a read's flag; a check inside the write is the write's own)")


def check_service(svc, doc, classes, probs):
    tables, _ = sql_schema.schema(svc) if svc in sql_schema.services_with_db() else ({}, [])
    cur_tables = {t.lower(): t for t in (doc.get("tables") or {}) if not t.startswith("@")}
    for t in tables:
        if t not in cur_tables:
            probs.error(svc, f"table {tables[t]['table']} not curated")
    for t in cur_tables:
        if t not in tables:
            probs.error(svc, f"curated table {cur_tables[t]} not in the migrations")
    for table, d in (doc.get("tables") or {}).items():
        w = f"{svc}.tables.{table}"
        k = d.get("kind")
        if k not in ("class", "join", "copy"):
            probs.error(w, f"kind {k!r}")
        if k == "join" and not d.get("field"):
            probs.error(w, "a join table names its field (the reference joins[0].field)")
        for c in list((d.get("copyOf") or {}).keys()) + list(d.get("joins") or []) + [r["to"] for r in d.get("refs") or []]:
            if c not in classes:
                probs.error(w, f"unknown class {c}")
        for r in d.get("refs") or []:
            if r.get("attr") and not table.startswith("@") and r["attr"].lower() not in {c.lower() for c in tables.get(table.lower(), {}).get("columns", {})}:
                probs.error(w, f"ref attr {r['attr']} is not a column")
    inv = persistence.inventory(svc)["methods"]
    ids = set()
    for op in doc.get("operations") or []:
        w = op.get("id", "?")
        if not w.startswith(svc + "."):
            probs.error(w, "id must start with the service name")
        if w in ids:
            probs.error(w, "duplicate id")
        ids.add(w)
        if op.get("kind") not in KINDS:
            probs.error(w, f"kind {op.get('kind')!r}")
        if not op.get("feature") or op.get("feature") == "TODO":
            probs.warn(w, "no feature")
        op["_entry"] = ev(op.get("entry"), svc, probs, w + ".entry") if op.get("entry") not in (None, "TODO") else None
        if op["_entry"] is None:
            probs.error(w, "no entry")
        txs = op.get("transaction")
        for tx in (txs if isinstance(txs, list) else [txs] if txs else []):
            tx["_at"] = ev(tx.get("at"), svc, probs, w + ".transaction")
            for c in tx.get("classes") or []:
                if c not in classes:
                    probs.error(w, f"transaction: unknown class {c}")
        for i, a in enumerate(op.get("accesses") or []):
            wa = f"{w}.accesses[{i}]"
            for key in ("class", "alt", "assoc"):
                if a.get(key) is not None and a[key] not in classes:
                    probs.error(wa, f"unknown {key} {a[key]}")
            if a.get("mode") not in MODES:
                probs.error(wa, f"mode {a.get('mode')!r}")
            check_write_flags(a, wa, probs)
            if a.get("op") is not None and a["op"] not in OPS:
                probs.error(wa, f"op {a['op']!r}")
            if a.get("shape") not in SHAPES:
                probs.error(wa, f"shape {a.get('shape')!r}")
            if a.get("today") not in TODAY:
                probs.error(wa, f"today {a.get('today')!r}")
            if a.get("via") and a["via"] not in inv:
                probs.warn(wa, f"via {a['via']} not in the persistence inventory")
            if a.get("today") in ("local", "copy") and a.get("table") and not a["table"].startswith("@") \
                    and a["table"].lower() not in tables:
                probs.error(wa, f"table {a['table']} not in {svc}")
            if a.get("today") in ("local", "copy") and not a.get("table"):
                probs.error(wa, "table missing")
            a["_at"] = ev(a.get("at"), svc, probs, wa + ".at")
            if a.get("today") in ("local", "copy") and a.get("table"):
                td = next((d for t, d in doc["tables"].items() if t.lower() == a["table"].lower()), None)
                if td:
                    owned = td.get("classes") or [td.get("class")] if td["kind"] == "class" else \
                        td.get("joins") if td["kind"] == "join" else list((td.get("copyOf") or {}).keys())
                    if td.get("copyAlso"):
                        owned = list(owned) + list(td["copyAlso"].keys())
                    if a.get("class") not in owned:
                        probs.error(wa, f"class {a.get('class')} is not stored in {a['table']} ({owned})")
                    if (td["kind"] == "copy") != (a["today"] == "copy") and not td.get("copyAlso"):
                        probs.error(wa, f"today {a['today']} but table kind {td['kind']}")
        for i, c in enumerate(op.get("calls") or []):
            c["_at"] = ev(c.get("at"), svc, probs, f"{w}.calls[{i}].at")
            # an effect call changes something outside and reads nothing: marked explicitly, not
            # through the read-consistency flag
            tos = c.get("to") if isinstance(c.get("to"), list) else [c.get("to")]
            if any(str(t).startswith("simulation.") for t in tos) and c.get("effect") is not True:
                probs.error(f"{w}.calls[{i}]", "a call of an external provider (simulation.*) is an effect: effect: true")
            if c.get("effect") is not None and c.get("effect") is not True:
                probs.error(f"{w}.calls[{i}]", f"effect {c['effect']!r}: true or absent")
            if c.get("effect") and "strong" in c:
                probs.error(f"{w}.calls[{i}]", "an effect call reads nothing: no `strong`")
        for i, p in enumerate(op.get("publishes") or []):
            p["_at"] = ev(p.get("at"), svc, probs, f"{w}.publishes[{i}].at")
            for c in p.get("payload") or []:
                if c not in classes:
                    probs.error(f"{w}.publishes[{i}]", f"unknown payload class {c}")
    # coverage: SDL fields and subscriptions
    covered = {json.dumps(o.get("trigger"), sort_keys=True) for o in doc.get("operations") or []}
    covered |= {json.dumps(x.get("trigger"), sort_keys=True) for x in doc.get("excluded") or []}
    for o in sdl.operations(svc):
        trig = {"graphql": o["graphql"]}
        if o["kind"] == "field":
            continue  # field candidates: plain properties need no operation
        if json.dumps(trig, sort_keys=True) not in covered:
            probs.error(svc, f"GraphQL {o['graphql']} not covered (operation or excluded)")
    for s in events.subscriptions(svc):
        if json.dumps({"topic": s["topic"]}, sort_keys=True) not in covered:
            probs.error(svc, f"subscription {s['topic']} not covered")
    return ids


def crosscheck(svc, doc, probs):
    """Compare curated `via`s with the persistence methods reachable from the entry."""
    out = []
    for op in doc.get("operations") or []:
        e = op.get("_entry")
        if not e:
            continue
        path, line = e.rsplit(":", 1)
        fn = next((f for f in callgraph.index(svc)["funcs"] if f["path"] == path and f["line"] == int(line)), None)
        r = callgraph.reach(svc, f"{fn['cls']}.{fn['name']}") if fn else callgraph.reach_span(svc, path, int(line))
        reach = set(r["persistence"])
        cur = {a.get("via") for a in op.get("accesses") or [] if a.get("via")}
        missing = sorted(reach - cur - set(op.get("notReached") or []))
        extra = sorted(cur - reach)
        if missing:
            probs.warn(op["id"], f"reachable but not curated: {missing}")
        if extra:
            out.append((op["id"], extra))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", nargs="*")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    curated = {svc: load(svc) for svc in SERVICES}
    missing = [s for s, d in curated.items() if d is None]
    curated = {s: d for s, d in curated.items() if d is not None}
    classes = domain_classes(curated)
    probs = Problems()
    targets = args.check if args.check is not None and args.check else list(curated)
    for svc in targets:
        if svc not in curated:
            probs.error(svc, "no curated file")
            continue
        check_service(svc, curated[svc], classes, probs)
        crosscheck(svc, curated[svc], probs)
    for w in probs.warnings:
        print("WARN ", w)
    for e in probs.errors:
        print("ERROR", e)
    print(f"{len(probs.errors)} error(s), {len(probs.warnings)} warning(s); services without a file: {missing}")
    if args.check is not None:
        sys.exit(1 if probs.errors else 0)
    import assemble
    n_err, n_warn = len(probs.errors), len(probs.warnings)
    doc = assemble.assemble(curated, classes, probs)
    # the problems found while assembling (calls' parents, consistency levels, lock reads)
    for w in probs.warnings[n_warn:]:
        print("WARN ", w)
    for e in probs.errors[n_err:]:
        print("ERROR", e)
    if len(probs.errors) > n_err or len(probs.warnings) > n_warn:
        print(f"assembling: {len(probs.errors) - n_err} error(s), {len(probs.warnings) - n_warn} warning(s)")
    if probs.errors:
        print("not written (errors):", args.out)
        sys.exit(1)
    args.out.write_text(json.dumps(doc, indent=1, sort_keys=False) + "\n")
    print("wrote", args.out)


if __name__ == "__main__":
    main()
