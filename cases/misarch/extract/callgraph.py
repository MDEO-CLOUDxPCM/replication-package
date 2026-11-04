"""Heuristic reachability inside one service: from an entry function to the persistence methods,
topics and remote calls it can reach. Used only as a cross-check of the curated accesses (a
curated operation that misses a reachable table, or names one that is not reachable, is reported).

Resolution rules (regex-based, deliberately simple):
- `x.m(` where `x` is a constructor property / property / parameter of known type T: methods `m`
  of T and of classes whose supertypes mention T;
- `m(` without receiver: methods `m` of the same class (or top-level functions of the service);
- `XDataLoader::class` / `dataLoader<..>("XDataLoader")`: all functions of XDataLoader, and
  `R.findAllById` if XDataLoader extends IdDataLoader(repository: R);
- `XConnection(`: `XConnection.nodes` and `.totalCount`.
"""

import functools
import re

import gitsrc
import kt
import persistence

FIELD_RE = re.compile(r"\b(?:val|var)\s+(\w+)\s*:\s*([A-Z][\w.]*)")
PARAM_RE = re.compile(r"\b(\w+)\s*:\s*([A-Z][\w.]*)")
TOPIC_RE = re.compile(r"^[a-z]+(?:/[a-z-]+){2}$")
# libs/common extension functions of repositories -> the repository method they run
REPOSITORY_EXTENSIONS = {"findByIdOrThrow": "findById", "existsByIdOrThrow": "existsById"}


@functools.lru_cache(maxsize=None)
def index(svc):
    funcs, classes = [], {}
    for path in kt.kotlin_files(svc):
        src = gitsrc.read(path)
        for c in kt.classes(path):
            # constructor parameters (with or without val/var: `repository: R` passed to a base class)
            fields = dict((n, t.split(".")[-1]) for n, t in PARAM_RE.findall(c["header"]))
            body = src[c["start"]:c["end"]]
            fields.update((n, t.split(".")[-1]) for n, t in FIELD_RE.findall(body) if n not in fields)
            classes.setdefault(c["name"], {"name": c["name"], "fields": fields, "supertypes": c["supertypes"],
                                           "header": c["header"], "path": path})
        for f in kt.functions(path):
            funcs.append({**f, "path": path, "key": f"{f['cls']}.{f['name']}"})
    by_cls_name = {}
    for f in funcs:
        by_cls_name.setdefault((f["cls"], f["name"]), []).append(f)
    return {"funcs": funcs, "classes": classes, "byClsName": by_cls_name}


def _impls(svc, typ):
    idx = index(svc)
    res = {typ}
    for name, c in idx["classes"].items():
        if re.search(rf"\b{re.escape(typ)}\b", c["supertypes"]):
            res.add(name)
    return res


def _callees(svc, f):
    idx = index(svc)
    src = gitsrc.read(f["path"])
    ms = kt.masked(f["path"])
    body = ms[f["start"]:f["end"] + 1]
    raw = src[f["start"]:f["end"] + 1]
    cls = idx["classes"].get(f["cls"], {"fields": {}})
    params = dict((n, t.split(".")[-1]) for n, t in PARAM_RE.findall(body[:body.find(")") + 1]))
    local = dict((n, t.split(".")[-1]) for n, t in re.findall(r"\bval\s+(\w+)\s*=\s*([A-Z]\w*)\(", body))
    env = {**cls["fields"], **params, **local}
    out = set()
    for m in re.finditer(r"\b(\w+)\s*(?:\?|!!)?\.\s*(\w+)\s*(?:<[^>]*>)?\s*[({]", body):
        recv, meth = m.groups()
        typ = env.get(recv) or (recv if recv in idx["classes"] else None)
        if typ:
            for t in _impls(svc, typ):
                for g in idx["byClsName"].get((t, meth), []):
                    out.add(g["key"])
                if t in persistence.inventory(svc)["repositories"]:
                    out.add(f"{t}.{REPOSITORY_EXTENSIONS.get(meth, meth)}")
    for m in re.finditer(r"(?<![.\w])([a-z]\w*)\s*(?:<[^>]*>)?\s*\(", body):
        name = m.group(1)
        if name in ("if", "when", "for", "while", "catch", "listOf", "setOf", "mapOf", "require", "check"):
            continue
        for g in idx["byClsName"].get((f["cls"], name), []) + idx["byClsName"].get((None, name), []):
            out.add(g["key"])
    for m in re.finditer(r"\b(\w+DataLoader)\b", raw):
        dl = m.group(1)
        c = idx["classes"].get(dl)
        if not c:
            continue
        for (cn, _), gs in idx["byClsName"].items():
            if cn == dl:
                out.update(g["key"] for g in gs)
        if "IdDataLoader" in c["supertypes"]:
            rm = re.search(r"\w+\s*:\s*(\w+Repository)", c["header"])
            if rm:
                out.add(f"{rm.group(1)}.findAllById")
    for m in re.finditer(r"\b(\w+Connection)\s*\(", raw):
        out.add(f"{m.group(1)}.nodes")
        out.add(f"{m.group(1)}.totalCount")
    out.discard(f["key"])
    return out


@functools.lru_cache(maxsize=None)
def reach_span(svc, path, line):
    """Like reach(), for a lambda block (e.g. `POST(route) { ... }`) starting at `line` of `path`, or for a class
    declared on that line (e.g. a federation resolver that only names its data loader: `class XResolver :
    DataLoaderEntityResolver<X>(X::class, XDataLoader::class)`), its header and body."""
    ms = kt.masked(path)
    start = sum(len(l) + 1 for l in gitsrc.lines(path)[:line - 1])
    decl = next((c for c in kt.classes(path) if start <= c["start"] < start + len(gitsrc.lines(path)[line - 1])), None)
    if decl:
        start, end = decl["start"], decl["end"]
    else:
        brace = ms.find("{", start)
        end = kt._match_brace(ms, brace)
    owner = kt.enclosing_class(path, start)
    pseudo = {"name": f"<lambda@{line}>", "cls": owner["name"] if owner else None, "start": start, "end": end,
              "path": path, "key": f"<lambda@{path}:{line}>"}
    return reach(svc, None, _first=frozenset(_callees(svc, pseudo)), _pseudo=(path, start, end))


@functools.lru_cache(maxsize=None)
def reach(svc, entry_key, _first=None, _pseudo=None):
    """Persistence methods and topics reachable from function `Class.method` (all overloads)."""
    idx = index(svc)
    inv = persistence.inventory(svc)["methods"]
    consts = kt.constants(svc)
    seen, todo = set(), ([entry_key] if entry_key else list(_first))
    while todo:
        k = todo.pop()
        if k in seen:
            continue
        seen.add(k)
        cls, _, name = k.rpartition(".")
        for f in idx["byClsName"].get((cls or None, name), []):
            todo.extend(_callees(svc, f) - seen)
    tables_r, tables_w, topics = set(), set(), set()
    pmethods = sorted(k for k in seen if k in inv)
    for k in pmethods:
        tables_r |= set(inv[k]["reads"])
        tables_w |= set(inv[k]["writes"])
    spans = [(f["path"], f["start"], f["end"]) for k in seen
             for f in idx["byClsName"].get((k.rpartition(".")[0] or None, k.rpartition(".")[2]), [])]
    if _pseudo:
        spans.append(_pseudo)
    for path, a, b in spans:
        if True:
            raw = gitsrc.read(path)[a:b + 1]
            if re.search(r"publish", raw, re.I):
                for c in re.findall(r"\b([A-Z][A-Z0-9_]+)\b", raw):
                    if c in consts and TOPIC_RE.match(consts[c]):
                        topics.add(consts[c])
                for lit in re.findall(r'"([a-z]+(?:/[a-z-]+){2})"', raw):
                    topics.add(lit)
    return {"functions": sorted(seen), "persistence": pmethods, "reads": sorted(tables_r),
            "writes": sorted(tables_w), "topicsNearPublish": sorted(topics)}


if __name__ == "__main__":
    import sys
    svc, entry = sys.argv[1], sys.argv[2]
    import json
    print(json.dumps(reach(svc, entry), indent=1))
