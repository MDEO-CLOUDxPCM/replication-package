"""Assemble misarch-domain.json from the validated curated files and the automatic inventories,
and compute the coupling analysis (build.py calls this after validation).

Everything is deterministic: lists are sorted, no timestamps; evidence is `path:line` on the
commit in meta.commit.
"""

import json
import math
import re
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

import yaml

import consistency
import events
import gitsrc
import persistence
import requests as reqs
import sdl
import sql_schema

HERE = Path(__file__).resolve().parent
MSA_MODEL = HERE.parent / "domain" / "msa" / "misarch-kotlin.m"
DEMANDS = HERE.parent / "timing" / "calibration" / "results-kotlin" / "demands.json"


def _field_types(oid):
    """(type the operation is a field of, type of the objects it resolves) from its subgraph's schema
    (reference/schemas): `<svc>._entities.<T>` (None, T), `<svc>.<T>.<f>` (T, f's type, a Connection's node
    type), `<svc>.<f>` (Query or Mutation, f's type)."""
    parts = oid.split(".")
    svc = parts[0]
    if len(parts) == 3 and parts[1] == "_entities":
        return None, parts[2]
    s = sdl.parse(f"reference/schemas/{svc}.graphql")["types"]
    tname, fname = (parts[1], parts[2]) if len(parts) == 3 else \
        (next((t for t in ("Query", "Mutation") if parts[1] in s.get(t, {}).get("fields", {})), None), parts[1])
    f = s.get(tname, {}).get("fields", {}).get(fname)
    if f is None:
        return tname, None
    base = f["base"]
    if base.endswith("Connection") and "nodes" in s.get(base, {}).get("fields", {}):
        base = s[base]["fields"]["nodes"]["base"]
    return (None if tname in ("Query", "Mutation") else tname), base


def _with_parents(c, oid, probs):
    """A call whose `to` lists several fields of one invocation's query (the first the field the caller calls, the
    others fields of fields, in the document's order) gets `parents` after `to`: per entry the index of the entry
    whose objects it is resolved on (None for the first), the latest earlier entry that resolves objects of the
    type the field belongs to (as a request plan's `parent`, requests.py)."""
    if not isinstance(c["to"], list) or len(c["to"]) < 2:
        return c
    types = [_field_types(x) for x in c["to"]]
    for x, (_, t) in zip(c["to"], types):
        if t is None:
            probs.error(oid, f"call {c['to']}: {x} is not a field of its subgraph's schema")
    parents = []
    for i, (on, _) in enumerate(types):
        if i == 0:
            if on is not None:
                probs.error(oid, f"call {c['to']}: the first entry {c['to'][0]} is a field of {on}, not a root")
            parents.append(None)
            continue
        js = [j for j in range(i) if types[j][1] == on]
        if not js:
            probs.error(oid, f"call {c['to']}: no earlier entry resolves the {on} objects of {c['to'][i]}")
        parents.append(js[-1] if js else None)
    out = {}
    for k, v in c.items():
        out[k] = v
        if k == "to":
            out["parents"] = parents
    return out


def _strip(d):
    """Drop internal keys (`_at`, `_entry`) and None values."""
    if isinstance(d, dict):
        return {k: _strip(v) for k, v in d.items() if not (isinstance(k, str) and k.startswith("_")) and v is not None}
    if isinstance(d, list):
        return [_strip(x) for x in d]
    return d


def expected_statements(a):
    """Expected statements per execution where it is a number, else the expression."""
    times = a.get("times", 1)
    p = a.get("prob")
    base = {"one": 1, "list": 1, "batch": 1, "optional": 1}.get(a.get("shape"))
    if base is None:
        return f"{times} x |{a.get('per', '?')}|" if times != 1 else f"|{a.get('per', '?')}|"
    n = base * (times if isinstance(times, (int, float)) else 1)
    if isinstance(p, (int, float)):
        n *= p
    elif a.get("shape") == "optional" or a.get("when"):
        return f"{n} if {a.get('when', 'condition')}"
    return n


def load_msa():
    """Operations (with demands), entities and data needs of the msa seed model."""
    src = MSA_MODEL.read_text()
    ops, ents, needs = {}, {}, []
    for m in re.finditer(r'^op_\w+ : Operation \{ name = "(\w+)"  kind = OpKind\.(\w+)  rate = ([\d.]+)  cpuMs = ([\d.]+)  '
                         r'dbMs = ([\d.]+)  sloMs = ([\d.]+) \}(?:\s*//\s*(.*))?$', src, re.M):
        ops[m.group(1)] = {"kind": m.group(2), "rate": float(m.group(3)), "cpuMs": float(m.group(4)),
                           "dbMs": float(m.group(5)), "comment": m.group(7)}
    for m in re.finditer(r'^e_\w+ : Entity \{ name = "(\w+)"  sizeKb = ([\d.]+) \}(?:\s*//\s*(.*))?$', src, re.M):
        ents[m.group(1)] = {"sizeKb": float(m.group(2)), "comment": m.group(3)}
    for m in re.finditer(r'^n_\w+ : DataNeed \{ name = "([\w>\- ()]+)"  kind = NeedKind\.(\w+)  callsPerOp = ([\d.]+)  '
                         r'strong = (\w+)(?:  carriedByProcess = (\w+))? \}(?:\s*//\s*(.*))?$', src, re.M):
        name = m.group(1)
        cons, tgt = name.split("->")
        needs.append({"name": name, "consumer": cons, "target": tgt.split(" ")[0], "kind": m.group(2),
                      "callsPerOp": float(m.group(3)), "strong": m.group(4) == "true",
                      "carriedByProcess": m.group(5) == "true", "comment": m.group(6)})
    # mechanism of each need today: the links section `n_x.mechanism -- m_y`
    mech = dict(re.findall(r"^(n_\w+)\.mechanism -- (m_\w+)", src, re.M))
    prov = dict(re.findall(r"^(n_\w+)\.provider -- op_(\w+)", src, re.M))
    ids = re.findall(r"^(n_\w+) : DataNeed", src, re.M)
    for nid, n in zip(ids, needs):
        n["id"], n["mechanismToday"] = nid, mech.get(nid, "").replace("m_", "")
        n["provider"] = prov.get(nid)
    return ops, ents, needs


def bell(n):
    row = [1]
    for _ in range(n):
        nxt = [row[-1]]
        for x in row:
            nxt.append(nxt[-1] + x)
        row = nxt
    return row[0]


def assemble(curated, classes, probs):
    glob = yaml.safe_load((HERE / "curated" / "global.yaml").read_text())
    svc_tables = {svc: sql_schema.schema(svc) if svc in sql_schema.services_with_db() else ({}, [])
                  for svc in curated}
    owner = {c: d["service"] for c, d in classes.items()}

    # ---------------------------------------------------------------- classes, joins, copies
    out_classes, join_tables, copies, references = [], [], [], []
    table_role = {}
    for svc, doc in sorted(curated.items()):
        tables, _ = svc_tables[svc]
        for tname, d in doc["tables"].items():
            t = tables.get(tname.lower())
            info = {"service": svc, "table": tname if t else None,
                    "columns": len(t["columns"]) if t else None,
                    "attributes": sorted(t["columns"]) if t else [],
                    "rowBytes": t["rowBytes"] if t else None,
                    "evidence": t["evidence"] if t else gitsrc.resolve(d["evidence"], svc) if d.get("evidence") else None}
            if d["kind"] == "class":
                names = d.get("classes") or [d["class"]]
                for c in names:
                    out_classes.append({"name": c, **info, "storage": d.get("storage", "postgres"),
                                        "sharedTable": len(names) > 1 or None,
                                        "discriminator": d.get("discriminator"), "note": d.get("note")})
                table_role[(svc, tname.lower())] = ("class", names)
            elif d["kind"] == "join":
                join_tables.append({**info, "joins": d["joins"], "note": d.get("note")})
                table_role[(svc, tname.lower())] = ("join", d["joins"])
            else:
                copies.append({"id": f"{svc}.{tname}", **info, "copyOf": d["copyOf"], "fedBy": d.get("fedBy", []),
                               "process": d.get("process") or None, "own": d.get("own"), "note": d.get("note")})
                table_role[(svc, tname.lower())] = ("copy", list(d["copyOf"]))
            # references
            for r in d.get("refs") or []:
                src_cls = r.get("of") or (d.get("class") if d["kind"] == "class" else None)
                # a copy's columns are the copied data, but for an association the copy's service owns (`of`: the
                # class whose rows hold it, e.g. return's OrderItem.returnedWith)
                if d["kind"] == "copy" and not r.get("of"):
                    continue
                fk = None
                if t:
                    fk = next((f for f in t["foreignKeys"] if f["column"].lower() == r["attr"].lower()), None)
                col = t["columns"].get(next((c for c in t["columns"] if c.lower() == r["attr"].lower()), ""), {}) if t else {}
                references.append({
                    "id": f"{src_cls}.{r.get('field') or r['attr']}", "from": src_cls, "to": r["to"], "attr": r["attr"],
                    "inverse": f"{r['to']}.{r['inverse']}" if r.get("inverse") else None,
                    "inCopy": f"{svc}.{tname}" if d["kind"] == "copy" else None,
                    "kind": r["kind"], "mult": r["mult"], "snapshot": r.get("snapshot") or None,
                    "storage": "fk" if fk else ("id array" if col.get("type", "").endswith("[]") else
                                                "json" if col.get("type", "").startswith("json") else "id"),
                    "crossServiceToday": owner.get(src_cls) != owner.get(r["to"]),
                    "evidence": fk["evidence"] if fk else info["evidence"], "note": r.get("note")})
            if d["kind"] == "join":
                a, b = d["joins"]
                # named by the field of its first class (Product.categories), the other end's field its inverse
                references.append({"id": f"{a}.{d['field']}", "from": a, "to": b, "attr": None,
                                   "inverse": f"{b}.{d['inverse']}" if d.get("inverse") else None, "kind": "association",
                                   "mult": "*", "storage": f"join table {svc}.{tname}",
                                   "crossServiceToday": owner.get(a) != owner.get(b), "evidence": info["evidence"]})
    # foreign keys not covered by a curated ref (consistency check)
    for svc, (tables, _) in svc_tables.items():
        for t in tables.values():
            for f in t["foreignKeys"]:
                role = table_role.get((svc, t["table"].lower()))
                if role and role[0] == "class" and not any(r["attr"] and r["attr"].lower() == f["column"].lower() and
                                                           r["from"] in role[1] for r in references):
                    probs.warn(svc, f"foreign key {t['table']}.{f['column']} -> {f['references']} has no curated ref")

    # ---------------------------------------------------------------- operations
    ops = []
    op_by_id = {}
    for svc, doc in sorted(curated.items()):
        for op in doc.get("operations") or []:
            o = {"id": op["id"], "service": svc, "kind": op["kind"], "trigger": op["trigger"],
                 "entry": op.get("_entry"), "feature": op.get("feature"),
                 "domain": op.get("mechanism") != "copy", "mechanism": op.get("mechanism"),
                 "trivial": op.get("trivial") or None, "sagaStep": op.get("sagaStep"), "note": op.get("note")}
            txs = op.get("transaction")
            txs = txs if isinstance(txs, list) else [txs] if txs else []
            o["transactions"] = [{**_strip(tx), "evidence": tx.get("_at")} for tx in txs]
            o["accesses"] = []
            for a in op.get("accesses") or []:
                aa = _strip(a)
                aa["evidence"] = a.get("_at")
                aa["statements"] = expected_statements(a)
                aa["ownerToday"] = owner.get(a["class"])
                if a.get("assoc"):
                    # the association the access reads or writes (a join table, or the column that holds it)
                    rs = [r["id"] for r in references if r["kind"] == "association" and {r["from"], r["to"]} == {a["class"], a["assoc"]}]
                    if len(rs) != 1:
                        probs.error(f"{op['id']}.accesses", f"assoc {a['class']}-{a['assoc']}: {len(rs)} references {rs}")
                    aa["reference"] = rs[0] if rs else None
                aa["foreignToday"] = owner.get(a["class"]) != svc
                o["accesses"].append(aa)
            o["calls"] = [{**_strip(c), "evidence": c.get("_at")} for c in op.get("calls") or []]
            o["publishes"] = [{**_strip(p), "evidence": p.get("_at")} for p in op.get("publishes") or []]
            o["notReached"] = op.get("notReached")
            ops.append(_strip(o))
            op_by_id[o["id"]] = ops[-1]
    for o in ops:
        for c in o.get("calls", []):
            for tgt in (c["to"] if isinstance(c["to"], list) else [c["to"]]):
                if not tgt.startswith("simulation.") and tgt not in op_by_id:
                    probs.error(o["id"], f"call target {tgt} is not an operation")
        # one invocation whose query selects fields of fields: `parents` says on whose objects
        # each listed field is resolved
        o["calls"] = [_with_parents(c, o["id"], probs) for c in o.get("calls", [])]
    # the consistency levels of the strong reads and calls, and the lock reads' check (consistency.py)
    consistency_meta = consistency.apply(curated, ops, probs)

    # an operation's own data in its service's copy table (docs/model.md §3): through federation a service owns fields of
    # an entity whose home is another service, held in its copy (or representation) table of that class, and the copy
    # that comes with a saga message is the receiving handler's own record of it. An access of a domain operation
    # touches its own data (`own`: the copy) when it navigates a reference held in the copy (`refs` with `of`:
    # return's OrderItem.returnedWith), when it writes an event-carried copy (`process`) on the message that feeds it
    # (its trigger topic in `fedBy`: payment's open order, shipment's order items), or when the curated access says so
    # (`own: true`: a read of the own columns and the id only, or of the service's own record). Not copy maintenance
    # (`mechanism: copy`: the copy mechanism itself)
    copy_of = {tuple(cp["id"].lower().split(".", 1)): cp for cp in copies}
    in_copy = {r["id"]: r["inCopy"] for r in references if r.get("inCopy")}
    for o in ops:
        for i, a in enumerate(o.get("accesses", [])):
            cp = copy_of.get((o["service"].lower(), (a.get("table") or "").lower())) if a.get("today") == "copy" else None
            curated_own = a.pop("own", None)
            own = cp is not None and o["domain"] and (
                curated_own is True or (a.get("reference") and in_copy.get(a["reference"]) == cp["id"]) or
                (a["mode"] == "write" and cp.get("process") and o["trigger"].get("topic") in cp["fedBy"]))
            if curated_own is not None and (curated_own is not True or not own):
                probs.error(f"{o['id']}.accesses[{i}]", f"own: {curated_own!r} needs `true` on a domain operation's "
                                                        "access of a copy table of its own service (today copy)")
            if own:
                a["own"] = cp["id"]

    # copies: who writes and who reads them
    for cp in copies:
        svc, table = cp["id"].split(".", 1)
        cp["writers"] = sorted({o["id"] for o in ops if o["service"] == svc and any(
            a.get("table", "").lower() == table.lower() and a["mode"] == "write" for a in o.get("accesses", []))})
        cp["readers"] = sorted({o["id"] for o in ops if o["service"] == svc and any(
            a.get("table", "").lower() == table.lower() and a["mode"] == "read" for a in o.get("accesses", []))})
        cp["feeders"] = sorted({o["id"] for o in ops for p in o.get("publishes", []) if p["topic"] in cp["fedBy"]})

    # ---------------------------------------------------------------- events
    topics = defaultdict(lambda: {"publishers": [], "subscribers": []})
    for o in ops:
        for p in o.get("publishes", []):
            topics[p["topic"]]["publishers"].append({"op": o["id"], "payload": p.get("payload"), "prob": p.get("prob"),
                                                     "when": p.get("when"), "evidence": p.get("evidence")})
        if "topic" in o["trigger"]:
            topics[o["trigger"]["topic"]]["subscribers"].append({"op": o["id"], "service": o["service"],
                                                                 "copy": not o["domain"], "evidence": o.get("entry")})
    ext_publishers = {"user/user/create": "Keycloak (registration), outside misarch-kotlin"}
    event_list = []
    for t in sorted(topics):
        d = topics[t]
        subs = d["subscribers"]
        role = "unsubscribed" if not subs else "replication" if all(s["copy"] for s in subs) else \
            "process" if not any(s["copy"] for s in subs) else "mixed"
        event_list.append(_strip({"topic": t, "role": role, "publishers": d["publishers"], "subscribers": subs,
                                  "externalPublisher": ext_publishers.get(t),
                                  "neverPublished": (not d["publishers"] and t not in ext_publishers) or None}))

    # ---------------------------------------------------------------- calls today
    calls = []
    for o in ops:
        for c in o.get("calls", []):
            calls.append({"from": o["id"], **c})
    fed = sdl.federation()
    gateway = []
    for tname, e in sorted(fed["entities"].items()):
        for s, d in sorted(e["subgraphs"].items()):
            if s != e["owner"] and d["fields"]:
                gateway.append({"entity": tname, "owner": e["owner"], "subgraph": s, "kind": "contributes",
                                "fields": d["fields"], "entityResolver": f"{s}._entities.{tname}",
                                "resolverOps": sorted(x for x in (f"{s}.{tname}.{f}" for f in d["fields"]) if x in op_by_id),
                                "evidence": d["evidence"]})
            elif d["stub"] and s != e["owner"]:
                gateway.append({"entity": tname, "owner": e["owner"], "subgraph": s, "kind": "stub",
                                "entityResolver": f"{e['owner']}._entities.{tname}", "evidence": d["evidence"]})

    # ---------------------------------------------------------------- joins (cross-class statements)
    joins = []
    for svc in sorted(curated):
        inv = persistence.inventory(svc)["methods"]
        used = defaultdict(set)
        for o in ops:
            if o["service"] == svc:
                for a in o.get("accesses", []):
                    if a.get("via"):
                        used[a["via"]].add(o["id"])
        curated_tables = defaultdict(set)
        for o in ops:
            if o["service"] == svc:
                for a in o.get("accesses", []):
                    if a.get("via") and a.get("today") in ("local", "copy") and a.get("table"):
                        curated_tables[a["via"]].add(a["table"].lower())
        for key, m in sorted(inv.items()):
            stmts = list(m["joins"])
            if m.get("dynamicTables") and m["statements"]:
                # a table name passed in (`$source`): take the tables the curated accesses name
                st0 = m["statements"][0]
                extra = sorted(curated_tables[key] - set(st0["reads"]) - set(st0["writes"]))
                if extra and (st0["reads"] or st0["writes"]) and len(set(st0["reads"]) | set(extra)) > 1:
                    stmts = [{**st0, "reads": sorted(set(st0["reads"]) | set(extra))}]
            for st in stmts:
                tabs = sorted(set(st["reads"]) | set(st["writes"]))
                roles = [table_role.get((svc, t), ("?", [t])) for t in tabs]
                cls = sorted({c for r in roles for c in r[1]})
                if len(cls) < 2 and not any(r[0] == "join" for r in roles):
                    continue
                own = sorted({c for r in roles if r[0] == "class" for c in r[1]})
                joins.append({"id": f"{svc}.{key}#{st['evidence'].rsplit(':', 1)[1]}", "service": svc, "method": key,
                              "tables": tabs, "classes": cls, "ownClasses": own,
                              "kinds": sorted({r[0] for r in roles}),
                              "writes": st["writes"], "sql": re.sub(r"\s+", " ", st["sql"])[:300],
                              "evidence": st["evidence"], "usedBy": sorted(used.get(key, []))})
        for tr in svc_tables[svc][1]:
            tabs = sorted(set(tr["readsTables"]) | set(tr["writesTables"]) | {tr["table"]})
            if len(tabs) < 2:
                continue
            roles = [table_role.get((svc, t), ("?", [t])) for t in tabs]
            joins.append({"id": f"{svc}.trigger.{tr['name']}", "service": svc, "method": f"trigger {tr['name']} ({tr['events']} ON {tr['table']})",
                          "tables": tabs, "classes": sorted({c for r in roles for c in r[1]}),
                          "ownClasses": sorted({c for r in roles if r[0] == "class" for c in r[1]}),
                          "kinds": sorted({r[0] for r in roles}), "writes": tr["writesTables"],
                          "trigger": True, "evidence": tr["evidence"],
                          "usedBy": sorted({o["id"] for o in ops if o["service"] == svc and any(
                              a.get("table", "").lower() == tr["table"] and a["mode"] == "write" for a in o.get("accesses", []))})})

    # ---------------------------------------------------------------- transactions
    transactions = []
    for o in ops:
        for tx in o.get("transactions", []):
            written = sorted({a["class"] for a in o.get("accesses", []) if a["mode"] == "write" and a.get("today") == "local"})
            cls = sorted(set(tx.get("classes") or written))
            transactions.append(_strip({"op": o["id"], "service": o["service"], "classes": cls,
                                        "domainClassesWritten": sorted(c for c in cls if c in written),
                                        "multiClass": len([c for c in cls if c in written]) > 1,
                                        "publishInside": tx.get("publishInside"), "note": tx.get("note"),
                                        "evidence": tx.get("evidence"), "domainOp": o["domain"]}))

    # ---------------------------------------------------------------- features, sagas
    features = []
    for code, name in glob["features"].items():
        features.append({"code": code, "name": name, "msa": code != "F0",
                         "operations": sorted(o["id"] for o in ops if o.get("feature") == code)})
    sagas = []
    for s in glob.get("sagas", []):
        steps = sorted((o for o in ops if (o.get("sagaStep") or {}).get("saga") == s["name"]), key=lambda o: o["id"])
        sagas.append({**s, "operations": [{"op": o["id"], "role": o["sagaStep"].get("role", "step"),
                                           "trigger": o["trigger"]} for o in steps]})

    # ---------------------------------------------------------------- requests (round-2 workload)
    demands = json.loads(DEMANDS.read_text()) if DEMANDS.exists() else {"requestTypes": {}}
    request_list = []
    for rtype, doc in reqs.documents().items():
        plan = reqs.plan(doc, set(op_by_id))
        meas = demands["requestTypes"].get(rtype, {})
        cpu = defaultdict(dict)
        for c in meas.get("containers", []):
            if c["role"] in ("app", "db") and c["service"] not in ("redis", "experiment-config"):
                cpu[c["service"]][c["role"]] = c["cpuMsPerRequest"]
        request_list.append({"type": rtype, "document": doc, "plan": plan,
                             "measuredCpuMsPerRequest": dict(sorted(cpu.items())) or None,
                             "evidence": f"timing/calibration/scripts/loadgen.py ({reqs.REQUESTS[rtype]})"})

    # ---------------------------------------------------------------- msa mapping
    msa_ops, msa_ents, msa_needs = load_msa()
    mapping = glob.get("msa", {})
    map_ops = mapping.get("operations", {})
    map_ents = mapping.get("entities", {})
    for k in map_ops:
        for x in map_ops[k].get("ops", []):
            if x not in op_by_id:
                probs.error("global.msa", f"operation {x} (msa {k}) unknown")
        if k not in msa_ops:
            probs.error("global.msa", f"msa operation {k} unknown")
    for k in map_ents:
        for c in map_ents[k].get("classes", []):
            if c not in classes:
                probs.error("global.msa", f"class {c} (msa {k}) unknown")
    for k in msa_ops:
        if k not in map_ops:
            probs.warn("global.msa", f"msa operation {k} not mapped")
    # needs: find the access (or event) that realises them
    need_map = []
    overrides = mapping.get("needs", {})
    for n in msa_needs:
        cons = map_ops.get(n["consumer"], {}).get("ops", [])
        tcls = map_ents.get(n["target"], {}).get("classes", [])
        hits = []
        for oid in cons:
            o = op_by_id.get(oid)
            if not o:
                continue
            for i, a in enumerate(o.get("accesses", [])):
                if (a["class"] in tcls or a.get("assoc") in tcls) and a.get("foreignToday"):
                    hits.append({"op": oid, "access": i, "class": a["class"], "mode": a["mode"], "today": a.get("today")})
            if n["kind"] == "COMMAND":
                for p in o.get("publishes", []):
                    for t in event_list:
                        if t["topic"] == p["topic"]:
                            for s in t.get("subscribers", []):
                                so = op_by_id[s["op"]]
                                if any(a["class"] in tcls and a["mode"] == "write" for a in so.get("accesses", [])):
                                    hits.append({"op": oid, "event": p["topic"], "reaction": s["op"]})
        if not hits and n["kind"] == "QUERY" and n.get("provider"):
            # a gateway join today: the provider's operations run in the target's service
            pops = map_ops.get(n["provider"], {}).get("ops", [])
            if pops:
                hits.append({"op": ",".join(cons), "gatewayTo": pops})
        if not hits:
            # the need is local in this cut (msa counts it, e.g. a provider registration)
            for oid in cons:
                for i, a in enumerate(op_by_id.get(oid, {}).get("accesses", [])):
                    if a["class"] in tcls:
                        hits.append({"op": oid, "access": i, "class": a["class"], "mode": a["mode"], "today": a.get("today"),
                                     "local": True})
        ov = overrides.get(n["name"])
        need_map.append(_strip({"need": n["name"], "kind": n["kind"], "callsPerOp": n["callsPerOp"],
                                "strong": n["strong"], "msaMechanismToday": n["mechanismToday"],
                                "matches": hits or None, "override": ov,
                                "status": ov.get("status") if ov and ov.get("status") else ("mapped" if hits else "gap"),
                                "msaEvidence": n["comment"]}))
    msa_out = {"source": "domain/msa/misarch-kotlin.m",
               "demands": "msa cpuMs/dbMs per msa operation (round-2 calibration, calibration-mapped.json)",
               "operations": [], "entities": [], "needs": need_map}
    for k, v in msa_ops.items():
        m = map_ops.get(k, {})
        msa_out["operations"].append(_strip({"msa": k, "kind": v["kind"], "rate": v["rate"], "cpuMs": v["cpuMs"],
                                             "dbMs": v["dbMs"], "ops": m.get("ops"), "request": m.get("request"),
                                             "note": m.get("note"), "status": "mapped" if m.get("ops") else "gap"}))
    for k, v in msa_ents.items():
        m = map_ents.get(k, {})
        msa_out["entities"].append(_strip({"msa": k, "sizeKb": v["sizeKb"], "classes": m.get("classes"),
                                           "note": m.get("note"), "status": "mapped" if m.get("classes") else "gap"}))
    # seed demands per operation: an msa op's cpu split evenly over its mapped ops of its own service
    # (the first op's service), its db over their local accesses
    seeds = {}
    for k, v in msa_ops.items():
        mops = [x for x in map_ops.get(k, {}).get("ops", []) if x in op_by_id]
        if not mops:
            continue
        home = op_by_id[mops[0]]["service"]
        mine = [x for x in mops if op_by_id[x]["service"] == home]
        nacc = sum(len([a for a in op_by_id[x].get("accesses", []) if a.get("today") in ("local", "copy")]) for x in mine)
        for x in mine:
            na = len([a for a in op_by_id[x].get("accesses", []) if a.get("today") in ("local", "copy")])
            s = seeds.setdefault(x, {"cpuMs": 0.0, "dbMs": 0.0, "from": []})
            s["cpuMs"] += v["cpuMs"] / len(mine)
            s["dbMs"] += v["dbMs"] * (na / nacc if nacc else 1 / len(mine))
            s["from"].append(k)
    for x, s in seeds.items():
        s["cpuMs"], s["dbMs"] = round(s["cpuMs"], 4), round(s["dbMs"], 4)
    msa_out["seedDemands"] = {"method": "msa op cpuMs split evenly over the mapped operations of the msa op's home "
                                        "service; dbMs split over their local/copy accesses (per access: dbMs / accesses)",
                              "operations": dict(sorted(seeds.items()))}

    # ---------------------------------------------------------------- coupling
    domain_ops = [o for o in ops if o["domain"] and not o.get("trivial")]
    rate = {}
    for k, m in map_ops.items():
        for x in m.get("ops", []):
            rate[x] = max(rate.get(x, 0.0), msa_ops.get(k, {}).get("rate", 0.0))
    # reactions inherit the rate of their trigger's publishers (x publish probability), along the
    # event chains (msa gives reactions rate 0: they are driven by the processes)
    for _ in range(8):
        new_rate = dict(rate)
        for o in ops:
            t = o["trigger"].get("topic")
            if not t:
                continue
            r = 0.0
            for e in event_list:
                if e["topic"] == t:
                    for p in e.get("publishers", []):
                        pr = p.get("prob") if isinstance(p.get("prob"), (int, float)) else 1.0
                        r += rate.get(p["op"], 0.0) * pr
            new_rate[o["id"]] = max(rate.get(o["id"], 0.0), r)
        rate = new_rate
    co, co_w, ww, tx_pairs, join_pairs = Counter(), Counter(), Counter(), Counter(), Counter()
    touched = {}
    for o in domain_ops:
        cls = sorted({a["class"] for a in o.get("accesses", [])})
        touched[o["id"]] = cls
        for a, b in combinations(cls, 2):
            co[(a, b)] += 1
            co_w[(a, b)] += rate.get(o["id"], 0.0)
        wr = sorted({a["class"] for a in o.get("accesses", []) if a["mode"] == "write"})
        for a, b in combinations(wr, 2):
            ww[(a, b)] += 1
    for t in transactions:
        if t.get("domainOp"):
            for a, b in combinations(t.get("domainClassesWritten", []), 2):
                tx_pairs[(a, b)] += 1
    for j in joins:
        # a statement over a local copy does not bind the copied class: the copy is the mechanism
        dom = [c for c in j["ownClasses"] if c in classes]
        for a, b in combinations(sorted(set(dom)), 2):
            join_pairs[(a, b)] += 1
    comp = Counter()
    for r in references:
        if r["kind"] == "composition":
            comp[tuple(sorted((r["from"], r["to"])))] += 1
    pairs = sorted(set(co) | set(tx_pairs) | set(join_pairs) | set(comp))
    pair_rows = []
    for p in pairs:
        reasons = []
        if tx_pairs[p]:
            reasons.append("transaction")
        if join_pairs[p]:
            reasons.append("join")
        if comp[p]:
            reasons.append("composition")
        pair_rows.append({"a": p[0], "b": p[1], "coAccessOps": co[p], "coAccessRate": round(co_w[p], 4),
                          "writtenTogetherOps": ww[p], "transactions": tx_pairs[p], "joins": join_pairs[p],
                          "composition": bool(comp[p]), "bindings": reasons})
    # atoms: classes connected by a transaction, a join or a composition (inseparable candidates)
    parent = {c: c for c in classes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for r in pair_rows:
        if r["bindings"] and r["a"] in parent and r["b"] in parent:
            parent[find(r["a"])] = find(r["b"])
    atoms = defaultdict(list)
    for c in classes:
        atoms[find(c)].append(c)
    atom_list = sorted((sorted(v) for v in atoms.values()), key=lambda v: (-len(v), v))
    # stricter: only transactions of domain operations and joins on domain operations' paths
    parent = {c: c for c in classes}
    for r in pair_rows:
        if (r["transactions"] or r["joins"]) and r["a"] in parent and r["b"] in parent:
            parent[find(r["a"])] = find(r["b"])
    atoms2 = defaultdict(list)
    for c in classes:
        atoms2[find(c)].append(c)
    atom_list2 = sorted((sorted(v) for v in atoms2.values()), key=lambda v: (-len(v), v))
    # hot: only bindings exercised by operations with an msa rate >= HOT (req/s at loadFactor 1)
    HOT = 0.01
    hot_pairs = set()
    for t in transactions:
        if t.get("domainOp") and rate.get(t["op"], 0.0) >= HOT:
            hot_pairs |= {tuple(sorted(p)) for p in combinations(t.get("domainClassesWritten", []), 2)}
    for j in joins:
        if any(rate.get(o, 0.0) >= HOT for o in j.get("usedBy", [])):
            hot_pairs |= {tuple(sorted(p)) for p in combinations(sorted(set(c for c in j["ownClasses"] if c in classes)), 2)}
    parent = {c: c for c in classes}
    for a, b in hot_pairs:
        parent[find(a)] = find(b)
    atoms3 = defaultdict(list)
    for c in classes:
        atoms3[find(c)].append(c)
    atom_list3 = sorted((sorted(v) for v in atoms3.values()), key=lambda v: (-len(v), v))
    coupling = {
        "pairs": pair_rows,
        "atomsAll": {"rule": "classes connected by a multi-class transaction, a cross-class statement (join, "
                             "trigger) or a composition", "atoms": atom_list, "count": len(atom_list),
                     "bellNumber": bell(len(atom_list))},
        "atomsTxJoin": {"rule": "classes connected by a multi-class transaction or a cross-class statement only",
                        "atoms": atom_list2, "count": len(atom_list2), "bellNumber": bell(len(atom_list2))},
        "atomsHot": {"rule": f"classes connected by a multi-class transaction or a cross-class statement of an "
                             f"operation with msa rate >= {HOT} req/s (loadFactor 1)", "atoms": atom_list3,
                     "count": len(atom_list3), "bellNumber": bell(len(atom_list3))},
        "classesBellNumber": bell(len(classes)),
    }

    # ---------------------------------------------------------------- stats
    acc = [a for o in ops for a in o.get("accesses", [])]
    stats = {
        "tables": sum(len(t[0]) for t in svc_tables.values()),
        "domainClasses": len(out_classes), "joinTables": len(join_tables), "copies": len(copies),
        "references": len(references),
        "referencesCrossServiceToday": sum(1 for r in references if r["crossServiceToday"]),
        "operations": len(ops),
        "operationsByKind": dict(Counter(o["kind"] for o in ops)),
        "operationsByTrigger": dict(Counter(next(iter(o["trigger"])) for o in ops)),
        "domainOperations": len([o for o in ops if o["domain"]]),
        "copyMaintenanceOperations": len([o for o in ops if not o["domain"]]),
        "trivialOperations": len([o for o in ops if o.get("trivial")]),
        "accesses": len(acc),
        "accessesDomainOps": sum(len(o.get("accesses", [])) for o in ops if o["domain"]),
        "accessesByToday": dict(Counter(a.get("today") for a in acc)),
        "accessesByMode": dict(Counter(a["mode"] for a in acc)),
        "accessesByShape": dict(Counter(a.get("shape") for a in acc)),
        "callsToday": len(calls), "gatewayJoins": len([g for g in gateway if g["kind"] == "contributes"]),
        "topics": len(event_list), "publishSites": sum(len(e.get("publishers", [])) for e in event_list),
        "subscriptions": sum(len(e.get("subscribers", [])) for e in event_list),
        "joins": len([j for j in joins if not j.get("trigger")]), "triggers": len([j for j in joins if j.get("trigger")]),
        "transactions": len(transactions), "transactionsMultiClass": len([t for t in transactions if t.get("multiClass")]),
        "features": len([f for f in features if f["operations"]]),
    }
    persistence_out = []
    for svc in sorted(curated):
        for k, m in sorted(persistence.inventory(svc)["methods"].items()):
            if m["how"] == "CRUD (inherited)" and not any(a.get("via") == k for o in ops for a in o.get("accesses", [])):
                continue
            persistence_out.append({"method": k, "service": svc, "how": m["how"], "reads": m["reads"], "writes": m["writes"],
                                    "dynamicTables": m.get("dynamicTables"), "evidence": m["evidence"],
                                    "statements": [{"sql": re.sub(r"\s+", " ", s["sql"])[:300], "evidence": s["evidence"]}
                                                   for s in m["statements"]]})
    return _strip({
        "meta": {
            "source": "misarch-kotlin", "ref": gitsrc.REF, "commit": gitsrc.commit(),
            "generatedBy": "cases/misarch/extract/build.py (curated/*.yaml + automatic inventories)",
            "evidence": "path:line on meta.commit, repository-relative (reference/schemas for federation)",
            "gateway": "../misarch/gateway/supergraph.yaml composes reference/schemas/<svc>.graphql of all 16 subgraphs",
        },
        "stats": stats,
        "consistency": consistency_meta,
        "classes": sorted(out_classes, key=lambda c: c["name"]),
        "joinTables": join_tables, "copies": copies, "references": sorted(references, key=lambda r: r["id"]),
        "operations": ops, "events": event_list, "callsToday": calls, "gatewayJoins": gateway,
        "joins": joins, "transactions": transactions, "features": features, "sagas": sagas,
        "requests": request_list, "msaMapping": msa_out, "coupling": coupling,
        "persistenceMethods": persistence_out,
    })
