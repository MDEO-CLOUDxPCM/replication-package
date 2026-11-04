"""Draft of a service's curated file (curated/<svc>.yaml): its tables (from the curated file's `tables`) and
every operation candidate with the entry it was found at and the persistence methods reachable
from it (callgraph.py). The draft is the starting point of the curation; build.py never reads it.

    skeleton.py <svc> [...]      writes build/skeleton/<svc>.yaml (never touches curated/)

Operation candidates: GraphQL root fields and resolvable entity types and resolver-like fields of
reference/sdl/<svc>.graphql, topic subscriptions (events.py), HTTP callbacks (@PostMapping /
POST routes that are neither GraphQL nor subscriptions).
"""

import re
import sys
from pathlib import Path

import yaml

import yamlio

import callgraph
import events
import gitsrc
import kt
import persistence
import sdl

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "build" / "skeleton"


def load_tables(svc):
    """The `tables` of curated/<svc>.yaml (empty without the file)."""
    p = HERE / "curated" / f"{svc}.yaml"
    return (yaml.safe_load(p.read_text()) or {}).get("tables") or {} if p.exists() else {}


def table_role(table_lower, tables):
    for t, d in tables.items():
        if t.lower() == table_lower:
            if d["kind"] == "class":
                return d.get("class") or "|".join(d.get("classes", [])), "local", t
            if d["kind"] == "join":
                return "join(" + ",".join(d["joins"]) + ")", "local", t
            return "|".join(d["copyOf"]), "copy", t
    return f"?{table_lower}", "?", table_lower


def anchor_for(path, line):
    """`relpath#text[@n]` for the function declared at `line`."""
    text = gitsrc.lines(path)[line - 1].strip()
    m = re.search(r"fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(", text)
    c = None if m else re.search(r"\bclass\s+(\w+)", text)
    needle = f"fun {m.group(1)}(" if m else f"class {c.group(1)}" if c else text[:60]
    hits = [i + 1 for i, l in enumerate(gitsrc.lines(path)) if needle in l]
    rel = re.sub(r"^services/[^/]+/src/main/kotlin/org/misarch/[^/]+/", "", path)
    rel = re.sub(r"^services/[^/]+/", "", rel)
    n = hits.index(line) + 1 if line in hits else 1
    return f"{rel}#{needle}" + (f"@{n}" if n > 1 else "")


def find_function(svc, cls_pred, name):
    idx = callgraph.index(svc)
    for f in idx["funcs"]:
        if f["name"] == name and cls_pred(f["cls"], idx["classes"].get(f["cls"], {})):
            return f
    return None


def entity_resolvers(svc):
    res = {}
    for path in kt.kotlin_files(svc):
        src = gitsrc.read(path)
        for c in kt.classes(path):
            m = re.search(r"\b(?:DataLoader|Reference)EntityResolver<(\w+)>", c["supertypes"])
            if m:
                # a one-line resolver class of libs/common: its entry is the class line (callgraph.reach_span)
                res[m.group(1)] = {"path": path, "line": gitsrc.line_of(path, c["start"]), "classLine": True}
                continue
            if "FederatedType" not in c["supertypes"]:
                continue
            body = src[c["start"]:c["end"]]
            m = re.search(r'typeName\s*(?::\s*String)?\s*(?:=|get\(\)\s*=)\s*"(\w+)"', body) or \
                re.search(r"typeName[\s\S]{0,80}?(\w+)::class\.simpleName", body) or \
                re.search(r"FederatedType\w*Resolver<(\w+)>", c["supertypes"])
            f = next((f for f in kt.functions(path) if f["cls"] == c["name"] and f["name"] == "resolve"), None)
            if m and f:
                res[m.group(1)] = {**f, "path": path}
    return res


def http_routes(svc, sub_routes):
    handlers = {s["handlerKey"] for s in events.subscriptions(svc) if s["handlerKey"]}
    res = []
    for path in kt.kotlin_files(svc):
        src = gitsrc.read(path)
        for m in re.finditer(r'(?:@(?:Post|Put|Patch)Mapping|\bPOST|\bPUT)\(\s*"([^"]+)"', src):
            route = m.group(1)
            if route.strip("/") in sub_routes or "dapr" in route or "graphql" in route or route == "/":
                continue
            line = gitsrc.line_of(path, m.start())
            nxt = next((g for g in kt.functions(path) if g["start"] > m.start()), None)
            if nxt and "Mapping" in m.group(0) and f"{nxt['cls']}.{nxt['name']}" in handlers:
                continue  # the HTTP route of a @Topic handler
            res.append({"route": route, "path": path, "line": line,
                        "fn": nxt if (nxt and "Mapping" in m.group(0)) else None})
    return res


def skeleton(svc):
    tables = load_tables(svc)
    inv = persistence.inventory(svc)["methods"]
    ops = []
    ents = entity_resolvers(svc)

    def acc_from(reach):
        out = []
        for pm in reach["persistence"]:
            m = inv[pm]
            for mode, tabs in (("read", m["reads"]), ("write", m["writes"])):
                for t in tabs:
                    cls, today, table = table_role(t, tables)
                    out.append({"class": cls, "mode": mode, "count": "TODO", "via": pm, "table": table,
                                "today": today})
        return out

    def add(op_id, kind, trigger, f=None, path=None, line=None, note=None):
        entry = None
        reach = {"persistence": [], "topicsNearPublish": [], "functions": []}
        if f is not None:
            entry = anchor_for(f["path"], f["line"])
            reach = callgraph.reach(svc, f"{f['cls']}.{f['name']}")
        elif path:
            entry = anchor_for(path, line)
            reach = callgraph.reach_span(svc, path, line)
        op = {"id": op_id, "kind": kind, "trigger": trigger, "entry": entry or "TODO", "feature": "TODO"}
        if note:
            op["note"] = note
        op["accesses"] = acc_from(reach)
        if reach["topicsNearPublish"]:
            op["publishes"] = [{"topic": t, "at": "TODO", "payload": "TODO"} for t in reach["topicsNearPublish"]]
        op["reach"] = reach["persistence"]
        ops.append(op)

    is_root = lambda root: (lambda cls, c: cls == root or bool(re.search(rf"\b{root}\b", c.get("supertypes", ""))))
    for o in sdl.operations(svc):
        g = o["graphql"]
        if o["kind"] in ("query", "command"):
            root, name = g.split(".")
            f = find_function(svc, is_root(root), name)
            add(f"{svc}.{name}", o["kind"], {"graphql": g}, f, note=None if f else "entry not found automatically")
        elif o["kind"] == "entity":
            t = re.match(r"_entities\((\w+)\)", g).group(1)
            f = ents.get(t)
            if f and f.get("classLine"):
                add(f"{svc}._entities.{t}", "query", {"graphql": g}, path=f["path"], line=f["line"])
            else:
                add(f"{svc}._entities.{t}", "query", {"graphql": g}, f, note=None if f else "no resolver class found")
        else:
            t, name = g.split(".")
            f = find_function(svc, lambda cls, c: cls == t or (cls or "").startswith(t), name)
            if f is None:
                continue  # a plain property: no work of its own
            add(f"{svc}.{t}.{name}", "query", {"graphql": g}, f)
    subs = events.subscriptions(svc)
    for s in subs:
        tname = s["topic"]
        op_id = f"{svc}.on:{tname}"
        if s["handlerKey"]:
            f = find_function(svc, lambda cls, c: f"{cls}" == s["handlerKey"].split(".")[0], s["handlerKey"].split(".")[1])
            add(op_id, "reaction", {"topic": tname}, f)
        elif s["handler"]:
            p, l = s["handler"].rsplit(":", 1)
            add(op_id, "reaction", {"topic": tname}, path=p, line=int(l),
                note="route lambda" + (" shared by several topics: split by topic" if sum(1 for x in subs if x["route"] == s["route"]) > 1 else ""))
        else:
            add(op_id, "reaction", {"topic": tname}, note="handler not found")
    for r in http_routes(svc, {(s["route"] or "").strip("/") for s in subs}):
        if r["fn"]:
            add(f"{svc}.http:{r['route']}", "reaction", {"http": r["route"]}, {**r["fn"], "path": r["path"]})
        else:
            add(f"{svc}.http:{r['route']}", "reaction", {"http": r["route"]}, path=r["path"], line=r["line"])
    return {"service": svc, "commit": gitsrc.commit(), "tables": tables, "operations": ops}


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "--init":
        # one-time: start curated/<svc>.yaml from the draft (never overwrites)
        for svc in sys.argv[2:]:
            target = HERE / "curated" / f"{svc}.yaml"
            if target.exists():
                print("exists:", target)
                continue
            doc = skeleton(svc)
            doc.pop("commit")
            for op in doc["operations"]:
                op.pop("reach", None)
            target.write_text(f"# {svc}: draft from skeleton.py, to be curated (schema: build.py docstring)\n" + yamlio.dump(doc))
            print("init", target)
        sys.exit(0)
    for svc in sys.argv[1:]:
        doc = skeleton(svc)
        (OUT / f"{svc}.yaml").write_text(yamlio.dump(doc))
        print(svc, len(doc["operations"]), "operations ->", OUT / f"{svc}.yaml")
