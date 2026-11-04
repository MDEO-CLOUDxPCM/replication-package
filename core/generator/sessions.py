#!/usr/bin/env python3
"""The session-model interpreter of the core (DESIGN.md C, AB52): a case's session usage model (its
sessions.json: requests with their operations, session classes as step lists of calls, think times,
fragments, loops and branches, workloads with mixes, load profiles with phases) read into expectations
(visits per request and session, think times, pages) and written as PCM text (a UsageModel with one
open-workload UsageScenario per session class, monitors per called request) and as SimOxide's
per-scenario load profile.

What a case calibrates (the design load, the rates of classes outside the mixes, the system's
provided role and signature of a request) is the case's own module, which imports this one
(cases/misarch/generator/gen_sessions.py: round 2's rates, the admin class, the login).
"""

import json
import re
import sys
from pathlib import Path


def load_model(path):
    return json.loads(Path(path).read_text())


# ---------------------------------------------------------------------------------------------
# expectations over a behaviour

def pmf_mean(spec):
    m = re.fullmatch(r"IntPMF\[(.*)\]", spec.replace(" ", ""))
    if not m:
        raise SystemExit(f"loop count {spec!r}: only IntPMF[...] is supported here")
    pairs = re.findall(r"\((-?\d+);([\d.eE-]+)\)", m.group(1))
    tot = sum(float(p) for _, p in pairs)
    return sum(int(v) * float(p) for v, p in pairs) / tot


def dist_mean(spec):
    s = spec.replace(" ", "")
    m = re.fullmatch(r"UniDouble\(([\d.]+),([\d.]+)\)", s)
    if m:
        return (float(m.group(1)) + float(m.group(2))) / 2
    m = re.fullmatch(r"Exp\(([\d.eE-]+)\)", s)
    if m:
        return 1.0 / float(m.group(1))
    return float(s)


def expect(model, steps):
    """(visits per operation, expected think time) of one run of `steps`."""
    visits, think = {}, 0.0

    def add(v, t, w):
        nonlocal think
        for k, x in v.items():
            visits[k] = visits.get(k, 0.0) + w * x
        think += w * t

    for st in steps:
        if "call" in st:
            add({st["call"]: 1.0}, 0.0, 1.0)
        elif "think" in st:
            add({}, dist_mean(model["think"][st["think"]]["dist"]), 1.0)
        elif "delay" in st:
            add({}, dist_mean(st["delay"]), 1.0)
        elif "use" in st:
            add(*expect(model, model["fragments"][st["use"]]["steps"]), 1.0)   # args do not change visits
        elif "loop" in st:
            add(*expect(model, st["body"]), pmf_mean(st["loop"]))
        elif "branch" in st:
            tot = sum(b["p"] for b in st["branch"])
            for b in st["branch"]:
                add(*expect(model, b["body"]), b["p"] / tot)
        else:
            raise SystemExit(f"unknown step {st}")
    return visits, think


def sample_pages(model, steps, rng, browse):
    """One random run of `steps`: its pages as lists of operations (a page ends at a think time
    other than `sub`; a login belongs to the page after it)."""
    pages, cur = [], []

    def run(steps):
        nonlocal cur
        for st in steps:
            if "call" in st:
                cur.append(st["call"])
            elif "think" in st or "delay" in st:
                if st.get("think") != "sub" and cur:
                    pages.append(cur)
                    cur = []
            elif "use" in st:
                run(model["fragments"][st["use"]]["steps"])
            elif "loop" in st:
                pairs = re.findall(r"\((-?\d+);([\d.eE-]+)\)", st["loop"])
                u, acc, n = rng.random() * sum(float(p) for _, p in pairs), 0.0, 0
                for v, p in pairs:
                    acc += float(p)
                    if u < acc:
                        n = int(v)
                        break
                for _ in range(n):
                    run(st["body"])
            elif "branch" in st:
                u, acc = rng.random() * sum(b["p"] for b in st["branch"]), 0.0
                for b in st["branch"]:
                    acc += b["p"]
                    if u < acc:
                        run(b["body"])
                        break

    run(steps)
    if cur:
        pages.append(cur)
    return pages


def page_shares(model, n=20000, seed=1):
    """Per class: expected pages per session and expected order pages per session (a page is an
    order page if it calls any operation that is not a browse operation), by sampling."""
    import random
    rng = random.Random(seed)
    browse = set(model["browseOperations"])
    out = {}
    for c, cl in model["classes"].items():
        pages = order = 0
        for _ in range(n):
            for pg in sample_pages(model, cl["steps"], rng, browse):
                pages += 1
                order += any(op not in browse for op in pg)
        out[c] = (pages / n, order / n)
    return out


def class_stats(model, name):
    v, t = expect(model, model["classes"][name]["steps"])
    return dict(visits=v, think=t, requests=sum(v.values()))


# ---------------------------------------------------------------------------------------------
# rates

def to_operations(model, rates):
    """Request rates -> rates per A operation (each request runs its plan once)."""
    out = {}
    for r, v in rates.items():
        for op in model["requests"][r]["operations"]:
            out[op] = out.get(op, 0.0) + v
    return out


# ---------------------------------------------------------------------------------------------
# outputs

def scenario_name(c):
    return f"session_{c}"


def loadprofile(model, profile):
    """SimOxide's load profile: per class scenario, factor = volume x share(mix) / share(base)."""
    w = model["workloads"]["realistic"]
    base = w["mixes"][w["baseMix"]]["shares"]
    norm = lambda sh: {c: v / sum(sh.values()) for c, v in sh.items()}
    base = norm(base)
    entries = []
    for c in base:
        pts = []
        for ph in model["profiles"][profile]["phases"]:
            sh = norm(w["mixes"][ph["mix"]]["shares"])
            pts.append([ph["from"], round(ph["volume"] * sh.get(c, 0.0) / base[c], 6)])
        if any(f <= 0 for _, f in pts):
            raise SystemExit(f"class {c}: a phase without it (factor 0) is not a SimOxide factor; give it a share")
        entries.append({"scenarios": [scenario_name(c)], "points": pts})
    return {"profiles": entries}


class Out:
    def __init__(self):
        self.lines = []

    def obj(self, name, cls, **attrs):
        if attrs:
            self.lines.append(f"{name} : {cls} {{")
            w = max(len(k) for k in attrs)
            for k, v in attrs.items():
                self.lines.append(f"    {k.ljust(w)} = {v}")
            self.lines.append("}")
        else:
            self.lines.append(f"{name} : {cls} {{ }}")
        return name

    def link(self, a, f, b):
        self.lines.append(f"{a}.{f} -- {b}")

    def comment(self, text):
        self.lines.append(f"// {text}")


def q(s):
    return json.dumps(s)


def resolve_param(model, v, args, overrides):
    """`${arg}` -> the fragment argument; `@name` -> a cardinality's value (or an override)."""
    v = str(v)
    for k, a in args.items():
        v = v.replace("${" + k + "}", str(a))
    if v.startswith("@"):
        name = v[1:]
        return str(overrides.get(name, model["cardinalities"][name]["value"]))
    return v


def usage_model(model, x, role_sig, system):
    """The usage model as mdeo model text lines: per session class of x["classes"] with a positive rate (sessions/s)
    an open-workload UsageScenario, its behaviour from the class's steps (EntryLevelSystemCalls through
    role_sig(model, request) -> (provided role, signature)), and per request of x["ops"] a response-time monitor
    at the system `system`."""
    o = Out()
    counter = {}

    def fresh(prefix):
        counter[prefix] = counter.get(prefix, 0) + 1
        return f"{prefix}_{counter[prefix]}"

    def behaviour(scen, steps, name, args=None, overrides=None):
        args, overrides = args or {}, overrides or {}
        b = o.obj(name, "ScenarioBehaviour", entityName=q(name))
        acts = [o.obj(fresh(f"{scen}_start"), "Start")]
        def emit(st):
            if "use" in st:
                a2 = {**args, **st.get("args", {})}
                o2 = {**overrides, **st.get("with", {})}
                for s in model["fragments"][st["use"]]["steps"]:
                    emit_with(s, a2, o2)
                return
            if "call" in st:
                role, sig = role_sig(model, st["call"])
                a = o.obj(fresh(f"{scen}_{st['call'].replace('.', '_').replace(':', '_').replace('/', '_')}"),
                          "EntryLevelSystemCall")
                o.link(a, "providedRole", role)
                o.link(a, "operationSignature", sig)
                for k, v in st.get("params", {}).items():
                    ref, kind = k.rsplit(".", 1)
                    u = o.obj(fresh(f"{scen}_param"), "VariableUsage", namedReference=q(ref))
                    c = o.obj(fresh(f"{scen}_char"), "VariableCharacterisation",
                              type=f"VariableCharacterisationType.{kind}",
                              specification=q(resolve_param(model, v, args, overrides)))
                    o.link(u, "variableCharacterisation", c)
                    o.link(a, "inputParameterUsages", u)
            elif "think" in st or "delay" in st:
                spec = model["think"][st["think"]]["dist"] if "think" in st else st["delay"]
                a = o.obj(fresh(f"{scen}_think"), "Delay", timeSpecification=q(spec))
            elif "loop" in st:
                a = o.obj(fresh(f"{scen}_loop"), "Loop", loopIteration=q(st["loop"]))
                body = behaviour(scen, st["body"], fresh(f"{scen}_loopBody"), args, overrides)
                o.link(a, "bodyBehaviour", body)
            elif "branch" in st:
                a = o.obj(fresh(f"{scen}_branch"), "Branch")
                for br in st["branch"]:
                    t = o.obj(fresh(f"{scen}_transition"), "BranchTransition", branchProbability=repr(float(br["p"])))
                    o.link(a, "branchTransitions", t)
                    body = behaviour(scen, br["body"], fresh(f"{scen}_branchBody"), args, overrides)
                    o.link(t, "branchedBehaviour", body)
            else:
                raise SystemExit(f"unknown step {st}")
            acts.append(a)

        def emit_with(st, a2, o2):
            nonlocal args, overrides
            saved = (args, overrides)
            args, overrides = a2, o2
            try:
                emit(st)
            finally:
                args, overrides = saved

        for st in steps:
            emit(st)
        acts.append(o.obj(fresh(f"{scen}_stop"), "Stop"))
        for a in acts:
            o.link(b, "actions", a)
        for a, c in zip(acts, acts[1:]):
            o.link(a, "successor", c)
        return b

    o.obj("usage", "UsageModel")
    for c, rate in x["classes"].items():
        if rate <= 0:
            continue
        scen = scenario_name(c)
        o.lines.append("")
        o.comment(f"{c}: {model['classes'][c]['about']}")
        o.comment(f"{rate:.4f} sessions/s (open, Poisson); {x['stats'][c]['requests']:.2f} requests per session")
        o.link("usage", "usageScenario", scen)
        o.obj(scen, "UsageScenario", entityName=q(scen))
        o.link(scen, "workload", f"{scen}_workload")
        o.obj(f"{scen}_workload", "OpenWorkload", interArrivalTime=q(f"Exp({rate:.10g})"))
        o.link(scen, "scenarioBehaviour", behaviour(scen, model["classes"][c]["steps"], f"{scen}_behaviour"))
    # per-operation response times: one SystemOperationMeasuringPoint per called operation (the
    # scenario's own response time now includes think times)
    o.lines.append("")
    o.obj("monitors", "MonitorRepository", entityName=q("monitors"))
    o.obj("points", "MeasuringPointRepository")
    for op in sorted(x["ops"]):
        role, sig = role_sig(model, op)
        ident = op.replace(".", "_").replace(":", "_").replace("/", "_")
        m, mp = f"rt_{ident}", f"mp_{ident}"
        o.link("monitors", "monitors", m)
        o.obj(m, "Monitor", entityName=q(f"RT {op}"), activated="true")
        o.link(m, "measuringPoint", mp)
        o.link(m, "measurementSpecifications", f"{m}_spec")
        o.obj(f"{m}_spec", "MeasurementSpecification", metricDescription="MetricDescription.RESPONSE_TIME",
              triggersSelfAdaptations="false")
        o.link(f"{m}_spec", "processingType", f"{m}_spec_feedThrough")
        o.obj(f"{m}_spec_feedThrough", "FeedThrough")
        o.link("points", "measuringPoints", mp)
        o.obj(mp, "SystemOperationMeasuringPoint")
        o.link(mp, "role", role)
        o.link(mp, "operationSignature", sig)
        o.link(mp, "system", system)
    return o.lines
