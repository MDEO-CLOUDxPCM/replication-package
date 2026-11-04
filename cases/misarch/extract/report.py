#!/usr/bin/env python3
"""Write domain/REPORT.md from domain/misarch-domain.json and the prose in report_text.py.

    report.py            write ../domain/REPORT.md
    report.py --print    print it instead
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOC = HERE.parent / "domain" / "misarch-domain.json"
REPORT = HERE.parent / "domain" / "REPORT.md"


def md_table(header, rows):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(x) if x is not None else "" for x in r) + " |")
    return "\n".join(out)


def short(ev):
    if not ev:
        return ""
    m = re.match(r"services/([^/]+)/src/main/kotlin/org/misarch/[^/]+/(.*)$", ev)
    if m:
        return f"{m.group(1)} `{m.group(2)}`"
    m = re.match(r"services/([^/]+)/src/main/resources/(.*)$", ev)
    if m:
        return f"{m.group(1)} `{m.group(2)}`"
    return f"`{ev}`"


def sections(d):
    s = {}
    st = d["stats"]
    ops = d["operations"]
    by_id = {o["id"]: o for o in ops}
    # ---- counts
    rows = [
        ("tables (Flyway migrations, 15 databases)", st["tables"]),
        ("domain classes (incl. Media in S3)", st["domainClasses"]),
        ("join tables (references)", st["joinTables"]),
        ("local copies (copy tables: mechanism instances)", st["copies"]),
        ("references (id columns, id arrays, join tables)", st["references"]),
        ("  of which cross-service today", st["referencesCrossServiceToday"]),
        ("operations", st["operations"]),
        ("  domain operations", st["domainOperations"]),
        ("  copy-maintenance operations", st["copyMaintenanceOperations"]),
        ("  trivial (no access, call or publish)", st["trivialOperations"]),
        ("accesses (all operations)", st["accesses"]),
        ("  accesses of domain operations", st["accessesDomainOps"]),
        ("synchronous calls today (Dapr invocation, HTTP)", st["callsToday"]),
        ("gateway joins (entity fields contributed by another subgraph)", st["gatewayJoins"]),
        ("topics", st["topics"]),
        ("publish sites / subscriptions", f"{st['publishSites']} / {st['subscriptions']}"),
        ("cross-class SQL statements (joins) / triggers", f"{st['joins']} / {st['triggers']}"),
        ("transactions / of them over several written classes", f"{st['transactions']} / {st['transactionsMultiClass']}"),
        ("features with operations", st["features"]),
    ]
    s["counts"] = md_table(["what", "count"], rows) + "\n\n" + md_table(
        ["operations by kind", "n"], sorted(st["operationsByKind"].items())) + "\n\n" + md_table(
        ["operations by trigger", "n"], sorted(st["operationsByTrigger"].items())) + "\n\n" + md_table(
        ["accesses by realisation today", "n"], sorted(st["accessesByToday"].items(), key=lambda x: str(x[0]))) + "\n\n" + md_table(
        ["accesses by shape", "n"], sorted(st["accessesByShape"].items(), key=lambda x: str(x[0])))
    # ---- per service
    svc = defaultdict(Counter)
    for o in ops:
        k = "copy" if not o["domain"] else ("trivial" if o.get("trivial") else o["kind"])
        svc[o["service"]][k] += 1
        svc[o["service"]]["accesses"] += len(o.get("accesses", []))
    for c in d["classes"]:
        svc[c["service"]]["classes"] += 1
    for c in d["copies"]:
        svc[c["service"]]["copies"] += 1
    cols = ["classes", "copies", "query", "command", "reaction", "copy", "trivial", "accesses"]
    s["services"] = md_table(["service"] + ["copy ops" if c == "copy" else c for c in cols],
                             [[k] + [svc[k][c] for c in cols] for k in sorted(svc)])
    # ---- classes
    reads, writes = defaultdict(set), defaultdict(set)
    for o in ops:
        if not o["domain"]:
            continue
        for a in o.get("accesses", []):
            (reads if a["mode"] == "read" else writes)[a["class"]].add(o["id"])
    copies_of = defaultdict(list)
    for c in d["copies"]:
        for k in c["copyOf"]:
            copies_of[k].append(c["service"])
    rows = []
    for c in d["classes"]:
        rows.append([c["name"], c["service"], c.get("table") or c.get("storage"), c.get("rowBytes"),
                     len(reads[c["name"]]), len(writes[c["name"]]), ", ".join(sorted(set(copies_of[c["name"]])))])
    s["classes"] = md_table(["class", "owner today", "table", "row bytes", "ops reading", "ops writing",
                             "copied by"], rows)
    # ---- copies
    rows = []
    for c in d["copies"]:
        rows.append([c["id"], ", ".join(f"{k}({', '.join(v)})" for k, v in c["copyOf"].items()),
                     ", ".join(c.get("fedBy", [])), len(c.get("writers", [])), len(c.get("readers", [])),
                     "payload" if c.get("process") else ""])
    s["copies"] = md_table(["copy", "of (attributes)", "fed by", "writer ops", "reader ops", ""], rows)
    # ---- joins and transactions
    rows = []
    for j in d["joins"]:
        rows.append([j["id"].split("#")[0], ", ".join(j["classes"]), ", ".join(j["kinds"]),
                     ", ".join(j.get("usedBy", [])) or "(none)", short(j["evidence"])])
    s["joins"] = md_table(["statement", "classes", "table kinds", "used by", "evidence"], rows)
    rows = []
    for t in d["transactions"]:
        if not t.get("multiClass"):
            continue
        rows.append([t["op"], ", ".join(t["domainClassesWritten"]), ", ".join(c for c in t["classes"] if c not in t["domainClassesWritten"]),
                     "yes" if t.get("publishInside") else "", short(t.get("evidence"))])
    s["transactions"] = md_table(["operation", "classes written together", "also in the transaction", "publish inside",
                                  "evidence"], rows)
    # ---- coupling
    cp = d["coupling"]
    rows = [[p["a"], p["b"], p["coAccessOps"], p["coAccessRate"], p["writtenTogetherOps"], p["transactions"], p["joins"],
             "yes" if p["composition"] else ""] for p in cp["pairs"] if p["bindings"]]
    s["bindings"] = md_table(["class A", "class B", "ops touching both", "rate (msa req/s)", "ops writing both",
                              "transactions", "statements", "composition"], rows)
    top = sorted(cp["pairs"], key=lambda p: (-p["coAccessRate"], -p["coAccessOps"], p["a"], p["b"]))[:25]
    s["coaccess"] = md_table(["class A", "class B", "ops touching both", "rate (msa req/s)", "bindings"],
                             [[p["a"], p["b"], p["coAccessOps"], p["coAccessRate"], ", ".join(p["bindings"])] for p in top])
    s["atoms"] = "\n".join(
        [f"- **{name}** ({a['rule']}): {a['count']} groups, Bell number {a['bellNumber']:.3g} partitions;"
         f" groups of more than one class: " + "; ".join("{" + ", ".join(g) + "}" for g in a["atoms"] if len(g) > 1)
         for name, a in (("atoms (all bindings)", cp["atomsAll"]), ("atoms (transactions and statements only)", cp["atomsTxJoin"]),
                                ("atoms (hot paths only)", cp["atomsHot"]))]
        + [f"- all {len(d['classes'])} classes free: Bell number {cp['classesBellNumber']:.3g}"])
    # ---- events
    rows = []
    for e in d["events"]:
        rows.append([e["topic"], e["role"], ", ".join(dict.fromkeys(p["op"] for p in e.get("publishers", []))) or e.get("externalPublisher", "(none)"),
                     ", ".join(x["op"].split(".")[0] + ("*" if x.get("copy") else "") for x in e.get("subscribers", []))])
    s["events"] = md_table(["topic", "role", "published by", "subscribers (* = copy maintenance)"], rows)
    # ---- msa mapping
    mm = d["msaMapping"]
    gaps_ops = [o["msa"] for o in mm["operations"] if o["status"] != "mapped"]
    gaps_ents = [e["msa"] for e in mm["entities"] if e["status"] != "mapped"]
    need_status = Counter(n["status"] for n in mm["needs"])
    s["msa"] = "\n".join([
        f"- msa operations: {len(mm['operations'])}, mapped {len(mm['operations']) - len(gaps_ops)}"
        + (f"; not mapped: {', '.join(gaps_ops)}" if gaps_ops else ""),
        f"- msa entities: {len(mm['entities'])}, mapped {len(mm['entities']) - len(gaps_ents)}"
        + (f"; not mapped: {', '.join(gaps_ents)}" if gaps_ents else ""),
        f"- msa data needs: {len(mm['needs'])}: " + ", ".join(f"{k} {v}" for k, v in sorted(need_status.items())),
    ])
    rows = [[n["need"], n["kind"], n.get("msaMechanismToday"),
             "; ".join((m.get("op", "") + (f" [{m['class']} {m['mode']} {m['today']}{' local' if m.get('local') else ''}]" if "class" in m else
                                             f" -> gateway -> {', '.join(m['gatewayTo'])}" if "gatewayTo" in m else
                                             f" -> {m.get('event')} -> {m.get('reaction')}")) for m in (n.get("matches") or [])[:2])
             or (n.get("override") or {}).get("note", ""), n["status"]]
            for n in mm["needs"] if n["status"] != "mapped" or True]
    s["needs"] = md_table(["msa need", "kind", "msa mechanism", "our access / event / join (first 2)", "status"], rows)
    # ---- timing parts
    seeds = mm.get("seedDemands", {}).get("operations", {})
    rows = []
    for o in ops:
        if not o["domain"] or o.get("trivial"):
            continue
        acc = defaultdict(list)
        for a in o.get("accesses", []):
            if a.get("today") in ("local", "copy"):
                acc[(a["class"], a["mode"])].append(a)
        seed = seeds.get(o["id"])
        rows.append([o["id"], o["kind"], "own work", f"{seed['cpuMs']:.2f} ms CPU" if seed else "?"])
        nacc = sum(len(v) for v in acc.values())
        for (c, mode), lst in sorted(acc.items()):
            stmts = ", ".join(str(a.get("statements")) for a in lst)
            mag = f"{seed['dbMs'] * len(lst) / nacc:.2f} ms DB" if seed and nacc else "?"
            rows.append(["", "", f"{c} {mode} ({stmts} stmt)", mag])
    s["parts"] = md_table(["operation", "kind", "part", "seed (msa, split)"], rows)
    return s


def main():
    import report_text
    d = json.loads(DOC.read_text())
    s = sections(d)
    text = report_text.TEMPLATE
    for name, body in s.items():
        text = text.replace("{{" + name + "}}", body)
    text = text.replace("{{commit}}", d["meta"]["commit"])
    for k, v in d["stats"].items():
        text = text.replace("{{stats." + k + "}}", str(v))
    missing = re.findall(r"\{\{[\w.]+\}\}", text)
    if missing:
        raise SystemExit(f"unfilled placeholders: {missing}")
    if "--print" in sys.argv:
        print(text)
    else:
        REPORT.write_text(text)
        print("wrote", REPORT)


if __name__ == "__main__":
    main()
