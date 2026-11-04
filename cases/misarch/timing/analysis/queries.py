#!/usr/bin/env python3
"""pg_stat_statements per segment -> statement -> table -> class (A's mapping), read/write, calls, rows, DB ms;
k_db per DB container (README.md §3.2).

    queries.py WINDOW [--out WINDOW/analysis/queries.json]

Per instrumented segment (hooks.json: reset at the segment start, dump at its end; pgstat/<segment>.json):
- statement kind from the SQL: write (INSERT/UPDATE/DELETE/MERGE, also inside a CTE), read (SELECT, VALUES; with
  `lock` for FOR UPDATE/SHARE), tx (BEGIN/COMMIT/ROLLBACK/SAVEPOINT/SET ...: transaction control);
- tables from FROM/JOIN/INSERT INTO/UPDATE/DELETE FROM (CTE names and unknown names dropped; quotes and case
  folded); the write target for writes;
- class: A's access of the request's operations (and their follow-ups) on (service, table, mode) when there is
  one (so a join table counts for the class A names, e.g. Product for ProductToCategoryEntity), else A's
  table -> class mapping (classes, copies, join tables) of that service;
- per request: calls, rows, exec ms, plan ms divided by the requests of the segment's type(s) sent between reset
  and dump (requests.csv);
- k_db per DB container = (cgroup CPU over [reset, dump] - idle baseline) / (sum exec + plan time); the idle
  baseline is the container's CPU rate in the window's idle phases (cpu.csv).
Parallel-scan guard: a statement that touches more than PARALLEL_BLOCKS shared blocks (8 kB) per call
(1,000 blocks = 8 MB, Postgres' min_parallel_table_scan_size) reads a large table without an index; such statements
are listed per segment (`scanSuspects`, with blocks per call) and over the window (`scanSuspects` at the top). With
main's indexes the list must be empty.
The candidate operations of a request type: workload/sessions.json requests[type].operations (A's ids), plus the
operations they reach through calls and publishes (A's events -> subscribers): the follow-ups.
"""
import argparse
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

SESSIONS = os.path.join(common.ROOT, "workload", "sessions.json")
# request-type names that are not keys of sessions.json (timing/requests/reqs.py): factorial cells and
# anonymous variants -> the session request they execute
# a statement no operation of the request has an access for, run less than once per 100 requests, is background
# (pool refreshes of the load generator, maintenance), not part of the request
BACKGROUND_CALLS_PER_REQ = 0.01
PARALLEL_BLOCKS = 1000      # shared blocks per call (8 MB): Postgres' parallel-scan threshold
TYPE_ALIASES = {"foCart": "createShoppingcartItem", "foOrder": "createOrder", "foPlace": "placeOrder"}

# ------------------------------------------------------------------------------------------------- SQL parsing
_STR = re.compile(r"'(?:[^']|'')*'")
_COMMENT = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)
_TX = re.compile(r"^(begin|commit|rollback|start\s+transaction|savepoint|release|set|show|reset|discard|end|"
                 r"deallocate|prepare\s+transaction|lock)\b")
_WRITE = re.compile(r"(?<!for )(?<!do )\b(insert\s+into|update|delete\s+from|merge\s+into)\s+([a-z_][\w.$]*)")
_FROM = re.compile(r"\bfrom\s+(.+?)(?=\bwhere\b|\bjoin\b|\bleft\b|\bright\b|\binner\b|\bouter\b|\bcross\b|\bfull\b|"
                   r"\bgroup\b|\border\b|\blimit\b|\boffset\b|\bfor\b|\bunion\b|\breturning\b|\bon\b|\bhaving\b|"
                   r"\bwindow\b|\)|;|$)", re.S)
_JOIN = re.compile(r"\bjoin\s+([a-z_][\w.$]*)")
_CTE = re.compile(r"(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z_]\w*)\s+as\s*(?:not\s+materialized\s+|materialized\s+)?\(")
_KEYWORDS = {"select", "lateral", "unnest", "values", "set", "only", "generate_series", "json_to_recordset"}


def normalise(sql):
    s = _COMMENT.sub(" ", sql)
    s = _STR.sub("''", s)
    s = s.replace('"', "").lower()
    return re.sub(r"\s+", " ", s).strip()


def _name(t):
    t = t.strip().split()[0] if t.strip() else ""
    t = t.split(".")[-1].split("$")[0]
    return t if t and t not in _KEYWORDS and not t.startswith(("(", "$")) else None


def parse_sql(sql):
    """-> {kind: read|write|tx, lock: bool, tables: [..], writes: [..]} (table names lower case)."""
    s = normalise(sql)
    if _TX.match(s):
        return {"kind": "tx", "op": None, "lock": False, "tables": [], "writes": []}
    ctes = set(_CTE.findall(s))
    writes = []
    for verb, t in _WRITE.findall(s):
        if verb == "update" and t in ("set", "skip", "nowait", "of"):
            continue
        n = _name(t)
        if n and n not in ctes:
            writes.append(n)
    reads = []
    for m in _FROM.finditer(s):
        words = re.findall(r"[a-z_]+", s[max(0, m.start() - 20):m.start()])
        before = words[-1] if words else ""
        if before in ("epoch", "year", "month", "day", "hour", "minute", "second", "both", "leading", "trailing",
                      "distinct"):
            continue                    # EXTRACT(x FROM col), TRIM(... FROM ...), IS DISTINCT FROM
        for item in m.group(1).split(","):
            n = _name(item)
            if n and n not in ctes:
                reads.append(n)
    reads += [n for n in (_name(t) for t in _JOIN.findall(s)) if n and n not in ctes]
    tables = list(dict.fromkeys(writes + reads))
    lock = bool(re.search(r"\bfor\s+(no\s+key\s+)?(update|share)\b", s))
    if writes:
        op = "insert" if s.lstrip("( ").startswith("insert") or re.search(r"\binsert\s+into\b", s) else \
            ("delete" if re.search(r"\bdelete\s+from\b", s) else "update")
        if op == "insert" and " on conflict " in s:
            op = "upsert"
    elif lock:
        op = "lock"
    elif re.match(r"select (count|exists)\b|select count\(", s):
        op = "count" if "count(" in s.split(" from ")[0] else "exists"
    elif re.match(r"select 1\b", s) or "exists(" in s.split(" from ")[0]:
        op = "exists"
    else:
        op = "select"
    return {"kind": "write" if writes else "read", "op": op, "lock": lock, "tables": tables,
            "writes": list(dict.fromkeys(writes))}


def skeleton(sql):
    """Shape of a statement for comparing A's SQL with pg_stat_statements' normalised text."""
    s = normalise(sql)
    s = re.sub(r"\$\{[^}]*\}|\$\d+|:\w+|\b\d+\b|''", "?", s)
    s = re.sub(r"\s*([(),=<>])\s*", r"\1", s)
    return s


# ------------------------------------------------------------------------------------------------- A's mapping
class Mapping:
    def __init__(self, dom=None, sessions=None):
        self.d = dom or common.domain()
        self.s = sessions or json.load(open(SESSIONS))
        self.ops = {o["id"]: o for o in self.d["operations"]}
        self.table_class = {}           # (service, table) -> (class, how)
        for c in self.d["classes"]:
            if c.get("table"):           # Media lives in S3 (no table)
                self.table_class[(c["service"], c["table"].lower())] = (c["name"], "class")
        for c in self.d["copies"]:
            cls = next(iter(c["copyOf"]))
            self.table_class.setdefault((c["service"], c["table"].lower()), (cls, "copy"))
        for j in self.d["joinTables"]:
            self.table_class.setdefault((j["service"], j["table"].lower()), (j["joins"][0], "join"))
        self.tables = collections.defaultdict(set)
        for (svc, t) in self.table_class:
            self.tables[svc].add(t)
        for m in self.d["persistenceMethods"]:
            self.tables[m["service"]].update(m["reads"] + m["writes"])
        self.subs = collections.defaultdict(list)
        for ev in self.d["events"]:
            for s in ev["subscribers"]:
                self.subs[ev["topic"]].append(s["op"])
        self.shapes = collections.defaultdict(list)     # (service, skeleton) -> methods
        for m in self.d["persistenceMethods"]:
            for st in m["statements"]:
                if st.get("sql"):
                    self.shapes[(m["service"], skeleton(st["sql"]))].append(m["method"])

    def session_key(self, rtype):
        if rtype in self.s["requests"]:
            return rtype
        head = rtype.split(".")[0]
        if head in TYPE_ALIASES:
            return TYPE_ALIASES[head]
        if rtype.rsplit(".", 1)[0] in self.s["requests"]:
            return rtype.rsplit(".", 1)[0]
        return None

    def request_ops(self, rtype):
        """[(op, role)]: role plan (the request's own operations), call, followUp (event handlers, transitively)."""
        key = self.session_key(rtype)
        if key is None:
            return []
        out = [(x, "plan") for x in self.s["requests"][key]["operations"] if x in self.ops]
        seen = {x for x, _ in out}
        todo = list(seen)
        while todo:
            o = self.ops[todo.pop(0)]
            nxt = []
            for c in o.get("calls", []):
                for t in ([c["to"]] if isinstance(c["to"], str) else c["to"]):
                    if t in self.ops:
                        nxt.append((t, "call"))
                    else:                   # the provider stub calls the service back over HTTP
                        nxt += [(x, "callback") for x in self.stub_callbacks(t)]
            for p in o.get("publishes", []):
                nxt += [(t, "followUp") for t in self.subs.get(p["topic"], [])]
            for t, role in nxt:
                if t in self.ops and t not in seen:
                    seen.add(t)
                    out.append((t, role))
                    todo.append(t)
        return out

    def reach_probs(self, rtype):
        """{op: probability that one request of rtype reaches it} along A's calls and publishes (the maximum over
        paths; a publish or call without `prob` counts as 1). Compensations A gives probability 0 get 0."""
        key = self.session_key(rtype)
        if key is None:
            return {}
        pr = {x: 1.0 for x in self.s["requests"][key]["operations"] if x in self.ops}
        todo = list(pr)
        while todo:
            o = todo.pop(0)
            op = self.ops[o]
            nxt = []
            for c in op.get("calls", []):
                q = c.get("prob") if isinstance(c.get("prob"), (int, float)) else 1.0
                for t in ([c["to"]] if isinstance(c["to"], str) else c["to"]):
                    nxt += [(x, q) for x in ([t] if t in self.ops else self.stub_callbacks(t))]
            for p_ in op.get("publishes", []):
                q = p_.get("prob") if isinstance(p_.get("prob"), (int, float)) else 1.0
                nxt += [(t, q) for t in self.subs.get(p_["topic"], [])]
            for t, q in nxt:
                v = pr[o] * q
                if t in self.ops and v > pr.get(t, -1.0):
                    pr[t] = v
                    todo.append(t)
        return pr

    def stub_callbacks(self, target):
        """A call to the provider stub ('simulation.<service>.register') returns through the stub's HTTP callback
        into <service> (README §3.5: the 2 HTTP callbacks of the provider stub): the operations of <service>
        with an http trigger."""
        parts = target.split(".")
        if len(parts) < 2 or parts[0] != "simulation":
            return []
        return [oid for oid, o in self.ops.items() if o["service"] == parts[1] and "http" in (o.get("trigger") or {})]

    def classify(self, service, table, mode, ops, stmt_op=None):
        """-> (class, how, [candidate accesses (op, access)]); candidates with A's statement kind (`op`: select,
        count, exists, lock, insert, upsert, update, delete) equal to the statement's are preferred."""
        cands = []
        for oid, _role in ops:
            o = self.ops[oid]
            if o["service"] != service:
                continue
            for a in o["accesses"]:
                if (a.get("table") or "").lower() == table and a["mode"] == mode and a["today"] in ("local", "copy"):
                    cands.append((oid, a))
        if cands:
            same = [x for x in cands if x[1].get("op") == stmt_op]
            if same:
                cands = same
            return cands[0][1]["class"], "access", cands
        cls, how = self.table_class.get((service, table), (None, "unknown"))
        return cls, how, []


# ------------------------------------------------------------------------------------------------- analysis
def segment_requests(d, seg, t0, t1, meta_phases):
    """Request types active in the segment's steady phase -> number sent in [t0, t1]."""
    meta = common.load_json(d, "meta.json")
    rates = next((p.get("rates", {}) for p in meta["phases"] if p["name"] == seg), {}) if meta else {}
    return {t: common.requests_in(d, t, t0, t1) for t in rates}


def idle_rates(cd, d, keys):
    ph = common.phases(d)
    iv = [(s + 5, e) for n, (s, e) in ph.items() if (n in ("idle", "idle_end") or n.endswith(":pre")) and e - s > 8]
    out = {}
    for k in keys:
        u = sum((cd.usec(k, s, e) or 0) for s, e in iv)
        t = sum(e - s for s, e in iv)
        out[k] = u / 1e6 / t if t else 0.0
    return out


def analyse_window(d, mapping=None):
    d = common.window_dir(d)
    mp = mapping or Mapping()
    segs = common.segments(d)
    try:
        cd = common.cpu_data(d)
    except Exception:
        cd = None
    out = {"window": os.path.basename(d), "segments": {}}
    pgdir = os.path.join(d, "pgstat")
    idle = None
    for seg, iv in segs.items():
        f = os.path.join(pgdir, common.segname(seg) + ".json")
        if seg == "idle" or not os.path.exists(f):
            continue
        dump = json.load(open(f))
        t0 = iv["start"]
        t1 = max(iv.get("pgDumpT", {}).values() or [iv["end"]])
        reqs = segment_requests(d, seg, t0, t1, None)
        n_ref = next(iter(reqs.values()), 0) if reqs else 0
        types = list(reqs)
        ops = []
        for t in types:
            for x in mp.request_ops(t):
                if x not in ops:
                    ops.append(x)
        if cd is not None and idle is None:
            idle = idle_rates(cd, d, [f"{common.PREFIX}{common.short(c)}-1" for c in dump])
        dbs, stmts = {}, []
        acc = collections.OrderedDict()
        tx = collections.Counter()
        for c, v in dump.items():
            cs = common.short(c)
            ex = sum(r["total_exec_time"] for r in v["rows"])
            pl = sum(r.get("total_plan_time") or 0 for r in v["rows"])
            e = {"execMs": round(ex, 3), "planMs": round(pl, 3), "statements": len(v["rows"]),
                 "error": v.get("error")}
            if cd is not None:
                key = f"{common.PREFIX}{cs}-1"
                u = cd.usec(key, t0, v["t"])
                if u is not None:
                    cg = u / 1000
                    idl = idle.get(key, 0) * (v["t"] - t0) * 1000
                    ok = ex > 20       # k_db only where the segment did real DB work
                    e.update(cgroupMs=round(cg, 2), idleMs=round(idl, 2), netMs=round(cg - idl, 2),
                             kDb=round((cg - idl) / (ex + pl), 3) if ok else None,
                             kDbExec=round((cg - idl) / ex, 3) if ok else None)
            dbs[cs] = e
            for r in v["rows"]:
                svc = r["datname"]
                p = parse_sql(r["query"])
                n = n_ref or 1
                row = {"db": cs, "service": svc, "queryid": r["queryid"], "kind": p["kind"], "lock": p["lock"],
                       "tables": p["tables"], "calls": r["calls"], "rows": r["rows"],
                       "execMs": round(r["total_exec_time"], 3), "planMs": round(r.get("total_plan_time") or 0, 3),
                       "callsPerReq": round(r["calls"] / n, 4), "rowsPerReq": round(r["rows"] / n, 4),
                       "execMsPerReq": round(r["total_exec_time"] / n, 4),
                       "blkReadMs": round((r.get("blk_read_time") or r.get("shared_blk_read_time") or 0), 3),
                       "sharedBlksPerCall": shared_blocks_per_call(r),
                       "query": r["query"][:400]}
                meth = mp.shapes.get((svc, skeleton(r["query"])))
                if meth:
                    row["methods"] = meth
                if p["kind"] == "tx":
                    tx[(cs, svc, normalise(r["query"]).split()[0])] += r["calls"]
                    row["class"] = None
                    stmts.append(row)
                    continue
                targets = [t for t in (p["writes"] if p["kind"] == "write" else p["tables"])
                           if not t.startswith("pg_")]      # pg_catalog (driver type lookups): not an access
                known = [t for t in targets if t in mp.tables.get(svc, ())]
                row["unknownTables"] = [t for t in p["tables"] if t not in mp.tables.get(svc, ())]
                tgt = known[0] if known else (targets[0] if targets else None)
                cls, how, cands = mp.classify(svc, tgt, p["kind"], ops, p["op"]) if tgt else (None, "none", [])
                row.update({"table": tgt, "class": cls, "classBy": how, "op": p["op"],
                            "ops": sorted({o for o, _ in cands})})
                stmts.append(row)
                if tgt is None:          # SELECT $1 (pool validation), advisory locks: no table, not an access
                    continue
                if not cands and r["calls"] / n < BACKGROUND_CALLS_PER_REQ:
                    row["background"] = True     # e.g. the load generator's pool refresh: not the request's
                    continue
                k = (svc, cls, p["kind"], tuple(row["ops"]))
                a = acc.setdefault(k, {"service": svc, "class": cls, "mode": p["kind"], "tables": [],
                                       "calls": 0, "rows": 0, "execMs": 0.0, "planMs": 0.0, "statements": 0,
                                       "ops": [], "classBy": how, "lock": False})
                a["calls"] += r["calls"]
                a["rows"] += r["rows"]
                a["execMs"] += r["total_exec_time"]
                a["planMs"] += r.get("total_plan_time") or 0
                a["statements"] += 1
                a["lock"] |= p["lock"]
                if tgt and tgt not in a["tables"]:
                    a["tables"].append(tgt)
                for o in row["ops"]:
                    if o not in a["ops"]:
                        a["ops"].append(o)
        # the hooks' own psql (reset, dump) costs every DB container ~50 ms per segment: measured on the DB
        # containers without statements in this segment and removed before k_db
        idle_net = sorted(v["netMs"] for v in dbs.values() if "netMs" in v and v["execMs"] < 1)
        hook = idle_net[len(idle_net) // 2] if idle_net else 0.0
        for v in dbs.values():
            if v.get("kDb") is not None:
                v["hookMs"] = round(hook, 2)
                v["kDb"] = round((v["netMs"] - hook) / (v["execMs"] + v["planMs"]), 3)
                v["kDbExec"] = round((v["netMs"] - hook) / v["execMs"], 3)
        n = n_ref or 1
        accesses = []
        for a in acc.values():
            k = dbs.get(f"{a['service']}-db", {}).get("kDb") or next(
                (v.get("kDb") for c, v in dbs.items() if a["service"] in c), None)
            a.update(callsPerReq=round(a["calls"] / n, 4), rowsPerReq=round(a["rows"] / n, 4),
                     execMsPerReq=round(a["execMs"] / n, 4), planMsPerReq=round(a["planMs"] / n, 4),
                     execMs=round(a["execMs"], 3), planMs=round(a["planMs"], 3))
            accesses.append(a)
        scans = scan_suspects(stmts)
        out["segments"][seg] = {
            "scanSuspects": scans,
            "types": types, "requests": reqs, "perRequestOf": types[0] if types else None,
            "interval": [t0, t1], "dbs": dbs,
            "accesses": sorted(accesses, key=lambda a: -a["execMs"]),
            "tx": [{"db": c, "service": s, "stmt": k, "calls": v, "callsPerReq": round(v / n, 4)}
                   for (c, s, k), v in sorted(tx.items())],
            "candidateOps": [{"op": o, "role": r} for o, r in ops],
            "statements": sorted(stmts, key=lambda r: -r["execMs"])}
    allsc = {}
    for seg, v in out["segments"].items():
        for x in v["scanSuspects"]:
            k = (x["db"], x["queryid"])
            if k not in allsc or x["sharedBlksPerCall"] > allsc[k]["sharedBlksPerCall"]:
                allsc[k] = dict(x, segment=seg)
    out["scanSuspects"] = sorted(allsc.values(), key=lambda x: -x["sharedBlksPerCall"])
    return out


def shared_blocks_per_call(r):
    """Shared buffer blocks (hit + read) per call of a pg_stat_statements row."""
    c = r.get("calls") or 0
    return round(((r.get("shared_blks_hit") or 0) + (r.get("shared_blks_read") or 0)) / c, 1) if c else 0.0


def scan_suspects(stmts, limit=PARALLEL_BLOCKS):
    """Statements above `limit` shared blocks per call: [{db, service, queryid, table, calls, sharedBlksPerCall,
    execMsPerCall, query}], largest first."""
    out = [{"db": r["db"], "service": r["service"], "queryid": r["queryid"], "table": r.get("table"),
            "calls": r["calls"], "sharedBlksPerCall": r["sharedBlksPerCall"],
            "execMsPerCall": round(r["execMs"] / r["calls"], 3) if r["calls"] else None, "query": r["query"][:200]}
           for r in stmts if r.get("sharedBlksPerCall", 0) > limit]
    return sorted(out, key=lambda x: -x["sharedBlksPerCall"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("window")
    ap.add_argument("--out")
    a = ap.parse_args()
    d = common.window_dir(a.window)
    r = analyse_window(d)
    out = a.out or os.path.join(d, "analysis", "queries.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(r, open(out, "w"), indent=1)
    for seg, s in r["segments"].items():
        print(f"{seg}: requests {s['requests']}")
        for c, v in sorted(s["dbs"].items()):
            if v["execMs"] > 0:
                print(f"   {c:16s} exec {v['execMs']:9.1f} ms plan {v['planMs']:7.1f} net cgroup {v.get('netMs')} "
                      f"kDb {v.get('kDb')}")
        for x in s["accesses"]:
            print(f"   {x['service']:12s} {str(x['class']):22s} {x['mode']:5s} calls/req {x['callsPerReq']:7.3f} "
                  f"rows/req {x['rowsPerReq']:7.3f} exec ms/req {x['execMsPerReq']:7.4f} ops {x['ops'][:3]} ({x['classBy']})")
        for x in s["tx"]:
            print(f"   tx {x['service']:12s} {x['stmt']:10s} calls/req {x['callsPerReq']}")
    for x in r["scanSuspects"]:
        print(f"SCAN {x['service']:12s} {x['sharedBlksPerCall']:9.0f} blocks/call {x['execMsPerCall']} ms ({x['segment']}): "
              f"{x['query'][:120]}")
    print(f"{len(r['scanSuspects'])} statements above {PARALLEL_BLOCKS} shared blocks per call")
    print(out)


if __name__ == "__main__":
    main()
