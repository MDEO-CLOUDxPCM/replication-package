#!/usr/bin/env python3
"""Write domain/misarch-inventory.json: what misarch-kotlin has, per service, independent of the curation.

    inventory.py             write ../domain/misarch-inventory.json (same ref as build.py: MISARCH_REF, default main)

The explorer's Verify tab maps every entry to the part of the model that covers it, so a reader can check that the
model is complete, not only that its claims are true. Entries, each with its evidence (`path:line` on
the commit):
- tables, with their columns and foreign keys, and database triggers (sql_schema.py, the Flyway migrations);
- GraphQL root fields, resolvable entity types and field candidates (sdl.py, reference/sdl): the fields with arguments
  or of a non-leaf type, which may be resolvers of their own (build.py requires root fields and entity types to be
  covered by an operation or excluded, not field candidates);
- subscriptions with their handlers and publish sites (events.py);
- persistence methods (persistence.py): repository methods (declared, derived or inherited CRUD) and SQL literals;
- HTTP routes and schedules: `@*Mapping`, router DSL `POST("...")`, `@Scheduled` (a scan of this script);
- the curated exclusions (curated/<svc>.yaml `excluded`) with their reasons.
The commit must be the one of domain/misarch-domain.json (run build.py on the same ref first).
"""

import json
import re
import sys
from pathlib import Path

import yaml

import events
import gitsrc
import kt
import persistence
import sdl
import sql_schema
from build import CURATED, SERVICES

OUT = Path(__file__).resolve().parent.parent / "domain" / "misarch-inventory.json"
DOMAIN = Path(__file__).resolve().parent.parent / "domain" / "misarch-domain.json"

ROUTE_RE = re.compile(r'@(Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*)?"([^"]*)"|\b(GET|POST|PUT|DELETE|PATCH)\("([^"]*)"\)')
SCHEDULE_RE = re.compile(r"@Scheduled\(([^)]*)\)")


def routes(svc):
    out = []
    consts = kt.constants(svc)
    for path in kt.kotlin_files(svc):
        src = gitsrc.read(path)
        for m in ROUTE_RE.finditer(src):
            method = (m.group(1) or m.group(3)).upper()
            route = m.group(2) if m.group(1) else m.group(4)
            # `${Events.X}` in a route: the constant's value
            route = re.sub(r"\$\{(?:\w+\.)?(\w+)\}", lambda x: consts.get(x.group(1), x.group(0)), route)
            f = kt.enclosing_function(path, m.start())
            out.append({"method": "POST" if method == "REQUEST" else method, "route": route,
                        "evidence": f"{path}:{gitsrc.line_of(path, m.start())}",
                        "function": f"{f['cls']}.{f['name']}" if f else None})
        for m in SCHEDULE_RE.finditer(src):
            nxt = next((g for g in kt.functions(path) if g["start"] > m.start()), None)
            out.append({"method": "SCHEDULE", "route": m.group(1).strip(),
                        "evidence": f"{path}:{gitsrc.line_of(path, m.start())}",
                        "function": f"{nxt['cls']}.{nxt['name']}" if nxt else None})
    return out


def service(svc):
    tables, triggers = sql_schema.schema(svc) if svc in sql_schema.services_with_db() else ({}, [])
    cur = yaml.safe_load((CURATED / f"{svc}.yaml").read_text()) if (CURATED / f"{svc}.yaml").exists() else {}
    gql = sdl.operations(svc) if svc in sdl.services() else []
    return {
        "tables": [{"table": t["table"], "columns": sorted(t["columns"]), "foreignKeys": [f"{f['column']} -> {f['references']}" for f in t["foreignKeys"]],
                    "rowBytes": t["rowBytes"], "evidence": t["evidence"]} for t in tables.values()],
        "triggers": [{"name": t["name"], "table": t["table"], "events": t["events"], "function": t["function"],
                      "reads": t["readsTables"], "writes": t["writesTables"], "evidence": t["evidence"]} for t in triggers],
        "graphql": [{"graphql": o["graphql"], "kind": o["kind"], "returns": o.get("returns"), "args": bool(o.get("args")),
                     "evidence": o["evidence"]} for o in gql],
        "subscriptions": [{"topic": s["topic"], "route": s["route"], "how": s["how"], "handler": s["handler"],
                           "declared": s["declared"]} for s in events.subscriptions(svc)],
        "publishSites": [{"topics": p["topics"], "function": p["function"], "evidence": p["at"]} for p in events.publish_sites(svc)],
        "persistenceMethods": [{"method": m["method"], "how": m["how"], "reads": sorted(m["reads"]), "writes": sorted(m["writes"]),
                                "evidence": m["evidence"]} for m in persistence.inventory(svc)["methods"].values()],
        "routes": routes(svc),
        "excluded": [{"trigger": x.get("trigger"), "reason": " ".join(str(x.get("reason", "")).split())} for x in cur.get("excluded") or []],
    }


def main():
    commit = gitsrc.commit()
    want = json.loads(DOMAIN.read_text())["meta"]["commit"]
    if commit != want:
        sys.exit(f"misarch-kotlin {gitsrc.REF} is {commit[:12]}, the extraction is {want[:12]}: run build.py first")
    doc = {"meta": {"source": "misarch-kotlin", "ref": gitsrc.REF, "commit": commit, "generatedBy": "cases/misarch/extract/inventory.py"},
           "services": {svc: service(svc) for svc in SERVICES}}
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    n = {k: sum(len(s[k]) for s in doc["services"].values()) for k in next(iter(doc["services"].values()))}
    print("wrote", OUT, n)


if __name__ == "__main__":
    main()
