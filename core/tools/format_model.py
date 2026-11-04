#!/usr/bin/env python3
"""Normalise an mdeo model file (.m) to the layout of the committed models.

    format_model.py MODEL.m [-o OUT.m | -i]     format (to stdout, OUT, or in place)
    format_model.py --check A.m B.m              do A and B hold the same model up to renaming?

Formatting is semantics-preserving. Every run checks its own output: the formatted text is parsed
again and compared with the input as a canonical graph (objects, attribute values, links), with
the renaming applied. It also checks that every ordered list keeps its order, except the lists
the layout reorders on purpose (SEFF and scenario actions go in execution order; interfaces are
grouped with the component that provides them). Palladio's simulator does not depend on those.

Layout:
- decisions first, then PCM by root: repository, system, resource environment, allocation, usage
  model, monitoring;
- the repository per component: its interfaces, the component, one block per SEFF;
- section headers, every object followed by its outgoing links (containment first);
- generated names (aName_2, variableUsage_1, EMF ids) become paths: Order_createOrder_cpu;
- one attribute per line, `=` aligned; an object without attributes on one line;
- SEFF actions in execution order, the successor links as one chain at the end of the block.
"""

import argparse
import os
import re
import sys
from collections import defaultdict

WIDTH = 100
KEYWORDS = {"using", "true", "false", "null", "in", "out", "inout", "import", "class", "enum",
            "abstract", "extends", "view"}

# ---------------------------------------------------------------------------------------------
# Metamodel


class Metamodel:
    def __init__(self):
        self.supers = {}            # class -> [direct supers]
        self.abstract = set()
        # feature lookup: (class, feature) -> (assoc index, end 0|1)
        self.ends = {}
        # assoc: dict(op, cls=(c0, c1), feat=(f0, f1), many=(m0, m1))
        self.assocs = []

    def load(self, path, seen=None):
        seen = set() if seen is None else seen
        path = os.path.normpath(path)
        if path in seen:
            return
        seen.add(path)
        text = open(path, encoding="utf-8").read()
        text = re.sub(r"//[^\n]*", "", text)
        for m in re.finditer(r'^\s*import\s+"([^"]+)"', text, re.M):
            self.load(os.path.join(os.path.dirname(path), m.group(1)), seen)
        for m in re.finditer(r"^\s*(abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w\s,]+?))?\s*\{", text, re.M):
            name = m.group(2)
            self.supers[name] = [s.strip() for s in (m.group(3) or "").split(",") if s.strip()]
            if m.group(1):
                self.abstract.add(name)
        assoc_re = re.compile(
            r"^\s*(\w+)\.(\w+)(\[[^\]]*\])?\s*(\*-->|<-->|-->)\s*(\w+)(?:\.(\w+)(\[[^\]]*\])?)?\s*$", re.M)
        for m in assoc_re.finditer(text):
            c0, f0, mult0, op, c1, f1, mult1 = m.groups()
            idx = len(self.assocs)
            self.assocs.append(dict(op=op, cls=(c0, c1), feat=(f0, f1),
                                    many=(is_many(mult0), is_many(mult1))))
            self.ends[(c0, f0)] = (idx, 0)
            if f1:
                self.ends[(c1, f1)] = (idx, 1)

    def ancestors(self, cls):
        out, todo = [], [cls]
        while todo:
            c = todo.pop(0)
            if c in out:
                continue
            out.append(c)
            todo.extend(self.supers.get(c, []))
        return out

    def is_a(self, cls, sup):
        return sup in self.ancestors(cls)

    def end(self, cls, feat):
        for c in self.ancestors(cls):
            if (c, feat) in self.ends:
                return self.ends[(c, feat)]
        return None


def is_many(mult):
    return bool(mult) and ("*" in mult or re.search(r"\.\.\s*[2-9]", mult) is not None)


def metamodel_for(model_path, using):
    mm = Metamodel()
    mm.load(os.path.join(os.path.dirname(os.path.abspath(model_path)), using))
    return mm


# ---------------------------------------------------------------------------------------------
# Model text

TOKEN = re.compile(r"""
    (?P<ws>\s+)
  | (?P<comment>//[^\n]*)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<bq>`[^`]*`)
  | (?P<num>-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<arrow>--)
  | (?P<punct>[{}\[\]:.,=])
""", re.X)


def tokenize(text):
    pos, line, out = 0, 1, []
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m:
            raise SyntaxError(f"line {line}: cannot read {text[pos:pos + 20]!r}")
        kind = m.lastgroup
        val = m.group(kind)
        if kind == "bq":
            kind, val = "ident", val[1:-1]
        if kind != "ws":
            out.append((kind, val, line))
        line += m.group(0).count("\n")
        pos = m.end()
    out.append(("eof", "", line))
    return out


class Obj:
    def __init__(self, name, cls, index):
        self.name, self.cls, self.index = name, cls, index
        self.attrs = []          # [(key, value text)]
        self.comments = []       # comment lines above the object


class Link:
    def __init__(self, src, feat, tgt, index):
        self.src, self.feat, self.tgt, self.index = src, feat, tgt, index
        self.comments = []


class Model:
    def __init__(self):
        self.using = None
        self.header = []         # comments before the first object
        self.objs = {}           # name -> Obj (insertion order = declaration order)
        self.links = []


def is_generated_header(c):
    return c.startswith("// ═══") or c.startswith("// ──")


def parse_model(text):
    toks = tokenize(text)
    model = Model()
    i = 0
    pending = []

    def take_comments():
        nonlocal i
        cs = []
        while toks[i][0] == "comment":
            if not is_generated_header(toks[i][1]):
                cs.append(toks[i][1])
            i += 1
        return cs

    def expect(kind, val=None):
        nonlocal i
        t = toks[i]
        if t[0] != kind or (val is not None and t[1] != val):
            raise SyntaxError(f"line {t[2]}: expected {val or kind}, found {t[1]!r}")
        i += 1
        return t[1]

    def value():
        nonlocal i
        t = toks[i]
        if t[0] == "punct" and t[1] == "[":
            i += 1
            items = []
            while not (toks[i][0] == "punct" and toks[i][1] == "]"):
                items.append(value())
                if toks[i][0] == "punct" and toks[i][1] == ",":
                    i += 1
            i += 1
            return "[" + ", ".join(items) + "]"
        if t[0] in ("string", "num"):
            i += 1
            return t[1]
        if t[0] == "ident":
            i += 1
            v = t[1]
            if toks[i][0] == "punct" and toks[i][1] == ".":
                i += 1
                v += "." + expect("ident")
            return v
        raise SyntaxError(f"line {t[2]}: unexpected {t[1]!r}")

    first = True
    while True:
        cs = take_comments()
        t = toks[i]
        if t[0] == "eof":
            if first:
                model.header = cs
            pending = cs
            break
        if t[0] == "ident" and t[1] == "using":
            model.header += cs
            i += 1
            model.using = expect("string")[1:-1]
            continue
        if first:
            model.header += cs
            cs = []
            first = False
        name = expect("ident")
        if toks[i][1] == ":":
            i += 1
            cls = expect("ident")
            o = Obj(name, cls, len(model.objs))
            o.comments = cs
            if name in model.objs:
                raise SyntaxError(f"line {t[2]}: {name} is declared twice")
            model.objs[name] = o
            expect("punct", "{")
            while True:
                take_comments()
                if toks[i][1] == "}":
                    i += 1
                    break
                key = expect("ident")
                expect("punct", "=")
                o.attrs.append((key, value()))
        elif toks[i][1] == ".":
            i += 1
            feat = expect("ident")
            expect("arrow")
            tgt = expect("ident")
            ln = Link(name, feat, tgt, len(model.links))
            ln.comments = cs
            model.links.append(ln)
        else:
            raise SyntaxError(f"line {t[2]}: expected ':' or '.' after {name}")
    model.trailer = pending
    return model


# ---------------------------------------------------------------------------------------------
# Canonical graph


def canon_value(v):
    v = v.strip()
    if v.startswith("["):
        return tuple(canon_value(x) for x in split_list(v[1:-1]))
    if v.startswith('"'):
        return ("s", bytes(v[1:-1], "utf-8").decode("unicode_escape"))
    if re.fullmatch(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", v):
        return ("n", float(v))
    return ("e", v)


def split_list(s):
    out, depth, cur, q = [], 0, "", False
    for ch in s:
        if ch == '"' and not cur.endswith("\\"):
            q = not q
        if not q and ch == "," and depth == 0:
            out.append(cur)
            cur = ""
            continue
        cur += ch
    if cur.strip():
        out.append(cur)
    return out


class Graph:
    """Objects with classes and attributes, and links by association in canonical direction."""

    def __init__(self, model, mm):
        self.model, self.mm = model, mm
        self.cls = {n: o.cls for n, o in model.objs.items()}
        self.attrs = {n: {k: canon_value(v) for k, v in o.attrs} for n, o in model.objs.items()}
        self.edges = []          # (assoc, a, b, link)  a on end 0, b on end 1
        problems = []
        for ln in model.links:
            if ln.src not in model.objs or ln.tgt not in model.objs:
                problems.append(f"link {ln.src}.{ln.feat} -- {ln.tgt}: unknown object")
                continue
            e = mm.end(model.objs[ln.src].cls, ln.feat)
            if e is None:
                problems.append(f"link {ln.src}.{ln.feat}: {model.objs[ln.src].cls} has no {ln.feat}")
                continue
            a, end = e
            pair = (ln.src, ln.tgt) if end == 0 else (ln.tgt, ln.src)
            self.edges.append((a, pair[0], pair[1], ln))
        if problems:
            raise ValueError("; ".join(problems[:5]))
        # a set: the same link may be written from both ends
        seen, uniq = set(), []
        for e in self.edges:
            if (e[0], e[1], e[2]) not in seen:
                seen.add((e[0], e[1], e[2]))
                uniq.append(e)
        self.edges = uniq
        self.parent = {}
        self.children = defaultdict(list)       # parent -> [(feat, child)] in declaration order
        for a, x, y, _ in self.edges:
            if mm.assocs[a]["op"] == "*-->":
                self.parent[y] = (x, a)
        idx = {n: o.index for n, o in model.objs.items()}
        for y, (x, a) in sorted(self.parent.items(), key=lambda kv: idx[kv[0]]):
            self.children[x].append((a, y))

    def out(self, name):
        return [(a, y) for a, x, y, _ in self.edges if x == name]

    def key(self, rename=lambda n: n):
        objs = {(rename(n), self.cls[n], tuple(sorted(self.attrs[n].items()))) for n in self.cls}
        edges = {(a, rename(x), rename(y)) for a, x, y, _ in self.edges}
        return objs, edges


# ---------------------------------------------------------------------------------------------
# Names

JUNK_ID = re.compile(r"^_[A-Za-z0-9_-]{12,}$")


def lower_first(s):
    return s[:1].lower() + s[1:]


def is_junk(name, mm):
    if "aName" in name or JUNK_ID.match(name) or not ident_ok(name):
        return True
    m = re.fullmatch(r"([a-z][A-Za-z]*?)(?:_\d+)?", name)
    if m and any(lower_first(c) == m.group(1) for c in mm.supers):
        return True
    return False


def words(s):
    s = re.sub(r"<[^>]*>", " ", s or "")
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    return [w for w in re.split(r"[^A-Za-z0-9]+", s) if w]


def upper_camel(s):
    return "".join(w[:1].upper() + w[1:] for w in words(s))


def lower_camel(s):
    ws = words(s)
    if not ws:
        return ""
    first = ws[0].lower() if ws[0].isupper() else lower_first(ws[0])
    return first + "".join(w[:1].upper() + w[1:].lower() if w.isupper() else w[:1].upper() + w[1:]
                           for w in ws[1:])


def ident_ok(s):
    # the mdeo lexer: a name starts with a letter
    return bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", s)) and s not in KEYWORDS


def entity(attrs):
    v = attrs.get("entityName")
    if v and v[0] == "s" and v[1] and "aName" not in v[1]:
        return v[1]
    return None


RESOURCE_SHORT = {"CPU": "cpu", "HDD": "hdd", "DELAY": "delay"}


METRIC_SHORT = {"RESPONSE_TIME": "rt", "STATE_OF_ACTIVE_RESOURCE": "state", "UTILIZATION_OF_ACTIVE_RESOURCE": "util",
                "STATE_OF_PASSIVE_RESOURCE": "passive", "HOLDING_TIME": "holding", "WAITING_TIME": "waiting"}
MP_TARGETS = ["usageScenario", "entryLevelSystemCall", "externalCall", "activeResource", "passiveResource",
              "operationSignature", "assembly", "resourceContainer", "linkingResource", "subsystem", "system",
              "resourceEnvironment"]
# classes named after their entity name (renamed only when the name is generated junk)
ENTITY_NAMED = ["Repository", "Interface", "RepositoryComponent", "DataType", "System", "AssemblyContext",
                "ResourceEnvironment", "ResourceContainer", "LinkingResource", "Allocation", "UsageModel",
                "UsageScenario", "MonitorRepository", "MeasuringPointRepository"]


class Namer:
    """Derived names. Objects of the classes in ENTITY_NAMED keep a readable name and get their
    sanitised entityName when the name is junk. Every other Palladio object gets its path: the
    name of its owner, then a local part (Order_createOrder_cpu). Objects of other metamodels
    (the decisions) keep their names unless they are junk."""

    def __init__(self, g, pcm_classes):
        self.g, self.mm, self.pcm = g, g.mm, pcm_classes
        self.final = {}
        self.used = set()

    def is_a(self, n, c):
        return self.mm.is_a(self.g.cls[n], c)

    def target(self, n, feat):
        for a, y in self.g.out(n):
            if self.mm.assocs[a]["feat"][0] == feat:
                return y
        return None

    def name_of(self, n):
        return self.final.get(n, n)

    def entity_name(self, n):
        return entity(self.g.attrs[n]) if n else None

    def prefix(self, parent):
        """The path prefix children of `parent` use: a behaviour passes on its owner's path."""
        if parent is None:
            return None
        if (self.is_a(parent, "ResourceDemandingBehaviour") and not self.is_a(parent, "ResourceDemandingSEFF")) \
                or self.is_a(parent, "ScenarioBehaviour"):
            up = self.g.parent.get(parent)
            if up:
                return self.name_of(up[0])
        return self.name_of(parent)

    def local(self, n, parent, feat):
        """('entity' | 'path' | 'keep', base name)."""
        cls = self.g.cls[n]
        if cls not in self.pcm:
            return "keep", lower_first(cls)
        en = self.entity_name(n)
        isa = lambda c: self.is_a(n, c)
        P = self.prefix(parent)
        attrs = self.g.attrs[n]
        sub = lambda s: ("path", f"{P}_{s}" if P else s)
        if any(isa(c) for c in ENTITY_NAMED):
            if isa("UsageModel"):
                return "entity", "usage"
            return "entity", upper_camel(en) if en else lower_first(cls)
        if isa("Signature"):
            return sub(lower_camel(en) if en else "op")
        if isa("Parameter"):
            pn = attrs.get("parameterName")
            return sub(lower_camel(pn[1]) if pn else "param")
        if isa("ProvidedRole") or isa("RequiredRole"):
            iface = self.target(n, "providedInterface") or self.target(n, "requiredInterface")
            kind = "provides" if isa("ProvidedRole") else "requires"
            return sub(f"{kind}_{self.name_of(iface)}" if iface else kind)
        if isa("ServiceEffectSpecification"):
            sn = self.entity_name(self.target(n, "describedService"))
            return sub(lower_camel(sn) if sn else "seff")
        if isa("PassiveResource"):
            return sub(lower_camel(en) if en else "passive")
        if isa("StartAction") or isa("Start"):
            return sub("start")
        if isa("StopAction") or isa("Stop"):
            return sub("stop")
        if isa("ExternalCallAction") and en and en.lower() not in ("externalcallaction", "call", "action"):
            return sub(lower_camel(en))
        if isa("ExternalCallAction") or isa("EntryLevelSystemCall"):
            sn = self.entity_name(self.target(n, "calledService") or self.target(n, "operationSignature"))
            return sub("call" + upper_camel(sn) if sn else "call")
        if isa("InternalAction"):
            if en and en.lower() not in ("start", "stop", "internal", "internalaction", "action"):
                return sub(lower_camel(en))
            res = [self.g.attrs[d].get("requiredResource") for _, d in self.g.children[n]]
            res = [RESOURCE_SHORT.get(r[1].split(".")[-1], "work") for r in res if r]
            return sub(res[0] if len(res) == 1 else "work")
        if isa("AbstractAction") or isa("AbstractUserAction"):
            default = {"BranchAction": "branch", "Branch": "branch", "LoopAction": "loop", "Loop": "loop",
                       "ForkAction": "fork", "CollectionIteratorAction": "iterate", "SetVariableAction": "set",
                       "AcquireAction": "acquire", "ReleaseAction": "release", "Delay": "delay"}.get(cls, lower_first(cls))
            return sub(lower_camel(en) if en else default)
        if isa("AbstractBranchTransition") or isa("BranchTransition"):
            sibs = [c for _, c in self.g.children[parent]] if parent else [n]
            return sub(lower_camel(en) if en else f"case{sibs.index(n) + 1}")
        if isa("ForkedBehaviour"):
            sibs = [c for _, c in self.g.children[parent]] if parent else [n]
            return sub(f"forked{sibs.index(n) + 1}")
        if isa("SynchronisationPoint"):
            return sub("join")
        if isa("ResourceDemandingSEFF"):
            return sub("seff")
        if isa("ResourceDemandingBehaviour") or isa("ScenarioBehaviour"):
            if parent and self.is_a(parent, "UsageScenario"):
                return sub("behaviour")
            return sub("body")
        if isa("ParametricResourceDemand"):
            sibs = [c for _, c in self.g.children[parent]] if parent else [n]
            r = attrs.get("requiredResource")
            if len(sibs) > 1 and r:
                return sub(RESOURCE_SHORT.get(r[1].split(".")[-1], "demand"))
            return sub("demand")
        if isa("VariableUsage"):
            ref = attrs.get("namedReference")
            refn = "_".join(lower_camel(p) or p for p in ref[1].split(".")) if ref else "var"
            pre = {"returnVariableUsage": "out_", "outputParameterUsages": "out_",
                   "componentParameterUsage": "param_", "configParameterUsages": "config_"}.get(feat, "")
            return sub(pre + refn)
        if isa("VariableCharacterisation"):
            t = attrs.get("type")
            return sub(t[1].split(".")[-1].lower() if t else "value")
        if isa("AssemblyConnector"):
            a, b = self.target(n, "requiringAssemblyContext"), self.target(n, "providingAssemblyContext")
            if a and b:
                return "path", f"{self.name_of(a)}_to_{self.name_of(b)}"
        if isa("Connector"):
            inner = self.target(n, "innerProvidedRole") or self.target(n, "innerRequiredRole")
            if inner:
                return "path", f"delegate_{self.name_of(inner)}"
            return "entity", upper_camel(en) if en else lower_first(cls)
        if isa("ProcessingResourceSpecification"):
            r = attrs.get("activeResourceType")
            return sub(RESOURCE_SHORT.get(r[1].split(".")[-1], "resource") if r else "resource")
        if isa("CommunicationLinkResourceSpecification"):
            return sub("spec")
        if isa("AllocationContext"):
            ac = self.target(n, "assemblyContext")
            return "path", (f"alloc_{self.name_of(ac)}" if ac else "alloc")
        if isa("Workload"):
            return sub("workload")
        if isa("MeasuringPoint"):
            return "path", "mp_" + self.measured(n)
        if isa("Monitor"):
            mp = self.target(n, "measuringPoint")
            metric = None
            for _, spec in self.g.children[n]:
                m = self.g.attrs[spec].get("metricDescription")
                if m:
                    metric = m[1].split(".")[-1]
                    break
            short = METRIC_SHORT.get(metric, lower_camel(metric or "monitor"))
            return "path", f"{short}_{self.measured(mp)}" if mp else short
        if isa("MeasurementSpecification"):
            return sub("spec")
        if isa("ProcessingType") or isa("StatisticalCharacterization"):
            return sub(lower_first(cls))
        return sub(lower_first(cls)) if P else ("path", lower_first(cls))

    def measured(self, mp):
        outs = {self.mm.assocs[a]["feat"][0]: y for a, y in self.g.out(mp)}
        for f in MP_TARGETS:
            if f in outs:
                return self.name_of(outs[f])
        return "point"

    def claim(self, base):
        cand, k = base, 2
        while cand in self.used or not ident_ok(cand):
            cand = f"{base}_{k}"
            k += 1
        self.used.add(cand)
        return cand

    def run(self, order):
        g = self.g
        plan = {}
        for n in order:
            par = g.parent.get(n)
            parent, a = par if par else (None, None)
            feat = self.mm.assocs[a]["feat"][0] if a is not None else None
            plan[n] = (parent, feat)
        # names that stay
        for n in order:
            mode, _ = self.local(n, plan[n][0], plan[n][1])
            if mode in ("keep", "entity") and not is_junk(n, self.mm):
                self.final[n] = n
                self.used.add(n)
        # Interfaces, components, assemblies and containers first: other names refer to them.
        prio = lambda n: 0 if any(self.is_a(n, c) for c in ("Interface", "RepositoryComponent",
                                                              "AssemblyContext", "ResourceContainer")) else 1
        pending = sorted((n for n in order if n not in self.final), key=lambda n: (prio(n), order.index(n)))
        for n in pending:
            mode, base = self.local(n, plan[n][0], plan[n][1])
            self.final[n] = self.claim(base or lower_first(g.cls[n]))
        return self.final


# ---------------------------------------------------------------------------------------------
# Layout

ROOT_ORDER = ["ArchitectureDecisions", "Repository", "System", "ResourceEnvironment",
              "Allocation", "UsageModel", "MonitorRepository", "MeasuringPointRepository"]
SECTION_TITLE = {"ArchitectureDecisions": "Architecture decisions",
                 "Repository": "Repository", "System": "System", "ResourceEnvironment": "Resource environment",
                 "Allocation": "Allocation", "UsageModel": "Usage model", "MonitorRepository": "Monitoring",
                 "MeasuringPointRepository": "Measuring points"}
# lists the layout reorders on purpose (the simulator does not depend on their order)
REORDERED = {("ResourceDemandingBehaviour", "steps"), ("ScenarioBehaviour", "actions"), ("Repository", "interfaces"),
             # the copy sync's trace and the completions: sets, read in name order
             ("CopyFeed", "deliveries"), ("ArchitectureDecisions", "feedNotifications"), ("ArchitectureDecisions", "copyStores"),
             ("ArchitectureDecisions", "work"), ("ArchitectureDecisions", "redirects"),
             ("ArchitectureDecisions", "notifications"), ("ArchitectureDecisions", "colocations"),
             ("Notification", "deliveries")}


def h1(title):
    s = f"// ═══ {title} "
    return s + "═" * max(3, WIDTH - len(s))


def h2(title):
    s = f"// ── {title} "
    return s + "─" * max(3, WIDTH - len(s))


class Layout:
    def __init__(self, g):
        self.g, self.mm = g, g.mm
        self.order = []          # objects in output order
        self.blocks = []         # ("h1"/"h2", title) | ("obj", name) | ("chain", [names])
        self.done = set()

    def is_a(self, n, c):
        return self.mm.is_a(self.g.cls[n], c)

    def root_rank(self, n):
        for i, c in enumerate(ROOT_ORDER):
            if self.is_a(n, c):
                return i
        pcm = self.g.cls[n] in self.pcm_classes
        return -1 if not pcm else len(ROOT_ORDER)

    def behaviour_order(self, beh):
        steps = [c for _, c in self.g.children[beh]]
        succ = {}
        for a, x, y, _ in self.g.edges:
            fa = self.mm.assocs[a]["feat"]
            if "successor" in fa:
                if fa[0] == "successor":
                    succ[x] = y
                else:
                    succ[y] = x
        starts = [s for s in steps if self.is_a(s, "StartAction") or self.is_a(s, "Start")]
        ordered, seen = [], set()
        cur = starts[0] if starts else None
        while cur is not None and cur in steps and cur not in seen:
            ordered.append(cur)
            seen.add(cur)
            cur = succ.get(cur)
        chain = list(ordered)
        ordered += [s for s in steps if s not in seen]
        return ordered, chain, succ

    def emit(self, n, header=None):
        if n in self.done:
            return
        if header:
            self.blocks.append(("h2", header))
        self.done.add(n)
        self.order.append(n)
        self.blocks.append(("obj", n))
        kids = self.g.children[n]
        beh = self.is_a(n, "ResourceDemandingBehaviour") or self.is_a(n, "ScenarioBehaviour")
        if beh:
            ordered, chain, _ = self.behaviour_order(n)
            for s in ordered:
                self.emit(s)
            for _, c in kids:
                if c not in ordered:
                    self.emit(c)
            if len(chain) > 1:
                self.blocks.append(("chain", chain))
            return
        for _, c in kids:
            self.emit(c, self.sub_header(n, c))

    def sub_header(self, parent, child):
        if self.is_a(parent, "RepositoryComponent") and self.is_a(child, "ServiceEffectSpecification"):
            sig = None
            for a, y in self.g.out(child):
                if self.mm.assocs[a]["feat"][0] == "describedService":
                    sig = y
            sn = entity(self.g.attrs[sig]) if sig else None
            return f"{self.label(parent)} · {sn or 'SEFF'}"
        if self.is_a(child, "UsageScenario") or self.is_a(child, "ResourceContainer") or \
                (self.is_a(child, "AssemblyContext") and False):
            return self.label(child)
        return None

    def label(self, n):
        return entity(self.g.attrs[n]) or n

    def repository(self, repo):
        self.done.add(repo)
        self.order.append(repo)
        self.blocks.append(("obj", repo))
        kids = [c for _, c in self.g.children[repo]]
        comps = [c for c in kids if self.is_a(c, "RepositoryComponent")]
        ifaces = [c for c in kids if self.is_a(c, "Interface")]
        rest = [c for c in kids if c not in comps and c not in ifaces]
        for comp in comps:
            provided = []
            for _, role in self.g.children[comp]:
                for a, y in self.g.out(role):
                    if self.mm.assocs[a]["feat"][0] == "providedInterface" and y in ifaces and y not in self.done:
                        provided.append(y)
            self.blocks.append(("h2", self.label(comp)))
            for i in provided:
                self.emit(i)
            self.emit(comp)
        left = [i for i in ifaces if i not in self.done] + rest
        if left:
            self.blocks.append(("h2", "Other interfaces and data types"))
            for c in left:
                self.emit(c)

    def run(self, pcm_classes):
        self.pcm_classes = pcm_classes
        g = self.g
        idx = {n: o.index for n, o in g.model.objs.items()}
        roots = [n for n in g.cls if n not in g.parent]
        roots.sort(key=lambda n: (self.root_rank(n), idx[n]))
        current = None
        for r in roots:
            rank = self.root_rank(r)
            title = SECTION_TITLE.get(ROOT_ORDER[rank]) if 0 <= rank < len(ROOT_ORDER) else \
                ("Decisions" if rank < 0 else "Other")
            if rank < 0:
                title = "Architecture decisions" if current is None else current
            if title != current:
                self.blocks.append(("h1", title))
                current = title
            if self.is_a(r, "Repository"):
                self.repository(r)
            else:
                self.emit(r)
        return self.order


def fmt_attrs(o):
    if not o.attrs:
        return None
    w = max(len(k) for k, _ in o.attrs)
    return [f"    {k.ljust(w)} = {v}" for k, v in o.attrs]


def q(name):
    return name if ident_ok(name) else f"`{name}`"


def wrap_comment(c):
    if len(c) <= WIDTH:
        return [c]
    body = c[2:].strip()
    out, cur = [], "//"
    for w in body.split():
        if len(cur) + 1 + len(w) > WIDTH and cur != "//":
            out.append(cur)
            cur = "//"
        cur += " " + w
    out.append(cur)
    return out


def render(model, g, layout, final):
    mm = g.mm
    lines = []
    for c in model.header:
        lines += wrap_comment(c)
    if model.using is not None:
        if lines:
            lines.append("")
        lines.append(f'using "{model.using}"')
    succ_assocs = {i for i, a in enumerate(mm.assocs) if "successor" in a["feat"]}
    # outgoing links of each object in canonical direction
    out = defaultdict(list)
    for a, x, y, ln in g.edges:
        if a in succ_assocs:
            continue
        out[x].append((a, y, ln))
    order_index = {n: i for i, n in enumerate(layout.order)}
    chained = set()
    for kind, val in layout.blocks:
        if kind == "chain":
            chained.update(zip(val, val[1:]))
    succ_edges = []
    for a, x, y, ln in g.edges:
        if a in succ_assocs:
            fa = mm.assocs[a]["feat"]
            pair = (x, y) if fa[0] == "successor" else (y, x)
            succ_edges.append(pair)
    loose_succ = [p for p in succ_edges if p not in chained]
    succ_feat = {}
    for i in succ_assocs:
        succ_feat[i] = "successor"
    for kind, val in layout.blocks:
        if kind == "h1":
            lines += ["", "", h1(val)]
            continue
        if kind == "h2":
            lines += ["", h2(val)]
            continue
        if kind == "chain":
            lines.append("")
            for x, y in zip(val, val[1:]):
                lines.append(f"{q(final[x])}.successor -- {q(final[y])}")
            continue
        n = val
        o = model.objs[n]
        lines.append("")
        for c in o.comments:
            lines += wrap_comment(c)
        attrs = fmt_attrs(o)
        head = f"{q(final[n])} : {o.cls}"
        if attrs is None:
            lines.append(head + " { }")
        else:
            lines.append(head + " {")
            lines += attrs
            lines.append("}")
        mine = out.get(n, [])
        contain = [(a, y, ln) for a, y, ln in mine if mm.assocs[a]["op"] == "*-->"]
        other = [(a, y, ln) for a, y, ln in mine if mm.assocs[a]["op"] != "*-->"]
        contain.sort(key=lambda t: order_index.get(t[1], 1 << 30))
        other.sort(key=lambda t: (t[2].index if t[2] else 0))
        for a, y, ln in contain + other:
            if ln is not None:
                for c in ln.comments:
                    lines += wrap_comment(c)
            lines.append(f"{q(final[n])}.{mm.assocs[a]['feat'][0]} -- {q(final[y])}")
        for x, y in loose_succ:
            if x == n:
                lines.append(f"{q(final[x])}.successor -- {q(final[y])}")
    for c in getattr(model, "trailer", []):
        lines += wrap_comment(c)
    # trim leading blank lines and collapse triple blanks
    text = "\n".join(lines).strip("\n") + "\n"
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text


# ---------------------------------------------------------------------------------------------
# Checks


def ordered_lists(g, order_of):
    """For every multi-valued association end with more than one target: the targets, sorted the
    way palladio-sim-service orders a list (by declaration order)."""
    mm = g.mm
    lists = defaultdict(list)
    for a, x, y, _ in g.edges:
        A = mm.assocs[a]
        if A["many"][0]:
            lists[(a, 0, x)].append(y)
        if A["feat"][1] and A["many"][1]:
            lists[(a, 1, y)].append(x)
    return {k: sorted(v, key=order_of) for k, v in lists.items() if len(v) > 1}


def self_check(model, g, final, text, mm):
    m2 = parse_model(text)
    g2 = Graph(m2, mm)
    k1 = g.key(lambda n: final[n])
    k2 = g2.key()
    if len(set(final.values())) != len(final):
        raise AssertionError("renaming is not one-to-one")
    if k1 != k2:
        o1, e1 = k1
        o2, e2 = k2
        diff = [f"object only before: {x}" for x in list(o1 - o2)[:3]] + \
               [f"object only after: {x}" for x in list(o2 - o1)[:3]] + \
               [f"link only before: {x}" for x in list(e1 - e2)[:3]] + \
               [f"link only after: {x}" for x in list(e2 - e1)[:3]]
        raise AssertionError("formatted model differs: " + "; ".join(diff))
    # order of ordered lists
    i1 = {n: o.index for n, o in model.objs.items()}
    i2 = {n: o.index for n, o in m2.objs.items()}
    l1 = ordered_lists(g, lambda n: i1[n])
    l2 = ordered_lists(g2, lambda n: i2[n])
    changed = []
    for (a, end, owner), items in l1.items():
        A = mm.assocs[a]
        if any(mm.is_a(g.cls[owner], c) and A["feat"][end] == f for c, f in REORDERED):
            continue
        if [final[x] for x in items] != l2.get((a, end, final[owner])):
            changed.append(f"{final[owner]}.{A['feat'][end]}")
    return changed


def wl_hash(g, rounds=4):
    """Colour refinement over the canonical graph: a name-free fingerprint of every object."""
    col = {n: hash((g.cls[n], tuple(sorted(g.attrs[n].items())))) for n in g.cls}
    for _ in range(rounds):
        nb = defaultdict(list)
        for a, x, y, _ in g.edges:
            nb[x].append((a, 0, col[y]))
            nb[y].append((a, 1, col[x]))
        col = {n: hash((col[n], tuple(sorted(nb[n])))) for n in g.cls}
    return sorted(col.values())


def load(path):
    text = open(path, encoding="utf-8").read()
    model = parse_model(text)
    if model.using is None:
        raise SystemExit(f"{path}: no `using` line")
    mm = metamodel_for(path, model.using)
    return model, Graph(model, mm), mm


def format_file(path):
    model, g, mm = load(path)
    pcm = set()
    here = os.path.dirname(os.path.abspath(path))
    # classes of the Palladio metamodel (anything imported by palladio.mm), to tell decisions apart
    pm = Metamodel()
    for cand in [os.path.join(os.path.dirname(os.path.join(here, model.using)), "palladio.mm")]:
        if os.path.exists(cand):
            pm.load(cand)
    pcm = set(pm.supers)
    layout = Layout(g)
    order = layout.run(pcm)
    leftovers = [n for n in g.cls if n not in layout.done]
    for n in leftovers:
        layout.emit(n)
    order = layout.order
    final = Namer(g, pcm).run(order)
    text = render(model, g, layout, final)
    changed = self_check(model, g, final, text, mm)
    return text, changed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("-o", "--output")
    ap.add_argument("-i", "--in-place", action="store_true")
    ap.add_argument("--check", action="store_true", help="compare two models up to renaming")
    args = ap.parse_args()
    if args.check:
        if len(args.files) != 2:
            ap.error("--check takes two files")
        (_, g1, _), (_, g2, _) = load(args.files[0]), load(args.files[1])
        same = len(g1.cls) == len(g2.cls) and len(g1.edges) == len(g2.edges) and wl_hash(g1) == wl_hash(g2)
        print(f"{'same model' if same else 'DIFFERENT'}: {len(g1.cls)}/{len(g2.cls)} objects, "
              f"{len(g1.edges)}/{len(g2.edges)} links")
        sys.exit(0 if same else 1)
    for f in args.files:
        text, changed = format_file(f)
        if changed:
            print(f"{f}: order of {len(changed)} list(s) changed: {', '.join(changed[:8])}", file=sys.stderr)
        if args.in_place:
            open(f, "w", encoding="utf-8").write(text)
        elif args.output:
            open(args.output, "w", encoding="utf-8").write(text)
        else:
            sys.stdout.write(text)


if __name__ == "__main__":
    main()
