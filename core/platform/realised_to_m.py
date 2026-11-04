#!/usr/bin/env python3
"""Write a realised seed (the harness's realised/<seed>.model.json, made by transform/realise.mt in
core/tools/run-domain.sh) as a project model file (.m) for the mdeo platform, whose optimizer starts
from the model file a config names and does not realise it first.

    realised_to_m.py REALISED.model.json SOURCE.m OUT.m

The instances and links keep the model data's order exactly (the plugin's simulation depends on
the order: random streams), so the platform parses OUT.m into the same model data the harness
evaluated. SOURCE.m is the unrealised project
model: its header comment and `using` line are kept, its content hash is recorded (`// Source: <path> sha256
<16 hex>`), and its `prop = Enum.LITERAL` lines give the enum type of each enum-valued property (per class for `kind`).
"""
import json
import re
import sys
from collections import defaultdict

src_json, src_m, out = sys.argv[1:4]
d = json.load(open(src_json))
text = open(src_m).read()

# enum types: by (class, property), fallback by property
by_cp, by_p = {}, defaultdict(set)
cur = None
for line in text.splitlines():
    m = re.match(r"^(\w+)\s*:\s*(\w+)\s*\{", line)
    if m:
        cur = m.group(2)
        continue
    m = re.match(r"^\s+(\w+)\s*=\s*([A-Z]\w*)\.(\w+)\s*$", line)
    if m and cur:
        by_cp[(cur, m.group(1))] = m.group(2)
        by_p[m.group(1)].add(m.group(2))
    if line.startswith("}"):
        cur = None


def enum_type(cls, prop):
    if (cls, prop) in by_cp:
        return by_cp[(cls, prop)]
    s = by_p.get(prop, set())
    if len(s) == 1:
        return next(iter(s))
    sys.exit(f"no unique enum type for {cls}.{prop}: {s}")


def lit(cls, prop, v):
    if isinstance(v, dict) and "enum" in v:
        return f"{enum_type(cls, prop)}.{v['enum']}"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, float):
        r = repr(v)
        if "inf" in r or "nan" in r:
            sys.exit(f"float literal {r} of {cls}.{prop}")
        if "e" in r:   # the same value in positional notation (e.g. a small CallSite.staleShare)
            import decimal
            r = format(decimal.Decimal(r), "f")
            if "." not in r:
                r += ".0"
        return r
    if isinstance(v, int):
        return str(v)
    sys.exit(f"value {v!r} of {cls}.{prop}")


head = []
for line in text.splitlines():
    head.append(line)
    if line.startswith("using "):
        break
# the model it was realised from, by content: a realised seed whose source changed since is stale (the explorer checks it)
import hashlib
import os
project = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
source = f"// Source: {os.path.relpath(os.path.abspath(src_m), project)} sha256 {hashlib.sha256(text.encode()).hexdigest()[:16]}"
lines = head + ["", "// Realised by core/mdeo/transform/realise.mt (core/tools/run-domain.sh), written by core/platform/realised_to_m.py:",
                "// the platform's optimizer starts from this file as it is.", source, ""]
for i in d["instances"]:
    attrs = [(k, v) for k, v in i["properties"].items() if v is not None and not (isinstance(v, list) and not v)]
    lists = [(k, v) for k, v in attrs if isinstance(v, list)]
    if lists:
        sys.exit(f"list property {lists[0][0]} of {i['name']}")
    if not attrs:
        lines.append(f"{i['name']} : {i['className']} {{ }}")
    else:
        lines.append(f"{i['name']} : {i['className']} {{")
        for k, v in attrs:
            lines.append(f"    {k} = {lit(i['className'], k, v)}")
        lines.append("}")
for l in d["links"]:
    lines.append(f"{l['sourceName']}.{l['sourceProperty']} -- {l['targetName']}")
open(out, "w").write("\n".join(lines) + "\n")
print(f"{out}: {len(d['instances'])} instances, {len(d['links'])} links")
