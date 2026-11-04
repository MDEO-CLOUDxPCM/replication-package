"""GraphQL SDL of every subgraph: queries, mutations, entity types, field resolvers, federation joins.

Sources on `main`: reference/sdl/<svc>.graphql (the live `_service { sdl }` the ports reproduce,
SdlComparisonTest) and reference/schemas/<svc>.graphql (what the gateway composes its supergraph
from: ../misarch/gateway/supergraph.yaml lists the 16 files; the gateway image is unchanged).
Federation is computed from reference/schemas, the operations from reference/sdl.
"""

import functools
import re

import gitsrc

BUILTIN_SCALARS = {"String", "Int", "Float", "Boolean", "ID"}


def _clean(src):
    src = re.sub(r'"""[\s\S]*?"""', lambda m: re.sub(r"[^\n]", " ", m.group(0)), src)
    src = re.sub(r'"(?:[^"\\\n]|\\.)*"', lambda m: '"' + " " * (len(m.group(0)) - 2) + '"', src)
    return re.sub(r"#[^\n]*", "", src)


@functools.lru_cache(maxsize=None)
def parse(path):
    raw = gitsrc.read(path)
    src = _clean(raw)
    types, scalars, enums, inputs = {}, set(), set(), set()
    for m in re.finditer(r"\bscalar\s+(\w+)", src):
        scalars.add(m.group(1))
    for m in re.finditer(r"\benum\s+(\w+)", src):
        enums.add(m.group(1))
    for m in re.finditer(r"\binput\s+(\w+)", src):
        inputs.add(m.group(1))
    for m in re.finditer(r"\b(extend\s+)?(type|interface)\s+(\w+)([^{]*)\{", src):
        name, hdr = m.group(3), m.group(4)
        depth, j = 1, m.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(src[j], 0)
            j += 1
        body = src[m.end():j - 1]
        fields = {}
        for fm in re.finditer(r"(\w+)\s*(\((?:[^()]|\([^()]*\))*\))?\s*:\s*([\[\]\w!]+)([^\n]*)", body):
            fname, args, ftype, rest = fm.groups()
            if fname in fields:
                continue
            fields[fname] = {
                "args": re.findall(r"(\w+)\s*:", args or ""),
                "type": ftype, "base": re.sub(r"[\[\]!]", "", ftype), "list": "[" in ftype,
                "directives": re.findall(r"@(\w+)", rest),
                "line": gitsrc.line_of(path, m.end() + fm.start()),
            }
        # header `@key(fields: "...")`: the field set text is blanked by _clean, take it from raw
        keys = re.findall(r'@key\(\s*fields\s*:\s*"([^"]*)"(?:\s*,\s*resolvable\s*:\s*(\w+))?', raw[m.start():m.end()])
        t = types.setdefault(name, {"name": name, "kind": m.group(2), "fields": {}, "keys": [],
                                    "resolvable": True, "extend": bool(m.group(1)),
                                    "implements": re.findall(r"\b(\w+)\b", re.sub(r".*implements", "", hdr)) if "implements" in hdr else [],
                                    "line": gitsrc.line_of(path, m.start())})
        t["fields"].update(fields)
        for k, res in keys:
            t["keys"].append(k)
            if res == "false":
                t["resolvable"] = False
        t["shareable"] = "@shareable" in hdr
    return {"types": types, "scalars": scalars | BUILTIN_SCALARS, "enums": enums, "inputs": inputs, "path": path}


def services():
    return sorted(f.rsplit("/", 1)[1][:-8] for f in gitsrc.glob("reference/sdl/", ".graphql"))


def is_leaf(schema, base):
    return base in schema["scalars"] or base in schema["enums"]


def operations(svc):
    """Root fields and resolver candidates of one subgraph (reference/sdl)."""
    s = parse(f"reference/sdl/{svc}.graphql")
    path = s["path"]
    ops = []
    for root, kind in (("Query", "query"), ("Mutation", "command")):
        for fname, f in s["types"].get(root, {}).get("fields", {}).items():
            if fname.startswith("_"):
                continue
            ops.append({"service": svc, "graphql": f"{root}.{fname}", "kind": kind, "returns": f["type"],
                        "evidence": f"{path}:{f['line']}"})
    for tname, t in s["types"].items():
        if tname in ("Query", "Mutation") or t["kind"] == "interface":
            continue
        if t["keys"] and t["resolvable"]:
            ops.append({"service": svc, "graphql": f"_entities({tname})", "kind": "entity",
                        "keyFields": t["keys"], "evidence": f"{path}:{t['line']}"})
        fed = federation()["entities"].get(tname)
        contributed = bool(fed and fed["owner"] not in (None, svc))
        for fname, f in t["fields"].items():
            if f["args"] or not is_leaf(s, f["base"]) or (contributed and fname not in fed["keys"]):
                if tname.endswith("Connection") and fname in ("nodes", "pageInfo", "edges"):
                    continue
                ops.append({"service": svc, "graphql": f"{tname}.{fname}", "kind": "field",
                            "returns": f["type"], "args": f["args"], "evidence": f"{path}:{f['line']}"})
    return ops


def _key_fields(t):
    return {x for k in t["keys"] for x in re.findall(r"\w+", k)}


@functools.lru_cache(maxsize=None)
def federation():
    """Entity types across subgraphs (reference/schemas): owner, contributors, stubs, joins.

    owner: the subgraph whose definition of the type has the most non-key fields that no other
    subgraph defines as well (ties: none). A join is a field of an entity that the gateway must
    fetch from another subgraph than the one that returned the entity: every non-key field a
    non-owner contributes (`contributes`), and, for entities referenced as stubs, the owner's fields.
    """
    schemas = {svc: parse(f"reference/schemas/{svc}.graphql") for svc in services()}
    ents = {}
    for svc, s in schemas.items():
        for tname, t in s["types"].items():
            if t["keys"]:
                ents.setdefault(tname, {})[svc] = t
    result = {}
    for tname, defs in sorted(ents.items()):
        keyf = set().union(*(_key_fields(t) for t in defs.values()))
        own = {svc: {f for f in t["fields"] if f not in keyf} for svc, t in defs.items()}
        best = max(own, key=lambda s: (len(own[s]), s))
        owner = best if own[best] else None
        entry = {"type": tname, "owner": owner, "keys": sorted(keyf), "subgraphs": {}}
        for svc, t in defs.items():
            fields = sorted(own[svc])
            entry["subgraphs"][svc] = {
                "fields": fields, "stub": not fields, "resolvable": t["resolvable"],
                "evidence": f"reference/schemas/{svc}.graphql:{t['line']}",
            }
        result[tname] = entry
    # references: fields of any type returning an entity type
    refs = []
    for svc, s in schemas.items():
        for tname, t in s["types"].items():
            for fname, f in t["fields"].items():
                if f["base"] in result and f["base"] != tname or (f["base"] in result and tname in ("Query", "Mutation")):
                    refs.append({"service": svc, "field": f"{tname}.{fname}", "entity": f["base"],
                                 "list": f["list"], "evidence": f"reference/schemas/{svc}.graphql:{f['line']}"})
    return {"entities": result, "references": refs}


if __name__ == "__main__":
    tot = {}
    for svc in services():
        ops = operations(svc)
        for o in ops:
            tot[o["kind"]] = tot.get(o["kind"], 0) + 1
        print(svc, {k: sum(1 for o in ops if o["kind"] == k) for k in ("query", "command", "entity", "field")})
    print(tot)
    fed = federation()
    for t, e in fed["entities"].items():
        contrib = {s: d["fields"] for s, d in e["subgraphs"].items() if s != e["owner"] and d["fields"]}
        stubs = [s for s, d in e["subgraphs"].items() if d["stub"]]
        print(f"{t:36s} owner={e['owner']}  contributors={contrib}  stubs={stubs}")
