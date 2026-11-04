"""Pub/sub inventory: subscriptions (topic -> route -> handler location) and publish call sites.

Subscriptions come from `@Topic(name = CONST)` annotations, from subscription JSON written in the
code (`"topic":"..","route":".."`) and from `src/main/resources/dapr-subscribe.json`; the handler
of a route is the `POST("route")` / `POST(CONST)` / `@PostMapping("route")` site. Publish sites are
lines that publish (`publishEvent(`, `.publish(`, `/v1.0/publish/`) with the topics named nearby.
"""

import functools
import json
import re

import gitsrc
import kt

TOPIC_RE = re.compile(r"^[a-z]+(?:/[a-z-]+){2}$")


def _resolve(svc, token):
    token = token.strip()
    if token.startswith('"'):
        return token.strip('"')
    name = token.split(".")[-1]
    return kt.constants(svc).get(name, token)


@functools.lru_cache(maxsize=None)
def subscriptions(svc):
    subs = []
    files = kt.kotlin_files(svc)
    # 1. @Topic
    for path in files:
        src = gitsrc.read(path)
        for m in re.finditer(r"@Topic\(\s*name\s*=\s*([\w.\"/-]+)", src):
            f = next((f for f in kt.functions(path) if f["start"] > m.start()), None)
            subs.append({"topic": _resolve(svc, m.group(1)), "route": None, "how": "@Topic",
                         "handler": f"{path}:{f['line']}" if f else f"{path}:{gitsrc.line_of(path, m.start())}",
                         "handlerKey": f"{f['cls']}.{f['name']}" if f else None,
                         "declared": f"{path}:{gitsrc.line_of(path, m.start())}"})
    # 2. subscription JSON in code or resources
    sources = [(p, gitsrc.read(p)) for p in files]
    for p in gitsrc.glob(f"services/{svc}/src/main/resources/", ".json"):
        sources.append((p, gitsrc.read(p)))
    routes = {}
    for path, src in sources:
        for m in re.finditer(r'\\?"topic\\?"\s*:\s*\\?"([a-z/-]+)\\?"\s*,\s*\\?"route\\?"\s*:\s*\\?"([^"\\]+)', src):
            routes.setdefault(m.group(1), (m.group(2), f"{path}:{gitsrc.line_of(path, m.start())}"))
        # order: SUBSCRIPTIONS = listOf(TOPIC to ROUTE, ...)
        for m in re.finditer(r"\b([A-Z_]+)\s+to\s+([A-Z_]+)\b", src):
            t, r = _resolve(svc, m.group(1)), _resolve(svc, m.group(2))
            if TOPIC_RE.match(t) and r.startswith("/") or (TOPIC_RE.match(t) and "ROUTE" in m.group(2)):
                routes.setdefault(t, (r, f"{path}:{gitsrc.line_of(path, m.start())}"))
    for topic, (route, decl) in routes.items():
        if any(s["topic"] == topic for s in subs):
            continue
        handler, key = None, None
        r = route.lstrip("/")
        for path in files:
            src = gitsrc.read(path)
            consts = [c for c, v in kt.constants(svc).items() if v.lstrip("/") == r]
            pat = r'(?:POST|PostMapping)\(\s*(?:"/?' + re.escape(r) + r'"' + "".join(f"|[\\w.]*\\b{c}\\b" for c in consts) + r")"
            m = re.search(pat, src)
            if m:
                handler = f"{path}:{gitsrc.line_of(path, m.start())}"
                f = kt.enclosing_function(path, m.start())
                nxt = next((g for g in kt.functions(path) if g["start"] > m.start()), None)
                if "PostMapping" in m.group(0) and nxt:
                    handler, key = f"{path}:{nxt['line']}", f"{nxt['cls']}.{nxt['name']}"
                else:
                    key = None  # a route lambda: the entry is the POST line
                break
        subs.append({"topic": topic, "route": route, "how": "subscription list", "handler": handler,
                     "handlerKey": key, "declared": decl})
    return subs


@functools.lru_cache(maxsize=None)
def publish_sites(svc):
    sites = []
    consts = kt.constants(svc)
    for path in kt.kotlin_files(svc):
        src = gitsrc.read(path)
        ls = gitsrc.lines(path)
        for m in re.finditer(r"publishEvent\(|\.publish\(|/v1\.0/publish/", src):
            line = gitsrc.line_of(path, m.start())
            window = "\n".join(ls[line - 1:line + 3])
            topics = {consts[c] for c in re.findall(r"\b([A-Z][A-Z0-9_]+)\b", window) if TOPIC_RE.match(consts.get(c, ""))}
            topics |= set(re.findall(r'"([a-z]+(?:/[a-z-]+){2})"', window))
            f = kt.enclosing_function(path, m.start())
            sites.append({"at": f"{path}:{line}", "topics": sorted(topics),
                          "function": f"{f['cls']}.{f['name']}" if f else None})
    return sites


@functools.lru_cache(maxsize=None)
def topic_literals(svc):
    """Every topic string of the service's main code (constants and literals)."""
    res = {}
    for path in kt.kotlin_files(svc):
        for off, text in kt.strings(path):
            if TOPIC_RE.match(text):
                res.setdefault(text, f"{path}:{gitsrc.line_of(path, off)}")
    return res


if __name__ == "__main__":
    import sys
    for svc in sys.argv[1:] or sorted({gitsrc.service_of(f) for f in gitsrc.glob("services/")} - {None}):
        print("==", svc)
        for s in subscriptions(svc):
            print(f"  SUB {s['topic']:45s} route={s['route']} handler={gitsrc.short(s['handler'] or '?')} {s['handlerKey']}")
        for p in publish_sites(svc):
            print(f"  PUB {gitsrc.short(p['at'])} {p['topics']} in {p['function']}")
