"""The code that contributes steps to each operation of package A's extraction, for the Verify tab (verify/chains.json
of the MiSArch packet, written by build.ts): the functions on a path from the operation's entry to one of its step
sites (the evidence of an access, call, publish or transaction, and the persistence method of an access's `via`),
each with its declaration, and the call sites between them. Reachability is cases/misarch/extract/callgraph.py's (the
extraction's own cross-check), read at the extraction's commit (MISARCH_REF and MISARCH_KOTLIN, set by the caller);
this script only keeps the part of it that leads to a step.

  python3 chains.py <misarch-domain.json> <callgraph.py>   ->  {opId: {root, nodes, calls, unreached}} on stdout

The second argument is config.ts `files.callgraph`; its directory (domain/extract) holds gitsrc.py and kt.py too.
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[2]).resolve().parent))
import callgraph  # noqa: E402
import gitsrc  # noqa: E402
import kt  # noqa: E402


def split(ev):
    m = re.match(r"^(.*):(\d+)$", ev or "")
    return (m.group(1), int(m.group(2))) if m else None


def offset(path, line):
    return sum(len(x) + 1 for x in gitsrc.lines(path)[:line - 1])


def span(f):
    """kt.functions' function, an expression body that opens a block on its first line (`= NestRest.handle {`) up
    to that block's end (kt ends it at the next declaration, inside the block)"""
    ms = kt.masked(f["path"])
    b = f.get("bodyStart", f["start"])
    if ms[b:b + 1] != "=":
        return f
    eol = ms.find("\n", b)
    brace = ms.find("{", b, eol if eol >= 0 else len(ms))
    return {**f, "end": max(f["end"], kt._match_brace(ms, brace))} if brace >= 0 else f


def funcs(svc, key):
    cls, _, name = key.rpartition(".")
    return [span(f) for f in callgraph.index(svc)["byClsName"].get((None if cls in ("", "None") else cls, name), [])]


def enclosing(path, at):
    fs = [span({**f, "path": path}) for f in kt.functions(path)]
    return max((f for f in fs if f["start"] <= at <= f["end"]), key=lambda f: f["start"], default=None)


def chain(op, pms):
    svc = op["service"]
    entry = split(op["entry"])
    if not entry or not entry[0].endswith(".kt"):
        return None
    path, line = entry
    fn = next((f for f in callgraph.index(svc)["funcs"] if f["path"] == path and f["line"] == line), None)
    if fn:
        root, first = fn["key"], None
    else:  # a lambda block (a route, a subscription): callgraph.reach_span's pseudo function
        ms = kt.masked(path)
        start = offset(path, line)
        brace = ms.find("{", start)
        owner = kt.enclosing_class(path, start)
        root = f"<lambda@{path}:{line}>"
        first = {"name": root, "cls": owner["name"] if owner else None, "start": start, "end": kt._match_brace(ms, brace), "path": path, "key": root, "line": line}
    # the call graph from the entry (callgraph.reach's walk, with the edges kept)
    edges, seen, todo = {}, set(), [root]
    while todo:
        k = todo.pop()
        if k in seen:
            continue
        seen.add(k)
        fs = [first] if k == root and first else funcs(svc, k)
        edges[k] = set().union(*(callgraph._callees(svc, f) for f in fs)) if fs else set()
        todo.extend(edges[k] - seen)
    # the step sites: the function each evidence line lies in, the persistence methods of the vias
    targets, unreached = set(), []
    sites = [x for k in ("accesses", "calls", "publishes", "transactions") for x in op.get(k) or []]
    for x in sites:
        if x.get("via") in seen:
            targets.add(x["via"])
        loc = split(x.get("evidence"))
        if not loc or not loc[0].endswith(".kt") or loc[0] not in gitsrc.files():
            continue
        at = offset(*loc) + len(gitsrc.lines(loc[0])[loc[1] - 1]) - len(gitsrc.lines(loc[0])[loc[1] - 1].lstrip())
        if first and loc[0] == path and first["start"] <= at <= first["end"]:
            key = root
        else:
            g = enclosing(loc[0], at)
            if g is None:
                continue  # outside any function (an annotation of the class)
            key = f"{g['cls']}.{g['name']}"
        if key in seen:
            targets.add(key)
        else:
            unreached.append({"evidence": x["evidence"], "function": key})
    # keep what leads to a step
    rev = {}
    for a, bs in edges.items():
        for b in bs:
            rev.setdefault(b, set()).add(a)
    keep, todo = set(), list(targets)
    while todo:
        k = todo.pop()
        if k in keep:
            continue
        keep.add(k)
        todo.extend(rev.get(k, ()))
    keep.add(root)
    # a step's function the walk does not reach (callgraph.py misses the call): still a contributor, without calls
    lost = {u["function"] for u in unreached} - keep
    nodes = []
    for k in keep | lost:
        fs = [first] if k == root and first else funcs(svc, k)
        decl = [{"path": f["path"], "line": f["line"], "end": gitsrc.line_of(f["path"], f["end"])} for f in fs]
        if not decl and k in pms:  # an inherited CRUD method: the repository's declaration
            loc = split(pms[k]["evidence"])
            decl = [{"path": loc[0], "line": loc[1], "end": loc[1]}] if loc else []
        nodes.append({"key": k, "decl": decl, "pm": k in pms, "step": k in targets or k in lost, "reached": k in keep})
    # the call sites between kept functions: where the callee's name (or its class, for connections and data loaders) is called
    calls = []
    for a in keep:
        fs = [first] if a == root and first else funcs(svc, a)
        for f in fs:
            ms = kt.masked(f["path"])
            body0 = f.get("bodyStart", f["start"])
            for b in sorted(edges.get(a, set()) & keep):
                cls, _, name = b.rpartition(".")
                pats = [rf"(?<![\w$])(?<!fun ){re.escape(name)}\s*(?:<[^>]*>)?\s*[({{]"]
                if re.search(r"(Connection|DataLoader)$", cls):
                    pats.append(rf"\b{re.escape(cls)}\b")
                for pat in pats:
                    for m in re.finditer(pat, ms[body0:f["end"] + 1]):
                        o = body0 + m.start()
                        ln = gitsrc.line_of(f["path"], o)
                        calls.append({"from": a, "to": b, "path": f["path"], "line": ln, "col": o - offset(f["path"], ln),
                                      "len": len(re.match(r"[\w$]+", m.group(0)).group(0))})
    calls.sort(key=lambda c: (c["path"], c["line"], c["col"]))
    return {"root": root, "nodes": sorted(nodes, key=lambda n: n["key"]), "calls": calls, "unreached": unreached}


def main():
    a = json.load(open(sys.argv[1]))
    pms_by = {}
    for m in a["persistenceMethods"]:
        pms_by.setdefault(m["service"], {})[m["method"]] = m
    out = {}
    for op in a["operations"]:
        try:
            c = chain(op, pms_by.get(op["service"], {}))
        except Exception as e:  # noqa: BLE001 - one operation's failure must not hide the others
            c = {"error": f"{type(e).__name__}: {e}"}
        if c:
            out[op["id"]] = c
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
