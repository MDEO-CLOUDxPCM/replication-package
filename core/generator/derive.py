#!/usr/bin/env python3
"""The core's derivation engine (DESIGN.md §F, AB52): a case's optimisation models from its domain model: base PCM
with one component per domain class (variant A) and the architecture decisions with the local copies
(metamodel/architecture.mm), in the style of the unified project's tools/gen_misarch.py. Developed on MiSArch
(cases/misarch), whose adapter (case.json `generator.adapter`: cases/misarch/generator/misarch.py) supplies the
fixed topology (gateway, broker, authentication), the federation and login rules and the calibration constants;
the case's inputs are case.json's `inputs` (docs/case-interface.md). The text below describes MiSArch's models.

    [ARCH_CASE=misarch] core/generator/derive.py [--seed ...] [--parts ...] [--out OUT.m] [--no-format] [--no-sync]

    gen_domain.py [--seed neutral|today|monolith|all] [--parts timing/parts.json] [--out OUT.m]
                  [--no-format] [--no-sync]                       -> models/domain-<seed>.m

Inputs (read only): domain/misarch-domain.json (work package A: classes, operations, accesses,
calls, events, sagas, transactions, joins, msa mapping and seed demands), workload/sessions.json
with workload/gen_sessions.py (work package C: the session usage model), the timing campaign's
parts (--parts, default timing/parts.json), the cache hit ratios (models/domain-cache-hits.json,
tools/cache_hits.py), the latency fit (timing/latency_fit.json), and the msa model's System (round
2's calibrated middleware and the costs the campaign did not measure).

The service cut is the allocation: the seeds differ only in where the components sit and in the
mechanisms their call sites point to (DESIGN.md F1, F9):
- neutral:  every class in one container, every schema on the shared database server, every call
            synchronous, every saga choreographed (no knowledge of today's design);
- today:    the 16 services of misarch-kotlin `main` (classes by their owner service, one database
            server per service), today's mechanisms (copies, gateway joins, events);
- monolith: every class in one container, one database server, today's code without the network
            (events stay asynchronous in the process, gateway joins are local resolution).
The fourth seed, perclass, is tools/gen_perclass_seed.py's (from the neutral model).
Timings (DESIGN.md AB32, AB64): the campaign's parts per operation and access, x the at-load scale k_c of
today's container; mechanism parameters of the platform (MiSArch: the campaign's, timing/RESULTS.md §5, through
generator/platform.json); middleware round 2's (AB32.3). Structure (AB33): joinCache as
built (the provider's entity cache), per-site hit ratios and per-key staleness, latency-only waits.
One saga notion (AB35): an operation's transaction-bound writes are the steps of a workflow.
Load profile (DESIGN.md AB3, AB10): C4's compressed day (LoadProfile `day`, per-scenario
LoadSteps). C1 per request type (DESIGN.md L, AB20): an OperationLatencyBudget per gateway request
type against today's simulated statistics under the same profile, and the ObjectiveBounds (AB30)
against today's objectives, as tools/gen_domain_budgets.sh measured them
(models/domain-today-p95-day.json, models/domain-today-objectives-day.json; none while missing).
The layer-3 realisation (CopyStores, Redirects, Notifications) is written into the model by the
unified project's sync (tools/sync_model.py), as for the earlier MiSArch models; the layer-2
realisation is B's transform/realise.mt (harness problem `realise`).
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
P = HERE.parents[1]                       # the repository root
TOOLS = P / "core" / "tools"
sys.path.insert(0, str(TOOLS))
import case as case_  # noqa: E402
import stage_project  # noqa: E402
CASE = os.environ.get("ARCH_CASE", "misarch")
C = case_.load(CASE)                      # the case's inputs (cases/<case>/case.json)
WS = P.parent
DOMAIN = C.path("domain")
SESSIONS = C.path("sessions")
PARTS = C.path("parts")
PLATFORM = C.path("platform")             # the platform's parameters, S[...]
SESSIONS_CORE = HERE / "sessions.py"      # the session-model interpreter the case's sessionModel builds on
CASE_DIR = os.path.relpath(C.dir, P)      # the case's directory, repository-relative (cases/misarch)


def cpath(rel):
    """A file of the case that the models' comments name (a document or a tool of the case): its
    repository-relative path, as the models name every file."""
    return f"{CASE_DIR}/{rel}"


def load_adapter(path):
    spec = importlib.util.spec_from_file_location(f"adapter_{CASE}", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


A = load_adapter(C.path("generator.adapter"))      # the case's adapter (names, rules, fixed parts, calibration)

# ---------------------------------------------------------------------------------------------
# writing a model (the unified project's gen_misarch.py Out, unchanged in behaviour)


class E(str):
    """An enum literal."""


class Out:
    def __init__(self):
        self.objs = []
        self.links = []
        self.names = set()

    def obj(self, name, cls, comments=(), /, **attrs):
        assert name not in self.names, name
        self.names.add(name)
        self.objs.append((name, cls, attrs, list(comments)))
        return name

    def link(self, a, f, b):
        self.links.append((a, f, b))

    def text(self, using, header, tail=""):
        def lit(v):
            if isinstance(v, E):
                return str(v)
            if isinstance(v, bool):
                return "true" if v else "false"
            if isinstance(v, str):
                return json.dumps(v)
            if isinstance(v, float):
                return repr(v)
            return str(v)
        lines = [f"// {h}" if h else "//" for h in header] + ["", f'using "{using}"', ""]
        by_src = {}
        for a, f, b in self.links:
            by_src.setdefault(a, []).append((f, b))
        for name, cls, attrs, comments in self.objs:
            lines += [f"// {c}" for c in comments]
            body = " ".join(f"{k} = {lit(v)}" for k, v in attrs.items())
            lines.append(f"{name} : {cls} {{ {body} }}" if body else f"{name} : {cls} {{ }}")
            lines += [f"{name}.{f} -- {b}" for f, b in by_src.pop(name, [])]
            lines.append("")
        rest = [f"{a}.{f} -- {b}" for a, fs in by_src.items() for f, b in fs]
        return "\n".join(lines + rest) + "\n" + tail


def decimal(x):
    s = f"{x:.10g}"
    if "e" in s:
        s = f"{x:.20f}".rstrip("0")
        digits = len(s.split(".")[1].lstrip("0"))
        s = f"{x:.{len(s.split('.')[1]) - digits + 10}f}".rstrip("0")
    return s


def exp(ms):
    return f"Exp({decimal(1.0 / ms)})"


def num(x):
    return f"{x:.6g}"


def wrap(text, width=96):
    out, cur = [], ""
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > width:
            out.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    return out + ([cur] if cur else [])


def upper(s):
    return s[:1].upper() + s[1:]


def ident(s):
    """A model name from an operation or request id: order.on:order/order/created ->
    order_on_order_order_created."""
    return re.sub(r"_+", "_", re.sub(r"[^A-Za-z0-9]", "_", s)).strip("_")


# ---------------------------------------------------------------------------------------------
# the problem data


def platform():
    """The platform's parameters (the case's platform.json `parameters`): middleware, infrastructure, costs."""
    return json.loads(PLATFORM.read_text())["parameters"]


def statements(a):
    """Expected statements per execution: a number, or 1 for a data-dependent count."""
    s = a.get("statements", 1)
    if isinstance(s, (int, float)):
        return float(s)
    return 1.0


PUBLISH_DEFAULT = "an outcome without a probability: 1 for success topics, 0 for failure topics (F6)"


def publish_prob(p):
    if isinstance(p.get("prob"), (int, float)):
        return float(p["prob"])
    return 0.0 if "failed" in p["topic"] else 1.0


class Domain:
    """A's domain, reduced to what the derivation needs (DESIGN.md F2-F6)."""

    def __init__(self, d, sessions):
        self.d = d
        self.classes = [c["name"] for c in d["classes"]]
        self.service_of = {c["name"]: c["service"] for c in d["classes"]}
        self.ops = {o["id"]: o for o in d["operations"]}
        self.refs = {r["id"]: r for r in d["references"]}
        self.seed = d["msaMapping"]["seedDemands"]["operations"]
        self.sessions = sessions
        # federation glue (DESIGN.md AB43; the case's rule): resolvers that are not domain operations, but what the
        # gateway's fetch costs the subgraph
        self.glue = A.glue(d, self.ops)
        # the glue a request's field is fetched through: (request, field) -> resolver
        self.fetches = {}
        # requests of the usage model: key -> plan [(op, via)]
        plans = {r["type"]: r["plan"] for r in d["requests"]}
        self.requests = OrderedDict()
        for key, r in sessions["requests"].items():
            if A.skip_request(key):
                continue
            rt = r.get("roundTwoRequest")
            if rt in plans and [s["op"] for s in plans[rt]] == r["operations"]:
                steps = [(s["op"], s["via"], s.get("parent")) for s in plans[rt]]
            else:
                # no document (A's plan): every field on the root's objects, a subgraph's fields on what its glue found
                steps, last = [], {}
                for i, x in enumerate(r["operations"]):
                    svc = self.ops[x]["service"] if x in self.ops else None
                    steps.append((x, "root" if i == 0 else "local", None if i == 0 else last.get(svc, 0)))
                    if x in self.glue:
                        last[svc] = i
            # the plan as a tree (DESIGN.md AB44): `parents[i]` is the entry whose objects entry i is resolved on (None:
            # the root). The gateway's fetch into a subgraph through its glue resolver is the fetch of the field it
            # finds the entity for (AB43): the resolver leaves the plan, that field is the gateway join, on the glue's
            # parent
            index, glue_of, out, parents = {}, {}, [], []
            for i, (x, via, par) in enumerate(steps):
                if par in glue_of:
                    g, par = glue_of[par]
                    if not any(f == g for (k_, _), f in self.fetches.items() if k_ == key):
                        self.fetches[(key, x)] = g
                    via = "gateway"
                if x in self.glue:
                    glue_of[i] = (x, par)
                    continue
                index[i] = len(out)
                out.append((x, via))
                parents.append(index[par] if par is not None else None)
            self.requests[key] = dict(msa=r["msa"], plan=out, parents=parents)
        # topic -> domain reactions
        self.reactions = defaultdict(list)
        for ev in d["events"]:
            for s in ev["subscribers"]:
                o = self.ops.get(s["op"])
                if o and not s.get("copy") and o.get("mechanism") != "copy":
                    self.reactions[ev["topic"]].append(s["op"])
        # http callbacks of external providers, by service
        self.callbacks = defaultdict(list)
        for o in d["operations"]:
            if "http" in o["trigger"]:
                self.callbacks[o["service"]].append(o["id"])
        # copies that come with a saga message (A3 `process`): (reader op, class) -> copy id
        self.carried = {}
        for c in d["copies"]:
            if c.get("process"):
                for cls in c["copyOf"]:
                    for r in c.get("readers", []):
                        self.carried[(r, cls)] = c["id"]
        # the copies by id: an access's own data in one (A's `own`, Domain.own_in_copy, DESIGN.md AB67)
        self.copies = {c["id"]: c for c in d["copies"]}
        self.saga_of = {}
        for s in d["sagas"]:
            for x in s["operations"]:
                self.saga_of.setdefault(x["op"], (s["name"], x["role"]))
        self.reach()
        # operations called by another operation or as a request's further field without fields of its own (not only
        # as a root): they get a SEFF of their own; a field with fields of its own is built per request (AB44)
        # (a call whose invocation resolves fields of fields, AB55: the fields without fields of their own; the others
        # are built per call)
        self.called = {t[0] for x in self.reached for t in self.targets(x) if not (t[1] == "call" and t[4])} | \
            {y for x in self.reached for t in self.targets(x) if t[1] == "call" for y, kids in self.nested(t[4])
             if not kids} | \
            {x for k in self.requests for i, (x, _, kids) in self.entries(k) if i > 0 and not kids}
        self.timing = None          # the campaign's Timing (DESIGN.md AB32), set by main

    # --- a request's plan as a tree (DESIGN.md AB44)
    def entries(self, key):
        """[(index, (op, via, [child indexes]))] of the request's plan."""
        r = self.requests[key]
        return [(i, (x, via, [j for j, p in enumerate(r["parents"]) if p == i])) for i, (x, via) in enumerate(r["plan"])]

    def tree(self, key, i=0):
        """The fields resolved on the objects of entry i: [(op, via, subtree)], in the document's order."""
        r = self.requests[key]
        return [(r["plan"][j][0], r["plan"][j][1], self.tree(key, j)) for j, p in enumerate(r["parents"]) if p == i]

    # --- which operations the workload reaches (F2)
    def targets(self, oid):
        """(callee op, kind, probability, sync only[, fields | topic][, call]) of an operation: calls, publishes. A
        call is sync only (no cache) when it is an effect or a strict read (Domain.sync_only, DESIGN.md AB60). A
        call's `fields`: the fields its one invocation's query resolves on the callee's objects (DESIGN.md AB55), a
        tree [(op, fields)] in the document's order (empty for a call of one operation), and `call` the domain's
        call; an event's `topic`."""
        o = self.ops[oid]
        out = []
        for c in o["calls"]:
            tos = [c["to"]] if isinstance(c["to"], str) else c["to"]
            if any(t.startswith("simulation.") for t in tos) and not c.get("effect"):
                sys.exit(f"{oid}: the call of the external provider {tos} is an effect (`effect: true`, DESIGN.md AB60)")
            if len(tos) > 1:
                out.append((tos[0], "call", 1.0, self.sync_only(oid, c), self.call_fields(oid, c), c))
                continue
            for t in tos:
                if t in self.ops:
                    out.append((t, "call", 1.0, self.sync_only(oid, c), [], c))
                else:
                    svc = t.split(".")[1] if t.startswith("simulation.") else None
                    for cb in self.callbacks.get(svc, []):
                        # the callback registering again is a retry of a failed credit-card payment
                        # (about 0.7 % of callbacks, A's note), not a call on every execution: left out
                        if cb != oid:
                            out.append((cb, "callback", 1.0, False))
        for p in o["publishes"]:
            pr = publish_prob(p)
            if pr < 1e-4:          # negligible outcomes (e.g. a 4th credit-card failure, 1e-6) are left out
                continue
            for r in self.reactions.get(p["topic"], []):
                out.append((r, "event", pr, False, p["topic"]))
        return out

    @staticmethod
    def level(oid, x):
        """The consistency level of a read access or a call (DESIGN.md AB60): a strong one's curated level
        (`consistency.level`: strict, stale-ok, immutable), stale-ok for one that is not strong."""
        if not x.get("strong"):
            return "stale-ok"
        lv = (x.get("consistency") or {}).get("level")
        if lv not in LEVEL_RANK:
            sys.exit(f"{oid}: a strong {'call of ' + str(x['to']) if 'to' in x else 'read of ' + x['class']} without "
                     f"a consistency level (`consistency.level`, one of {', '.join(LEVEL_RANK)}; DESIGN.md AB60)")
        return lv

    @staticmethod
    def call_level(oid, c):
        """A call's level (Domain.level). O4's immutable rule (p = 0, metrics.fn immutableRead) reads the Accesses of a
        site, not a call's level: an immutable call would be priced as stale-ok, so it stops here (DESIGN.md AB60)."""
        lv = Domain.level(oid, c)
        if lv == "immutable":
            sys.exit(f"{oid}: the call of {c['to']} is immutable, which O4 does not price for calls (DESIGN.md AB60): "
                     "make it stale-ok, or teach metrics.fn a call's level")
        return lv

    @staticmethod
    def sync_only(oid, c):
        """A call that allows no cache (its site has sync only, so it has none): an effect call (DESIGN.md AB60: it
        changes something and reads nothing, never cached or copied, whatever its callee) or a strict read call."""
        if c.get("effect"):
            if c.get("strong"):
                sys.exit(f"{oid}: the effect call of {c['to']} reads nothing: not `strong` (DESIGN.md AB60)")
            return True
        return Domain.call_level(oid, c) == "strict"

    def call_fields(self, oid, c):
        """The tree of a call whose `to` lists several fields of one invocation's query (DESIGN.md AB55): `to[0]` is
        the field the caller calls, `parents[i]` the entry whose objects `to[i]` is resolved on; [(op, fields)] of
        the fields resolved on to[0]'s objects."""
        tos, par = c["to"], c.get("parents")
        if not par or len(par) != len(tos) or par[0] is not None or \
                any(not isinstance(p, int) or not 0 <= p < i for i, p in enumerate(par) if i > 0):
            sys.exit(f"{oid}: the call of {tos} needs `parents` (one per entry, None first, then an earlier entry's "
                     f"index; DESIGN.md AB55), has {par}")
        for t in tos:
            if t not in self.ops:
                sys.exit(f"{oid}: the call of {tos}: {t} is not an operation")

        def sub(i):
            return [(tos[j], sub(j)) for j in range(1, len(tos)) if par[j] == i]
        return sub(0)

    @staticmethod
    def nested(fields):
        """[(op, fields)] of every field of a call's tree, depth first in the document's order."""
        return [n for y, kids in fields for n in [(y, kids)] + Domain.nested(kids)]

    def reach(self):
        seen = []
        todo = [x for r in self.requests.values() for x, _ in r["plan"]]
        while todo:
            x = todo.pop(0)
            if x in seen or x not in self.ops:
                continue
            seen.append(x)
            todo += [y for t in self.targets(x)
                     for y in [t[0]] + ([z for z, _ in self.nested(t[4])] if t[1] == "call" else [])]
        self.reached = seen

    # --- home class (F2; from the domain model alone, DESIGN.md AB71)
    def home(self, oid, seen=()):
        """The default home of an operation, independent of today's cut: an operation lives with its data. The first
        class it writes (its writes commit on that class's schema); else the class it reads most (statements per
        execution; ties: the strictest level, then the class whose rows hold the reference it navigates, then the
        first); its own data in a copy table aside (AB67: the home's, whichever it is). Without accesses (a resolver
        that only passes an entity on), its neighbour's in an invocation: the field it is resolved on, else its
        first field. Else its trigger's type, else the first class."""
        o = self.ops[oid]
        acc = [a for a in o["accesses"] if statements(a) > 0 and not a.get("own")]
        writes = [a for a in acc if a["mode"] == "write"]
        if writes:
            return writes[0]["class"]
        reads = defaultdict(lambda: [0.0, 0, 0])
        for a in acc:
            r = reads[a["class"]]
            r[0] += statements(a)
            r[1] = max(r[1], LEVEL_RANK[Domain.level(oid, a)])
            r[2] = max(r[2], 1 if a.get("reference") else 0)
        if reads:
            first = list(reads)
            return max(first, key=lambda c: (*reads[c], -first.index(c)))
        for n in self.neighbours(oid):
            if n not in seen:
                return self.home(n, seen + (oid,))
        t = A.trigger_type(o)
        return t if t in self.service_of else self.classes[0]

    def neighbours(self, oid):
        """The operations next to oid in the invocations of the domain (a call's fields, a request's plan): the one
        it is resolved on, then the first one resolved on it."""
        if not hasattr(self, "_neighbours"):
            up, down = {}, {}
            trees = [(c["to"], c.get("parents")) for o in self.ops.values() for c in o["calls"]
                     if not isinstance(c["to"], str) and len(c["to"]) > 1]
            trees += [([x for x, _ in r["plan"]], r["parents"]) for r in self.requests.values()]
            for tos, par in trees:
                for j, p in enumerate(par or []):
                    if isinstance(p, int):
                        up.setdefault(tos[j], tos[p])
                        down.setdefault(tos[p], tos[j])
            self._neighbours = (up, down)
        return [m[oid] for m in self._neighbours if oid in m]

    # --- demands (AB32; A9's seed for an operation the campaign has no parts of, F7)
    def demand(self, oid, request=None):
        """The operation's own CPU from the campaign's parts (Timing.demand). An operation without
        parts keeps A's seed demand (A9), which must be its own (one msa operation)."""
        if self.timing.has(oid):
            return self.timing.demand(oid, request)
        s = self.seed.get(oid)
        if not s or len(s["from"]) > 1:
            sys.exit(f"{oid}: no campaign parts and no seed demand of its own (A9)")
        return s

    # --- the operation's own data in a copy table (DESIGN.md AB67)
    def own_in_copy(self, oid, a):
        """The copy whose table holds the operation's own data that the access touches (A's `own`, DESIGN.md AB67),
        else None. Through federation a service owns fields of an entity whose home is another service, held in its
        copy (or representation) table of that class, and the copy that comes with a saga message is the receiving
        handler's own record of it: return's OrderItem.returnedWith, shipment's sentWithId, payment's open order (A
        marks the accesses: a reference held in the copy, the write of an event-carried copy on the message that
        feeds it, a curated read of the own columns or record). Not the copied class's data: the access is the
        operation's own, its home class's rows on its schema, with no site, no Access of the copied class, no
        feed writer and no write in O4."""
        if not a.get("own"):
            return None
        if self.ops[oid].get("mechanism") == "copy" or a["today"] != "copy" or a["own"] not in self.copies:
            sys.exit(f"{oid}: own data in {a['own']} needs a domain operation's access of its copy (DESIGN.md AB67)")
        return self.copies[a["own"]]

    # --- what an access touches (DESIGN.md AB42)
    def data(self, a, oid=None):
        """("links", reference) for an access of an association in a join table through its first class (the
        links of Product.categories, nothing of Product's rows), else ("rows", class): a class's own data, which
        for a reference held in a column (Order.userId) includes it. The operation `oid`'s own data in a copy
        (DESIGN.md AB67: OrderItem.returnedWith in return's copy) is its home class's rows, not the copied class's."""
        if oid is not None and self.own_in_copy(oid, a):
            return ("rows", self.home(oid))
        r = self.refs.get(a.get("reference"))
        if r and r["storage"].startswith("join table") and r["from"] == a["class"]:
            return ("links", r["id"])
        return ("rows", a["class"])

    @staticmethod
    def data_name(dt):
        return dt[1]

    def what(self, c, g):
        """The data of an access group in words: `Product`, `Product.categories`, `Product and Product.categories`."""
        names = [self.data_name(dt) for dt in g["data"]]
        own = f" (with its own data in {', '.join(g['own'])}, AB67)" if g.get("own") else ""
        return (" and ".join(names) if names else c) + own

    # --- accesses grouped per (class, mode) (F3)
    def access_groups(self, oid, timed=True):
        """[(class, mode, dict(statements, dbMs, strong, level, today, n, parts, data, keyData))] in order of first
        access. Accesses through a call (today `call`) are the callee's work; payload accesses come with
        the event (F3). timed=False: without the timing (dbMs 0), for an operation the workload
        does not reach (it has no parts and no SEFF). `parts`: per reference the access navigates (None:
        none) its statements, strength, level, statement kinds and shape, the domain's accesses (AB42); `data`: what
        the group touches (Domain.data), `keyData`: what it creates or deletes rows of. `level` (reads; DESIGN.md
        AB60): the strictest of its accesses' consistency levels (strict over stale-ok over immutable); `levels` the
        strong accesses' curated (level, rules, reason). An access of the operation's own data in a copy table
        (Domain.own_in_copy, DESIGN.md AB67) is one of its home class's group (its rows, part None; `own` names the
        copies), so it forms no group of the copied class; the campaign's part of the copied class is split over
        the groups its accesses fall into by statements (as an Access's over its references, AB42)."""
        o = self.ops[oid]
        h = self.home(oid)
        measured = timed and self.timing.has(oid)
        # without parts (A9's seed): the operation's dbMs is split evenly over its local and copy accesses
        n_db = sum(1 for a in o["accesses"] if a["today"] in ("local", "copy")) or 1
        seed_db = self.demand(oid)["dbMs"] / n_db if timed and not measured else 0.0
        groups = OrderedDict()
        for a in o["accesses"]:
            st = statements(a)
            if st <= 0 or a["today"] in ("call", "payload"):
                continue
            own = self.own_in_copy(oid, a)
            key = (h, a["mode"]) if own else (a["class"], a["mode"])
            g = groups.setdefault(key, dict(statements=0.0, dbMs=0.0, strong=False, level=None, today=set(), n=0,
                                            ops=set(), parts=OrderedDict(), data=[], keyData=[], own=[],
                                            src=OrderedDict()))
            g["statements"] += st
            g["ops"].add(a.get("op"))
            # the (class, mode) of the campaign's part the access is timed in
            g["src"][(a["class"], a["mode"])] = g["src"].get((a["class"], a["mode"]), 0.0) + st
            if own and own["id"] not in g["own"]:
                g["own"].append(own["id"])
            pt = g["parts"].setdefault(None if own else a.get("reference"),
                                       dict(statements=0.0, strong=False, level=None, ops=set(), levels=[], src={}))
            pt["statements"] += st
            pt["src"][(a["class"], a["mode"])] = pt["src"].get((a["class"], a["mode"]), 0.0) + st
            pt["strong"] |= bool(a.get("strong"))
            if a["mode"] == "read":
                lv = self.level(oid, a)
                pt["level"] = max(pt["level"] or lv, lv, key=LEVEL_RANK.get)
                g["level"] = max(g["level"] or lv, lv, key=LEVEL_RANK.get)
                if a.get("consistency"):
                    pt["levels"].append(a["consistency"])
            pt["ops"].add(a.get("op"))
            dt = self.data(a, oid)
            if dt not in g["data"]:
                g["data"].append(dt)
            if a.get("op") in KEY_WRITES and dt not in g["keyData"]:
                g["keyData"].append(dt)
            if not measured:
                g["dbMs"] += seed_db
            g["strong"] |= bool(a.get("strong"))
            g["today"].add("local" if own else a["today"])
            g["n"] += 1
        if measured:
            # the campaign's parts per (class, mode) (AB32): DB ms, mapping CPU ms, measured statements;
            # a group the campaign did not see costs nothing (its work is in the groups it measured). A part whose
            # accesses fall into several groups (own data in a copy, AB67) is split over them by statements
            total = defaultdict(float)
            for g in groups.values():
                for k, st in g["src"].items():
                    total[k] += st
            part = {k: self.timing.access(oid, *k) for k in total}
            for (c, m), g in groups.items():
                if list(g["src"]) == [(c, m)] and g["src"][(c, m)] == total[(c, m)]:
                    g.update(part[(c, m)])
                    continue
                sh = [(part[k], st / total[k]) for k, st in g["src"].items()]
                g.update(dbMs=sum(p["dbMs"] * f for p, f in sh), mapCpuMs=sum(p["mapCpuMs"] * f for p, f in sh),
                         calls=sum(p["calls"] * f for p, f in sh), rows=sum(p.get("rows", 0.0) * f for p, f in sh),
                         measured=any(p["measured"] for p, _ in sh))
                # each reference's part keeps its own statements' share of each measured part (an Access's timing:
                # the own data's part does not dilute Shipment.sentItems', AB67)
                for pt in g["parts"].values():
                    pt.update(dbMs=sum(part[k]["dbMs"] * st / total[k] for k, st in pt["src"].items()),
                              mapCpuMs=sum(part[k]["mapCpuMs"] * st / total[k] for k, st in pt["src"].items()))
        return [(c, m, g) for (c, m), g in groups.items()]

    def tx_classes(self, oid):
        """Classes written together in one transaction (or one statement) by the operation."""
        out = set()
        for t in self.d["transactions"]:
            if t["op"] == oid and t.get("multiClass"):
                out |= set(t["domainClassesWritten"]) if t.get("domainClassesWritten") else set(t["classes"])
        return out

    def homes(self, oid):
        """The candidate homes of an operation (DESIGN.md AB38, AB41): today's home first, then every other class
        the operation itself writes in its transaction with the home class (not reads, not its reactions'
        classes). Whoever calls it (the gateway, an effect step of an event, another operation): the realisation
        re-targets every call into it to the chosen candidate."""
        h = self.home(oid)
        tx = self.tx_classes(oid)
        if h not in tx:
            return [h]
        ws = [c for c, m, g in self.access_groups(oid, timed=False) if m == "write" and c in tx]
        return [h] + [c for c in ws if c != h]

    def join_classes(self, oid):
        out = set()
        for j in self.d["joins"]:
            if oid in j.get("usedBy", []):
                out |= set(j.get("ownClasses", []))
        return out


def campaign_label(parts):
    """`campaign v<pass>` of a parts.json: the pass its `analysis` names (approx<pass>, the windows' prefix; the fourth
    pass keeps schema version 3, AB65), else its schema version."""
    m = re.search(r"approx(\d+)", str(parts.get("analysis", "")))
    return f"campaign v{m.group(1) if m else parts.get('version', 2)}"


def remote_calls_measured(parts):
    """The campaign's per-call middleware values and the sidecars at load that RemoteCalls' text cites (AB32.3, AB64):
    (caller sidecar per call, (min, max) of the callee's two sidecars per replaced call, delivery per event, the
    services' sidecars ms per session at load, the gateway's), from parts.json mechanisms and kAtLoadDetail."""
    mech = parts["mechanisms"]
    callee = [c["callee"]["dapr"] + c["callee"]["ecs"] for c in mech["parameters"]["remoteCallReplaced"].values()]
    cont = parts["kAtLoadDetail"]["containers"]
    side = [c for c in cont if c.endswith(("-dapr", "-ecs"))]
    gw = sum(cont[c]["D_msPerSession"] for c in side if c.startswith("gateway-"))
    svc = sum(cont[c]["D_msPerSession"] for c in side if not c.startswith("gateway-"))
    return (mech["localCopies"]["createOrder"]["callerSidecarPerCallMs"], (min(callee), max(callee)),
            mech["parameters"]["deliverCpuMs"]["value"], svc, gw)


# executions per order of an operation that carries a service's cardinality term (Timing; DESIGN.md AB70): once
# per order, up to the deliveries across a segment's edges and a payment branch of 2 % (v4: 0.976-1.0 on the four)
CARD_ONCE = (0.9, 1.1)


class Timing:
    """The timing campaign's parts (timing/parts.json, timing/RESULTS.md §2; DESIGN.md AB32, AB64) per
    operation of A's domain:
    - own CPU: operations[op].ownCpuMs (for a request's root resolver its byRequest[request] value);
    - per (class, mode) access: dbMs (DB-container CPU) and mapCpuMs (app-side persistence: the mapping
      CPU, 32 % of the operations' app CPU), the measured statements (calls);
    - the at-load scale k_c (kAtLoad, levels 0.25-0.75, with the session cardinalities) of the container
      that ran the work in today's cut: the operation's service for own and mapping CPU, <service>-db for
      dbMs; only on app and DB parts, never on the middleware (round 2's values, at load already);
    - the order path's cardinality term (kAtLoadDetail.cardinalityMsPerOrder: the sessions' 1.25 items,
      1.25 units, 10 % coupons against the isolation's one item of one unit): per app or DB container
      added to one operation of its service that runs once per order (CARD_ONCE, order_executions; per
      execution), before k_c (RESULTS §4: k_c is measured against the parts with the cardinality term);
    - operations without parts (shoppingcart.User.shoppingcart) keep A9's seed (F7).
    The model's comments name the parts by the campaign's pass (`campaign v<pass>`, campaign_label: the pass
    of the parts' `analysis`, approx<pass>; the schema version where it names none: v4's parts are schema 3)."""

    # the versions read as above; version 3 (the third pass, timing/DECISIONS-V3.md D8) moves the
    # service's per-request rest out of ownCpuMs into requestOverheadCpuMs (on the request's plan
    # operation of each service, operations[op].byRequest[request]): the generator charges it to the
    # request's entry operation (its root resolver, req_<request>) in its container (user decision
    # 2026-10-29, DESIGN.md AB37); the overhead other services carry in a request is listed in the notes
    VERSIONS = (2, 3)

    # the operation that carries a service's per-order cardinality term: the order path's operation of
    # that service that runs once per order (CARD_ONCE) with the largest own CPU (DESIGN.md AB70)
    def __init__(self, path, dom, rates=None):
        parts = json.loads(Path(path).read_text())
        if parts.get("version") not in self.VERSIONS:
            sys.exit(f"{path}: version {parts.get('version')}, this generator reads {self.VERSIONS}")
        self.version = parts["version"]
        self.label = campaign_label(parts)
        self.parts = parts
        self.ops = parts["operations"]
        self.weighted = self.weigh(rates or {}) if rates else []
        self.flags = []
        if self.weighted:
            self.flags.append("operations measured in several request types, their values weighted by the types' executions "
                              "x request rates (DESIGN.md AB69): " + ", ".join(o for o, _ in self.weighted))
        self.k = parts["kAtLoad"]
        self.dom = dom
        # the code the campaign measured against the code the domain was extracted from (DESIGN.md AB57): the parts
        # of operations whose accesses changed in between describe the old code; said in every model, not a stop
        pc, dc = parts.get("domainCommit"), (dom.d.get("meta") or {}).get("commit")
        if pc and dc and pc != dc:
            self.flags.append(f"timing parts measured on the domain's code at {pc[:7]} (parts domainCommit), the domain "
                              f"is extracted at {dc[:7]}: where an operation's accesses changed in between its parts "
                              f"describe the old code (placeholders until a campaign at {dc[:7]}; an access group "
                              f"without parts costs 0 ms, an operation without parts keeps A9's seed)")
        # a measured part whose (class, mode) the domain no longer has would be dropped without a word: say it
        for x in dom.reached:
            groups = {(a["class"], a["mode"]) for a in dom.ops[x]["accesses"]
                      if statements(a) > 0 and a["today"] not in ("call", "payload")}
            for a in (self.ops.get(x) or {}).get("accesses", []):
                if (a["class"], a["mode"]) not in groups and (a.get("dbMs") or a.get("mapCpuMs")):
                    self.flags.append(f"{x}: the measured part {a['mode']} {a['class']} ({a['dbMs']:.3g} ms DB, "
                                      f"{a['mapCpuMs']:.3g} ms mapping) has no access in the domain any more: not "
                                      f"charged")
        card = parts["kAtLoadDetail"]["cardinalityMsPerOrder"]
        self.card_cpu, self.card_db = {}, {}
        for c, ms in sorted(card.items()):
            if c.endswith("-dapr") or c.endswith("-ecs"):
                continue                    # sidecars: middleware, round 2's values
            svc, db = (c[:-3], True) if c.endswith("-db") else (c, False)
            # an operation of the order path that runs once per order (DESIGN.md AB70: executions per request of
            # createOrder or placeOrder within CARD_ONCE; a handler of a 2 % branch no longer qualifies by its
            # per-execution CPU); the term per execution, so that its executions per order give the measured ms
            once = {x: self.order_executions(x) for x in dom.reached if x in self.ops and dom.ops[x]["service"] == svc}
            cands = [x for x, e in once.items() if e is not None and CARD_ONCE[0] <= e <= CARD_ONCE[1]]
            if db:
                cands = [x for x in cands if any(a["dbMs"] > 0 for a in self.ops[x]["accesses"])]
            if not cands:
                self.flags.append(f"cardinality {c} {ms:+.3g} ms per order: no order-path operation of {svc} that runs "
                                  f"once per order")
                continue
            x = max(cands, key=lambda y: (self.ops[y]["ownCpuMs"], y))
            (self.card_db if db else self.card_cpu)[x] = ms / once[x]
        self.applied = []

    def order_executions(self, oid):
        """Executions of the operation per order (one createOrder and one placeOrder): the sum of its measured
        executions per request in the two (byRequest executionsPerRequest, 1 where the parts predate it; fewExecutions
        entries left out), None where neither measured it."""
        brs = [b for t, b in self.ops[oid].get("byRequest", {}).items()
               if t in ("createOrder", "placeOrder") and not b.get("fewExecutions")]
        return sum(float(b.get("executionsPerRequest", 1.0)) for b in brs) if brs else None

    def weigh(self, rates):
        """An operation the campaign measured in several request types has one SEFF for all of them (a field, a
        reaction to every raiser's event, a callee; a root's own CPU is its request's, `demand`): its values are the
        means over those types weighted by their executions (DESIGN.md AB69), not the parts' plain means. The weight
        of type T: the design rate of its session request (`rates`, the case's request_rates; the campaign's types of
        one session request share it equally, e.g. product and product.anon) x T's measured executions per request;
        a type with fewer executions than the campaign's minimum is left out, as in the parts' means. Operations
        measured in one type keep the parts' values. -> [(op, {type: weight})]."""
        sess = {t: r.get("sessionRequest") for t, r in self.parts.get("requests", {}).items()}
        out = []
        for oid, p in self.ops.items():
            brs = {t: b for t, b in p.get("byRequest", {}).items() if not b.get("fewExecutions")}
            if len(brs) < 2:
                continue
            if any(sess.get(t) not in rates for t in brs):
                sys.exit(f"{oid}: a request type of its parts has no session request with a rate "
                         f"({sorted(t for t in brs if sess.get(t) not in rates)}; AB69)")
            n = Counter(sess.get(t) for t in brs)
            w = {t: rates.get(sess.get(t), 0.0) / n[sess.get(t)] * float(b.get("executionsPerRequest", 1.0))
                 for t, b in brs.items()}
            tot = sum(w.values())
            if tot <= 0 or max(w.values()) - min(w.values()) <= 1e-9 * tot:
                continue                             # equal weights: the parts' plain means (product, product.anon)
            own = round(sum(w[t] * b["ownCpuMs"] for t, b in brs.items()) / tot, 6)
            acc = OrderedDict()
            for a in p["accesses"]:                  # the parts' groups and their order
                acc[(a["class"], a["mode"])] = dict(a, calls=0.0, rows=0.0, dbMs=0.0, mapCpuMs=0.0)
            for t, b in brs.items():
                for a in b["accesses"]:
                    g = acc.setdefault((a["class"], a["mode"]), dict(**{"class": a["class"], "mode": a["mode"]},
                                                                     calls=0.0, rows=0.0, dbMs=0.0, mapCpuMs=0.0))
                    for f in ("calls", "rows", "dbMs", "mapCpuMs"):
                        g[f] += w[t] * float(a.get(f) or 0.0) / tot
            for g in acc.values():
                for f in ("calls", "rows", "dbMs", "mapCpuMs"):
                    g[f] = round(g[f], 6)
            self.ops[oid] = dict(p, ownCpuMs=own, accesses=list(acc.values()), weightedBy=w)
            out.append((oid, w))
        return out

    def has(self, oid):
        return oid in self.ops

    def kof(self, container):
        return float(self.k.get(container, 1.0))

    def demand(self, oid, request=None):
        p = self.ops[oid]
        svc = self.dom.ops[oid]["service"]
        own = p["ownCpuMs"]
        overhead = 0.0
        if request is not None and request in p.get("byRequest", {}):
            own = p["byRequest"][request]["ownCpuMs"]
            overhead = float(p["byRequest"][request].get("requestOverheadCpuMs", 0.0) or 0.0)
        own = max(0.0, own + self.card_cpu.get(oid, 0.0))
        return dict(cpuMs=(own + overhead) * self.kof(svc), dbMs=0.0, ownRawMs=own, overheadMs=overhead,
                    k=self.kof(svc))

    def uncharged_overhead(self, roots):
        """v3: per request the requestOverheadCpuMs that services other than the root resolver's carry
        (on a plan operation that is not the request's root): not charged in the model (AB37)."""
        out = {}
        for oid, p in self.ops.items():
            for req, br in p.get("byRequest", {}).items():
                ov = float(br.get("requestOverheadCpuMs", 0.0) or 0.0)
                if ov > 0 and roots.get(req) != oid:
                    out[req] = out.get(req, 0.0) + ov
        return out

    def access(self, oid, c, mode):
        p = self.ops[oid]
        svc = self.dom.ops[oid]["service"]
        acc = [a for a in p["accesses"] if a["class"] == c and a["mode"] == mode]
        if not acc:
            return dict(dbMs=0.0, mapCpuMs=0.0, calls=0.0, measured=False)
        a = acc[0]
        db = a["dbMs"]
        if oid in self.card_db:
            # the per-order DB term on the operation's first access with database work
            first = next(x for x in p["accesses"] if x["dbMs"] > 0)
            if first is a:
                db = max(0.0, db + self.card_db[oid])
        return dict(dbMs=db * self.kof(f"{svc}-db"), mapCpuMs=a["mapCpuMs"] * self.kof(svc), calls=float(a["calls"]),
                    rows=float(a.get("rows", 0.0)), measured=True)


# Mechanism parameters: the platform's S[...] (MiSArch: generator/platform.py takes them from timing/parts.json v3
# `mechanisms.parameters`, timing/RESULTS.md §5; DESIGN.md AB32, AB64). Not scaled by k_c (they are per mechanism,
# not per container). LocalCopy: readDbMs per copy-read statement (the domain's copy reads are one statement each),
# readCpuMs the reader's net CPU per copy read (per createOrder answered from copies over its copy reads,
# approximate), writeCpuMs per delivered copy event (whole handler, a new subscription, approximate), writeDbMs per
# copy write. CachedCall: hitCpuMs the caller's CPU per hit net of the saved call's client work (at least 0);
# hitRatio stays the assumption 0.8 (a workload property, not measured), the default of a site without its own
# (Structure). The provider's entity cache (entityCacheHitCpuMs, entityCacheMissCpuMs) and the orchestrator's step
# (orchestratorStepCpuMs): Structure. RemoteCalls and the gateway: round 2's values (parts.json middleware,
# unchanged in v3; AB32.3, AB64).
# a copy read only for an existence check needs the keys, so its feed is the writes that create or delete rows (AB40)
KEY_WRITES = {"insert", "upsert", "delete"}
# the consistency levels of a read (DESIGN.md AB60), from the most permissive: an access group, a model Access and a
# site take the strictest of their accesses' levels
LEVEL_RANK = {"immutable": 0, "stale-ok": 1, "strict": 2}
MODEL_LEVEL = {"immutable": "IMMUTABLE", "stale-ok": "STALE_OK", "strict": "STRICT"}



class Envelope:
    """The envelope of an effect step (DESIGN.md AB37, docs/history/proposals/effects-cut-independent.md proposal 2):
    the cost a step pays because it runs in a transaction of its own (handler dispatch, decoding,
    idempotency / inbox check, transaction begin and commit CPU: `envelopeAppCpuMs` of timing/ENVELOPE.md's
    handlers), as opposed to its work (B's business logic and statements, cut independent). In-transaction a
    step pays its work only. The commit's latency is Latency.commitDelayMs (AB33.3), the messages' middleware
    (publish, broker, delivery: deliveryCpuMs, v3 2.707 ms, RemoteCalls.deliverCpuMs' measured value) RemoteCalls.
    Source: timing/parts.json `envelope` (version 3, the third pass) when present, else the estimate from the
    v2 data (timing/envelope-estimate-v2.json, flagged as an estimate in the model's comments).
    - A reaction, v2 (`in_own`): ENVELOPE.md's workCpuMs replaces the handler's own + access CPU (both hold the
      dispatch share in v2), so the model splits the handler's measured own + mapping CPU by the estimate's share
      envelope / (work + envelope) and takes the envelope out of its own CPU (at most all of it): the total stays
      the measured one. v3 (DESIGN.md AB64): the counters measure the handler's own and mapping CPU without the
      envelope (DECISIONS-V3 D8; the rest of a handler-only container is `envelopeRemainderCpuMs`), so the work is
      the measured own + mapping CPU and the step form adds the counters' remainder per delivery x k_c (Envelope.handler;
      own + mapping + remainder = the measured total, as v2's split kept it). Only the app part; the subscriber
      sidecars' delivery (deliveryCpuMs, inside envelopeCpuMs) is the middleware's (RemoteCalls, round 2's, AB32.3).
    - A write of another class has no handler today: its synchronous / asynchronous step pays the callee
      envelope of a synchronous invocation of the receiving class's service (`callees[service]`), else the
      mean of that service's handlers, else of all handlers.
    - A synchronous call across containers into a read, an operation or a request field (DESIGN.md AB56): the callee
      service's receiving envelope of a request (Envelope.inbound), paid by the realisation only where the call has its
      hop (ReceivingEnvelope; receiving_split takes it out of the work of today's cross-service invocations).
    One receiving envelope per step for the synchronous and the asynchronous step: what differs between them
    (the hop vs the broker's delivery) is the middleware's. The sender's publish and serialisation
    (senders.publishAppCpuMs) stay in the trigger's measured work (open point for proposal 3: hop costs in
    one place)."""

    ESTIMATE = C.path("envelopeEstimate")

    def __init__(self, parts):
        env = parts.get("envelope") if parts.get("version", 2) >= 3 else None
        if env:
            self.src, self.estimate = f"{C.rel('parts')} envelope ({campaign_label(parts)})", False
        elif self.ESTIMATE.exists():
            env = json.loads(self.ESTIMATE.read_text())
            self.src, self.estimate = f"estimate from the v2 data, {C.rel('envelopeEstimate')}", True
        else:
            sys.exit(f"no envelope: {C.rel('parts')} has none (version {parts.get('version')}) and {self.ESTIMATE} is missing")
        # v2's own CPU of a handler holds its envelope (taken out of it); v3's does not (counters, AB64)
        self.in_own = parts.get("version", 2) < 3
        self.handlers = env["handlers"]
        self.callees = {s: float(c["envelopeAppCpuMs"]) for s, c in (env.get("callees") or {}).items()
                        if isinstance(c.get("envelopeAppCpuMs"), (int, float))}
        self.callee_types = {s: list(c.get("types") or []) for s, c in (env.get("callees") or {}).items()}
        self.rows = env.get("rows") or []
        self.overhead = env.get("requestOverhead") or {}
        by_svc = defaultdict(list)
        for h in self.handlers.values():
            by_svc[h["service"]].append(float(h["envelopeAppCpuMs"]))
        self.by_svc = {s: sum(v) / len(v) for s, v in by_svc.items()}
        allv = [float(h["envelopeAppCpuMs"]) for h in self.handlers.values()]
        self.pooled_all = sum(allv) / len(allv)

    def share(self, oid):
        """The envelope's share of the handler's own CPU (work + envelope of the source), None without one."""
        h = self.handlers.get(oid)
        if not h:
            return None
        w, e = float(h["workCpuMs"]), float(h["envelopeAppCpuMs"])
        return e / (w + e) if w + e > 0 else 0.0

    def pooled(self, service):
        return self.by_svc.get(service, self.pooled_all)

    def handler(self, oid, service):
        """(ms before k_c, how) of a handler's envelope in v3 (DESIGN.md AB64): the counters' remainder per delivery
        (handlers[oid].countersRemainderCpuMs: the subscriber app's CPU outside the operation and statement counters,
        DECISIONS-V3 D8), else the mean of its service's handlers', else of all handlers'. Not envelopeAppCpuMs: that is
        the profile's split (work + envelope = the container's total), while the work here is the counters' own +
        mapping CPU (own + mapping + remainder = the total), so the profile's envelope on top would count the part of
        the dispatch the counters hold twice."""
        rem = lambda h: h.get("countersRemainderCpuMs")
        h = self.handlers.get(oid) or {}
        if isinstance(rem(h), (int, float)):
            return float(rem(h)), f"handlers.{oid}.countersRemainderCpuMs"
        own = [float(rem(x)) for x in self.handlers.values() if x["service"] == service and isinstance(rem(x), (int, float))]
        if own:
            return sum(own) / len(own), f"the mean countersRemainderCpuMs of {service}'s handlers"
        allv = [float(rem(x)) for x in self.handlers.values() if isinstance(rem(x), (int, float))]
        return sum(allv) / len(allv), "the mean countersRemainderCpuMs of all handlers"

    def callee(self, service):
        return self.callees.get(service, self.pooled(service))

    # a service's query-row envelope above OUTLIER x the median of the services' is not taken as its envelope (AB56)
    OUTLIER = 2.0

    def inbound(self, ops):
        """The receiving envelope of a synchronous call into a service across containers (DESIGN.md AB56): what the
        callee's application spends on receiving a GraphQL/HTTP request (dispatch + decode + its transaction's app
        part), per inbound request, before k_c. A synchronous call across containers reads data (reads of another
        class, calls of operations, request fields: writes and events are effect steps, AB37), so the value is a
        query's: `callees[service]` where the estimate measured the service's invocations (createOrder's four, S20-S23),
        else the sampled-ms-weighted mean of D x (dispatch + decode + tx share) over the service's rows of query request
        types (entry operation a query) in which it is a plan container (a gateway fetch: exactly one per request,
        instead of the traces' measured split) and receives no event delivery; else the same mean over every service's
        such rows (`pooled`: return's only row mixes its request with two event deliveries, tax's are commands, cold in
        v2); a service whose rows give more than OUTLIER x the median of the services' takes the pooled value too
        (flagged), and the pool leaves its rows out. Sets self.gql {service: ms}, self.gql_how {service: text}."""
        rows = defaultdict(list)
        for r in self.rows:
            ov = self.overhead.get(r["type"]) or {}
            entry = ops.get(ov.get("entryOperation"))
            plan = set(ov.get("byPlanContainer") or {})
            if not entry or entry.get("kind") != "query" or r["container"] not in plan:
                continue
            if any(v > 0 for v in (r.get("deliveriesPerReq") or {}).values()):
                continue
            s = r["shares"]
            rows[r["container"]].append((float(r["D"]) * (s["dispatch"] + s["decode"] + s.get("tx", 0.0)),
                                         float(r.get("sampledMs") or 1.0), r["type"]))
        mean = lambda xs: sum(e * w for e, w, _ in xs) / sum(w for _, w, _ in xs)
        # an outlier is not an envelope (AB56 review): a service whose query rows give more than OUTLIER x the median
        # of the services' row values (notification 2.88, wishlist 2.22 against 0.55-1.06: list-returning roots, the
        # dispatch share scales with the answer's elements, per-element GraphQL execution) takes the pooled value
        own = {svc: mean(xs) for svc, xs in rows.items() if svc not in self.callees}
        vals = sorted(own.values())
        med = (vals[(len(vals) - 1) // 2] + vals[len(vals) // 2]) / 2 if vals else 0.0
        self.gql_outliers = {svc: v for svc, v in own.items() if v > self.OUTLIER * med}
        kept = [x for svc, xs in rows.items() if svc not in self.gql_outliers and svc not in self.callees for x in xs]
        self.gql_pooled = mean(kept) if kept else self.pooled_all
        self.gql_median = med
        self.gql, self.gql_how = {}, {}
        for svc in sorted(set(rows) | set(self.callees)):
            if svc in self.callees:
                self.gql[svc] = self.callees[svc]
                self.gql_how[svc] = f"callees.{svc} (its invocations in {', '.join(self.callee_types.get(svc, []))})"
            elif svc in self.gql_outliers:
                self.gql[svc] = self.gql_pooled
                self.gql_how[svc] = (f"pooled, FLAGGED: its query rows give {self.gql_outliers[svc]:.4g} ms, more than "
                                     f"{self.OUTLIER:g} x the median {med:.4g} of the services' rows (a list-returning root: "
                                     "per-element execution, not a fixed envelope)")
            else:
                self.gql[svc] = own[svc]
                self.gql_how[svc] = ("query rows " + ", ".join(f"{t} {e:.4g}" for e, _, t in rows[svc]) +
                                     " (weighted by sampled ms)")

    def receiving(self, service):
        """(ms before k_c, how) of a service's receiving envelope (inbound)."""
        if service in self.gql:
            return self.gql[service], self.gql_how[service]
        return self.gql_pooled, "pooled over every service's query rows (none of its own)"

    def label(self):
        return f"{self.src}{', ESTIMATE' if self.estimate else ''}"


def receiving_split(dom, home):
    """The callee's receiving envelope inside today's measured CPU (DESIGN.md AB56; timing v2 only). Every synchronous
    invocation that crosses services today (a call into another service's operation: createOrder's S20-S23; a field the
    gateway fetches from another subgraph) was measured with the callee's envelope in the CPU of the operations it runs
    there: the callee, the fields its invocation resolves (AB55), the request plan's fields under it resolved in that
    subgraph (AB44), its federation glue (AB43) and that service's operations they call. Its work there is the measured
    CPU minus the envelope: the service's receiving envelope x k_c (Envelope.receiving), taken first from the
    invocation's entry (the operation that receives the request: the glue resolver of a fetch, else the fetched field;
    the called operation of a call), up to its own CPU (k_c applied); only what that cannot hold spills over to the
    others in proportion to their own CPU, at most all of it (clamped); operations without campaign parts (A9's seed,
    shoppingcart.User.shoppingcart) take none. The realisation charges the envelope only where such a call has its hop
    (transform/realise/blocks.mt `bv`). An operation that gives up envelope must be measured only in the requests that
    make its invocation (its `measuredIn`; a type whose root is one of theirs counts as theirs, e.g. an anonymous
    variant): else its other SEFFs would lose envelope they never held (derive.py stops). v3 measures the work without
    the envelope (DECISIONS-V3 D8): nothing is taken. Returns ({op: ms taken from its own CPU}, [notes],
    [(invocation, service, envelope ms, {op: ms}, clamped)])."""
    if dom.timing.version != 2:
        return {}, [], []
    env, tm = dom.envelope, dom.timing
    svc = lambda x: dom.ops[x]["service"]

    def closure(ops, s):
        out = list(ops)
        for y in out:
            for t in dom.targets(y):
                if t[1] == "call" and t[0] in home and svc(t[0]) == s and t[0] not in out:
                    out.append(t[0])
                    out += [z for z, _ in dom.nested(t[4]) if z not in out]
        return out

    def reach(k):
        """The operations request k reaches (its plan, transitively through calls, nested fields and events)."""
        seen, todo = set(), [x for x, _ in dom.requests[k]["plan"]]
        while todo:
            x = todo.pop()
            if x in seen or x not in dom.ops:
                continue
            seen.add(x)
            todo += [y for t in dom.targets(x) for y in [t[0]] + ([z for z, _ in dom.nested(t[4])] if t[1] == "call" else [])]
        return seen

    reached = {k: reach(k) for k in dom.requests}
    roots = {k: r["plan"][0][0] for k, r in dom.requests.items()}
    entry_of = {t: (ov or {}).get("entryOperation") for t, ov in env.overhead.items()}

    found = []                         # (invocation, service, entry, ops, requests)
    for x in dom.reached:
        for t in dom.targets(x):
            if t[1] == "call" and t[0] in home and svc(t[0]) != svc(x):
                found.append((f"{x} -> {t[0]}", svc(t[0]), t[0],
                              closure([t[0]] + [z for z, _ in dom.nested(t[4])], svc(t[0])),
                              {k for k, ops in reached.items() if x in ops}))
    for k in dom.requests:
        r = dom.requests[k]

        def local_kids(i, s):
            return [n for j, p in enumerate(r["parents"]) if p == i and r["plan"][j][1] != "gateway"
                    and svc(r["plan"][j][0]) == s for n in [r["plan"][j][0]] + local_kids(j, s)]
        for i, (x, via, _) in dom.entries(k):
            if i > 0 and via == "gateway" and x in home:
                glue = dom.fetches.get((k, x))
                ops = ([glue] if glue else []) + [x] + local_kids(i, svc(x))
                found.append((f"{k}: gateway fetch of {x}", svc(x), glue or x, closure(ops, svc(x)), {k}))
    take, notes, out, why = {}, [], [], {}
    for what, s, entry, ops, reqs in found:
        e = env.receiving(s)[0] * tm.kof(s)
        own = {y: dom.demand(y)["cpuMs"] for y in ops if tm.has(y)}
        part = {}
        first = min(e, own.get(entry, 0.0))
        if first > 0:
            part[entry] = first
        rest = {y: v for y, v in own.items() if y != entry}
        tot = sum(rest.values())
        spill = min(e - first, tot)
        for y, v in rest.items():
            if spill > 0 and v > 0:
                part[y] = spill * v / tot
        clamped = e > first + spill + 1e-12
        if clamped:
            notes.append(f"receiving envelope of {what} ({s}, AB56): {num(e)} ms > the {num(sum(own.values()))} ms own "
                         f"CPU of {', '.join(ops)}: clamped to it")
        if spill > 1e-12:
            notes.append(f"receiving envelope of {what} ({s}, AB56): {num(spill)} ms more than its entry {entry}'s own "
                         f"CPU ({num(own.get(entry, 0.0))} ms), spilled over to {', '.join(y for y in part if y != entry)}")
        allowed = reqs | {t for t, r0 in entry_of.items() if any(roots[k] == r0 for k in reqs)}
        for y, v in part.items():
            if y in take and abs(take[y] - v) > 1e-9:
                sys.exit(f"{y}: two invocations measured remote today would take different envelopes from its CPU "
                         f"({num(take[y])}, {num(v)} ms; AB56)")
            measured = set(tm.ops[y].get("measuredIn") or [])
            if not measured <= allowed:
                sys.exit(f"{y}: gives up {num(v)} ms of {s}'s receiving envelope ({what}) but is measured in "
                         f"{sorted(measured - allowed)} too, where it is not that invocation (AB56): its other SEFFs "
                         "would lose envelope they never held")
            take[y] = v
        out.append((what, s, e, part, clamped))
    return take, notes, out


class Structure:
    """The cache and latency structure (DESIGN.md AB33), on top of the campaign's timing:
    1. joinCache as built: a gateway join with a cache is the provider's entity cache behind its
       sidecar (MiSArch's knee EntityCache), not a cache in the gateway. Per field site that allows
       joinCache a cached operation on the provider (CallSite.cachedService) whose SEFF is the cache:
       hit (the site's hit ratio) the lookup on the provider, no DB; miss entityCacheMissCpuMs (0: left out)
       and the field's own operation. The composer keeps its compose CPU and the middleware.
    2. Per-site hit ratios and per-key staleness (CallSite.hitRatio, staleShare) of every site that
       allows a cache, from tools/cache_hits.py (models/domain-cache-hits.json, the model's profile,
       Zipf popularity).
    3. Latency without CPU (Latency): per database access a DELAY of statements x stmtRoundTripMs +
       commits x commitDelayMs on the database server's DELAY resource (one commit per execution of an
       operation that writes, on its first write access, or per write statement, as the fit's commit
       proxy says), per publish publishWaitMs (realised by transform/realise/middleware.mt); values from
       timing/latency_fit.json or the placeholders below while it is missing.
    The cache's and the orchestrator's costs are the platform's (S): entityCacheHitCpuMs, the provider's CPU per hit
    (MiSArch: parts.json v3 cacheHitCpuMs, RESULTS §5), entityCacheMissCpuMs per miss (0: v3's 0.64 ms is
    `inModel: false`), orchestratorStepCpuMs (AB33.7: derived, not measured, MiSArch has no orchestrator; per step
    the coordinator persists the saga state, one upsert handler without its inbound part, parts.json
    replicaWriteCpuMs.extraUpsertOnly; its messages are the middleware blocks; the upsert's DB time and its commit
    are left out, the orchestrator has no schema in the model)."""

    # the services whose hits the campaign measured (orderTracking: shipment, wishlistView: catalog; parts.json
    # mechanisms.entityCache): their hit holds their receiving envelope (the HTTP request into the provider), so the
    # cache's own part of a hit, the lookup, is the hit minus the mean of their envelopes (before k_c, the
    # measurement's scale), at least 0: an ESTIMATE (DESIGN.md AB56, AB64)
    HIT_PROVIDERS = ("shipment", "catalog")
    PLACEHOLDER = dict(stmtRoundTripMs=0.15, commitDelayMs=1.0, publishWaitMs=1.0, commitUnit="perWritingHandler")
    HITS = C.path("cacheHits")
    LATENCY = C.path("latencyFit")

    def __init__(self, S):
        self.hit_cpu_ms = float(S["entityCacheHitCpuMs"])
        self.miss_cpu_ms = float(S["entityCacheMissCpuMs"])
        self.orch_step_cpu_ms = float(S["orchestratorStepCpuMs"])
        runs = json.loads(self.HITS.read_text())["runs"]
        key = f"{PROFILE}/zipf"
        if key not in runs:
            sys.exit(f"{self.HITS}: no run {key} ({cpath('generator/cache_hits.py')} --all)")
        self.hits = runs[key]["sites"]
        self.hits_source = f"{cpath('generator/cache_hits.py')}, {key}, TTL {json.loads(self.HITS.read_text())['ttlSeconds']:g} s"
        if self.LATENCY.exists():
            f = json.loads(self.LATENCY.read_text())
            f = f.get("latency", f)
            val = lambda k: float(f[k]["value"] if isinstance(f[k], dict) else f[k])
            self.lat = dict(stmtRoundTripMs=max(0.0, val("stmtRoundTripMs")), commitDelayMs=max(0.0, val("commitDelayMs")),
                            publishWaitMs=max(0.0, val("publishWaitMs")),
                            commitUnit=f.get("headline") or "perWritingHandler")
            se = {k: f[k].get("se") for k in ("stmtRoundTripMs", "commitDelayMs", "publishWaitMs") if isinstance(f[k], dict)}
            self.lat_source = (f"{C.rel('latencyFit')}, fit on " + ", ".join(f.get("windows") or []) + " (n " + str(f.get("n")) + ", SE " +
                               ", ".join(f"{k} {v:g}" for k, v in se.items() if v is not None) + ")")
        else:
            self.lat = dict(self.PLACEHOLDER)
            self.lat_source = f"PLACEHOLDERS ({C.rel('latencyFit')} missing)"

    def wait_ms(self, statements, commits):
        return statements * self.lat["stmtRoundTripMs"] + commits * self.lat["commitDelayMs"]


# ---------------------------------------------------------------------------------------------
# the generator


SEEDS = ("neutral", "today", "monolith")
# The network between pods (DESIGN.md AB39): one-way delay of one message between pods on different nodes of one
# zone, the literature default (timing/LITERATURE-NETWORK.md "Recommended model defaults": 0.10 ms, low 0.03, high
# 0.25; x0/x1/x3/x10 in tools/sensitivity.py). The single-host measurements contain loopback only, so this is the
# unmeasured part on top of RemoteCalls.latencyMs and Latency.publishWaitMs (sidecars and commits are measured:
# not added). GEN_NETWORK_MS overrides it (0: the dev VM as measured).
NETWORK_MS = float(os.environ.get("GEN_NETWORK_MS", "0.10"))
# The load profile (AB3, AB10): C4's compressed day, phases and window [warmUp, end] from C's
# sessions.json (profiles.day: 1 320 s with the first 120 s not measured)
PROFILE = "day"
# C1 per request type (DESIGN.md L1, AB6): today's simulated statistics per request type under the
# model's profile (realised models/domain-today.m, metrics.fn's printOperations), measured by
# tools/gen_domain_budgets.sh into P95, today's objectives into BOUNDS; none while a file is missing
P95 = C.path("budgets")
BOUNDS = C.path("bounds")
# The C1 policy (LatencyBudgetPolicy, DESIGN.md AB20): statistic (mean, p50, p90, p95) of a request
# type's simulated response times <= factor x the same statistic of today's cut; only request types
# with at least MIN_BUDGET_COUNT completions in today's window get a budget (a percentile of fewer
# requests is noise: two realisations of the same design differ by up to 8 x below 100 completions,
# within about ±10 % above 250; AB17). Every request type carries today's statistics, so changing
# the policy is one object in the model (or these three constants and a regeneration).
BUDGET_STATISTIC = "p90"
BUDGET_FACTOR = 3.0
MIN_BUDGET_COUNT = 200
# Simulations per evaluation (LoadProfile.replications, AB26; user decisions 2026-10-24: 3, then 6, AB28; 2026-11-03:
# 5, seeds SIM_SEED to SIM_SEED + 4, AB72): the objectives and constraints combine them; the references of C1 and O5
# must be measured over the same seeds (SEEDS="1 2 3 4 5" tools/gen_domain_budgets.sh)
# GEN_REPLICATIONS overrides it (e.g. 1 to generate models from single-seed references before measuring the
# multi-seed ones: GEN_REPLICATIONS=1 gen_domain.py; SEEDS="1 2 3" gen_domain_budgets.sh; gen_domain.py)
REPLICATIONS = int(os.environ.get("GEN_REPLICATIONS", "5"))
CAPACITY_LIMIT = 0.85
# C2 (AB6): the largest utilisation over time bins of this length (s)
CAPACITY_BIN_SECONDS = 10.0
# The HPA of every application container and of the gateway (AB2, AB10): Kubernetes' defaults,
# target 0.7, min 2 (AB30: the usual production minimum for availability; with min 1 an idle pod per
# extra service was cheap spare capacity, so many tiny services bought latency), every group starts
# at its minimum and converges; the pod limit per group and the start-up delay of a pod (a JVM
# service's start and readiness).
HPA_TARGET = 0.7
HPA_MIN = 2
HPA_INITIAL = 2
HPA_MAX = 50
HPA_STARTUP_SECONDS = 30.0
# pods one evaluation may create (all groups); beyond, the run stops and the design is infeasible
MAX_PODS = 400
SIM_SEED = 1
CONTRACT_BREAK = 0.15
# DESIGN U1/U2 (user decision 2026-10-20): full shared fate of a database server's tenants in O2,
# and a change touches every co-tenant service of the unit's database server in O3.
TENANT_SHARE = 1.0
# O1 of a database server (AB30): DB_PRICE per server plus the cores it is sized to (its busiest
# 10-s bin at C2's limit, at least DB_MIN_CORES) at the per-core price of the application pods, so
# that a consolidated server costs its load (before: a flat 1.0 for the 8-core server of any load).
DB_PRICE = 0.2
DB_MIN_CORES = 0.5
# Objectives as constraints against today's cut (ObjectiveBound, AB30): value <= BOUND_FACTOR x today's
# under the same profile and seeds, read from BOUNDS
# (tools/gen_domain_budgets.sh writes it with the latency references); the against-today configs use them.
BOUND_OBJECTIVES = ("changeCoupling", "inconsistency")
BOUND_FACTOR = 1.1
# DESIGN AB24.2 (user: failures of asynchronous workflows count too): weight of a failed
# asynchronous unit of work against a failed session in O2 (0: synchronous paths only, as before),
# a global factor on top of the units' business criticality (AB25).
ASYNC_WEIGHT = 1.0
# DESIGN.md AB25: business criticality of a process's asynchronous work (domain.mm Process.criticality), per
# saga name, and of work of no process: the case's (adapter)
PROCESS_CRITICALITY = A.PROCESS_CRITICALITY
DEFAULT_CRITICALITY = A.DEFAULT_CRITICALITY
SHARED_SERVER_COUPLING = 1.0
# O4's staleness windows (DESIGN.md AB23): a copy's replication lag (write to copy updated) and a
# cache's TTL (the case's)
REPLICATION_LAG_S = 1.0
CACHE_TTL_S = A.CACHE_TTL_S
# O2, O3: the releases a year of the whole system (the case's CHANGES_PER_YEAR; MiSArch: as in the unified project,
# 16 aggregates, a release a week each), shared by the classes (F11). Since AB24 (user decision: by
# operations, not by lines of code) a class's share is proportional to its operations: the domain
# operations of A's domain model (domain/misarch-domain.json `domain: true`: GraphQL queries,
# mutations, field and entity resolvers, reactions to domain events, callbacks) whose home class
# (F2) it is, at least MIN_UNIT_OPERATIONS (a class without operations of its own still has a
# schema and mapping code). Not counted, because they exist only because of today's cut: the 35
# copy-maintenance handlers (`domain: false`, `mechanism: copy`) and, since AB25 (user decision
# 2026-10-23), the 23 operations marked `trivial` (16 federation `_entities` stubs of foreign
# types, 7 resolvers that only read the parent; no access, call or publication of their own,
# and since AB43 the federation glue (Domain.glue: a contributing subgraph's `_entities` resolver that only
# checks that the entity exists; what the gateway's fetch costs, not a domain operation).
CHANGES_PER_YEAR = A.CHANGES_PER_YEAR
MIN_UNIT_OPERATIONS = 1
PERIOD_HOURS = 8760.0


def counted_operations(dom):
    """The domain operations a change unit counts (AB24.1, AB25): A's `domain: true`, not `trivial`, not
    copy maintenance, not federation glue (AB43), in A's order."""
    return [o["id"] for o in dom.d["operations"]
            if o.get("domain") and not o.get("trivial") and o.get("mechanism") != "copy" and o["id"] not in dom.glue]


def class_operations(dom):
    """Per class the domain operations (A's `domain: true` and not `trivial`, reached by the
    workload or not) whose home class (F2) it is."""
    n = {c: 0 for c in dom.classes}
    for x in counted_operations(dom):
        n[dom.home(x)] += 1
    return n


def change_rates(dom):
    """Releases a year per class (AB24.1): CHANGES_PER_YEAR in all, shared in proportion to
    max(operations, MIN_UNIT_OPERATIONS) (whatever the number of classes, AB45)."""
    ops = class_operations(dom)
    w = {c: max(ops[c], MIN_UNIT_OPERATIONS) for c in dom.classes}
    return {c: CHANGES_PER_YEAR * w[c] / sum(w.values()) for c in dom.classes}


def profile_steps(dom, sessions_mod):
    """The LoadProfile's steps of PROFILE: per session class C's factor volume x share(mix) /
    share(base) from each phase on (gen_sessions.loadprofile); a class of no mix (admin) keeps the
    model's rate. Returns (warmUp, end, about, [(scenario, phase, t, f)])."""
    prof = dom.sessions["profiles"][PROFILE]
    warm, end = float(prof["warmUpSeconds"]), float(prof["endSeconds"])
    phases = {float(ph["from"]): ph["name"] for ph in prof["phases"]}
    steps = []
    for e in sessions_mod.loadprofile(dom.sessions, PROFILE)["profiles"]:
        for sc in e["scenarios"]:
            for t, f in e["points"]:
                steps.append((sc, phases[float(t)], float(t), float(f)))
    return warm, end, prof["about"], steps


def generate(dom, seed, S, notes, steps, struct):
    o = Out()
    classes = dom.classes
    services = sorted(set(dom.service_of.values()))
    rep = {s: [c for c in classes if dom.service_of[c] == s][0] for s in services}
    app_c = {c: f"{c}Service" for c in classes}
    db_c = {c: f"{c}Database" for c in classes}
    MONO, SHARED, BROKER = "MonolithService", "SharedDatabase", A.BROKER_CONTAINER
    home = {x: dom.home(x) for x in dom.reached}
    # the receiving envelope (DESIGN.md AB56): what the invocations measured across services today hold of it, taken
    # out of their work (v2), and the operations a synchronous call reaches with it (its ReceivingEnvelope's services)
    take, split_notes, split_rows = receiving_split(dom, home)
    notes += split_notes
    notes += [f"receiving envelope inside today's measured CPU (AB56), {what}: {num(e)} ms taken from "
              + ", ".join(f"{y} {num(v)}" for y, v in part.items() if v > 0) for what, _, e, part, _ in split_rows]
    recv_sigs = OrderedDict()          # signature -> (component, service of the callee)

    def receives(comp, sig, service):
        if recv_sigs.setdefault(sig, (comp, service)) != (comp, service):
            sys.exit(f"{sig}: reached as two services' operation ({recv_sigs[sig]}, {(comp, service)}; AB56)")

    def recv_ms(service):
        return dom.envelope.receiving(service)[0] * dom.timing.kof(service)

    # the provider cache's lookup per hit (AB56): the measured hit without the measured providers' envelope; at least 0
    # (v3, AB64: the measured hit is below the providers' mean receiving envelope, so a hit costs the envelope only)
    hit_env = sum(dom.envelope.receiving(x)[0] for x in struct.HIT_PROVIDERS) / len(struct.HIT_PROVIDERS)
    hit_lookup = max(0.0, struct.hit_cpu_ms - hit_env)
    if struct.hit_cpu_ms <= hit_env:
        notes.append(f"the provider cache's measured hit {num(struct.hit_cpu_ms)} ms is not above the mean receiving "
                     f"envelope {num(hit_env)} ms of {' and '.join(struct.HIT_PROVIDERS)} (before k_c): the lookup is 0 ms, a "
                     "hit costs the provider its receiving envelope only (DESIGN.md AB56, AB64)")

    # --- the cut of the seed (F9) ----------------------------------------------------------------
    if seed == "today":
        place_app = {c: app_c[rep[dom.service_of[c]]] for c in classes}
        place_db = {c: db_c[rep[dom.service_of[c]]] for c in classes}
    elif seed == "monolith":
        place_app = {c: MONO for c in classes}
        place_db = {c: db_c[classes[0]] for c in classes}
    else:
        place_app = {c: MONO for c in classes}
        place_db = {c: SHARED for c in classes}

    # --- decisions ---------------------------------------------------------------------------------
    o.obj("decisions", "ArchitectureDecisions", msPerTimeUnit=1000.0)
    o.link("decisions", "autoscalings", "autoscaler")
    o.obj("autoscaler", "Autoscaling", wrap(
        "The HPA of every application container and of the gateway (DESIGN.md AB2, AB10): SimOxide's "
        f"HorizontalPodAutoscaler with Kubernetes' defaults, CPU target {HPA_TARGET:g}, {HPA_MIN} to {HPA_MAX} "
        f"pods, {HPA_INITIAL} at the start, a new pod ready after {HPA_STARTUP_SECONDS:g} s; cost counts the "
        "pods the simulation measured."),
        targetUtilisation=HPA_TARGET, maxReplicas=HPA_MAX, minReplicas=HPA_MIN, startupSeconds=HPA_STARTUP_SECONDS,
        initialReplicas=HPA_INITIAL)
    warm, end, about, psteps = steps
    o.link("decisions", "loadProfile", "profile")
    o.obj("profile", "LoadProfile", wrap(
        f"C's `{PROFILE}` profile (DESIGN.md C4, AB3): {about} Per session class a step per phase (factor = "
        "volume x the class's share in the phase's mix / its share in the base mix; admin keeps the model's "
        f"rate). Measured from {warm:g} s to {end:g} s; seeds {SIM_SEED}..{SIM_SEED + REPLICATIONS - 1} "
        f"({REPLICATIONS} simulations per evaluation, AB26), usage streams, at most {MAX_PODS} pods created (else "
        "infeasible)."),
        warmUpSeconds=warm, endSeconds=end, name=PROFILE, seed=SIM_SEED, usageStreams=True,
        maxPods=MAX_PODS, replications=REPLICATIONS)
    for sc, ph, t0, f in psteps:
        o.link("profile", "steps", f"step_{ph}_{sc}")
    for sc, ph, t0, f in psteps:
        o.obj(f"step_{ph}_{sc}", "LoadStep", seconds=t0, factor=f)
        o.link(f"step_{ph}_{sc}", "scenario", sc)

    # mechanisms (fixed option objects)
    def mech(name, cls, comments, **attrs):
        o.link("decisions", "mechanisms", name)
        o.obj(name, cls, comments, **attrs)
    mech("sync", "SyncCall", ["A synchronous call: free within a container, middleware across (F3). At an effect site a "
                              "synchronous step in its own transaction (the step form, AB37)."])
    mech("async", "AsyncCall", wrap("Fire and forget through the broker: an event (F5), or a saga step when "
                                    "the cut separates classes written in one transaction (F6)."))
    mech("inTx", "InTransaction", wrap(
        "In the caller's transaction (DESIGN.md AB37): at an effect site whose caller and provider share a container "
        "and whose two schemas share a database server, the provider's work runs as a local call in the caller's "
        "transaction (CallSite.joinedService: no envelope, no commit of its own, no message); otherwise a synchronous "
        "step. Allowed at every internal effect site, not at the provider callbacks."))
    cv = dom.timing.label              # the parts' pass in the comments (campaign v<pass>)
    pm = dom.timing.parts["mechanisms"]["parameters"]
    rc_caller, rc_callee, rc_deliver, rc_svc, rc_gw = remote_calls_measured(dom.timing.parts)
    mech("cache", "CachedCall", wrap(f"A read-through cache in the caller: hitRatio {S['cacheHitRatio']} (assumed), "
                                     f"hitCpuMs {S['cacheHitCpuMs']:g} (the platform's: the caller's CPU per hit net of the "
                                     f"saved call's client work, at least 0; {cv}, {cpath('timing/parts.json')} mechanisms.parameters "
                                     f"callerCacheHitCpuMs {pm['callerCacheHitCpuMs']['value']:g} ms, the hit saves the caller CPU, RESULTS §5; AB64)."),
         hitRatio=S["cacheHitRatio"], hitCpuMs=S["cacheHitCpuMs"])
    mech("join", "ComposedCall", wrap(f"A gateway join (federation): across containers the gateway fetches the "
                                      f"field after the request's root resolver, gatewayFetchCpuMs "
                                      f"{S['gatewayFetchCpuMs']}; within one container the resolver resolves it "
                                      f"itself (F5)."), composeCpuMs=S["gatewayFetchCpuMs"])
    mech("joinCache", "ComposedCall", wrap(
        f"A gateway join with a cache, as built (DESIGN.md AB33.1): the provider's entity cache behind its sidecar. "
        f"The gateway fetches the field (composeCpuMs {S['gatewayFetchCpuMs']}) through the middleware either way; "
        f"a hit costs the provider hitCpuMs {struct.hit_cpu_ms:g} ({cv}, {cpath('timing/RESULTS.md')} §5, no database; measured at "
        f"{' and '.join(struct.HIT_PROVIDERS)}: in the model a hit is the lookup, {num(hit_lookup)} ms (ESTIMATE: the measured "
        "hit minus those providers' mean receiving envelope, at least 0), in the cached operation and the provider's receiving envelope "
        f"after the fetch, AB56, AB64), a miss missCpuMs {struct.miss_cpu_ms:g} more and the field's operation. The hit ratio is the site's "
        f"(CallSite.hitRatio; {S['cacheHitRatio']} where a site has none); the cache sits in each site's "
        "cachedService."),
        composeCpuMs=S["gatewayFetchCpuMs"], hitRatio=S["cacheHitRatio"], hitCpuMs=struct.hit_cpu_ms,
        missCpuMs=struct.miss_cpu_ms)
    mech("copy", "LocalCopy", wrap(
        f"A local copy of the accessed class in the consumer (F4): readDbMs {S['replicaReadDbMs']} (per copy read "
        f"of one statement, measured), readCpuMs {S['replicaReadCpuMs']} (the reader's CPU per copy read, approximate), "
        f"writeCpuMs {S['replicaWriteCpuMs']} (per delivered copy event, approximate), writeDbMs "
        f"{S['replicaWriteDbMs']} (measured); {cv}, {cpath('timing/RESULTS.md')} §5 (AB32, AB64). Across containers "
        "a copy read is stale and couples like a gateway join."),
        readDbMs=S["replicaReadDbMs"], writeCpuMs=S["replicaWriteCpuMs"], writeDbMs=S["replicaWriteDbMs"],
        readCpuMs=S["replicaReadCpuMs"], couplingWeight=0.5, staleReads=1.0)
    o.link("decisions", "coordinations", "choreography")
    o.obj("choreography", "Choreographed", ["A saga as a choreography: every step made by its own component."])
    o.link("decisions", "coordinations", "orchestration")
    o.obj("orchestration", "Orchestrated", [f"A saga orchestrated by its trigger's component: "
                                            f"orchestratorStepCpuMs {struct.orch_step_cpu_ms:g} per step (derived, not "
                                            "measured: MiSArch has no orchestrator; per step the coordinator persists the "
                                            f"saga state, one upsert handler without its inbound part, {cv}, "
                                            f"{cpath('timing/parts.json')} mechanisms.parameters replicaWriteCpuMs.extraUpsertOnly; the messages are the middleware "
                                            "blocks, AB33.7, AB64)."],
          stepCpuMs=struct.orch_step_cpu_ms)
    o.link("decisions", "remoteCalls", "remoteCalls")
    o.obj("remoteCalls", "RemoteCalls", wrap(
        f"Middleware costs of round 2 (msa System, calibrated at load): a hop {S['hopCallerCpuMs']} ms on the "
        f"caller's sidecar, {S['hopLatencyMs']} ms latency, {S['hopCalleeCpuMs']} ms on the callee's; a message "
        f"publishCpuMs {S['publishCpuMs']}, the broker, deliverCpuMs {S['deliverCpuMs']}. Database servers are "
        f"reached directly by their class's component (F8). Kept with the campaign's timing (AB32.3, AB64): the {cv} "
        f"measured {rc_caller:.2f} ms on the caller's sidecar, {rc_callee[0]:.2f}-{rc_callee[1]:.2f} ms on the callee's two (dapr + ecs) per call and {rc_deliver:.2f} ms "
        f"per delivered event, at low rates ({cpath('timing/RESULTS.md')} §5), but at load (§4) the services' sidecars cost "
        f"{rc_svc:.1f} ms per session and the gateway's {rc_gw:.1f}, which these per-call values reproduce (AB32.3: 17.2 and 6.1). "
        f"The middle per hop (DESIGN.md AB39), one place: sidecar CPU callerCpuMs, calleeCpuMs, publishCpuMs, "
        f"deliverCpuMs (measured, above); latencyMs (measured on one host, loopback); networkMs {NETWORK_MS:g} ms, the "
        "one-way network delay of a message between pods on different nodes of one zone (ASSUMED, literature default, "
        f"{cpath('timing/LITERATURE-NETWORK.md')}; not in the single-host measurements): a remote hop is two messages (a call's "
        "request and response; a message's sender -> broker -> subscriber), the publisher's wait the broker's "
        "acknowledgement round trip (+2 networkMs on Latency.publishWaitMs); 0 within a container (no hop); not on "
        "database accesses (every schema is remote from every cut alike; the measured statement round trip stays). "
        "The broker's delivery: the broker's CPU and the transit (measured), the publisher's wait (Latency, measured); "
        "core/tools/sensitivity.py scales networkMs. The sidecars' CPU only: the callee application's receiving envelope "
        "of a synchronous call across containers is its ReceivingEnvelope's, in its own container (DESIGN.md AB56)."),
        callerCpuMs=S["hopCallerCpuMs"], calleeCpuMs=S["hopCalleeCpuMs"], latencyMs=S["hopLatencyMs"],
        publishCpuMs=S["publishCpuMs"], deliverCpuMs=S["deliverCpuMs"], sidecar=True, networkMs=NETWORK_MS)
    o.link("remoteCalls", "broker", f"Assembly_{A.BROKER}")
    for c in classes:
        o.link("remoteCalls", "direct", db_c[c])
    o.link("remoteCalls", "direct", SHARED)

    # --- repository ----------------------------------------------------------------------------
    rp = A.REPOSITORY
    o.obj(rp, "Repository", entityName=A.NAME)
    sigs = defaultdict(list)          # interface -> signatures (filled while building SEFFs)
    calls_to = defaultdict(list)      # signature -> [(call action, name prefix of its SEFF)] (a Home's calls, AB41)
    requires = defaultdict(set)       # component -> interfaces it requires
    seffs = defaultdict(list)         # component -> [(sig, builder)]

    def component(name, comments, provides):
        o.link(rp, "components", name)
        o.obj(name, "BasicComponent", comments, entityName=name)
        o.link(name, "providedRoles", f"{name}_provides_{provides}")
        o.obj(f"{name}_provides_{provides}", "OperationProvidedRole", entityName=f"{name}_provides_{provides}")
        o.link(f"{name}_provides_{provides}", "providedInterface", provides)

    def require(comp, iface):
        if iface not in requires[comp]:
            requires[comp].add(iface)
            o.link(comp, "requiredRoles", f"{comp}_requires_{iface}")
            o.obj(f"{comp}_requires_{iface}", "OperationRequiredRole", entityName=f"{comp}_requires_{iface}")
            o.link(f"{comp}_requires_{iface}", "requiredInterface", iface)
        return f"{comp}_requires_{iface}"

    chains = {}

    def beh_open(beh, prefix):
        chains[beh] = [o.obj(f"{prefix}_start", "StartAction", entityName="start")]
        o.link(beh, "steps", f"{prefix}_start")

    def beh_add(beh, action):
        o.link(beh, "steps", action)
        chains[beh].append(action)

    def beh_close(beh, prefix):
        stop = o.obj(f"{prefix}_stop", "StopAction", entityName="stop")
        beh_add(beh, stop)
        ch = chains.pop(beh)
        for x, y in zip(ch, ch[1:]):
            o.link(x, "successor", y)

    def seff(comp, iface, sig, comments=()):
        if sig not in sigs[iface]:
            sigs[iface].append(sig)
        base = f"{comp}_{sig}"
        o.link(comp, "serviceEffectSpecifications", base)
        o.obj(base, "ResourceDemandingSEFF", comments)
        o.link(base, "describedService", f"{iface}_{sig}")
        beh_open(base, base)
        return base

    def internal(beh, prefix, local, ms, note=None):
        a = o.obj(f"{prefix}_{local}", "InternalAction", entityName=local)
        if ms > 0:
            d = f"{a}_demand"
            o.link(a, "resourceDemand", d)
            o.obj(d, "ParametricResourceDemand", [f"mean {num(ms)} ms"] + (wrap(note) if note else []),
                  specification=exp(ms), requiredResource=E("ProcessingResourceType.CPU"))
        beh_add(beh, a)
        return a

    def call(beh, prefix, local, role, sig, calls):
        """An external call made `calls` times (a loop, or a branch for a fraction)."""
        if abs(calls - 1.0) < 1e-12:
            a = o.obj(f"{prefix}_{local}", "ExternalCallAction", entityName=local)
            o.link(a, "role", role)
            o.link(a, "calledService", sig)
            beh_add(beh, a)
            calls_to[sig].append((a, prefix))
            return a
        if calls < 1.0:
            br = o.obj(f"{prefix}_maybe{upper(local)}", "BranchAction", entityName=f"maybe{upper(local)}")
            beh_add(beh, br)
            inner = None
            for t, prob in (("call", calls), ("skip", 1.0 - calls)):
                tr = o.obj(f"{br}_{t}", "ProbabilisticBranchTransition", entityName=t, branchProbability=round(prob, 9))
                o.link(br, "branches", tr)
                body = o.obj(f"{tr}_body", "ResourceDemandingBehaviour")
                o.link(tr, "branchBehaviour", body)
                beh_open(body, tr)
                if t == "call":
                    inner = call(body, tr, local, role, sig, 1.0)
                beh_close(body, tr)
            return inner
        k, f = int(calls), calls - int(calls)
        count = str(k) if f < 1e-12 else f"IntPMF[({k};{1 - f:.9g})({k + 1};{f:.9g})]"
        lp = o.obj(f"{prefix}_repeat{upper(local)}", "LoopAction", entityName=f"repeat{upper(local)}", iterationCount=count)
        beh_add(beh, lp)
        body = o.obj(f"{lp}_body", "ResourceDemandingBehaviour")
        o.link(lp, "bodyBehaviour", body)
        beh_open(body, lp)
        inner = call(body, lp, local, role, sig, 1.0)
        beh_close(body, lp)
        return inner

    # access operations of the class components and their database work (F3)
    access_sig = {}                   # (op, class, mode) -> (component, sig, db call action)
    db_sig = {}                       # (op, class, mode) -> sig on <class>Db
    # the write actions (DB calls of writes) with the data they write and the data they create or delete rows of: a
    # copy's feed writers are those of the data it holds (AB42), a key copy's those creating or deleting its rows (AB40)
    writes_of = []                    # (action, data, keyData)
    pending_db = []                   # (class, sig, dbMs, comment)

    db_wait = {}                      # (class, sig) -> latency-only wait ms (AB33.3)
    env = dom.envelope
    # effect steps (DESIGN.md AB37): the reactions of events raised by reached operations; their commit (and
    # every write of another class's) sits in the step form, not in the database access
    step_ops = {t[0] for x in dom.reached for t in dom.targets(x) if t[1] == "event" and t[0] in home}
    per_stmt = struct.lat["commitUnit"] == "perWriteStatement"

    def old_commits(oid, c, mode, g):
        """One commit per transaction (AB33.7): the operation's on its home class's write (else on its first
        measured write), its own on a write outside the home's transaction."""
        writes = [(cc, m) for cc, m, gg in dom.access_groups(oid) if m == "write" and gg.get("measured")]
        h = home[oid]
        tx = dom.tx_classes(oid)
        carrier = (h, "write") if (h, "write") in writes else (writes[0] if writes else None)
        if mode != "write":
            return 0.0
        if per_stmt:
            return g["calls"]
        if (c, mode) == carrier or not (c in tx and h in tx):
            return 1.0
        return 0.0

    def step_commits(oid):
        """The commits of a reaction's own transaction (on its home class), moved into its step form."""
        if per_stmt:
            return 0.0
        h = home[oid]
        return sum(old_commits(oid, c, m, g) for c, m, g in dom.access_groups(oid) if c == h and g.get("measured"))

    def db_signature(oid, c, mode, g, apart=False):
        """apart: today's home's write reached through its access part (an alternative home's SEFF, AB38):
        its statements without the transaction's commit (`<op>_write_apart`)."""
        key = (oid, c, mode, apart)
        if key not in db_sig:
            sig = f"{ident(oid)}_{mode}" + ("_apart" if apart else "")
            db_sig[key] = sig
            if g.get("measured"):
                # one commit per transaction (AB33.7); an effect step's commit (a write of another class, a
                # reaction's own) sits in its step form (AB37): the access itself commits nothing
                commits = old_commits(oid, c, mode, g)
                if not per_stmt and (c != home[oid] or oid in step_ops or apart):
                    commits = 0.0
                db_wait[(c, sig)] = (struct.wait_ms(g["calls"], commits), g["calls"], commits)
            if "measured" in g:
                how = (f"{num(g['calls'])} measured, {num(g['dbMs'])} ms DB, {num(g['mapCpuMs'])} ms mapping CPU ({cv}, "
                       "k_c applied)" if g["measured"] else f"{num(g['dbMs'])} ms ({cv}: not seen in its requests)")
                pending_db.append((c, sig, g["dbMs"], f"{oid}: {mode} {dom.what(c, g)}, {num(g['statements'])} "
                                                      f"statement(s) per execution in A's domain, {how}"))
            else:
                pending_db.append((c, sig, g["dbMs"], f"{oid}: {mode} {dom.what(c, g)}, {num(g['statements'])} "
                                                      f"statement(s) per execution, {num(g['dbMs'])} ms (seed)"))
        return db_sig[key]

    def access_signature(oid, c, mode, g):
        """The class component's access operation for (op, class, mode): mapping CPU (the campaign's,
        AB32) and the database work on the class's schema."""
        key = (oid, c, mode)
        if key not in access_sig:
            sig = f"{ident(oid)}_{mode}"
            dsig = db_signature(oid, c, mode, g, apart=(c == home[oid] and mode == "write"))
            access_sig[key] = sig
            base = seff(c, f"I{c}", sig, [f"{oid} {mode}s {dom.what(c, g)} (access part, F3)" + (
                f": mapping CPU {num(g['mapCpuMs'])} ms ({cv}, AB32)" if g.get("mapCpuMs") else "")])
            if g.get("mapCpuMs"):
                internal(base, base, "map", g["mapCpuMs"])
            act = call(base, base, "db", require(c, f"I{c}Db"), f"I{c}Db_{dsig}", 1.0)
            if mode == "write":
                writes_of.append((act, g["data"], g["keyData"]))
            beh_close(base, base)
        return access_sig[key]

    step_forms = {}                   # (component, work sig) -> step sig
    commit_sigs = {}                  # (component, work sig) -> commit sig

    def commit_sig(comp_b, work_sig, commits, what):
        """The commit of a transaction on comp_b's schema (a latency-only wait, AB33.3): `<work sig>_commit`."""
        key = (comp_b, work_sig)
        if key not in commit_sigs:
            csig = f"{work_sig}_commit"
            commit_sigs[key] = csig
            db_wait[(comp_b, csig)] = (commits * struct.lat["commitDelayMs"], 0.0, commits)
            pending_db.append((comp_b, csig, 0.0, f"the commit of {what}'s own transaction (AB37, AB38)"))
        return commit_sigs[key]

    def step_form(comp_b, work_sig, envelope_ms, commits, what, inside=None):
        """The step form of an effect step (DESIGN.md AB37): B's receiving envelope (a step in its own
        transaction), a local call into B's work (the joined form), the commit of B's transaction on B's
        schema (a latency-only wait). `inside`: the write is not measured on its own, its database work is
        part of that class's measured statement today (ESTIMATE, timing/CAMPAIGN.md §4.3). Returns the
        signature (on I<comp_b>)."""
        key = (comp_b, work_sig)
        if key not in step_forms:
            sig = f"{work_sig}_step"
            step_forms[key] = sig
            base = seff(comp_b, f"I{comp_b}", sig, wrap(
                f"The step form of {what} (DESIGN.md AB37): a step in its own transaction, as a synchronous step or "
                f"an asynchronous message: the receiving envelope {num(envelope_ms)} ms CPU ({env.label()}), the "
                f"step's work (I{comp_b}.{work_sig}, which an in-transaction step calls directly), "
                + (f"the commit ({num(commits)} x {struct.lat['commitDelayMs']:g} ms, AB33.3)." if commits else "no commit (it commits per write statement).")
                + (f" ESTIMATE: the write is not measured on its own; today it runs inside {inside}'s statement (a trigger "
                   f"or one statement for both), whose measured database work includes it, so its work here is 0 ms and "
                   f"separated it keeps only the commit ({cpath('timing/CAMPAIGN.md')} §4.3)." if inside else "")))
            if envelope_ms > 0:
                internal(base, base, "envelope", envelope_ms)
            call(base, base, "work", require(comp_b, f"I{comp_b}"), f"I{comp_b}_{work_sig}", 1.0)
            if commits > 0:
                csig = commit_sig(comp_b, work_sig, commits, what)
                call(base, base, "commit", require(comp_b, f"I{comp_b}Db"), f"I{comp_b}Db_{csig}", 1.0)
            beh_close(base, base)
        return step_forms[key]

    def envelope_of(cls):
        """A write step's receiving envelope in B's container: a synchronous invocation's callee envelope of B's
        service today (else its handlers' mean) x its k_c."""
        svc = dom.service_of[cls]
        return env.callee(svc) * dom.timing.kof(svc)

    def reaction_envelope(oid):
        """A reaction's envelope. v2 (Envelope.in_own): its own CPU (x k_c) x the estimate's envelope share of that
        handler (else the pooled envelope of its service, at most its own CPU), taken out of its own CPU. v3
        (AB64): the counters' remainder per delivery (Envelope.handler) x k_c, on top of the measured work."""
        svc = dom.ops[oid]["service"]
        if not env.in_own:
            return env.handler(oid, svc)[0] * dom.timing.kof(svc)
        own = dom.demand(oid)["cpuMs"]
        mapping = sum(g.get("mapCpuMs", 0.0) for _, _, g in dom.access_groups(oid))
        sh = env.share(oid)
        if sh is None:
            svc = dom.ops[oid]["service"]
            return min(own, env.pooled(svc) * dom.timing.kof(svc))
        return min(own, (own + mapping) * sh)

    # call sites (filled while building)
    sites = []

    def site(name, action, allowed, current, comment, writes=False, composer=None, feed=None, cached=None,
             effect=None, fetch=None):
        sites.append(dict(name=name, action=action, allowed=allowed, current=current, comment=comment,
                          writes=writes, composer=composer, feed=feed, cached=cached,
                          effect=effect, fetch=fetch))

    alt_bases = {}                     # SEFF of an alternative home -> today's home's SEFF of the request (AB38)

    def field_service(hc, x, request, kids, composer_call):
        """The operation a request's field call goes to: the field's own; for a field with fields of its own
        (DESIGN.md AB44) its SEFF for this request, which resolves them on its objects (their call sites in it, a
        gateway join composed after the gateway's call of the request's root, as every field's)."""
        if not kids:
            return f"I{hc}_{ident(x)}"
        sig = f"{ident(x)}_req_{ident(request)}"
        if sig not in field_sigs:
            field_sigs[sig] = f"I{hc}_{sig}"
            base = seff(hc, f"I{hc}", sig, [f"{x} as a field of the request {request} (DESIGN.md AB44): its own work, then "
                                            f"the fields resolved on its objects: {', '.join(k[0] for k in kids)}"])
            body(hc, base, x, composer_call=composer_call, plan=kids, request=request, field=True)
            beh_close(base, base)
        return field_sigs[sig]

    field_sigs = {}

    def call_service(hc, x, caller, kids, strong):
        """The operation a call goes to whose one invocation's query resolves fields of fields of x (DESIGN.md AB55,
        as a request's field with fields of its own, AB44): x's SEFF for the caller's call
        (`<x>_call_<caller>`, on its class), its own work and accesses, then the call of each field resolved on its
        objects, in that field's own SEFF (for a field with fields of its own, its SEFF for this call): a local call
        within a container, a hop only when the cut places the field's class elsewhere."""
        sig = f"{ident(x)}_call_{ident(caller)}"
        # the SEFF is named by (x, caller) only: a second invocation of x by the caller with other fields or another
        # strength would silently reuse the first one's
        key = (repr(kids), bool(strong))
        if call_keys.setdefault(sig, key) != key:
            sys.exit(f"{caller} invokes {x} twice with different nested fields or strength; AB55's per-call SEFF "
                     f"{sig} would serve both (name the SEFF by the invocation)")
        if sig not in call_sigs:
            call_sigs[sig] = f"I{hc}_{sig}"
            base = seff(hc, f"I{hc}", sig, wrap(
                f"{x} as called by {caller} (DESIGN.md AB55): one invocation whose query resolves, on the objects of "
                f"{x}, {', '.join(k[0] for k in kids)}; its own work, then those fields' calls (local within a container)."))
            body(hc, base, x, nested=kids, caller=caller, strong=strong)
            beh_close(base, base)
        return call_sigs[sig]

    call_sigs = {}
    call_keys = {}

    def fetch_service(hc, x, request, target):
        """The federation fetch of a field (DESIGN.md AB43): an operation of the field's home class whose SEFF is
        what the gateway's fetch costs the subgraph, its glue resolver's measured work (own and mapping CPU, its
        statements on the class's schema), then the field's own operation. The composed call goes to it across
        containers (CallSite.fetchService); None for a field fetched without glue."""
        g = dom.fetches.get((request, x))
        if not g:
            return None
        sig = f"{ident(x)}_fetch_{ident(request)}"
        if sig in fetch_sigs:
            return fetch_sigs[sig]
        dem = dom.demand(g)
        gs = dom.access_groups(g)
        mp = sum(gg.get("mapCpuMs", 0.0) for _, _, gg in gs)
        db = sum(gg["dbMs"] for _, _, gg in gs)
        calls_ = sum(gg.get("calls", gg["statements"]) for _, _, gg in gs)
        base = seff(hc, f"I{hc}", sig, wrap(
            f"The federation fetch of {x} for the request {request} (DESIGN.md AB43): across containers the gateway "
            f"hands {dom.ops[g]['service']} the entity it contributes {x} to; {g} finds it ({num(dem['cpuMs'])} ms own "
            f"CPU, {num(mp)} ms mapping, {num(db)} ms of database work, {cv}), then {x} itself. Within one container "
            f"the caller resolves {x} itself, with nothing to find."))
        internal(base, base, "resolve", dem["cpuMs"] - take.get(g, 0.0) + mp,
                 f"without {num(take[g])} ms of {dom.ops[g]['service']}'s receiving envelope (DESIGN.md AB56)"
                 if take.get(g) else None)
        if gs:
            dsig = f"{ident(g)}_read"
            pending_db.append((hc, dsig, db, f"{g}: finding the representation (AB43), {num(calls_)} statement(s)"))
            db_wait[(hc, dsig)] = (struct.wait_ms(calls_, 0.0), calls_, 0.0)
            call(base, base, "find", require(hc, f"I{hc}Db"), f"I{hc}Db_{dsig}", 1.0)
        call(base, base, "own", require(hc, f"I{hc}"), target, 1.0)
        beh_close(base, base)
        fetch_sigs[sig] = f"I{hc}_{sig}"
        return fetch_sigs[sig]

    fetch_sigs = {}

    def cached_service(sname, hc, x, request, miss):
        """The provider-side cache of a field site, as built (AB33.1): an operation of the field's home
        class whose SEFF is the cache (hit: the hit CPU; miss: the miss CPU, then the field's own
        operation, or its federation fetch, AB43)."""
        h = struct.hits.get(sname, {}).get("hitRatio", 0.0)
        # a hit is the lookup (the cache's own CPU, the same at every provider) and the provider's receiving envelope,
        # which the envelope block after the gateway's fetch pays (AB56)
        e_hit = recv_ms(dom.ops[x]["service"])
        sig = f"{ident(x)}_cached_{ident(request)}"
        base = seff(hc, f"I{hc}", sig, wrap(
            f"The entity cache of {x} for the request {request}, as built (DESIGN.md AB33.1): hit ratio {num(h)} "
            f"({struct.hits_source}); a hit on {hc}'s CPU, no database: the lookup {num(hit_lookup)} ms here (ESTIMATE: "
            f"{num(struct.hit_cpu_ms)} ms measured per hit, {cv}, {cpath('timing/RESULTS.md')} §5, minus the mean receiving envelope of "
            f"{' and '.join(struct.HIT_PROVIDERS)}, whose hits it measured, at least 0) and {num(e_hit)} ms of {dom.ops[x]['service']}'s "
            f"receiving envelope, which the envelope block after the gateway's fetch pays (AB56); a miss "
            f"{num(struct.miss_cpu_ms)} ms more, then {x} itself."))
        br = o.obj(f"{base}_cache", "BranchAction", entityName="cache")
        beh_add(base, br)
        for tname, prob in (("hit", h), ("miss", 1.0 - h)):
            tr = o.obj(f"{br}_{tname}", "ProbabilisticBranchTransition", entityName=tname, branchProbability=round(prob, 9))
            o.link(br, "branches", tr)
            body_ = o.obj(f"{tr}_body", "ResourceDemandingBehaviour")
            o.link(tr, "branchBehaviour", body_)
            beh_open(body_, tr)
            if tname == "hit":
                internal(body_, tr, "cacheHit", hit_lookup)
            else:
                if struct.miss_cpu_ms > 0:
                    internal(body_, tr, "cacheMiss", struct.miss_cpu_ms)
                call(body_, tr, "own", require(hc, f"I{hc}"), miss, 1.0)
            beh_close(body_, tr)
        beh_close(base, base)
        return f"I{hc}_{sig}"

    built = {}                         # op -> its SEFF base (for workflows)
    tx_steps = defaultdict(list)       # SEFF base -> (operation, bound write calls) (AB35)
    event_calls = defaultdict(list)    # reaction op -> [call action] (workflow steps)

    def body(comp, base, oid, composer_call=None, plan=(), request=None, at=None, field=False, nested=(), caller=None,
             strong=True):
        """An operation's parts in its SEFF (F3): own work, accesses, calls, gateway-planned fields,
        events. `plan`: the request's further resolvers resolved on this operation's objects (gateway joins or
        local resolution), a tree (AB44). `at`: the operation's SEFF on another candidate home (DESIGN.md AB38):
        that class's accesses go to its schema (its own transaction's commit after its write), today's home's
        through its access part. `field`: a request's field with fields of its own (AB44): its own demand, as
        the field's SEFF (another service's per-request overhead is not charged, AB37). `nested`: the fields a
        call of `caller` resolves on this operation's objects (AB55), each called from here (a site sync / cache
        only for a call that is not sync only: `strong` here is Domain.sync_only, a strict or an effect call, AB60)."""
        dem = dom.demand(oid, None if field else request)
        h = at or home[oid]
        alt = h != home[oid]
        # the mapping CPU of the home class's own accesses (AB32) is the operation's work too (they call
        # its schema directly); another class's runs in that class's access operation
        own_map = sum(g.get("mapCpuMs", 0.0) for c, _, g in dom.access_groups(oid) if c == h)
        own_cpu = dem["cpuMs"]
        if oid in step_ops and env.in_own:
            # v2: a reaction's measured own CPU is its work plus its receiving envelope (AB37): the envelope moves
            # into its step form (v3 measures the work without it, AB64)
            own_cpu -= reaction_envelope(oid)
        note = None
        if take.get(oid):
            # measured across services today (AB56): its share of the callee's receiving envelope is not work; the
            # envelope block pays it where the call has its hop
            if request is not None and not field:
                sys.exit(f"{oid}: the root of {request} would give up a receiving envelope (AB56)")
            own_cpu -= take[oid]
            note = (f"without {num(take[oid])} ms of {dom.ops[oid]['service']}'s receiving envelope (measured across "
                    "services today; paid by the envelope block where the call has its hop, DESIGN.md AB56)")
        internal(base, base, "work", own_cpu + own_map, note)
        tx = dom.tx_classes(oid)
        joined = dom.join_classes(oid)
        for c, mode, g in dom.access_groups(oid):
            local = f"{mode}{c}"
            if c == h:
                dsig = db_signature(oid, c, mode, g)
                act = call(base, base, local, require(comp, f"I{c}Db"), f"I{c}Db_{dsig}", 1.0)
                if mode == "write":
                    writes_of.append((act, g["data"], g["keyData"]))
                    tx_commit = db_wait.get((home[oid], db_sig.get((oid, home[oid], "write", False))), (0, 0, 0.0))[2]
                    if alt and not per_stmt and tx_commit > 0:
                        # the transaction's commit (AB33.7) is on today's home's write; at an alternative home it
                        # follows the home's own write, on its schema (AB38)
                        csig = commit_sig(c, ident(oid), tx_commit, f"{oid} at home {c}")
                        call(base, base, f"commit{c}", require(comp, f"I{c}Db"), f"I{c}Db_{csig}", 1.0)
                continue
            sig = access_signature(oid, c, mode, g)
            if mode == "write":
                # an effect step (AB37): the call goes to the write's step form; in-transaction to its work. A step
                # is its own transaction and commits, measured or not: a write the campaign did not see on its own
                # (it runs inside the home's statement today, a trigger or one statement for both classes) has no
                # statement time but still its commit (else splitting it off would cost less from one home than
                # from the other, AB38); per write statement a measured write commits in its access
                commits = 0.0 if per_stmt and g.get("measured") else 1.0
                ssig = step_form(c, sig, envelope_of(c), commits, f"{oid}'s write of {c}",
                                 inside=None if g.get("measured") else h)
                act = call(base, base, local, require(comp, f"I{c}"), f"I{c}_{ssig}", 1.0)
            else:
                act = call(base, base, local, require(comp, f"I{c}"), f"I{c}_{sig}", 1.0)
                receives(c, f"I{c}_{sig}", dom.service_of[c])
            today = "copy" if "copy" in g["today"] else "sync"
            sname = f"site_{base}_{local}"
            desc = (f"{oid} {mode}s {dom.what(c, g)} ({num(g['statements'])} statements, "
                    + (f"{g['level']}" if mode == "read" else f"{'strong' if g['strong'] else 'not strong'}")
                    + f"; today {'/'.join(sorted(g['today']))}).")
            if mode == "read":
                if c in joined and h in joined:
                    desc += (" Bound to the home class by a cross-class statement: two queries and an "
                             "application-side join when the cut separates them (F6).")
                # F4 by consistency level (DESIGN.md AB60): strict sync only; stale-ok and immutable as any read.
                # AB60.4's exception (a strict read today's code serves from a copy: sync or the copy) had five
                # instances, all the reader's own data (return's returnedWithId, payment's four open-order reads),
                # local since AB67: a strict copy read that is not would leave today's cut unrepresentable
                if g["level"] == "strict" and today == "copy":
                    sys.exit(f"{oid}: a strict read of {c} that today's code serves from a copy: sync only (F4, AB60) "
                             "cannot represent today's cut. Is it the operation's own data (A's `own`, DESIGN.md AB67)?")
                if g["level"] == "strict":
                    allowed = ["sync"]
                else:
                    allowed = ["sync", "cache", "copy"]
                    if g["level"] == "immutable":
                        desc += " Immutable data (AB60): O4 counts no staleness for it."
                cur = {"today": today, "monolith": "sync", "neutral": "sync"}[seed]
                if alt:
                    # an alternative home's SEFF (AB38): no copy (layer 3 feeds a copy by its site's mechanism, not
                    # by whether the reader runs: a copy of an option not chosen would still be maintained)
                    allowed = [m for m in allowed if m != "copy"]
                    cur = cur if cur in allowed else "sync"
                    desc += " At an alternative home (AB38): sync or a cache, no copy."
                if allowed == ["sync"]:
                    continue
                carried = dom.carried.get((oid, c))
                if carried and "copy" in allowed:
                    desc += (f" Today's copy ({carried}) comes with the saga message that triggers {oid}: a copy "
                             "that no write feeds (event-carried state, as the unified project's D46).")
                keys = g["ops"] <= {"exists"}
                site(sname, act, allowed, cur, desc,
                     feed=(dom.what(c, g), comp, bool(carried), keys, g["data"]) if "copy" in allowed else None)
            else:
                bound = c in tx and h in tx
                desc += (" An effect step (AB37). Today written in one transaction with the home class: "
                         "in-transaction (co-located, one database server), else a synchronous step or an "
                         "asynchronous message in its own transaction (step form: envelope, work, commit)." if bound else
                         " An effect step (AB37). Today a write outside a transaction with the home class: a "
                         "synchronous step in its own transaction (step form); in-transaction when co-located on "
                         "one database server.")
                cur = "inTx" if bound else "sync"
                site(sname, act, ["sync", "async", "inTx"], cur, desc, writes=True,
                     effect=(f"I{c}_{sig}", f"I{c}_{ssig}", comp, c))
                if bound:
                    tx_steps[base].append((oid, act))
        for t in dom.targets(oid):
            callee, kind, prob = t[0], t[1], t[2]
            if callee not in home:
                continue
            hc = home[callee]
            local = f"{kind}{upper(ident(callee))}"
            k = 2
            while f"{base}_{local}" in o.names or f"{base}_maybe{upper(local)}" in o.names:
                local = f"{kind}{upper(ident(callee))}{k}"
                k += 1
            target = f"I{hc}_{ident(callee)}"
            if kind == "call" and t[4]:
                # one invocation into fields of fields (AB55): the callee's SEFF for this call resolves them
                target = call_service(hc, callee, oid, t[4], t[3])
            if kind == "event":
                ssig = step_form(hc, ident(callee), reaction_envelope(callee),
                                 step_commits(callee), f"the reaction {callee}")
                target = f"I{hc}_{ssig}"
            act = call(base, base, local, require(comp, f"I{hc}"), target, prob)
            if kind == "call":
                receives(hc, target, dom.ops[callee]["service"])
            sname = f"site_{base}_{local}"
            if kind == "event":
                # an event's reaction (F5): async today and in the monolith (in-process events), sync in the
                # neutral seed; in-transaction an option (AB37) when the reaction's class is another
                cur = "sync" if seed == "neutral" else "async"
                allowed = ["async", "sync"] + (["inTx"] if hc != comp else [])
                site(sname, act, allowed, cur,
                     f"{oid} raises {t[4]} (p {num(prob)}), reaction {callee} (F5). An effect step (AB37): an "
                     "asynchronous message or a synchronous step in its own transaction (step form: envelope, work, "
                     "commit), or in-transaction when co-located on one database server (the work only; a failing "
                     "outcome rolls the whole transaction back).", writes=True,
                     effect=(f"I{hc}_{ident(callee)}", f"I{hc}_{ssig}", comp, hc) if hc != comp else None)
                event_calls[callee].append(act)
            elif kind == "callback":
                site(sname, act, ["async"], "async",
                     f"{oid} registers with the external provider, which calls back {callee} later (F5).", writes=True)
                event_calls[callee].append(act)
            else:
                # a strict or effect call is sync only, without a site; any other call sync or a cache (AB60)
                if not t[3]:
                    site(sname, act, ["sync", "cache"], "sync",
                         f"{oid} calls {callee} ({Domain.level(oid, t[5])}; F4, AB60).")
        for y, kids in nested:
            # a field of a call's invocation on this operation's objects (AB55): the call's mechanism (strong: sync
            # only, no site; else sync or a cache)
            if y not in home:
                continue
            hy = home[y]
            local = f"call{upper(ident(y))}"
            k = 2
            while f"{base}_{local}" in o.names:
                local = f"call{upper(ident(y))}{k}"
                k += 1
            target = call_service(hy, y, caller, kids, strong) if kids else f"I{hy}_{ident(y)}"
            act = call(base, base, local, require(comp, f"I{hy}"), target, 1.0)
            receives(hy, target, dom.ops[y]["service"])
            if not strong:
                site(f"site_{base}_{local}", act, ["sync", "cache"], "sync",
                     f"{caller}'s call resolves {y} on the objects of {oid} (not sync only: neither strict nor an "
                     "effect; AB55, AB60).")
        for x, via, kids in plan:
            if x not in home:
                continue
            hc = home[x]
            local = f"field{upper(ident(x))}"
            target = field_service(hc, x, request, kids, composer_call)
            act = call(base, base, local, require(comp, f"I{hc}"), target, 1.0)
            receives(hc, target, dom.ops[x]["service"])
            cur = {"today": "join" if via == "gateway" else "sync", "monolith": "sync", "neutral": "sync"}[seed]
            sname = f"site_{base}_{local}"
            if alt:
                # an alternative home's SEFF (AB38): no gateway join (the composer is the gateway's call of
                # every option; a join of an option not chosen would run), so sync or cache
                site(sname, act, ["sync", "cache"], "sync",
                     f"The request's field {x} in the SEFF of {oid} at the alternative home {h} (AB38): sync or a "
                     "cache (no gateway join).")
                continue
            fetch = fetch_service(hc, x, request, target)
            cached = cached_service(sname, hc, x, request, fetch or target)
            for sg in (fetch, cached):
                if sg:
                    receives(hc, sg, dom.ops[x]["service"])
            site(sname, act, ["sync", "join", "cache", "joinCache"], cur,
                 f"The request's field {x} (today resolved {'by a gateway fetch' if via == 'gateway' else 'in the subgraph'}; F5)." +
                 (f" Across containers the gateway's fetch costs the subgraph its glue {dom.fetches[(request, x)]} "
                  "(the site's fetchService, AB43)." if fetch else ""),
                 composer=composer_call, cached=cached, fetch=fetch)

    # gateway: one SEFF per request; the request's root resolver gets a SEFF of its own per request
    gw_calls = {}
    reqs = list(dom.requests.items())
    req_sig = {k: f"req_{ident(k)}" for k, _ in reqs}
    for c in classes:
        mine = [x for x in dom.reached if home[x] == c]
        comments = wrap(
            f"{c}: the domain class {c} (today in the service `{dom.service_of[c]}`), with the operations whose "
            f"home it is (F2): {', '.join(mine) if mine else 'none'}; one SEFF per operation (own work, then an "
            f"external call per accessed class: into {c}Db for its own data, into the class's component for "
            f"another class's), one SEFF per access of another class's operation, one per request whose root "
            f"resolver it holds.")
        component(c, comments, f"I{c}")
    # the case's fixed parts write through this builder (the adapter)
    fb = SimpleNamespace(o=o, wrap=wrap, component=component, seff=seff, internal=internal, beh_close=beh_close)
    component(A.ENTRY, A.entry_comments(fb, S), A.ENTRY_IFACE)
    for k, r in reqs:
        root = r["plan"][0][0]
        base = seff(A.ENTRY, A.ENTRY_IFACE, ident(k), [f"request {k} (msa {r['msa']}): " +
                                                       " -> ".join(f"{x} ({v})" for x, v in r["plan"])])
        internal(base, base, "work", S[A.ENTRY_CPU])
        hc = home[root]
        gw_calls[k] = call(base, base, "root", require(A.ENTRY, f"I{hc}"), f"I{hc}_{req_sig[k]}", 1.0)
        beh_close(base, base)
    for k, r in reqs:
        root = r["plan"][0][0]
        hc = home[root]
        base = seff(hc, f"I{hc}", req_sig[k], [f"request {k}: the root resolver {root} and the request's fields"])
        body(hc, base, root, composer_call=gw_calls[k], plan=dom.tree(k), request=k)
        beh_close(base, base)
    # an operation that only the gateway calls as a request's root lives in its request SEFFs (no
    # duplicate SEFF, so no duplicate call sites and copies, F2)
    called = dom.called
    for k, r in reqs:
        built.setdefault(r["plan"][0][0], f"{home[r['plan'][0][0]]}_{req_sig[k]}")
    for x in dom.reached:
        if x not in called:
            continue
        hc = home[x]
        dem = dom.demand(x)
        if dom.timing.has(x):
            mp = sum(g.get("mapCpuMs", 0.0) for _, _, g in dom.access_groups(x))
            db = sum(g["dbMs"] for _, _, g in dom.access_groups(x))
            text = (f"{x} ({dom.ops[x]['kind']}, {dom.ops[x]['feature']}): own work {num(dem['cpuMs'])} ms (x k_c "
                    f"{num(dem['k'])}), mapping {num(mp)} ms, {num(db)} ms of database work ({cv}, AB32)")
        else:
            text = (f"{x} ({dom.ops[x]['kind']}, {dom.ops[x]['feature']}): own work "
                    f"{num(dem['cpuMs'])} ms, {num(dem['dbMs'])} ms of database work (seed)")
        base = seff(hc, f"I{hc}", ident(x), [text])
        built[x] = base
        body(hc, base, x)
        beh_close(base, base)

    # the home as a decision (DESIGN.md AB38, AB41): an operation with transaction-bound writes gets its SEFFs on
    # every other candidate home (built after every other SEFF, so today's objects keep their order), from the same
    # per-class parts: a request root's request SEFF, a called operation's work and, for a reaction, its step form;
    # every call into the operation is re-targeted to the chosen option by the realisation (Home decision)
    homes = {}                         # operation -> {class: [SEFF bases]} (today's home first)
    for k, r in reqs:
        root = r["plan"][0][0]
        cands = dom.homes(root)
        if len(cands) < 2:
            continue
        opts = homes.setdefault(root, {c: [] for c in cands})
        opts[home[root]].append(f"{home[root]}_{req_sig[k]}")
        for cand in cands[1:]:
            base = seff(cand, f"I{cand}", req_sig[k], wrap(
                f"request {k}: the root resolver {root} at the alternative home {cand} (DESIGN.md AB38; today's home "
                f"{home[root]}): the same parts, {cand}'s accesses on its schema with its transaction's commit, "
                f"{home[root]}'s through its access part (an effect step); reached only while the Home decision is {cand}."))
            alt_bases[base] = opts[home[root]][-1]
            body(cand, base, root, composer_call=None, plan=dom.tree(k), request=k, at=cand)
            beh_close(base, base)
            opts[cand].append(base)
    for x in dom.reached:
        cands = dom.homes(x)
        if x not in called or len(cands) < 2:
            continue
        hc = home[x]
        opts = homes.setdefault(x, {c: [] for c in cands})
        opts[hc].append(built[x])
        step = step_forms.get((hc, ident(x)))
        if step:
            opts[hc].append(f"{hc}_{step}")
        for cand in cands[1:]:
            base = seff(cand, f"I{cand}", ident(x), wrap(
                f"{x} at the alternative home {cand} (DESIGN.md AB41; today's home {hc}): the same parts, {cand}'s "
                f"accesses on its schema, {hc}'s through its access part (an effect step); reached only while the Home "
                f"decision is {cand}."))
            alt_bases[base] = built[x]
            body(cand, base, x, at=cand)
            beh_close(base, base)
            opts[cand].append(base)
            if step:
                # the reaction's step form on the candidate: its envelope there, the commit on its schema (AB37)
                opts[cand].append(f"{cand}_" + step_form(cand, ident(x), reaction_envelope(x), step_commits(x),
                                                         f"the reaction {x} at {cand}"))

    # database components: one per class (its schema), one SEFF per (operation, mode) access (F8)
    db_seffs = defaultdict(list)
    for c, sig, ms, comment in pending_db:
        db_seffs[c].append((sig, ms, comment))
    for c in classes:
        component(f"{c}Db", wrap(f"{c}Db: the schema of {c} ({'S3 objects' if c == 'Media' else 'Postgres'}); "
                                 f"its operations are the database work of the accesses of {c} ({cv}: the "
                                 f"measured DB CPU per access x k_c of today's database, AB32). Only {c}'s "
                                 f"component reaches it (F8)."), f"I{c}Db")
        for sig, ms, comment in db_seffs[c]:
            w = db_wait.get((c, sig))
            if w and w[0] > 0:
                comment += (f"; waits {num(w[0])} ms ({num(w[1])} statements x {struct.lat['stmtRoundTripMs']:g} + "
                            f"{num(w[2])} commits x {struct.lat['commitDelayMs']:g}, AB33.3)")
            base = seff(f"{c}Db", f"I{c}Db", sig, [comment])
            internal(base, base, "sql", ms)
            if w and w[0] > 0:
                a = o.obj(f"{base}_wait", "InternalAction", entityName="wait")
                d = f"{a}_demand"
                o.link(a, "resourceDemand", d)
                o.obj(d, "ParametricResourceDemand", [f"{num(w[0])} ms of latency, no CPU (AB33.3)"],
                      specification=decimal(w[0] / 1000.0), requiredResource=E("ProcessingResourceType.DELAY"))
                beh_add(base, a)
            beh_close(base, base)

    # the broker and the authentication (the case's)
    A.components(fb, S)

    # the receiving envelopes (DESIGN.md AB56): per class component and callee service an operation `envelope` whose
    # SEFF is that service's receiving envelope x k_c, in the callee's container; the realisation calls it after a
    # synchronous call into one of the services with its hop. Never for a step form (its envelope is in it, AB37), a
    # commit, a joined call's work or a request's root (the gateway's root call)
    excluded = set(step_forms.values()) | set(commit_sigs.values()) | set(req_sig.values())
    joined_sigs = {s_["effect"][0] for s_ in sites if s_.get("effect")}
    bad = [x for x in recv_sigs if x.split("_", 1)[1] in excluded or x in joined_sigs]
    if bad:
        sys.exit(f"receiving envelope on a step form, commit, joined work or request root: {bad} (AB56)")
    home_targets = {t for opts in homes.values() for bs in opts.values() for b in bs
                    for t in [f"I{b.split('_', 1)[0]}_{b.split('_', 1)[1]}"]}
    # also an operation with several homes reached through its SEFF for a call (AB55) or for a request's field (AB44),
    # which no HomeOption lists: a re-targeting of those SEFFs would leave the envelope on the written option
    multi = {ident(x) for x in dom.reached if len(dom.homes(x)) > 1}
    home_sigs = {sg for sg in recv_sigs if sg.split("_", 1)[1] in multi or
                 any(sg.split("_", 1)[1].startswith(f"{x}_call_") or sg.split("_", 1)[1].startswith(f"{x}_req_") for x in multi)}
    if (set(recv_sigs) & home_targets) or home_sigs:
        sys.exit(f"receiving envelope on a Home's option {sorted((set(recv_sigs) & home_targets) | home_sigs)}: a re-targeted "
                 "call would need it on every option's interface (AB56)")
    envelopes = OrderedDict()          # (component, service) -> (envelope sig, [services])
    for sg, (comp, service) in recv_sigs.items():
        envelopes.setdefault((comp, service), [None, []])[1].append(sg)
    per_comp = defaultdict(int)
    for comp, service in envelopes:
        per_comp[comp] += 1
    for (comp, service), ent in envelopes.items():
        local = "envelope" if per_comp[comp] == 1 else f"envelope_{ident(service)}"
        ms, how = dom.envelope.receiving(service)
        base = seff(comp, f"I{comp}", local, wrap(
            f"The receiving envelope of {service} in {comp} (DESIGN.md AB56): what {service}'s application spends on a "
            f"synchronous request it receives across containers (dispatch, decoding, the answer), {num(ms)} ms x k_c "
            f"{num(dom.timing.kof(service))} = {num(ms * dom.timing.kof(service))} ms ({how}; {dom.envelope.label()}). "
            f"Called by the realisation after a synchronous call with its hop into one of {comp}'s {len(ent[1])} "
            "operations of its ReceivingEnvelope; within a container nobody calls it."))
        internal(base, base, "envelope", ms * dom.timing.kof(service))
        beh_close(base, base)
        ent[0] = f"I{comp}_{local}"

    # interfaces (now that the signatures are known)
    for iface, ss in sigs.items():
        o.link(rp, "interfaces", iface)
        o.obj(iface, "OperationInterface", entityName=iface)
        for s in ss:
            o.link(iface, "signatures", f"{iface}_{s}")
            o.obj(f"{iface}_{s}", "OperationSignature", entityName=s)

    # --- call sites and copy feeds --------------------------------------------------------------
    for s in sites:
        o.link("decisions", "callSites", s["name"])
        attrs = {"writes": True} if s["writes"] else {}
        comment = s["comment"]
        if {"cache", "joinCache"} & set(s["allowed"]):
            hs = struct.hits.get(s["name"])
            alt = next((ab for ab in alt_bases if s["name"].startswith(f"site_{ab}_")), None)
            if alt and hs is not None and not hs["lookups"]:
                hs = None              # the case's cache_hits.py follows today's homes: no lookups at an alternative one
            if hs is None and alt:
                # a site of an alternative home's SEFF (AB38): the same access of today's home's SEFF, if any
                hs = struct.hits.get(s["name"].replace(f"site_{alt}_", f"site_{alt_bases[alt]}_", 1))
            if hs is None and not alt and not os.environ.get("GEN_HITS_BOOTSTRAP"):
                # GEN_HITS_BOOTSTRAP=1: a pass before the case's cache_hits.py, which reads the sites from the model
                sys.exit(f"{struct.HITS}: no entry for {s['name']} (GEN_HITS_BOOTSTRAP=1 core/generator/derive.py, "
                         f"{cpath('generator/cache_hits.py')} --all, then core/generator/derive.py)")
            if hs is not None:
                attrs.update(hitRatio=round(hs["hitRatio"], 6), staleShare=round(hs["staleShare"], 6))
                comment += (f" A cache here (AB33.2, {struct.hits_source}): hit ratio {num(hs['hitRatio'])} over "
                            f"{hs['lookups']} lookups, {num(hs['staleShare'])} of the hits stale.")
            else:
                comment += (" A cache here: no per-site hit ratio (an access today's home makes locally, AB38): the "
                            "mechanism's.")
        o.obj(s["name"], "CallSite", wrap(comment), **attrs)
        if s.get("cached"):
            o.link(s["name"], "cachedService", s["cached"])
        if s.get("fetch"):
            o.link(s["name"], "fetchService", s["fetch"])
        if s.get("effect"):
            joined, stepsig, ca, pa = s["effect"]
            o.link(s["name"], "joinedService", joined)
            o.link(s["name"], "stepService", stepsig)
            o.link(s["name"], "callerSchema", f"Assembly_{ca}Db")
            o.link(s["name"], "providerSchema", f"Assembly_{pa}Db")
        o.link(s["name"], "call", s["action"])
        o.link(s["name"], "mechanism", s["current"])
        for m in s["allowed"]:
            o.link(s["name"], "allowed", m)
        if s["composer"] and any(m in ("join", "joinCache") for m in s["allowed"]):
            o.link(s["name"], "composer", s["composer"])
        if s["feed"]:
            c, consumer, carried, keys, data = s["feed"]
            writers = [] if carried else [a for a, dt, kd in writes_of if set(kd if keys else dt) & set(data)]
            f = s["name"].replace("site_", "feed_", 1)
            o.link("decisions", "copyFeeds", f)
            o.obj(f, "CopyFeed", wrap(f"The copy of {c} that this access may read, in {consumer}'s container: " +
                                      ("it comes with the saga message, no write feeds it (F4)." if carried else
                                       f"an existence check, so a copy of the keys, fed by the writes of {c} that "
                                       f"create or delete rows ({len(writers)}; F4, AB40)." if keys else
                                       f"fed by every write of {c} ({len(writers)}; F4).")))
            o.link(f, "site", s["name"])
            for w in writers:
                o.link(f, "writers", w)
            o.link(f, "store", f"Assembly_{consumer}")

    # --- receiving envelopes (DESIGN.md AB56) -----------------------------------------------------------
    for (comp, service), (esig, svcs) in envelopes.items():
        n = f"envelope_{comp}" + ("" if esig.endswith("_envelope") else f"_{ident(service)}")
        ms, how = dom.envelope.receiving(service)
        o.link("decisions", "envelopes", n)
        o.obj(n, "ReceivingEnvelope", wrap(
            f"{service}'s receiving envelope in {comp} (DESIGN.md AB56): {num(ms * dom.timing.kof(service))} ms CPU "
            f"(k_c applied; {how}; {dom.envelope.label()}) after every synchronous call with its hop into one of these "
            f"{len(svcs)} operations (reads of {comp}, calls of its operations, request fields, their fetches and "
            "caches); none within a container."),
              cpuMs=round(ms * dom.timing.kof(service), 6), estimate=dom.envelope.estimate)
        o.link(n, "envelope", esig)
        for sg in svcs:
            o.link(n, "services", sg)

    # --- sagas as workflows (F6) -----------------------------------------------------------------
    for sg in dom.d["sagas"]:
        trig = sg["trigger"]
        steps = [a for x in sg["operations"] if x["role"] == "step" and x["op"] != trig
                 for a in event_calls.get(x["op"], [])]
        if trig not in built or not steps:
            notes.append(f"saga {sg['name']}: no workflow (trigger or steps not reached)")
            continue
        wf = f"saga_{sg['name']}"
        o.link("decisions", "workflows", wf)
        o.obj(wf, "Workflow", wrap(f"The saga {sg['name']} (A's sagas): triggered by {trig}; its steps are the event "
                                   f"calls into its step reactions ({len(steps)}). Choreographed today."))
        o.link(wf, "trigger", built[trig])
        for a in steps:
            o.link(wf, "steps", a)
        o.link(wf, "style", "choreography")
        o.link(wf, "allowed", "choreography")
        o.link(wf, "allowed", "orchestration")
    # one saga notion (AB35): an operation's writes bound to its home class by a transaction are the
    # steps of a workflow triggered by its SEFF (one per SEFF that makes them), with the event sagas'
    # coordination options; co-located they stay one transaction (Workflow.transactional)
    for base, acts in tx_steps.items():
        wf = f"tx_{base}"
        o.link("decisions", "workflows", wf)
        o.obj(wf, "Workflow", wrap(
            f"The transaction of {acts[0][0]} as a saga (DESIGN.md AB35): triggered by its SEFF {base}; its steps are "
            f"the writes bound to its home class ({len(acts)}). Co-located they are local calls in one transaction "
            "(orchestrated: no coordination CPU, no commit of their own); separated each is a saga step that "
            "commits on its own (AB33.7), orchestrated with the coordinator's stepCpuMs. Choreographed today."),
              transactional=True)
        o.link(wf, "trigger", base)
        for _, a in acts:
            o.link(wf, "steps", a)
        o.link(wf, "style", "choreography")
        o.link(wf, "allowed", "choreography")
        o.link(wf, "allowed", "orchestration")

    # --- homes (DESIGN.md AB38, AB41) ------------------------------------------------------------------
    for x, opts in homes.items():
        hc = home[x]
        inner = tuple(f"{b}_" for bs in opts.values() for b in bs)
        targets = [f"I{hc}_{b[len(hc) + 1:]}" for b in opts[hc]]
        # every call into the operation as written, but the option's own (a step form's call of its work)
        hcalls = [a for t in targets for a, prefix in calls_to[t] if not f"{prefix}_".startswith(inner)]
        if not hcalls:
            notes.append(f"home of {x}: no call into it, no Home")
            continue
        hn = f"home_{ident(x)}"
        o.link("decisions", "homes", hn)
        o.obj(hn, "Home", wrap(f"The home of {x} (DESIGN.md AB38, AB41): one of the classes it writes in its transaction "
                               f"({', '.join(opts)}); today's {hc} (F2) is the written option. Its calls ({len(hcalls)}: "
                               "the gateway's root call, effect steps, other operations' calls) are re-targeted to the "
                               "chosen option, whatever their mechanism."),
              operation=x)
        for a in hcalls:
            o.link(hn, "calls", a)
        for c, bs in opts.items():
            on = f"{hn}_{c}"
            o.link(hn, "options", on)
            o.obj(on, "HomeOption", cls=c)
            o.link(on, "provider", f"Assembly_{c}")
            o.link(on, "interface", f"I{c}")
            o.link(on, "schema", f"Assembly_{c}Db")
            for b in bs:
                o.link(on, "seffs", b)
        o.link(hn, "home", f"{hn}_{hc}")
        o.link(hn, "written", f"{hn}_{hc}")

    # --- system ------------------------------------------------------------------------------------
    sysn = A.NAME
    o.obj(sysn, "System", entityName=sysn)
    comps = classes + [f"{c}Db" for c in classes] + list(A.FIXED)
    for c in comps:
        o.link(sysn, "assemblyContexts", f"Assembly_{c}")
        o.obj(f"Assembly_{c}", "AssemblyContext", entityName=f"Assembly_{c}")
        o.link(f"Assembly_{c}", "encapsulatedComponent", c)
    for comp in comps:
        for iface in sorted(requires[comp]):
            prov = iface[1:]
            n = f"Assembly_{comp}_to_Assembly_{prov}"
            o.link(sysn, "connectors", n)
            o.obj(n, "AssemblyConnector", entityName=n)
            o.link(n, "requiringAssemblyContext", f"Assembly_{comp}")
            o.link(n, "providingAssemblyContext", f"Assembly_{prov}")
            o.link(n, "providedRole", f"{prov}_provides_{iface}")
            o.link(n, "requiredRole", f"{comp}_requires_{iface}")
    for c, i in A.PROVIDED:
        role = f"{sysn}_provides_{i}"
        o.link(sysn, "providedRoles", role)
        o.obj(role, "OperationProvidedRole", entityName=role)
        o.link(role, "providedInterface", i)
        d = f"delegate_{c}_provides_{i}"
        o.link(sysn, "connectors", d)
        o.obj(d, "ProvidedDelegationConnector", entityName=d)
        o.link(d, "assemblyContext", f"Assembly_{c}")
        o.link(d, "innerProvidedRole", f"{c}_provides_{i}")
        o.link(d, "outerProvidedRole", role)

    # --- resource environment (F10) ----------------------------------------------------------
    o.obj("environment", "ResourceEnvironment", entityName="environment")
    containers = []

    def container(name, comments, specs):
        containers.append(name)
        o.link("environment", "resourceContainer", name)
        o.obj(name, "ResourceContainer", comments, entityName=name)
        for kind, n in specs:
            s = f"{name}_{kind.lower()}"
            o.link(name, "activeResourceSpecifications", s)
            if kind == "DELAY":
                o.obj(s, "ProcessingResourceSpecification", schedulingPolicy=E("SchedulingPolicy.DELAY"),
                      activeResourceType=E("ProcessingResourceType.DELAY"), processingRate="1")
                continue
            o.obj(s, "ProcessingResourceSpecification", schedulingPolicy=E("SchedulingPolicy.PROCESSOR_SHARING"),
                  activeResourceType=E(f"ProcessingResourceType.{kind}"), processingRate="1000", numberOfReplicas=n)
    dbc = int(S["dbCores"])
    for c in classes:
        container(app_c[c], wrap(f"An application container of the pool, named after {c} (F10). CPU one full core "
                                 f"per replica before the decisions (coresPerReplica {S['coresPerReplica']}); HDD: "
                                 f"the local copies kept here."), [("CPU", 1), ("HDD", dbc)])
    container(MONO, ["An extra application container of the pool (the monolith's)."], [("CPU", 1), ("HDD", dbc)])
    for c in classes:
        container(db_c[c], [f"A database server of the pool, named after {c}: dbCores {dbc}." +
                            " DELAY: the accesses' latency-only waits (AB33.3)."],
                  [("CPU", dbc), ("DELAY", 1)])
    container(SHARED, [f"The shared database server: dbCores {dbc}, one schema per class placed here." +
                       " DELAY: the accesses' latency-only waits (AB33.3)."],
              [("CPU", dbc), ("DELAY", 1)])
    fb.container = container
    A.containers(fb, S)
    o.link("environment", "linkingResources", "lan")
    o.obj("lan", "LinkingResource", ["One network; latencies and middleware come from RemoteCalls."], entityName="lan")
    for c in containers:
        o.link("lan", "connectedResourceContainers", c)
    o.link("lan", "communicationLinkResourceSpecifications", "lan_spec")
    o.obj("lan_spec", "CommunicationLinkResourceSpecification", failureProbability=0.0,
          communicationLinkResourceType=E("CommunicationLinkResourceType.LAN"), latency="0", throughput="1.0E12")

    # placements: a class's component in any application container, its schema on any database server
    for c in classes:
        for comp, cands in ((c, [app_c[x] for x in classes] + [MONO]), (f"{c}Db", [db_c[x] for x in classes] + [SHARED])):
            pl = f"place_{comp}"
            o.link("decisions", "placements", pl)
            o.obj(pl, "Placement")
            o.link(pl, "allocation", f"alloc_Assembly_{comp}")
            for x in cands:
                o.link(pl, "candidates", x)
    for c in [app_c[x] for x in classes] + [MONO]:
        d = f"deploy_{c}"
        o.link("decisions", "deployables", d)
        o.obj(d, "Deployable", cpuPerReplica=S["coresPerReplica"])
        o.link(d, "container", c)
        o.link(d, "autoscaling", "autoscaler")
    A.deployables(fb, S)
    o.link("decisions", "costModel", "cost")
    o.obj("cost", "CostModel", [A.COST_TEXT],
          perContainer=0.0, perCore=S["costPerCore"], perReplicaOverhead=S["costPerReplicaOverhead"],
          perCache=S["costPerCache"])
    for pname, price, cs in [("price_databases", DB_PRICE, [db_c[c] for c in classes] + [SHARED])] + A.prices(S):
        o.link("cost", "prices", pname)
        if pname == "price_databases":
            o.obj(pname, "ContainerPrice", wrap(
                f"A database server (AB30): {DB_PRICE:g} plus perCore x its cores sized to its busiest bin at C2's "
                f"limit, at least {DB_MIN_CORES:g}."), price=float(price), perCore=S["costPerCore"], minCores=DB_MIN_CORES)
        else:
            o.obj(pname, "ContainerPrice", price=float(price))
        for c in cs:
            o.link(pname, "containers", c)

    # quality model (F11): change rates per class by its operations (AB24.1), no commit counts
    ops = class_operations(dom)
    rates = change_rates(dom)
    o.link("decisions", "reliability", "reliability")
    o.obj("reliability", "Reliability", wrap(
        "Failures (O2) as the unified project (H9): changeFailureRate 0.1, restored in 1 h; the system has "
        f"{CHANGES_PER_YEAR:g} releases a year ({A.CHANGES_TEXT}), shared by "
        "the classes in proportion to their domain operations (AB24.1); processUnavailability 2e-4 "
        "('deploy'); tenantShare 1.0: a tenant's failed release or runaway query takes the shared database "
        f"server down for every tenant (U1); asyncWeight {ASYNC_WEIGHT:g}: a failed asynchronous unit of work "
        "(event handlers, saga steps) counts as a failed session times its process's criticality "
        "(domain Process.criticality; copy maintenance 0; AB24.2, AB25)."),
        changeFailureRate=0.1, restoreHours=1.0, periodHours=PERIOD_HOURS, processUnavailability=2e-4,
        serverUnavailability=1e-4, tenantShare=TENANT_SHARE, asyncWeight=ASYNC_WEIGHT)
    for c in classes:
        u = f"change_{c}"
        o.link("decisions", "changeUnits", u)
        o.obj(u, "ChangeUnit", [f"{c}: {num(rates[c])} releases a year ({ops[c]} domain operations, AB24.1, AB25)."],
              changes=rates[c])
        o.link(u, "components", f"Assembly_{c}")
        o.link(u, "components", f"Assembly_{c}Db")
    o.link("decisions", "changeCoupling", "changeCoupling")
    o.obj("changeCoupling", "ChangeCoupling", [f"O3: a change breaks a caller in another container with {CONTRACT_BREAK}; "
          f"it touches every co-tenant service of its database server with {SHARED_SERVER_COUPLING} (U2)."],
          contractBreak=CONTRACT_BREAK, sharedServerCoupling=SHARED_SERVER_COUPLING)
    o.link("decisions", "consistency", "consistency")
    o.obj("consistency", "Consistency", wrap(
        "O4: a write to another container leaves the caller's transaction: 1 when synchronous, 1.5 when "
        "asynchronous (a saga step); a possibly stale read weighs the probability that its data changed within "
        f"the staleness window (AB23): the replication lag of a copy ({REPLICATION_LAG_S} s), the TTL of a cache "
        f"({CACHE_TTL_S} s, {A.CACHE_TEXT}). This prices the bindings (F6)."),
        syncWriteWeight=1.0, asyncWriteWeight=1.5, replicationLagSeconds=REPLICATION_LAG_S,
        cacheTtlSeconds=CACHE_TTL_S)
    o.link("decisions", "latency", "latency")
    o.obj("latency", "Latency", wrap(
        f"Latency without CPU (DESIGN.md AB33.3; {struct.lat_source}): per database statement "
        f"{struct.lat['stmtRoundTripMs']:g} ms, per commit {struct.lat['commitDelayMs']:g} ms ({struct.lat['commitUnit']}), "
        "written into each database access as a DELAY on its server; per message through the broker the "
        f"publisher waits {struct.lat['publishWaitMs']:g} ms (realised next to the publish CPU). Response times only."),
        stmtRoundTripMs=struct.lat["stmtRoundTripMs"], commitDelayMs=struct.lat["commitDelayMs"],
        publishWaitMs=struct.lat["publishWaitMs"])
    o.link("decisions", "peakCapacity", "peakCapacity")
    o.obj("peakCapacity", "PeakCapacity", wrap(
        f"C2 (AB6): the database servers and the broker stay at most at {CAPACITY_LIMIT} utilisation in every "
        f"{CAPACITY_BIN_SECONDS:g}-s bin of the simulated window."),
          limit=CAPACITY_LIMIT, binSeconds=CAPACITY_BIN_SECONDS)
    for c in [db_c[c] for c in classes] + [SHARED, BROKER]:
        o.link("peakCapacity", "containers", c)
    # C1 per request type (L1, AB6, AB20): the policy and, per gateway request type, today's simulated
    # statistics under this profile (the reference); a request type today's run completed none of in
    # its window gets no budget
    o.link("decisions", "latencyBudgetPolicy", "latencyPolicy")
    o.obj("latencyPolicy", "LatencyBudgetPolicy", wrap(
        f"C1 (AB20): the {BUDGET_STATISTIC} of a request type's simulated response times stays at most at "
        f"{BUDGET_FACTOR:g} x today's {BUDGET_STATISTIC} under the same profile; request types with fewer than "
        f"{MIN_BUDGET_COUNT} completions in today's window have no budget (noise)."),
          statistic=BUDGET_STATISTIC, factor=BUDGET_FACTOR, minCompletions=MIN_BUDGET_COUNT)
    if P95.exists():
        ref = json.loads(P95.read_text())
        if ref.get("seeds", 1) != REPLICATIONS:
            sys.exit(f"{P95}: references over {ref.get('seeds', 1)} seed(s), REPLICATIONS is {REPLICATIONS}: "
                     f"run SEEDS=\"{' '.join(str(SIM_SEED + k) for k in range(REPLICATIONS))}\" "
                     f"core/tools/gen_domain_budgets.sh first (AB26)")
        stat_key = {"mean": "meanMs", "p50": "p50Ms", "p90": "p90Ms", "p95": "p95Ms"}[BUDGET_STATISTIC]
        for k, _ in reqs:
            n = ident(k)
            c = ref["count"].get(n, 0)
            if c <= 0:
                notes.append(f"no budget for {k}: today's {PROFILE} run completed none in its window")
                continue
            if c < MIN_BUDGET_COUNT:
                notes.append(f"{k}: {c} completions in today's {PROFILE} window, below the policy's {MIN_BUDGET_COUNT}")
            b = f"budget_{n}"
            o.link("decisions", "operationLatencyBudgets", b)
            o.obj(b, "OperationLatencyBudget", [f"C1, O5: today's {k} under the {PROFILE} profile (mean over {ref.get('seeds', 1)} "
                  f"seeds): {c} requests, mean "
                  f"{ref['meanMs'][n]:.4g}, p50 {ref['p50Ms'][n]:.4g}, p90 {ref['p90Ms'][n]:.4g}, p95 {ref['p95Ms'][n]:.4g}, "
                  f"p99 {ref['p99Ms'][n]:.4g} ms; "
                  f"ms = the policy's budget."],
                  ms=round(BUDGET_FACTOR * ref[stat_key][n], 4), referenceMeanMs=round(ref["meanMs"][n], 4),
                  referenceP50Ms=round(ref["p50Ms"][n], 4), referenceP90Ms=round(ref["p90Ms"][n], 4),
                  referenceP95Ms=round(ref["p95Ms"][n], 4), referenceP99Ms=round(ref["p99Ms"][n], 4), referenceCount=c)
            o.link(b, "operation", f"{A.ENTRY_IFACE}_{n}")
    # objectives as constraints against today's cut (AB30)
    if BOUNDS.exists():
        ref = json.loads(BOUNDS.read_text())
        if ref.get("seeds", 1) != REPLICATIONS:
            sys.exit(f"{BOUNDS}: today's values over {ref.get('seeds', 1)} seed(s), REPLICATIONS is {REPLICATIONS}")
        for k in BOUND_OBJECTIVES:
            b = f"bound_{k}"
            o.link("decisions", "objectiveBounds", b)
            o.obj(b, "ObjectiveBound", wrap(
                f"AB30: {k} at most {BOUND_FACTOR:g} x today's {ref[k]:.6g} under the {PROFILE} profile "
                f"({ref.get('seeds', 1)} seeds); a constraint of the against-today configs."),
                  objective=k, reference=round(ref[k], 6), factor=BOUND_FACTOR)

    # --- allocation --------------------------------------------------------------------------------
    o.obj("allocation", "Allocation", entityName="allocation")
    o.link("allocation", "system", sysn)
    o.link("allocation", "targetResourceEnvironment", "environment")
    where = {**place_app, **{f"{c}Db": place_db[c] for c in classes}, **A.FIXED_PLACEMENT}
    for c in comps:
        ac = f"alloc_Assembly_{c}"
        o.link("allocation", "allocationContexts", ac)
        o.obj(ac, "AllocationContext", entityName=ac)
        o.link(ac, "assemblyContext", f"Assembly_{c}")
        o.link(ac, "resourceContainer", where[c])
    stats = dict(classes=len(classes), components=len(comps), seffs=sum(1 for x in o.objs if x[1] == "ResourceDemandingSEFF"),
                 callSites=len(sites), copyFeeds=sum(1 for s in sites if s["feed"]),
                 operations=len(dom.reached), requests=len(reqs),
                 options=sum(len(s["allowed"]) for s in sites))
    return o, stats


def usage_text(dom, sessions_mod):
    """C's session usage model (realistic workload) with this model's gateway signatures."""
    model = dom.sessions
    req_sig = {k: f"{A.ENTRY_IFACE}_{ident(k)}" for k in model["requests"]}

    def role_sig(model_, req):
        return A.role_sig(req, req_sig.get(req))
    sessions_mod.role_sig = role_sig
    return sessions_mod.pcm(model, "realistic")


# ---------------------------------------------------------------------------------------------
# the domain and its derivation trace (metamodel/domain.mm; DESIGN.md F16)


def domain_section(dom, path):
    """The domain instances of the derived model at `path` (formatted and synced, with
    architecture.mm) and their trace into its PCM, as model text (objects and links)."""
    sys.path.insert(0, str(TOOLS))
    import format_model
    m = format_model.parse_model(path.read_text())
    cls = {n: o.cls for n, o in m.objs.items()}
    ent = {n: dict(o.attrs).get("entityName", "").strip('"') for n, o in m.objs.items()}
    out = defaultdict(list)
    for l in m.links:
        out[(l.src, l.feat)].append(l.tgt)
    one = lambda n, f: (out.get((n, f)) or [None])[0]
    home = {x: dom.home(x) for x in set(dom.reached) | set(counted_operations(dom))}
    # SEFFs per component and signature entity name; external calls per SEFF (any depth)
    seff_of = {}
    for comp in [n for n, c in cls.items() if c == "BasicComponent"]:
        for sf in out.get((comp, "serviceEffectSpecifications"), []):
            seff_of[(comp, ent.get(one(sf, "describedService"), ""))] = sf

    def calls_in(beh):
        res = []
        for a in out.get((beh, "steps"), []):
            if cls[a] == "ExternalCallAction":
                res.append(a)
            for f in ("branches", "bodyBehaviour", "forkedBehaviours", "branchBehaviour"):
                for b in out.get((a, f), []):
                    res += calls_in(b) if cls[b] != "ProbabilisticBranchTransition" else \
                        [x for bb in out.get((b, "branchBehaviour"), []) for x in calls_in(bb)]
        return res
    site_of = {one(n, "call"): n for n, c in cls.items() if c == "CallSite"}
    # the assembly a call reaches: the one providing its role's interface
    asm_of = {}
    for asm in [n for n, c in cls.items() if c == "AssemblyContext"]:
        for r in out.get((one(asm, "encapsulatedComponent"), "providedRoles"), []):
            asm_of[one(r, "providedInterface")] = asm
    provider = lambda a: asm_of.get(one(one(a, "role"), "requiredInterface"))

    o = Out()
    o.obj("domain", "Domain", wrap(f"The domain of {A.NAME} ({A.DOMAIN_SOURCE}), reduced to what the "
                                   "workload reaches (F2), with the derivation trace into the PCM above (F16). "
                                   f"defaultCriticality {DEFAULT_CRITICALITY:g}: asynchronous work of no process "
                                   "that does more than maintain copies (O2, AB25)."),
          name=A.NAME, defaultCriticality=DEFAULT_CRITICALITY)
    cname = {c: f"class_{c}" for c in dom.classes}
    by_name = {c["name"]: c for c in dom.d["classes"]}
    for c in dom.classes:
        o.link("domain", "classes", cname[c])
        o.obj(cname[c], "DomainClass", [f"today in `{dom.service_of[c]}` ({by_name[c].get('table') or by_name[c]['storage']})"], name=c,
              rowBytes=int(by_name[c].get("rowBytes", 0)))
        o.link(cname[c], "component", f"Assembly_{c}")
        o.link(cname[c], "schema", f"Assembly_{c}Db")
    for r in dom.d["references"]:
        n = f"ref_{ident(r['id'])}"
        o.link(cname[r["from"]], "references", n)
        held = (f"{r['storage']}" if r["storage"].startswith("join table") else
                f"column {r['attr']} of {r['inCopy']}" if r.get("inCopy") else None)
        o.obj(n, "Reference", [x for x in (f"{r['id']} <-> {r['inverse']}" if r.get("inverse") else None, held) if x],
              name=r["id"], kind=E(f"ReferenceKind.{r['kind'].upper()}"),
              upper=1 if r["mult"] in ("1", "0..1") else -1, snapshot="snapshot" in r.get("note", "").lower(),
              table=r["storage"].startswith("join table"))
        o.link(n, "target", cname[r["to"]])
    # the operations the workload reaches (F2: with SEFFs, timings and the trace), then the other domain
    # operations counted for the change units (AB25: `domain`, not `trivial`, not copy maintenance), with
    # their accesses and calls but no SEFF and no timing: they belong to the domain's structure (C3's
    # affinity graph), not to the simulated system; events, processes and bindings stay with the reached ones
    extra = [x for x in counted_operations(dom) if x not in dom.reached]
    # a call whose one invocation resolves fields of fields (AB55): each field is a call of the operation whose
    # objects it is resolved on, as in the PCM (the callee's SEFF for that call calls it)
    nested_calls = defaultdict(list)

    def add_nested(parent, fields, strong, level):
        for y, kids in fields:
            if (y, 1.0, strong, level) not in nested_calls[parent]:
                nested_calls[parent].append((y, 1.0, strong, level))
            add_nested(y, kids, strong, level)
    for x in list(dom.reached) + extra:
        for t in dom.targets(x):
            if t[1] == "call":
                # the nested fields' Calls carry the invocation's strength and level (AB55, AB60)
                add_nested(t[0], t[4], bool(t[5].get("strong")), Domain.level(x, t[5]))
    opname = {x: f"op_{ident(x)}" for x in list(dom.reached) + extra}
    reached_op = {x: opname[x] for x in dom.reached}
    taken = receiving_split(dom, {x: dom.home(x) for x in dom.reached})[0]
    feats = defaultdict(list)
    all_feats = defaultdict(list)
    for x in list(dom.reached) + extra:
        op = dom.ops[x]
        hc = home[x]
        timed = x in reached_op
        dem = dom.demand(x) if timed else dict(cpuMs=0.0)
        n = opname[x]
        o.link("domain", "operations", n)
        o.obj(n, "Operation", [f"home {hc}; rates come from the usage model (C), so `rate` is 0" if timed else
                               f"home {hc}; not reached by the workload: no SEFF, no timing (AB25)"], name=x,
              kind=E(f"OperationKind.{op['kind'].upper()}"), cpuMs=float(dem["cpuMs"]),
              **({"envelopeMs": round(taken[x], 6)} if timed and taken.get(x) else {}))
        if timed:
            feats[op["feature"]].append(n)
        all_feats[op["feature"]].append(n)
        sigs = [ident(x), f"{ident(x)}_step"] + [f"req_{ident(k)}" for k, r in dom.requests.items() if r["plan"][0][0] == x] + \
            [f"{ident(x)}_req_{ident(k)}" for k in dom.requests] + [f"{ident(x)}_call_{ident(y)}" for y in dom.reached]
        seffs = [seff_of[(hh, sg)] for hh in dom.homes(x) for sg in sigs if (hh, sg) in seff_of]
        for sf in seffs:
            o.link(n, "seffs", sf)
        acts = [a for sf in seffs for a in calls_in(sf)]
        for c, mode, g in dom.access_groups(x, timed):
            sig = f"{ident(x)}_{mode}"
            # every class's access signature of the operation has the entity name `<op>_<mode>`: the calls
            # into this class's component or schema
            mine = [a for a in acts if ent.get(one(a, "calledService")) in (sig, f"{sig}_step")
                    and provider(a) in (f"Assembly_{c}", f"Assembly_{c}Db")]
            # one access per reference it navigates (AB42: Product.categories, not a read of Product); the
            # campaign times the class's reads or writes together (AB32): split over them by statements
            parts = g["parts"]
            total = sum(pt["statements"] for pt in parts.values())
            # the measured rows per statement (0 for a lookup that finds nothing), 1 where the campaign has none
            rows = round(g["rows"] / g["calls"], 4) if g.get("calls") else 1.0
            for via, pt in parts.items():
                share = pt["statements"] / total if len(parts) > 1 else 1.0
                an = f"acc_{ident(x)}_{c}_{mode}" if via is None else f"acc_{ident(x)}_{ident(via)}_{mode}"
                # (its shape; a part of only own data in a copy, AB67: that access's)
                first = next((a for a in op["accesses"] if a["class"] == c and a["mode"] == mode and
                              a.get("reference") == via and not dom.own_in_copy(x, a)), None) or \
                    next(a for a in op["accesses"] if a["mode"] == mode and via is None and c == dom.home(x) and
                         dom.own_in_copy(x, a))
                o.link(n, "accesses", an)
                # a read's consistency level (DESIGN.md AB60): the strictest of its accesses' (not strong: stale-ok);
                # the comment names the curated level, rules and reason of each strong one
                lv = {"level": E(f"ConsistencyLevel.{MODEL_LEVEL[pt['level']]}")} if mode == "read" else {}
                why = [f"{cs['level']} ({', '.join(cs['rules'])}): {cs['reason']}" for cs in pt.get("levels", [])]
                # a group with own data in a copy (AB67): each part its own statements' share of each measured part
                mixed = len(parts) > 1 and "dbMs" in pt
                why_t = ([f"{num(pt['dbMs'] / g['dbMs'] if g['dbMs'] else share)} of the timing of {x}'s {mode}s of {c} "
                          "(its statements' share of each measured part, AB67)"] if mixed else
                         [f"{num(share)} of the timing of {x}'s {mode}s of {c} (by statements)"] if len(parts) > 1 else [])
                o.obj(an, "Access", why_t +
                      [l for w in why for l in wrap(w)],
                      mode=E(f"AccessMode.{mode.upper()}"), shape=E(f"AccessShape.{
                    {'one': 'ONE', 'optional': 'OPTIONAL', 'list': 'LIST', 'batch': 'BATCH', 'perItem': 'PER_ITEM'}[first['shape']]}"),
                    count=float(pt["statements"]), rows=float(rows), strong=bool(pt["strong"]), **lv,
                    cpuMs=float(pt["mapCpuMs"] if mixed else g.get("mapCpuMs", 0.0) * share),
                    dbMs=float(pt["dbMs"] if mixed else g["dbMs"] * share))
                o.link(an, "target", cname[c])
                if via is not None:
                    o.link(an, "via", f"ref_{ident(via)}")
                for a in mine:
                    o.link(an, "actions", a)
                for a in mine:
                    if a in site_of:
                        o.link(an, "sites", site_of[a])
        k = 0
        for callee, count, strong, level in [(t[0], t[2], bool(t[5].get("strong")), Domain.level(x, t[5]))
                                             for t in dom.targets(x) if t[1] == "call"] + nested_calls.get(x, []):
            if callee in opname:
                k += 1
                cn = f"call_{ident(x)}_{k}"
                o.link(n, "calls", cn)
                cs = next((t[5].get("consistency") for t in dom.targets(x) if t[1] == "call" and t[0] == callee), None)
                o.obj(cn, "Call", wrap(f"{cs['level']} ({', '.join(cs['rules'])}): {cs['reason']}") if cs else [],
                      count=float(count), strong=bool(strong), level=E(f"ConsistencyLevel.{MODEL_LEVEL[level]}"))
                o.link(cn, "callee", opname[callee])
    # events with a reached reaction, and their raises
    ev = {}
    for x in dom.reached:
        for t in dom.targets(x):
            if t[1] == "event":
                ev.setdefault(t[4], set()).add(t[0])
    pay = {e["topic"]: sorted({c for p in e["publishers"] for c in p.get("payload", [])}) for e in dom.d["events"]}
    for topic in sorted(ev):
        en = f"event_{ident(topic)}"
        o.link("domain", "events", en)
        o.obj(en, "DomainEvent", name=topic)
        for c in pay.get(topic, []):
            if c in cname:
                o.link(en, "payload", cname[c])
        for r in sorted(ev[topic]):
            if dom.ops[r]["trigger"].get("topic") == topic:
                o.link(en, "reactions", opname[r])
    for x in dom.reached:
        for i, p in enumerate(dom.ops[x]["publishes"]):
            if p["topic"] in ev and publish_prob(p) >= 1e-4:
                rn = f"raise_{ident(x)}_{i + 1}"
                o.link(opname[x], "raises", rn)
                o.obj(rn, "Raise", probability=publish_prob(p))
                o.link(rn, "event", f"event_{ident(p['topic'])}")
    for sg in dom.d["sagas"]:
        if sg["trigger"] not in reached_op:
            continue
        pn = f"process_{sg['name']}"
        o.link("domain", "processes", pn)
        o.obj(pn, "Process", [f"criticality {PROCESS_CRITICALITY[sg['name']]:g}: O2's asynchronous work (AB25)"],
              name=sg["name"], criticality=PROCESS_CRITICALITY[sg["name"]])
        o.link(pn, "trigger", reached_op[sg["trigger"]])
        for x in sg["operations"]:
            if x["op"] in reached_op:
                o.link(pn, "compensations" if x["role"] == "compensation" else "steps", reached_op[x["op"]])
    for code in sorted(all_feats):
        f = next((f for f in dom.d["features"] if f["code"] == code), {"name": code})
        fn = f"feature_{code}"
        o.link("domain", "features", fn)
        o.obj(fn, "Feature", code=code, name=f["name"])
        for n in all_feats[code]:
            o.link(fn, "operations", n)
    # bindings (A6): transactions, cross-class statements, compositions
    binds = OrderedDict()
    for t in dom.d["transactions"]:
        if t.get("multiClass") and t["op"] in reached_op:
            cs = frozenset(t.get("domainClassesWritten") or t["classes"])
            if len(cs) > 1:
                binds.setdefault(("TRANSACTION", cs), set()).add(t["op"])
    for j in dom.d["joins"]:
        cs = frozenset(c for c in j.get("ownClasses", []) if c in cname)
        ops = set(j.get("usedBy", [])) & set(reached_op)
        if len(cs) > 1 and ops:
            binds.setdefault(("JOIN", cs), set()).update(ops)
    for r in dom.d["references"]:
        if r["kind"] == "composition" and r["from"] != r["to"]:
            binds.setdefault(("COMPOSITION", frozenset((r["from"], r["to"]))), set())
    for i, ((kind, cs), ops) in enumerate(binds.items()):
        bn = f"binding_{kind.lower()}_{'_'.join(sorted(cs))}"
        o.link("domain", "bindings", bn)
        o.obj(bn, "Binding", kind=E(f"GroupKind.{kind}"))
        for c in sorted(cs):
            o.link(bn, "classes", cname[c])
        for x in sorted(ops):
            o.link(bn, "operations", reached_op[x])
    # unit groups and couplings for the group operators (DESIGN.md G8, I6; decision layer, read by
    # move-unit, gather-unit and the coupling-aware growth of move-group/split-region/swap-groups):
    # members are the class components' Placements (place_<Class>)
    place = {c: f"place_{c}" for c in dom.classes if (f"place_{c}", "allocation") in out}
    groups = OrderedDict()
    for (kind, cs), _ in binds.items():
        ms = sorted(place[c] for c in cs if c in place)
        if len(ms) > 1:
            groups.setdefault(tuple(ms), kind.lower())
    for code in sorted(feats):
        cs = {home[x] for x in dom.reached if dom.ops[x]["feature"] == code}
        ms = sorted(place[c] for c in cs if c in place)
        if len(ms) > 1:
            groups.setdefault(tuple(ms), f"feature {code}")
    for i, (ms, kind) in enumerate(groups.items()):
        gn = f"unit_{i}_{ident(kind)}"
        o.link("decisions", "unitGroups", gn)
        o.obj(gn, "UnitGroup", kind=kind)
        for m_ in ms:
            o.link(gn, "members", m_)
    # coupling strength of a class pair (A's coupling.pairs): operations accessing both, plus 2 per
    # transaction and per cross-class statement over both, plus 1 for a composition
    for p in dom.d["coupling"]["pairs"]:
        a_, b_ = p["a"], p["b"]
        if a_ not in place or b_ not in place or a_ == b_:
            continue
        s = p.get("coAccessOps", 0) + 2 * p.get("transactions", 0) + 2 * p.get("joins", 0) + (1 if p.get("composition") else 0)
        if s <= 0:
            continue
        cn = f"coupling_{a_}_{b_}"
        o.link("decisions", "couplings", cn)
        o.obj(cn, "Coupling", strength=float(s))
        o.link(cn, "ends", place[a_])
        o.link(cn, "ends", place[b_])
    text = o.text("x", [])
    return text.split('using "x"', 1)[1]


def add_domain(dom, path, proj):
    """Turn the synced architecture model at `path` (in the staged project `proj`) into a domain model: `using
    domain.mm` and the domain with its trace appended; formatted again."""
    body = domain_section(dom, path)
    text = path.read_text()
    text = re.sub(r'using "[^"]*architecture\.mm"', f'using "{os.path.relpath(proj / "metamodel" / "domain.mm", path.parent)}"', text, count=1)
    path.write_text(text.rstrip("\n") + "\n\n\n// ═══ Domain (core/mdeo/metamodel/domain.mm; DESIGN.md F16) ═══\n" + body)


# the models' generator line (core/generator/perclass_seed.py replaces it in the per-class seed)
GENERATED = (f"Generated by core/generator/derive.py with {C.rel('generator.adapter')}; edit the generator, not "
             "this file.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", default="all", choices=list(SEEDS) + ["all"])
    ap.add_argument("--parts", default=str(PARTS),
                    help=f"the timing campaign's parts (default {PARTS.relative_to(P)}, versions {Timing.VERSIONS})")
    ap.add_argument("--out", help="the model file of one --seed (default the case's models/domain-<seed>.m)")
    ap.add_argument("--no-format", action="store_true")
    ap.add_argument("--no-sync", action="store_true")
    a = ap.parse_args()
    if a.out and a.seed == "all":
        sys.exit("--out needs one --seed")
    spec = importlib.util.spec_from_file_location("gen_sessions", C.path("sessionModel"))
    gs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gs)
    dom = Domain(json.loads(DOMAIN.read_text()), json.loads(SESSIONS.read_text()))
    # the weights of an operation's per-request parts (DESIGN.md AB69): the case's request rates, if it has them
    dom.timing = Timing(a.parts, dom, gs.request_rates(dom.sessions) if hasattr(gs, "request_rates") else None)
    dom.envelope = Envelope(dom.timing.parts)
    dom.envelope.inbound(dom.ops)
    S = platform()
    struct = Structure(S)
    usage = usage_text(dom, gs)
    usage = "\n".join(l for l in usage.splitlines() if not l.startswith("// Session usage model") and
                      not l.startswith("// design load") and not l.startswith("// the unified project")) + "\n"
    tm = dom.timing
    # the models are written, formatted and synced in a staged project of their own (the formatter and the sync
    # read the metamodels the `using` lines name, relative to the staged layout), then copied to the case
    proj = Path(os.environ.get("ARCH_PROJECT") or
                stage_project.stage(CASE, stage_project.default_out(CASE).with_name(f"{CASE}-gen"))).resolve()
    env = dict(os.environ, ARCH_PROJECT=str(proj))
    for seed in (SEEDS if a.seed == "all" else (a.seed,)):
        notes = []
        o, st = generate(dom, seed, S, notes, profile_steps(dom, gs), struct)
        dest = Path(a.out) if a.out else C.path("mdeo.models") / f"domain-{seed}.m"
        out = proj / "models" / f"domain-{seed}.m"
        using = os.path.relpath(proj / "metamodel" / "architecture.mm", out.parent)
        what = A.SEED_TEXT[seed]
        header = wrap(f"{A.TITLE} derived from the domain model (DESIGN.md §F): one component "
                      f"per domain class, the service cut is the allocation. Seed: {what}.")
        header += wrap(GENERATED)
        # what it was generated from, by content (the explorer reports a model older than its inputs)
        header += [f"Input: {f.relative_to(P)} sha256 {hashlib.sha256(f.read_bytes()).hexdigest()[:16]}" for f in
                   [HERE / "derive.py", SESSIONS_CORE, C.path("generator.adapter"), C.path("sessionModel"), DOMAIN,
                    SESSIONS, PLATFORM, Path(a.parts).resolve(),
                    Envelope.ESTIMATE, Structure.HITS, Structure.LATENCY, P95, BOUNDS] if f.exists()] + [""]
        header += wrap(f"Size: {st['classes']} classes, {st['components']} components, {st['operations']} operations "
                       f"the workload reaches, {st['requests']} request types, {st['seffs']} SEFFs, "
                       f"{st['callSites']} call sites ({st['options']} mechanism options, {st['copyFeeds']} copy "
                       f"feeds). Timings: the timing {tm.label} on today's cut ({os.path.relpath(Path(a.parts).resolve(), P)} version {tm.version}: "
                       "own CPU, per access DB and mapping CPU, x the at-load scale k_c of today's container, the order "
                       "path's cardinality term; mechanism parameters of the platform, RESULTS §5; middleware round 2's; "
                       "DESIGN.md AB32, AB64; approximate where RESULTS §9 says so). Load: C's realistic "
                       f"session workload (sessions.json), simulated with its `{PROFILE}` profile (AB3).")
        header += wrap("One saga notion (DESIGN.md AB35): each operation's transaction-bound writes are the steps "
                       "of a workflow (tx_<SEFF>, Workflow.transactional) with the event sagas' coordination options.")
        header += wrap("Effect steps (DESIGN.md AB37): every write of another class and every event reaction is an "
                       "effect step with the mechanisms in-transaction (co-located on one database server: the work only), "
                       "synchronous step or asynchronous message (each in its own transaction: the step form with the "
                       f"receiving envelope ({dom.envelope.label()}), the work and its commit)."
                       + (" Request overhead (parts v3 requestOverheadCpuMs) on each request's root resolver." if tm.version >= 3 else ""))
        header += wrap("Receiving envelopes (DESIGN.md AB56): a synchronous call across containers into a read, an "
                       "operation or a request field pays the callee's receiving envelope in its container "
                       f"(ReceivingEnvelope; {dom.envelope.label()}); within a container none."
                       + (" Where today's code makes such a call across services, the envelope measured inside the "
                          "callee's CPU is taken out of its work." if tm.version == 2 else ""))
        header += wrap("Structure (DESIGN.md AB33): joinCache as built (the provider's entity cache: CallSite."
                       "cachedService), per-site hit ratios and per-key staleness (CallSite.hitRatio, staleShare; "
                       f"{struct.hits_source}), latency-only waits (Latency; {struct.lat_source}).")
        # per execution of the carrier, which runs once per order (AB70): x its executions per order = the measured term
        card_note = lambda kind, x, ms: (f"order-path cardinality (ms per execution, before k_c): {kind} {x} {ms:+.3g}" +
                                         ("" if tm.order_executions(x) == 1.0 else
                                          f" (x {tm.order_executions(x):.4g} executions per order)"))
        notes += tm.flags + [card_note("app", x, ms) for x, ms in sorted(tm.card_cpu.items())] + \
            [card_note("DB", x, ms) for x, ms in sorted(tm.card_db.items())] + \
            [f"{x}: no campaign parts, A9's seed" for x in dom.reached if not tm.has(x)]
        if tm.version >= 3:
            roots = {k: r["plan"][0][0] for k, r in dom.requests.items()}
            un = tm.uncharged_overhead(roots)
            notes += [f"request overhead not charged (carried by a service other than the root resolver's): {k} "
                      f"{ms:.3g} ms" for k, ms in sorted(un.items())]
        if notes:
            header += ["", "Notes:"] + ["- " + n for n in notes]
        out.write_text(o.text(using, header, "\n" + usage))
        if not a.no_format:
            subprocess.run([sys.executable, str(TOOLS / "format_model.py"), "-i", str(out)], check=True)
        print(f"{out}: {len(o.objs)} objects, {len(o.links)} links; {st}")
        if not a.no_sync:
            # the copy sync (the unified project's layer-3 sync; the model still uses architecture.mm here), then
            # the domain and its trace (F16): the model switches to metamodel/domain.mm
            subprocess.run([sys.executable, str(TOOLS / "sync_model.py")] + (["--no-format"] if a.no_format else []) +
                           [str(out)], check=True, env=env)
            add_domain(dom, out, proj)
            if not a.no_format:
                subprocess.run([sys.executable, str(TOOLS / "format_model.py"), "-i", str(out)], check=True)
        shutil.copy2(out, dest)
        print(f"{os.path.relpath(dest, P)}: written")


if __name__ == "__main__":
    main()
