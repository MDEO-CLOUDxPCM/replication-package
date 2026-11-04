#!/usr/bin/env python3
"""Parts per A's operation from totals x shares (README.md §1, §3.3, §3.5); writes timing/parts.json.

    parts.py --off W1,W2 --on W3,W4 [--atload W7] [--out timing/parts.json] [--min-ms 0.2]

Totals: D(type, container) in ms CPU per request from calibration's analyze_iso.analyze_window (cgroup, idle
baseline, steady phase), less the segment's offset of the container's role (iso_totals, common.segment_offsets).
Off windows give the totals; a type measured only on gets
D_on x r_c, r_c = sum D_off / sum D_on over the paired types of container c (>= 2 pairs), else the median r of the
container's role (app, db, dapr, ecs, other); see overhead_ratios. Shares: buckets.json (profile_buckets.py) and
queries.json (queries.py) of the on windows, which are computed here when missing.

Per request type T and app container c (service s):
  shares of c's net CPU (instrumentation excluded): acc = db-driver + mapping, mw = dapr-client,
  own = graphql + resolver + serialisation + http; gc+jit and unmatched are per-request overhead and are spread in
  proportion (shares renormalised over acc + mw + own).
  P = D x acc (persistence CPU), M = D x mw (middleware: in the calibrated hop/publish costs, reported only),
  own work = D - P - M.
  Access CPU per service: P(T) = alphaRead reads(T) + alphaWrite writes(T) + beta rows(T), non-negative least
  squares weighted for relative residuals over all types of the service (fit_access_cpu; statements and rows per
  request from pg_stat_statements); access a gets P x p_a / sum p, p_a = alpha_mode calls_a + beta rows_a; the fit
  residual per (T, s) is reported (target within 20 %).
  DB side: dbMs of access a = D(T, <s>-db) x exec_a / sum exec (totals x shares); execMs x k_db is the check.
Operations: an access goes to the operations A names for (service, table, mode) in T, split by A's reach
probability (share_weights), else to T's first operation of that service; own work of s: the CPU under an
operation's entry frame (A's `entry`, resolved in the sources of A's commit) goes to it, the leftover equally over
the operations that ran, GraphQL ones among them by data-fetcher span durations (split_own, fetcher_weights).
With counters (every instrumented window): own CPU per operation from the operation counters, the leftover of
unmatched keys over the operations that ran x their executions, a shape several operations share by their executions x
A's statements (exec_weights). Every value of operations[op] (byRequest and the means) is per execution of op
(README.md §3.5): the per-request part / its executions per request (`executions`); an operation the counters show not
executed in T gets nothing of T, one with fewer than MIN_EXECUTIONS executions no per-execution value
(`fewExecutions`, `rareOperations`). Consumers that need the per-request parts take common.request_parts.
With --atload, kAtLoad per container from the block-7 session window (atload.py).
"""
import argparse
import collections
import gzip
import json
import os
import re
import statistics as st
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import profile_buckets  # noqa: E402
import queries  # noqa: E402
import counters as ctr  # noqa: E402

def _checkout(root, name):
    """The submodule <name>/ of the repository if it is checked out, else ../<name> beside the repository."""
    sub = os.path.join(root, name)
    return sub if os.path.isdir(sub) and os.listdir(sub) else os.path.join(os.path.dirname(root), name)


KOTLIN = os.environ.get("MISARCH_KOTLIN_REPO", _checkout(common.REPO, "misarch-kotlin"))
PARAMS = os.path.join(common.TIMING, "calibration", "params.json")   # the calibrated middleware (README.md)
OWN = ("graphql", "resolver", "serialisation", "http")
ACCESS = ("db-driver", "mapping")
MIDDLEWARE = ("dapr-client",)


# ------------------------------------------------------------------------------------------------- pure parts
def fit_alpha_beta(points):
    """Non-negative least squares for P = alpha*calls + beta*rows (no intercept).
    points: [(calls, rows, P)]. Returns (alpha, beta, residuals [(P_hat - P) / P])."""
    def sse(a, b):
        return sum((a * c + b * r - p) ** 2 for c, r, p in points)
    cands = [(0.0, 0.0)]
    scc = sum(c * c for c, _, _ in points)
    srr = sum(r * r for _, r, _ in points)
    scr = sum(c * r for c, r, _ in points)
    scp = sum(c * p for c, _, p in points)
    srp = sum(r * p for _, r, p in points)
    det = scc * srr - scr * scr
    if abs(det) > 1e-12 * max(1.0, scc * srr):
        a = (scp * srr - srp * scr) / det
        b = (srp * scc - scp * scr) / det
        if a >= 0 and b >= 0:
            cands.append((a, b))
    if scc > 0:
        cands.append((max(0.0, scp / scc), 0.0))
    if srr > 0:
        cands.append((0.0, max(0.0, srp / srr)))
    a, b = min(cands, key=lambda ab: sse(*ab))
    res = [((a * c + b * r - p) / p) if p > 0 else None for c, r, p in points]
    return a, b, res


def _solve(A, b):
    """Gaussian elimination with partial pivoting; None if singular."""
    n = len(b)
    M = [list(r) + [v] for r, v in zip(A, b)]
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(M[r][i]))
        if abs(M[piv][i]) < 1e-12 * max(1.0, max(abs(x) for x in M[piv][:n])):
            return None
        M[i], M[piv] = M[piv], M[i]
        for r in range(n):
            if r != i and M[r][i]:
                f = M[r][i] / M[i][i]
                for c in range(i, n + 1):
                    M[r][c] -= f * M[i][c]
    return [M[i][n] / M[i][i] for i in range(n)]


def nnls(X, y, w=None):
    """Exact non-negative (weighted) least squares for a few coefficients: every subset of active coefficients is
    solved unconstrained, infeasible (negative) solutions are dropped, the feasible one with the smallest weighted
    SSE wins. X: [[x_1..x_k]], y: [..], w: weights (default 1)."""
    import itertools
    k = len(X[0]) if X else 0
    w = w or [1.0] * len(y)

    def sse(c):
        return sum(wi * (sum(a * b for a, b in zip(c, x)) - yi) ** 2 for x, yi, wi in zip(X, y, w))
    best = ([0.0] * k, sse([0.0] * k))
    for m in range(1, k + 1):
        for S in itertools.combinations(range(k), m):
            A = [[sum(wi * x[i] * x[j] for x, wi in zip(X, w)) for j in S] for i in S]
            b = [sum(wi * x[i] * yi for x, yi, wi in zip(X, y, w)) for i in S]
            sol = _solve(A, b)
            if sol is None or any(v < 0 for v in sol):
                continue
            c = [0.0] * k
            for i, v in zip(S, sol):
                c[i] = v
            e = sse(c)
            if e < best[1] - 1e-15:
                best = (c, e)
    return best[0]


def fit_access_cpu(points, min_points=3):
    """Persistence CPU per (request, service) P = alpha_read calls_read + alpha_write calls_write + beta rows,
    non-negative, weighted by 1/P^2 (minimises the relative residuals, which are the 20 % check). Writes carry the
    transaction statements (BEGIN/COMMIT) and RETURNING/insert mapping, so they cost ~2-4x a read statement on the
    campaign's data; a single alpha left most residuals above 20 %. With fewer than `min_points` points the read
    and write alphas are tied (two coefficients only).
    points: [(calls_read, calls_write, rows, P)] -> ({alphaRead, alphaWrite, beta, model}, residuals)."""
    pts = [p for p in points if p[3] > 0]
    if not pts:
        return {"alphaRead": 0.0, "alphaWrite": 0.0, "beta": 0.0, "model": "none"}, [None] * len(points)
    w = [1.0 / p[3] ** 2 for p in pts]
    y = [p[3] for p in pts]
    if len(pts) >= min_points:
        ar, aw, b = nnls([[p[0], p[1], p[2]] for p in pts], y, w)
        model = "alphaRead,alphaWrite,beta"
    else:
        a, b = nnls([[p[0] + p[1], p[2]] for p in pts], y, w)
        ar = aw = a
        model = "alpha,beta (few points)"
    f = {"alphaRead": ar, "alphaWrite": aw, "beta": b, "model": model}
    res = [((ar * cr + aw * cw + b * r - P) / P) if P > 0 else None for cr, cw, r, P in points]
    return f, res


def access_weight(fit, mode, calls, rows):
    a = fit["alphaWrite"] if mode == "write" else fit["alphaRead"]
    return a * calls + fit["beta"] * rows


def worked_containers(counters_t, q_t):
    """The service containers that did work in a request type's segment (common.segment_offsets): an app whose counters hold an
    operation that is not background or a statement, and its sidecars; a DB with a statement of a table or a
    transaction that is not background (queries.py; every DB answers the health check's `SELECT 1`). None without
    counters (then every container counts)."""
    if not counters_t:
        return None
    apps = {a for a, x in counters_t.items() if isinstance(x, dict) and (x.get("statements") or any(
        o.get("class", "own") != "background" and o.get("callsPerReq", 0) > 0 for o in x.get("operations", [])))}
    dbs = {x["service"] for x in (q_t or {}).get("statements", [])
           if x.get("service") and not x.get("background") and (x.get("table") or x.get("kind") == "tx")}
    return apps | {a + suf for a in apps for suf in ("-dapr", "-ecs")} | {d + "-db" for d in dbs}


def idle_in(worked, t, c, services):
    """A container of a domain service (app, -db, -dapr, -ecs) that did no work in t (worked_containers): after the
    segment offset its demand is noise around 0, which a threshold alone lets through at a low rate."""
    w = worked.get(t)
    if w is None or c in w:
        return False
    return any(c == x + suf for x in services for suf in ("", "-db", "-dapr", "-ecs"))


def overhead_ratios(off, on, min_ms=0.2, min_pairs=2, idle=lambda t, c: False):
    """r_c = D_off / D_on per container from the types measured both ways: pooled (sum D_off / sum D_on, so tiny,
    noisy demands weigh little) when the container has at least `min_pairs` pairs, else the median over the
    containers of its role (app, db, dapr, ecs, other); not from a type in which the container did no work
    (`idle`). -> ({c: r}, {c: {n, method, pooled, overheads}}, r_role)."""
    pairs = collections.defaultdict(list)
    for t in sorted(set(off) & set(on)):     # sorted: the same order in every run
        for c, d_off in off[t]["D"].items():
            d_on = on[t]["D"].get(c)
            if d_off and d_on and d_off > min_ms and d_on > min_ms and not c.startswith("engine:") and not idle(t, c):
                pairs[c].append((d_off, d_on, t))
    pooled = {c: sum(p[0] for p in v) / sum(p[1] for p in v) for c, v in pairs.items()}
    by_role = collections.defaultdict(list)
    for c, v in pairs.items():
        if len(v) >= min_pairs:
            by_role[container_role(c)].append(pooled[c])
    r_role = {k: st.median(v) for k, v in by_role.items()}
    allv = [x for v in by_role.values() for x in v] or list(pooled.values()) or [1.0]
    r_all = st.median(allv)
    r, info = {}, {}
    for c in set(pooled) | {c for t in on for c in on[t]["D"] if not c.startswith("engine:")}:
        n = len(pairs.get(c, []))
        if n >= min_pairs:
            r[c], how = pooled[c], "pooled pairs"
        else:
            r[c], how = r_role.get(container_role(c), r_all), f"role median ({container_role(c)})"
        info[c] = {"n": n, "method": how, "r": round(r[c], 3),
                   "pooled": round(pooled[c], 3) if c in pooled else None,
                   "overheadPooled": round(1 / pooled[c] - 1, 3) if c in pooled else None,
                   "overheads": {t: round(d_on / d_off - 1, 3) for d_off, d_on, t in pairs.get(c, [])}}
    return r, info, {k: round(v, 3) for k, v in r_role.items()}, r_all


def container_role(c):
    if c.endswith("-db") or c.endswith("-db-1"):
        return "db"
    for suf in ("-dapr", "-ecs"):
        if c.endswith(suf):
            return suf[1:]
    if c.startswith(("gateway", "keycloak", "dapr-", "otel", "zipkin", "placement", "experiment-config")) \
            or c in ("simulation-rabbitmq", "media-minio"):
        return "other"                           # infrastructure, not a domain service's app container
    return "app"


def split_own(own, ops, entry_cnt, own_samples, leftover_w):
    """Own work of one (request, service) over its operations (README §3.5): the CPU under an operation's entry
    frame goes to it directly (entry samples / all own samples of the container); the leftover (framework CPU,
    the libs/common DataLoader and connection code that the resolvers delegate to) goes by `leftover_w`
    ({op: weight}, data-fetcher span durations or 1 for each operation that ran). -> {op: ms}."""
    direct = {o: own * entry_cnt.get(o, 0) / own_samples for o in ops} if own_samples > 0 else {o: 0.0 for o in ops}
    left = own - sum(direct.values())
    tw = sum(leftover_w.get(o, 0) for o in ops)
    return {o: direct[o] + (left * leftover_w.get(o, 0) / tw if tw > 0 else left / len(ops)) for o in ops}


def effective_shares(shares):
    """Bucket shares (instrumentation already excluded) -> (acc, mw, own) renormalised over the three, i.e. gc+jit,
    unmatched and anything else spread in proportion."""
    acc = sum(shares.get(k, 0) for k in ACCESS)
    mw = sum(shares.get(k, 0) for k in MIDDLEWARE)
    own = sum(shares.get(k, 0) for k in OWN)
    s = acc + mw + own
    if s <= 0:
        return 0.0, 0.0, 1.0
    return acc / s, mw / s, own / s


# ------------------------------------------------------------------------------------------------- entry frames
_ENTRY_CACHE = {}


def _entry_source(entry, commit):
    """(package, source lines, 0-based line) of A's entry 'services/x/.../File.kt:LINE' at A's commit."""
    path, line = entry.rsplit(":", 1)
    src = subprocess.run(["git", "-C", KOTLIN, "show", f"{commit}:{path}"], capture_output=True, text=True,
                         timeout=30).stdout.split("\n")
    pkg = next((m.group(1) for x in src if (m := re.match(r"\s*package\s+([\w.]+)", x))), "")
    return pkg, src, int(line) - 1


# a federation entry that is a one-line resolver class of libs/common (misarch-kotlin unify):
#   class UserResolver : DataLoaderEntityResolver<User>(User::class, UserDataLoader::class)
#   class UserResolver : ReferenceEntityResolver<User>(User::class, ::User)
_RESOLVER_CLASS = re.compile(r"\bclass\s+\w+\s*:\s*((?:DataLoader|Reference)EntityResolver)\s*<\s*\w+\s*>\s*\(([^)]*)\)")


def _resolver_class(pkg, src, ln):
    """(base frame prefix, data loader frame prefix or None, data loader name or None) of a resolver class declared
    at line ln, else None. Packages come from the file's imports (same package without one)."""
    m = _RESOLVER_CLASS.search(" ".join(x.strip() for x in src[ln:ln + 4]))
    if not m:
        return None

    def qualified(name):
        imp = next((i.group(1) for x in src if (i := re.match(rf"\s*import\s+([\w.]+\.{name})\s*$", x))), None)
        return (imp or f"{pkg}.{name}").replace(".", "/")
    loader = re.search(r"(\w+)::class\s*$", m.group(2).split(",")[-1].strip()) if m.group(1).startswith("DataLoader") else None
    return qualified(m.group(1)), qualified(loader.group(1)) if loader else None, loader.group(1) if loader else None


def entry_frames(entry, commit):
    """A's entry 'services/x/.../File.kt:LINE' -> frame prefixes ('org/misarch/x/Cls.method', 'org/misarch/x/Cls$method$')
    from the source at A's commit (git show; the working tree may be on another branch). A one-line resolver class of
    libs/common (`class XResolver : DataLoaderEntityResolver<X>(X::class, XDataLoader::class)`, no `fun` of its own)
    -> its base class's `resolve` (shared by the service's resolvers of that kind: entry_cpu splits a sample matched
    by several operations) and, for a data loader resolver, the loader class (its own code, if it has any)."""
    if entry in _ENTRY_CACHE:
        return _ENTRY_CACHE[entry]
    res = []
    try:
        pkg, src, ln = _entry_source(entry, commit)
        path = entry.rsplit(":", 1)[0]
        meth = None
        for x in src[ln:ln + 3]:
            m = re.search(r"\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(", x)
            if m:
                meth = m.group(1)
                break
        rc = None if meth else _resolver_class(pkg, src, ln)
        cls = None
        depth_line = ln
        for i in range(depth_line, -1, -1):
            m = re.match(r"\s*(?:[\w\s]*\s)?(?:class|object)\s+(\w+)", src[i])
            if m and not src[i].lstrip().startswith(("//", "*")):
                cls = m.group(1)
                break
        if cls is None:
            cls = os.path.basename(path).replace(".kt", "") + "Kt"
        if meth:
            base = pkg.replace(".", "/") + "/" + cls
            res = [f"{base}.{meth}", f"{base}${meth}$"]
        elif rc:
            res = [f"{rc[0]}.resolve", f"{rc[0]}$resolve$"] + ([f"{rc[1]}.", f"{rc[1]}$"] if rc[1] else [])
    except Exception:
        res = []
    _ENTRY_CACHE[entry] = res
    return res


def entry_dataloader(entry, commit):
    """The data loader (class simple name = its counter key, kind `dataloader`) of a DataLoaderEntityResolver entry,
    else None (an entry function: its loaders are not told from the entry)."""
    try:
        pkg, src, ln = _entry_source(entry, commit)
        if any(re.search(r"\bfun\s", x) for x in src[ln:ln + 3]):
            return None
        rc = _resolver_class(pkg, src, ln)
        return rc[2] if rc else None
    except Exception:
        return None


def entry_cpu(folded_path, frames_by_op, cl):
    """CPU samples in own buckets under each operation's entry frame (the first frame from the leaf that is an
    operation's entry frame; a frame several operations share, e.g. libs/common's DataLoaderEntityResolver.resolve,
    is split equally among them)."""
    out = collections.Counter()
    own_total = 0
    for frames, n in profile_buckets.read_folded(folded_path):
        b = cl.stack(frames)
        if b not in OWN:
            continue
        own_total += n
        hits = []
        for f in reversed(frames):
            hits = [op for op, prefs in frames_by_op.items() if any(f.startswith(p) for p in prefs)]
            if hits:
                break
        for op in hits:
            out[op] += n / len(hits)
    return out, own_total


_SPANS = {}


def fetcher_ms(d, svc, t0, t1):
    """{graphql field name: summed duration ms} of the OTel data-fetcher spans of service svc in [t0, t1]."""
    if d not in _SPANS:
        p = os.path.join(d, "spans.json.gz")
        _SPANS[d] = json.load(gzip.open(p, "rt")) if os.path.exists(p) else []
    out = collections.Counter()
    for x in _SPANS[d]:
        f = (x.get("tags") or {}).get("graphql.field.name")
        if f and x.get("localEndpoint", {}).get("serviceName") == svc and t0 * 1e6 <= x["timestamp"] < t1 * 1e6:
            out[f] += x.get("duration", 0) / 1000
    return out


def share_weights(targets, reach):
    """Shares of a statement shape A names for several operations: by reach probability (A's call/publish
    probabilities), equal when none is known or all are 0. -> {op: share}, summing to 1."""
    w = {o: max(0.0, reach.get(o, 1.0)) for o in targets}
    tot = sum(w.values())
    if tot <= 0:
        return {o: 1 / len(targets) for o in targets}
    return {o: v / tot for o, v in w.items()}


# per execution (README.md §3.5): an operation with fewer measured executions than this in its request's segment gets
# no per-execution value of that request (`fewExecutions`, not in its means); one with no other request moves to
# `rareOperations` (the generator then keeps its seed value). In this campaign none falls below it (the rarest:
# inventory's payment-failed handler, 18 executions in placeOrder)
MIN_EXECUTIONS = 10


def counter_calls(pr, ops, loaders):
    """{op: counter calls per request (n of requests.csv)} of the operations a counter key of one app names. A
    `dataloader` key counts batches, not the operation's executions: only for an operation no other key names."""
    calls, batches = collections.Counter(), collections.Counter()
    for x in pr["operations"]:
        if x.get("class", "own") != "own":
            continue
        for o in ctr.match_operation(x["key"], x["kind"], ops, loaders):
            (batches if x["kind"] == "dataloader" else calls)[o] += x["callsPerReq"]
    for o, v in batches.items():
        calls.setdefault(o, v)
    return calls


def executions(o, plan_set, calls, ref, trigger):
    """(executions per request of type T, how) of operation o, the unit of parts.json's per-execution values
    (README.md §3.5): a plan operation of T 1 (the model's unit: one resolution of the plan's field per request, over
    all its nodes; the counters count the field's calls per node, e.g. wishlistView's ProductVariant.currentVersion
    ~3); any other operation (a call, a follow-up, a callback) its counter calls / `ref`, the counter calls of T's root
    operation (the counters' delta and requests.csv's n differ by 1-5 %; their ratio is the executions); an event or
    HTTP handler without a counter key 0 (not delivered in T: every delivery is counted); another operation without a
    key None (not counted: one assumed)."""
    if o in plan_set:
        return 1.0, "plan"
    if o in calls:
        return calls[o] / ref, "counters"
    if trigger and ("topic" in trigger or "http" in trigger):
        return 0.0, "counters (no delivery)"
    return None, "no counter key (1 assumed)"


def statements_of(op, tables, mode, kinds=None):
    """A's statements per execution of op on these tables in this mode (a data-dependent count: 1, the campaign's one
    item; derive.py `statements`); with `kinds` (the measured shape's statement kinds: select, lock, exists, count,
    ...) only A's accesses of those kinds, all where none is (queries.Mapping.classify's choice of candidates:
    a lock or count of the same table is a shape and access group of its own)."""
    accs = [a for a in op.get("accesses", []) if (a.get("table") or "").lower() in tables and a["mode"] == mode
            and a["today"] in ("local", "copy")]
    same = [a for a in accs if kinds and a.get("op") in kinds]
    n = 0.0
    for a in same or accs:
        s = a.get("statements", 1)
        n += float(s) if isinstance(s, (int, float)) else 1.0
    return n


def stmt_key(sql):
    """A statement's shape, comparable between the counters' SQL (`?`, value lists as `(?...)`) and pg_stat_statements'
    (`$n`, literals): queries.skeleton with NULL, every VALUES list and every IN list as one `?` (pg keeps one entry
    per IN-list length, the counters one per shape)."""
    s = re.sub(r"\bnull\b", "?", sql, flags=re.I)
    k = queries.skeleton(s.replace("?...", "?").replace("?", "$1"))
    k = re.sub(r"values(\([^)]*\),?)+", "values(?)", k)
    return re.sub(r"\bin\(\?(,\?)*\)", "in(?)", k)


def find_key(k, keys):
    """The pg shape of a counter statement: the same key, else the one key that starts like it (both texts are cut
    after a few hundred characters; an INSERT also by its head up to VALUES, the counters omit RETURNING)."""
    if k in keys:
        return k
    head = lambda x: x.split("values(")[0] if x.startswith("insert") else x
    for f in (lambda x: x, head):
        a = f(k)
        c = [kk for kk in keys if min(len(a), len(f(kk))) >= 30 and f(kk)[:min(len(a), len(f(kk)))] == a[:min(len(a), len(f(kk)))]]
        if len(c) == 1:
            return c[0]
    return None


def shape_index(accesses, pg_rows):
    """{pg shape (stmt_key): [(access index, pg calls per request)]} of the accesses (queries.py) of one (request,
    service): a pg_stat_statements row belongs to the access of its service, class, kind, table and operations."""
    own = lambda x, a: (x.get("service") == a["service"] and x.get("class") == a["class"] and x.get("kind") == a["mode"]
                        and x.get("table") in a["tables"] and set(x.get("ops") or []) == set(a["ops"])
                        and not x.get("background"))
    by_key = collections.defaultdict(list)
    for x in pg_rows:
        if x.get("kind") == "tx" or not x.get("table") or not x.get("query"):
            continue
        for i, a in enumerate(accesses):
            if own(x, a):
                by_key[stmt_key(x["query"])].append((i, x["callsPerReq"]))
                break
    return by_key


def statement_accesses(stmt, by_key):
    """[(access index, weight)] of a counter statement: the accesses of its pg shape (stmt_key, find_key), several by
    their pg calls; None where no shape matches."""
    k = find_key(stmt_key(stmt["sql"]), by_key) if stmt.get("sql") else None
    if k is None:
        return None
    tot = sum(c for _, c in by_key[k])
    return [(i, c / tot if tot else 1.0 / len(by_key[k])) for i, c in by_key[k]]


def counter_statements(accesses, pg_rows, ctr_stmts):
    """Per access (queries.py, pg_stat_statements) the counters' statements and rows per request (counters.py: per n)
    of its shapes, [(calls, rows) or None]: a counter statement goes to the pg shape of its SQL
    (statement_accesses), a shape to the access of its rows (shared by several: by their pg calls); None for an access
    no counter statement matches."""
    by_key = shape_index(accesses, pg_rows)
    out = [None] * len(accesses)
    for s in ctr_stmts:
        for i, w in statement_accesses(s, by_key) or []:
            cur = out[i] or (0.0, 0.0)
            out[i] = (cur[0] + s["callsPerReq"] * w, cur[1] + s["rowsPerReq"] * w)
    return out


def statement_cpu(accesses, pg_rows, ctr_stmts, k_prod, by_table):
    """Per access the counters' driver + mapping CPU of its statements x k_prod: each counter statement to the
    accesses of its own SQL shape (statement_accesses); one that matches no shape by `by_table` (counters.match_access's
    table and mode; counted in the second value); one with neither (no table: advisory locks, SELECT 1) in the third,
    spread by the fit's weights. -> (per access ms, by-table ms, unmatched ms)."""
    by_key = shape_index(accesses, pg_rows)
    out, tab, left = [0.0] * len(accesses), 0.0, 0.0
    for x in ctr_stmts:
        c_ms = (x["driverCpuMs"] + x["mappingCpuMs"]) * k_prod
        ws = statement_accesses(x, by_key)
        if ws is None:
            i = by_table(x)
            if i is None:
                left += c_ms
                continue
            ws, tab = [(i, 1.0)], tab + c_ms
        for i, w in ws:
            out[i] += c_ms * w
    return out, tab, left


def shape_kinds(a, statements):
    """The statement kinds (queries.parse_sql `op`) of the pg_stat_statements rows an access (queries.py) holds."""
    return {x.get("op") for x in statements if x.get("service") == a["service"] and x.get("class") == a["class"]
            and x.get("kind") == a["mode"] and x.get("table") in a["tables"] and set(x.get("ops") or []) == set(a["ops"])
            and not x.get("background")}


def fallback_op(plan_ops, svc_ops, xof):
    """The operation that holds a service's parts no operation that ran can take: its first plan operation
    that ran, else its first operation that ran, else its first plan operation (or operation)."""
    return (next((o for o in plan_ops if xof(o) > 0), None) or next((o for o in svc_ops if xof(o) > 0), None)
            or (plan_ops or svc_ops or [None])[0])


def shape_shares(targets, tw, xof, fb):
    """{op: share} of an access over the operations that ran among its targets: the shares tw of those, else
    all of it to fb, so that no measured access is dropped."""
    ok = {o: tw[o] for o in targets if tw.get(o, 0) > 0 and xof(o) > 0}
    tot = sum(ok.values())
    if tot <= 0:
        return {fb: 1.0}
    return {o: v / tot for o, v in ok.items()}


def exec_weights(targets, ex, stmts, reach):
    """Shares of a statement shape A names for several operations: by measured executions x A's
    statements per execution (an operation that did not run gets none); by executions alone where A gives them no
    statements; A's reach probability (share_weights) without measured executions. -> {op: share}, summing to 1."""
    for w in ({o: max(0.0, ex[o]) * stmts[o] for o in targets}, {o: max(0.0, ex[o]) for o in targets}):
        tot = sum(w.values())
        if tot > 0:
            return {o: v / tot for o, v in w.items()}
    return share_weights(targets, reach)


def per_exec(v, x):
    """A per-request value as per execution of x per request; two more digits where x is not 1, so that x times it
    gives the per-request value to the old four digits."""
    if v is None:
        return None
    return round(v, 4) if x == 1.0 else round(v / x, 6)


def fetcher_weights(ran, fields, fm):
    """Leftover weights of the operations that ran: 1 each; the GraphQL operations (fields[o] not None) share their
    group's weight (number of GraphQL operations) by data-fetcher span ms when any was recorded. -> (w, how)."""
    w = {o: 1.0 for o in ran}
    g = [o for o in ran if fields.get(o)]
    tot = sum(fm.get(fields[o], 0.0) for o in g)
    if len(g) > 1 and tot > 0:
        for o in g:
            w[o] = len(g) * fm.get(fields[o], 0.0) / tot
        return w, "equal over operations that ran, GraphQL ones by data-fetcher spans"
    return w, "equal over operations that ran"


def ran_operations(svc_ops, plan_set, entry_cnt, accesses, fields, fm):
    """The operations of a (request, service) that ran: the request's own (plan) operations, and the others (calls,
    follow-ups) with an entry-frame sample, an attributed access or a data-fetcher
    span of their GraphQL field."""
    return [o for o in svc_ops if o in plan_set or entry_cnt.get(o, 0) > 0
            or any(o in a["ops"] for a in accesses) or (fields.get(o) and fm.get(fields[o], 0) > 0)]


def op_field(op):
    g = op.get("trigger", {}).get("graphql", "")
    if g.startswith("_entities"):
        return "_entities"
    return g.rsplit(".", 1)[-1] if g else None


# ------------------------------------------------------------------------------------------------- totals
SCHEDULED_SEEN = {}   # window -> CpuData.scheduled of its totals (the scheduled jobs' CPU masked out of them)


def scheduled_summary(windows):
    """Measured cost of the domain's scheduled operations from the masked firings of the production windows:
    per (service, cron) CPU per firing of the app and DB container, split equally over the operations that fire
    together (their individual shares are not separable in the cgroup CPU)."""
    acc = {}
    for w in windows:
        for key, v in SCHEDULED_SEEN.get(w, {}).items():
            if not v["firings"]:
                continue
            a = acc.setdefault(v["cron"] + "|" + ",".join(v["ops"]), {"cron": v["cron"], "ops": v["ops"], "c": {}})
            c = a["c"].setdefault(common.short(key), [0, 0.0])
            c[0] += v["firings"]
            c[1] += v["removedCpuS"]
    out = {}
    for a in acc.values():
        per = {c: round(1000 * s / n, 2) for c, (n, s) in a["c"].items() if n}
        for op in a["ops"]:
            out[op] = {"cron": a["cron"], "firedWith": a["ops"], "firingsSeen": max(n for n, _ in a["c"].values()),
                       "cpuMsPerFiring": {c: round(v / len(a["ops"]), 2) for c, v in per.items()},
                       "cpuMsPerFiringTogether": per, "windows": windows}
    return out


def iso_totals(d):
    os.environ.setdefault("MISARCH_STACK", "kotlin")
    if common.CAL_SCRIPTS not in sys.path:
        sys.path.insert(0, common.CAL_SCRIPTS)
    import analyze_iso
    r = analyze_iso.analyze_window(d, scheduled=common.scheduled_jobs())
    SCHEDULED_SEEN[os.path.basename(d)] = r.get("scheduled", {})
    mp = _mapping()
    services = sorted({o["service"] for o in mp.ops.values()})
    out = {}
    for t, v in r["types"].items():
        D = {common.short(k): c["D"] for k, c in v["containers"].items() if c.get("D") is not None}
        # the segment offset (common.segment_offsets): removed per role, per request at the rate X
        touched = common.touched_services(mp, t.split("@")[0]) if common.offset_enabled() else None
        offs = {}
        if touched is not None and v["X"]:
            net = {common.short(k): c["U"] - c["base"] for k, c in v["containers"].items() if c.get("U") is not None}
            offs = common.segment_offsets(net, touched, services)
            for c in D:
                role = common.offset_role(c, services)
                if role is not None:
                    D[c] -= offs[role][0] * 1000 / v["X"]
        out[t] = {"X": v["X"], "n": v["n"], "errRate": v["errRate"], "segmentValid": v["segmentValid"],
                  "latency": v["latency_ms"], "latencyIsolated": v["latency_isolated_ms"], "D": D,
                  "se": {common.short(k): c["se"] for k, c in v["containers"].items() if c.get("se") is not None},
                  "offsets": {role: {"msPerS": round(o * 1000, 4), "untouched": n} for role, (o, n) in offs.items()}}
    return out, r.get("valid")


_MP = []


def _mapping():
    """queries.Mapping, built once (iso_totals runs per window)."""
    if not _MP:
        _MP.append(queries.Mapping())
    return _MP[0]


def speed_segments(d):
    """{steady segment: {placement, regime, benchMs}} of a window (speed.py); {} if it cannot be computed."""
    try:
        import speed
        return {k: {x: v[x] for x in ("placement", "regime", "benchMs")} for k, v in speed.segment_regimes(d)["segments"].items()}
    except Exception:
        return {}


def ensure(d, name, fn):
    p = os.path.join(d, "analysis", name)
    if not os.path.exists(p):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        json.dump(fn(d), open(p, "w"), indent=1)
    return json.load(open(p))


# ------------------------------------------------------------------------------------------------- main
def build(off_dirs, on_dirs, min_ms=0.2, atload_window=None, atload_max_level=0.75, factorial_path=None):
    mp = queries.Mapping()
    commit = mp.d["meta"]["commit"]
    cl = profile_buckets.Classifier()
    off, on, buckets, qs, seg_dir, cnts = {}, {}, {}, {}, {}, {}
    windows = {"off": [], "on": []}
    seg_speed = collections.defaultdict(dict)       # type -> {off|on: regime of its steady segment}
    for d in off_dirs:
        t, valid = iso_totals(d)
        windows["off"].append({"window": os.path.basename(d), "valid": valid})
        off.update(t)
        for seg, v in speed_segments(d).items():
            seg_speed[seg.split(":")[0]]["off"] = v
    for d in on_dirs:
        t, valid = iso_totals(d)
        windows["on"].append({"window": os.path.basename(d), "valid": valid})
        on.update(t)
        for seg, v in speed_segments(d).items():
            seg_speed[seg.split(":")[0]]["on"] = v
        b = ensure(d, "buckets.json", profile_buckets.analyse_window)
        q = ensure(d, "queries.json", lambda x: queries.analyse_window(x, mp))
        for seg, v in b["segments"].items():
            if seg.endswith(":steady"):
                buckets[seg.split(":")[0]] = v
                seg_dir[seg.split(":")[0]] = d
        for seg, v in q["segments"].items():
            qs[seg.split(":")[0]] = v
        for seg, v in ctr.window_counters(d).items():    # the measured CPU counters (counters.py)
            if seg.endswith(":steady"):
                cnts[seg.split(":")[0]] = v
    # the containers that did work per type (with the segment offset only, TIMING_SEGMENT_OFFSET)
    services = sorted({o["service"] for o in mp.ops.values()})
    worked = {t: worked_containers(cnts.get(t), qs.get(t)) for t in set(off) | set(on)} if common.offset_enabled() else {}
    idle = lambda t, c: idle_in(worked, t, c, services)
    # overhead ratios r_c = D_off / D_on over paired types (pooled; role median for containers with < 2 pairs)
    r_c, r_info, r_role, r_all = overhead_ratios(off, on, min_ms, idle=idle)

    def total(t, c):
        if t in off and c in off[t]["D"]:
            return off[t]["D"][c], "off"
        if t in on and c in on[t]["D"]:
            return on[t]["D"][c] * r_c.get(c, r_all), "on x r_c"
        return None, None

    # per (type, service): P, M, own, calls, rows
    rows = {}
    for t in sorted(set(buckets) | set(qs)):
        b = buckets.get(t, {})
        q = qs.get(t, {})
        for c, v in b.items():
            if c == "_all" or c.endswith("-db"):
                continue
            D, src = total(t, c)
            if D is None or D < min_ms or idle(t, c):
                continue
            acc, mw, own = effective_shares(v["shares"])
            svc_acc = [a for a in q.get("accesses", []) if a["service"] == c]
            cs = None
            pr = cnts.get(t, {}).get(c)
            d_on = on.get(t, {}).get("D", {}).get(c)
            if pr and d_on:
                cs = ctr.shares(pr, d_on, v.get("instrumentationShareOfNet") or 0.0,
                                v["shares"].get("dapr-client", 0.0))
            if cs:      # measured: access and operation CPU from the counters, the rest = per-request overhead
                Pp = D * acc
                acc, mw = cs["access"], cs["middleware"]
                own = 1 - acc - mw
            rows[(t, c)] = {"D": D, "Dsource": src, "P": D * acc, "M": D * mw, "own": D * own,
                            "counters": pr if cs else None, "cshares": cs,
                            "Pprofile": Pp if cs else D * acc,
                            "shares": v["shares"], "unmatched": v.get("unmatchedShare"),
                            "instrumentation": v.get("instrumentationShareOfNet"), "coverage": v.get("coverage"),
                            "calls": sum(a["callsPerReq"] for a in svc_acc),
                            "callsRead": sum(a["callsPerReq"] for a in svc_acc if a["mode"] != "write"),
                            "callsWrite": sum(a["callsPerReq"] for a in svc_acc if a["mode"] == "write"),
                            "rows": sum(a["rowsPerReq"] for a in svc_acc), "accesses": svc_acc}
    # alpha/beta per service
    fits = {}
    for svc in sorted({c for _, c in rows}):
        pts = [(k, r) for k, r in rows.items() if k[1] == svc and (r["calls"] > 0 or r["rows"] > 0)]
        if not pts:
            continue
        f, res = fit_access_cpu([(r["callsRead"], r["callsWrite"], r["rows"], r["Pprofile"]) for _, r in pts])
        rs = [abs(x) for x in res if x is not None]
        fits[svc] = {"alphaRead": round(f["alphaRead"], 5), "alphaWrite": round(f["alphaWrite"], 5),
                     "beta": round(f["beta"], 6), "model": f["model"], "n": len(pts),
                     "medianAbsResidual": round(st.median(rs), 3) if rs else None,
                     "over20": sum(x > 0.2 for x in rs),
                     "residuals": {k[0]: (round(x, 3) if x is not None else None) for (k, _), x in zip(pts, res)}}
    # k_db per DB container (median over the segments with > 50 ms of exec; the same as the `kDb` section below)
    k_db_med = collections.defaultdict(list)
    for q in qs.values():
        for c, v in q.get("dbs", {}).items():
            if v.get("kDb") is not None and v["execMs"] > 50:
                k_db_med[c].append(v["kDb"])
    k_db_med = {c: st.median(v) for c, v in k_db_med.items()}
    # assemble per operation
    parts = collections.OrderedDict()
    by_request = {}
    for t in sorted({k[0] for k in rows}):
        ops = mp.request_ops(t)
        q = qs.get(t, {})
        # executions per request: the counters' calls relative to T's root operation's
        plan_set = {o for o, role in ops if role == "plan"}
        root = next((o for o, role in ops if role == "plan"), None)
        ref = None
        if root and cnts.get(t, {}).get(mp.ops[root]["service"]):
            rops = {o: mp.ops[o] for o, _ in ops if mp.ops[o]["service"] == mp.ops[root]["service"]}
            rl = {o: entry_dataloader(mp.ops[o]["entry"], commit) for o in rops if mp.ops[o].get("entry")}
            ref = counter_calls(cnts[t][mp.ops[root]["service"]], rops, rl).get(root)
        req = {"type": t, "sessionRequest": mp.session_key(t), "operations": [o for o, _ in ops], "containers": {}}
        if seg_speed.get(t):        # flags: a slow-regime segment, a not-warm one (jit share of its apps > 3 %)
            req["speed"] = seg_speed[t]
        ja = (buckets.get(t) or {}).get("_all") or {}
        if "jitShare" in ja:
            req["jitShare"], req["jitFlag"] = ja["jitShare"], ja.get("jitFlag")
        so = {w: x[t]["offsets"] for w, x in (("off", off), ("on", on)) if x.get(t, {}).get("offsets")}
        if so:      # the segment offsets removed from the totals, ms/s per role
            req["segmentOffsets"] = so
        by_request[t] = req
        for (tt, svc), r in rows.items():
            if tt != t:
                continue
            f = fits.get(svc, {"alphaRead": 0.0, "alphaWrite": 0.0, "beta": 0.0})
            ps = [access_weight(f, a["mode"], a["callsPerReq"], a["rowsPerReq"]) for a in r["accesses"]]
            sp = sum(ps)
            db_key = f"{svc}-db"
            D_db, _ = total(t, db_key)
            ex_tot = sum(a["execMsPerReq"] for a in r["accesses"])
            k_db = q.get("dbs", {}).get(db_key, {}).get("kDb")
            # a DB total at or below 0 is noise around a small cost (e.g. registration's user-created handlers at
            # 3/s): the statements' exec time x k_db (the segment's, else the container's, else all DBs' median)
            D_db_split, D_db_from = D_db, "total"
            k_fb = k_db or k_db_med.get(db_key) or (st.median(k_db_med.values()) if k_db_med else None)
            if D_db is not None and D_db <= 0 and k_fb and ex_tot > 0:
                D_db_split, D_db_from = ex_tot * k_fb, "exec x kDb (total <= 0)"
            svc_ops = [o for o, role in ops if mp.ops[o]["service"] == svc]
            plan_ops = [o for o, role in ops if mp.ops[o]["service"] == svc and role == "plan"] or svc_ops
            req["containers"][svc] = {"D": round(r["D"], 4), "Dsource": r["Dsource"], "P": round(r["P"], 4),
                                      "M": round(r["M"], 4), "own": round(r["own"], 4), "D_db": D_db,
                                      "D_dbFrom": D_db_from,
                                      "kDb": k_db, "unmatchedShare": r["unmatched"],
                                      "instrumentationShare": r["instrumentation"], "coverage": r["coverage"],
                                      "fitResidual": fits.get(svc, {}).get("residuals", {}).get(t),
                                      "operations": svc_ops}
            # per access the counters' driver + mapping CPU of its statements (scaled to production like the
            # shares); statements no access matches are spread by the fit's weights (without counters: all of P)
            measured, cstat = None, None
            if r["cshares"]:
                base = on[t]["D"][svc] * (1 - (r.get("instrumentation") or 0.0))
                k_prod = r["D"] / base if base > 0 else 0.0
                # each statement's CPU to the access of its own SQL shape (the table/mode rule only without one)
                measured, by_tab, left = statement_cpu(r["accesses"], q.get("statements", []), r["counters"]["statements"],
                                                       k_prod, lambda x: ctr.match_access(x, r["accesses"], queries.parse_sql))
                measured = [m + (left * p / sp if sp > 0 else (left / len(ps) if ps else 0)) for m, p in zip(measured, ps)]
                # statements and rows from the counters (the snapshot of the executions), per request sent in it
                cstat = counter_statements(r["accesses"], q.get("statements", []), r["counters"]["statements"])
                cstat = [None if c is None else (c[0] / (ref or 1.0), c[1] / (ref or 1.0)) for c in cstat]
                pg_c = sum(a_["callsPerReq"] for a_, c in zip(r["accesses"], cstat) if c is not None)
                req["containers"][svc]["statementsCountersVsPg"] = (
                    round(sum(c[0] for c in cstat if c is not None) / pg_c, 4) if pg_c > 0 else None)
                req["containers"][svc].update(
                    accessFrom="counters", Pprofile=round(r["Pprofile"], 4),
                    countersCoverage=round(r["cshares"]["coverage"], 3),
                    threadCoverage=round(r["cshares"]["threadCoverage"], 3) if r["cshares"]["threadCoverage"] else None,
                    attributedOfThread=(round(r["cshares"]["attributedOfThread"], 3)
                                        if r["cshares"]["attributedOfThread"] else None),
                    graphqlEngineMs=round(r["D"] * r["cshares"]["engine"], 4),
                    profileAccessRatio=round(r["P"] / r["Pprofile"], 3) if r["Pprofile"] else None,
                    fitVsCounters=round(sum(ps) / r["P"], 3) if r["P"] > 0 and sp > 0 else None,
                    requestOverheadMs=round(r["D"] * r["cshares"]["remainder"], 4),
                    unmatchedStatementMs=round(left, 4), countersOver100=r["cshares"]["over"],
                    **({"mappingByTableMs": round(by_tab, 4)} if by_tab > 0 else {}))
            # executions per request of the service's operations (without counters: 1)
            ex, ex_how, ex_n = {}, {}, {}
            if r["cshares"]:
                ld = {o: entry_dataloader(mp.ops[o]["entry"], commit) for o in svc_ops if mp.ops[o].get("entry")}
                calls_o = counter_calls(r["counters"], {o: mp.ops[o] for o in svc_ops}, ld)
                for o in svc_ops:
                    x, how = executions(o, plan_set, calls_o, ref or 1.0, mp.ops[o].get("trigger"))
                    ex[o], ex_how[o] = x, how
                    if how == "counters":
                        ex_n[o] = round(calls_o[o] * r["counters"]["n"])
            xof = lambda o: 1.0 if ex.get(o) is None else ex[o]
            fb = fallback_op(plan_ops, svc_ops, xof)
            xeff = lambda o: xof(o) if xof(o) > 0 else 1.0      # only the fallback can hold parts without executions

            def mark(br, o):
                """The executions the entry's values are per."""
                if ex and "executionsPerRequest" not in br:
                    br["executionsPerRequest"] = round(xeff(o), 6)
                    br["executionsFrom"] = ex_how[o] if xof(o) > 0 else ex_how[o] + "; holds the service's parts (1 assumed)"
                    if o in ex_n:
                        br["executions"] = ex_n[o]
                        if ex_n[o] < MIN_EXECUTIONS:
                            br["fewExecutions"] = True
            # accesses -> operations (a shape shared by several operations: split by measured executions x A's
            # statements per execution; without counters by A's reach probability)
            reach = mp.reach_probs(t)
            for ai, (a, p) in enumerate(zip(r["accesses"], ps)):
                map_ms = r["P"] * p / sp if sp > 0 else (r["P"] / len(r["accesses"]) if r["accesses"] else 0)
                if measured is not None:
                    map_ms = measured[ai]
                db_ms = (D_db_split * a["execMsPerReq"] / ex_tot) if (D_db_split and ex_tot > 0) else None
                # the counters' statements and rows; DB parts x counter / pg statements (per statement unchanged)
                calls_req, rows_req, exec_req, f_c, st_from = a["callsPerReq"], a["rowsPerReq"], a["execMsPerReq"], 1.0, None
                if cstat is not None:
                    if cstat[ai] is not None and a["callsPerReq"] > 0:
                        f_c = cstat[ai][0] / a["callsPerReq"]
                        calls_req, rows_req, exec_req = cstat[ai][0], cstat[ai][1], a["execMsPerReq"] * f_c
                        db_ms = db_ms * f_c if db_ms is not None else None
                    else:
                        st_from = "pg (no counter statement)"
                targets = [o for o in a["ops"] if o in svc_ops] or plan_ops[:1]
                if ex and len(targets) > 1:
                    kinds = shape_kinds(a, q.get("statements", []))
                    tw = exec_weights(targets, {o: xof(o) for o in targets},
                                      {o: statements_of(mp.ops[o], a["tables"], a["mode"], kinds) for o in targets}, reach)
                else:
                    tw = share_weights(targets, reach)
                n_targets = len(targets)
                if ex:
                    tw = shape_shares(targets, tw, xof, fb)
                    targets = [o for o in targets if o in tw] or [fb]
                for o in targets:
                    if tw[o] <= 0:
                        continue
                    e = parts.setdefault(o, {"service": svc, "byRequest": {}})
                    br = e["byRequest"].setdefault(t, {"ownCpuMs": 0.0, "accesses": []})
                    mark(br, o)
                    k = 1 / tw[o]
                    x = xeff(o)
                    br["accesses"].append({
                        "class": a["class"], "mode": a["mode"], "tables": a["tables"], "lock": a["lock"],
                        "calls": per_exec(calls_req / k, x), "rows": per_exec(rows_req / k, x),
                        "dbMs": per_exec(db_ms / k, x) if db_ms is not None else None,
                        "dbExecMs": per_exec(exec_req / k, x),
                        "dbExecXkDbMs": per_exec(exec_req * k_db / k, x) if k_db else None,
                        "mapCpuMs": per_exec(map_ms / k, x), "classBy": a["classBy"],
                        "split": round(k, 3) if n_targets > 1 else None,
                        **({"statementsFrom": st_from} if st_from else {})})
            # own work -> operations by entry frames
            frames = {o: entry_frames(mp.ops[o]["entry"], commit) for o in svc_ops if mp.ops[o].get("entry")}
            cnt, own_tot = collections.Counter(), 0
            fp = None
            adir = os.path.join(seg_dir.get(t, ""), "asprof")
            if os.path.isdir(adir):
                fp = next((os.path.join(adir, x) for x in os.listdir(adir)
                           if x.startswith(common.segname(f"{t}:steady") + "__" + svc + ".")), None)
            if fp and frames:
                cnt, own_tot = entry_cpu(fp, frames, cl)
                req["containers"][svc]["entrySampleShare"] = round(sum(cnt.values()) / own_tot, 3) if own_tot else None
            # operations that ran: the request's own (plan) operations, and the others (calls, follow-ups) where an
            # entry frame was sampled or an access was attributed to them
            plan_set = {o for o, role in ops if role == "plan"}
            fm = {}
            if seg_dir.get(t):
                iv = common.segments(seg_dir[t]).get(f"{t}:steady")
                if iv:
                    fm = fetcher_ms(seg_dir[t], svc, iv["start"], iv["end"])
            fields = {o: op_field(mp.ops[o]) if "graphql" in (mp.ops[o].get("trigger") or {}) else None
                      for o in svc_ops}
            ran = ran_operations(svc_ops, plan_set, cnt, r["accesses"], fields, fm) or plan_ops
            if ex:      # an operation the counters show not executed in t did not run (no access, no leftover)
                ran = [o for o in ran if xof(o) > 0] or ([fb] if fb else [])
            # the remainder's carrier: the request's plan operation of the service, else the first that ran
            has_plan = any(role == "plan" and mp.ops[x]["service"] == svc for x, role in ops)
            carrier = ran[0] if ex and not has_plan and ran else (plan_ops[0] if plan_ops else None)
            # leftover: equally over the operations that ran; within the GraphQL operations among them by the
            # data-fetcher span durations (§3.5) where the window has spans (event and HTTP handlers have no
            # data-fetcher spans, so they keep their equal share)
            lw, how = fetcher_weights(ran, {o: fields[o] for o in ran}, fm)
            if sum(cnt.values()):
                how = "entry frames + " + how
            req["containers"][svc]["ownSplitBy"] = how
            if r["cshares"] and svc_ops:    # a container A does not reach for t (background) has nothing to split
                # own CPU per operation measured (operation counters); unmatched keys (dataloader, ...) as the
                # leftover of split_own; the remainder is the request overhead, a part of its own (plan operation)
                ops_by_id = {o: mp.ops[o] for o in svc_ops}
                loaders = {o: entry_dataloader(mp.ops[o]["entry"], commit) for o in svc_ops if mp.ops[o].get("entry")}
                ov = r["D"] * r["cshares"]["remainder"]
                split = {o: 0.0 for o in svc_ops}
                left = 0.0
                for key, sh_ in r["cshares"]["operations"].items():
                    kind = next((x["kind"] for x in r["counters"]["operations"] if x["key"] == key), None)
                    m = ctr.match_operation(key, kind, ops_by_id, loaders)
                    for o in m:
                        split[o] += r["D"] * sh_ / len(m)
                    if not m:
                        left += r["D"] * sh_
                # the leftover by the weights x the executions per request (1 each where all ran once)
                lx = {o: lw.get(o, 0) * xeff(o) for o in ran}
                tw = sum(lx.values())
                for o in ran:
                    split[o] += left * lx[o] / tw if tw > 0 else left / len(ran)
                how = "counters" + (" + unmatched keys " + req["containers"][svc]["ownSplitBy"] if left > 0 else "")
                req["containers"][svc]["ownSplitBy"] = how
                req["containers"][svc]["requestOverheadOp"] = carrier
            else:
                split = split_own(r["own"], svc_ops, cnt, own_tot, lw)
                ov = None
            for o in svc_ops:
                if split[o] <= 0 and o not in ran:
                    continue
                e = parts.setdefault(o, {"service": svc, "byRequest": {}})
                br = e["byRequest"].setdefault(t, {"ownCpuMs": 0.0, "accesses": []})
                x = xeff(o)
                br["ownCpuMs"] = per_exec(split[o], x)      # per execution; the share and overheads per request
                br["ownShareOfService"] = round(split[o] / r["own"], 4) if r["own"] else 0.0
                br["totals"] = r["Dsource"]
                mark(br, o)
                if ov is not None and o == carrier:
                    # the entry container's remainder is the request overhead; in a container without a plan
                    # operation of t (event handlers only) it is the handlers' envelope (README.md §6: use
                    # `envelope`, not this; kept for the cross-check)
                    if has_plan:
                        br["requestOverheadCpuMs"] = round(ov, 4)
                    else:
                        br["envelopeRemainderCpuMs"] = round(ov, 4)
    # summary per op: mean over the requests that measured it (per execution; not over a request with fewer
    # than MIN_EXECUTIONS executions; an operation with only such requests moves to rareOperations); follow-ups from A
    rare = collections.OrderedDict()
    for o in list(parts):
        if all(x.get("fewExecutions") for x in parts[o]["byRequest"].values()):
            rare[o] = parts.pop(o)
    for o, e in parts.items():
        reqs = [x for x in e["byRequest"].values() if not x.get("fewExecutions")]
        e["ownCpuMs"] = round(st.mean(x["ownCpuMs"] for x in reqs), 4)
        ovs = [x["requestOverheadCpuMs"] for x in reqs if "requestOverheadCpuMs" in x]
        if ovs:     # the service's per-request overhead, carried by the request's plan operation
            e["requestOverheadCpuMs"] = round(st.mean(ovs), 4)
        merged = collections.OrderedDict()
        for x in reqs:
            for a in x["accesses"]:
                k = (a["class"], a["mode"])
                m = merged.setdefault(k, {"class": a["class"], "mode": a["mode"], "n": 0, "calls": 0.0, "rows": 0.0,
                                          "dbMs": 0.0, "mapCpuMs": 0.0})
                m["n"] += 1
                for f in ("calls", "rows", "mapCpuMs"):
                    m[f] += a[f]
                m["dbMs"] += a["dbMs"] or 0.0
        e["accesses"] = [{"class": m["class"], "mode": m["mode"], "calls": round(m["calls"] / len(reqs), 4),
                          "rows": round(m["rows"] / len(reqs), 4), "dbMs": round(m["dbMs"] / len(reqs), 4),
                          "mapCpuMs": round(m["mapCpuMs"] / len(reqs), 4)} for m in merged.values()]
        op = mp.ops[o]
        e["kind"] = op["kind"]
        e["followUps"] = sorted({s for p in op.get("publishes", []) for s in mp.subs.get(p["topic"], [])})
        e["measuredIn"] = sorted(e["byRequest"])
        e["totalsFrom"] = sorted({by_request[t]["containers"][e["service"]]["Dsource"] for t in e["byRequest"]
                                  if e["service"] in by_request[t]["containers"]})
        e["approximateTotals"] = "off" not in e["totalsFrom"]
    params = json.load(open(PARAMS))
    k_db = collections.defaultdict(list)
    for t, q in qs.items():
        for c, v in q.get("dbs", {}).items():
            if v.get("kDb") is not None and v["execMs"] > 50:
                k_db[c].append(v["kDb"])
    overhead = {}
    for t in sorted(set(off) & set(on)):
        for c, d_off in off[t]["D"].items():
            d_on = on[t]["D"].get(c)
            if d_off and d_on and d_off > min_ms and d_on > min_ms and not c.startswith("engine:"):
                overhead.setdefault(t, {})[c] = round(d_on / d_off - 1, 3)
    k_at_load, at_load = {}, None
    if atload_window:
        import atload
        delta = None
        if factorial_path and os.path.exists(factorial_path):
            fj = json.load(open(factorial_path))
            delta = atload.cardinality_delta(common.factorial_fits(fj), r_c, r_all,
                                             path=atload.order_path(off, min_ms))
        at_load = atload.analyse(atload_window, atload.demand_table(off, on, r_c, r_all, min_ms), atload_max_level,
                                 order_delta=delta)
        k_at_load = {c: v["k"] for c, v in sorted(at_load["containers"].items()) if "k" in v}
    return {
        "schema": "docs/history/timing/PREP-T3.md §parts.json",
        "version": 3 if cnts else 2,
        "analysis": (f"{os.path.basename(off_dirs[0]).split('_')[0]} windows: "
                     + ("measured counters" if cnts else "bucket shares, no counters")),
        "counters": ({"source": "GET /timing/counters (counters.py)", "types": sorted(cnts),
                      "accessFrom": "counters (driver + mapping CPU per statement); fits = cross-check",
                      "ownFrom": "operation counters; requestOverheadCpuMs = the rest of the service's CPU"}
                     if cnts else None),
        "generatedBy": "timing/analysis/parts.py",
        "domainCommit": commit,
        "windows": windows,
        "operations": parts,
        "perExecution": {"rule": "operations[op].byRequest[T] and the means per execution of op (DESIGN.md AB68): the "
                                  "per-request parts / executionsPerRequest (a plan operation of T 1; else the counters' "
                                  "calls of op / those of T's root operation); a shape several operations share split by "
                                  "executions x A's statements; requestOverheadCpuMs, envelopeRemainderCpuMs and "
                                  "ownShareOfService stay per request",
                         "minExecutions": MIN_EXECUTIONS,
                         "rareOperations": "operations measured only with fewer executions (as in `operations`, "
                                           "not read by the generator, which keeps A9's seed for them)"} if cnts else None,
        "rareOperations": rare,
        "scheduledJobs": scheduled_summary([os.path.basename(x) for x in off_dirs]),
        "requests": by_request,
        "fits": fits,
        "middleware": {"source": os.path.relpath(PARAMS, common.REPO), **{k: params["system"][k] for k in
                                            ("hopLatencyMs", "hopCallerCpuMs", "hopCalleeCpuMs", "gatewayRequestCpuMs",
                                             "gatewayFetchCpuMs", "publishCpuMs", "deliverCpuMs")}},
        "kDb": {c: {"median": round(st.median(v), 3), "n": len(v), "values": v} for c, v in sorted(k_db.items())},
        "kAtLoad": k_at_load,
        "kAtLoadNoCardinality": {c: v["kNoCardinality"] for c, v in sorted(at_load["containers"].items())
                                 if "kNoCardinality" in v} if at_load else {},
        "kAtLoadDetail": ({"window": at_load["window"], "maxLevel": at_load["maxLevel"], "levels": at_load["levels"],
                           "cardinalityMsPerOrder": {c: round(v, 4) for c, v in at_load["orderDelta"].items()},
                           "factorial": factorial_path and os.path.relpath(factorial_path, common.REPO),
                           "containers": {c: {k: v for k, v in x.items() if k not in ("U", "P")}
                                          for c, x in at_load["containers"].items()}} if at_load else None),
        "overheadOnVsOff": overhead,
        "overheadRatios": {"r_c": {c: round(v, 3) for c, v in sorted(r_c.items())}, "r_role": r_role,
                           "r_all": round(r_all, 3), "byContainer": {c: r_info[c] for c in sorted(r_info)}},
    }


def cardinality_summary(fj, r_c, r_all, min_t=2.0):
    """The order path's per-item, per-unit, coupon and payment-method costs for step 4 (factorial.py,
    primary fits): per container CPU ms per order (production: x r_c), per service statements and DB exec
    ms; a coefficient within min_t standard errors of 0 is reported but flagged `significant: false`."""
    fits = common.factorial_fits(fj)
    terms = ("item", "unit", "coupon", "PRE", "CC", "s600")
    out = {"source": f"timing/analysis/factorial.py ({fj.get('primary') or 'fitsRobust'})", "windows": fj.get("windows"),
           "model": fj.get("model"), "base": "one item of one unit, INVOICE, no coupon, stock 60",
           "units": "ms per order (createOrder + placeOrder + saga); CPU x r_c = production; statements per order",
           "cpuMsPerOrder": {}, "statements": {}, "dbExecMs": {}}
    for k, f in sorted(fits.items()):
        kind, _, c = k.partition(":")
        if kind not in ("cpu", "statements", "dbExec"):
            continue
        sc = r_c.get(c, r_all) if kind == "cpu" and c not in ("apps", "dbs", "sidecars") else 1.0
        e = {"base": round(f["coef"]["b0"] * sc, 4), "residualSd": f["residualSd"]}
        for t in terms:
            e[t] = {"value": round(f["coef"][t] * sc, 4), "se": round(f["se"][t] * sc, 4),
                    "significant": abs(f["coef"][t]) >= min_t * f["se"][t]}
        out[{"cpu": "cpuMsPerOrder", "statements": "statements", "dbExec": "dbExecMs"}[kind]][c] = e
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--off", default="")
    ap.add_argument("--on", required=True)
    ap.add_argument("--out", default=os.path.join(common.TIMING, "parts.json"))
    ap.add_argument("--min-ms", type=float, default=0.2, help="containers below this D (ms/req) are background noise")
    ap.add_argument("--atload", default="", help="session window of block 7 -> kAtLoad (atload.py)")
    ap.add_argument("--atload-max-level", type=float, default=0.75)
    ap.add_argument("--factorial", default=os.path.join(common.RAW, "factorial.json"),
                    help="factorial.json for the at-load cardinality term ('' for none)")
    ap.add_argument("--mechanisms", default="", help="mechanisms.json (mechanisms.py) to embed as `mechanisms`")
    ap.add_argument("--sensitivity", default="", help="sensitivity.json (sensitivity.py) to embed as `rateSensitivity`")
    a = ap.parse_args()
    off = [common.window_dir(x) for x in a.off.split(",") if x]
    on = [common.window_dir(x) for x in a.on.split(",") if x]
    r = build(off, on, a.min_ms, common.window_dir(a.atload) if a.atload else None, a.atload_max_level,
              a.factorial or None)
    if a.factorial and os.path.exists(a.factorial):
        r["orderPathCardinality"] = cardinality_summary(json.load(open(a.factorial)), r["overheadRatios"]["r_c"],
                                                        r["overheadRatios"]["r_all"])
    if a.sensitivity and os.path.exists(a.sensitivity):
        sj = json.load(open(a.sensitivity))
        r["rateSensitivity"] = {"source": sj["source"], "model": sj["model"],
                                "types": {t: {"midRate": v["midRate"], "asymptoteRatio": v.get("asymptoteRatio"),
                                              "v2TwoRatesRatio": (v.get("v2TwoRates") or {}).get("asymptoteRatio")}
                                          for t, v in sj["types"].items()}}
    if a.mechanisms:
        r["mechanisms"] = json.load(open(a.mechanisms))
    # envelope vs work per event handler, publish per sender, delivery hops (README.md §6); from the --on windows
    import envelope as envmod
    r["envelope"] = envmod.from_parts(r, on)
    r["windows"].update({"atload": a.atload or None, "factorial": (r.get("orderPathCardinality") or {}).get("windows"),
                         "mechanisms": (r.get("mechanisms") or {}).get("windows")})
    def names(v):
        if isinstance(v, str):
            return [v]
        if isinstance(v, dict):
            return [v["window"]] if "window" in v else [x for y in v.values() for x in names(y)]
        return [x for y in v or [] for x in names(y)]
    used = sorted(set(names(r["windows"])))
    hits = {w: common.firings_in_measured(common.window_dir(w)) for w in used}
    r["scheduledJobsCheck"] = {"rule": "no firing of a scheduled job in a measured phase (idle, idle_end, pre, trans, "
                                       "warm, steady; sessions: steady); fourth pass: excluded by construction",
                               "firingsInMeasuredPhases": {w: len(v) for w, v in hits.items()},
                               "phases": {w: sorted({n for n, _ in v}) for w, v in hits.items() if v}}
    print("scheduled-job firings in measured phases:", {w: n for w, n in r["scheduledJobsCheck"]
                                                       ["firingsInMeasuredPhases"].items() if n} or "none")
    json.dump(r, open(a.out, "w"), indent=1)
    for o, e in r["operations"].items():
        print(f"{o:44s} own {e['ownCpuMs']:7.3f} ms  " + "  ".join(
            f"{x['mode'][0]}:{x['class']} c{x['calls']:.2f} db{x['dbMs']:.3f} map{x['mapCpuMs']:.3f}" for x in e["accesses"]))
    print("fits", {s: (f["alphaRead"], f["alphaWrite"], f["beta"], f["n"], f["medianAbsResidual"])
                   for s, f in r["fits"].items()})
    print("kDb", {c: v["median"] for c, v in r["kDb"].items()})
    print(a.out)


if __name__ == "__main__":
    main()
