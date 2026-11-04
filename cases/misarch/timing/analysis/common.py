"""Shared helpers of the timing analyses: window files, segments from hooks.json, a minimal YAML reader for
buckets.yaml (no PyYAML on this machine), cgroup CPU through calibration's CpuData (read-only reuse)."""
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TIMING = os.path.dirname(HERE)
ROOT = os.path.dirname(TIMING)                       # the case's root (cases/misarch: domain/, workload/, timing/)
REPO = os.path.dirname(os.path.dirname(ROOT))        # the repository root
RAW = os.environ.get("TIMING_RAW") or os.path.join(TIMING, "raw")
WINDOWS = os.path.join(RAW, "windows")
CAL_SCRIPTS = os.path.join(TIMING, "calibration", "scripts")
DOMAIN = os.environ.get("TIMING_DOMAIN") or os.path.join(ROOT, "domain", "misarch-domain.json")   # TIMING_DOMAIN: a
# window measured on other code is analysed with the domain of that code
PREFIX = "misarch-kotlin-"


def window_dir(w):
    return w if os.path.isdir(w) else os.path.join(WINDOWS, w)


def short(c):
    n = c[len(PREFIX):] if c.startswith(PREFIX) else c
    return n[:-2] if n.endswith("-1") else n


def segname(phase):
    return phase.replace(":", "_").replace("/", "_")


# --- minimal YAML: mappings, lists of mappings, lists of scalars, comments; enough for buckets.yaml -------------
def _scalar(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        return v


def load_yaml(path):
    lines = []
    with open(path) as fh:
        text = fh.read().splitlines(True)
    for raw in text:
        s = raw.split(" #")[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if s.strip():
            lines.append((len(s) - len(s.lstrip()), s.strip()))

    def block(i, ind):
        if lines[i][1].startswith("- "):
            out = []
            while i < len(lines) and lines[i][0] == ind and lines[i][1].startswith("- "):
                item = lines[i][1][2:]
                if re.match(r"^[A-Za-z_][\w-]*:( |$)", item):
                    # mapping item: re-indent the first key as part of the mapping
                    lines[i] = (ind + 2, item)
                    v, i = block(i, ind + 2)
                    out.append(v)
                else:
                    out.append(_scalar(item))
                    i += 1
            return out, i
        out = {}
        while i < len(lines) and lines[i][0] == ind and not lines[i][1].startswith("- "):
            k, _, v = lines[i][1].partition(":")
            i += 1
            if v.strip():
                out[k.strip()] = _scalar(v)
            elif i < len(lines) and lines[i][0] > ind:
                out[k.strip()], i = block(i, lines[i][0])
            elif i < len(lines) and lines[i][0] == ind and lines[i][1].startswith("- "):
                out[k.strip()], i = block(i, ind)
            else:
                out[k.strip()] = None
        return out, i
    v, _ = block(0, lines[0][0])
    return v


# --- window data ----------------------------------------------------------------------------------------------
def load_json(d, name, default=None):
    p = os.path.join(d, name)
    if not os.path.exists(p):
        return default
    return json.load(open(p))


def segments(d):
    """Instrumented segments of a window from hooks.json: {phase: {start, end}} with the times the hooks actually
    ran: start = when the reset/asprof start had completed, end = when the stop was requested."""
    h = load_json(d, "hooks.json", {"log": []})
    segs = {}
    for r in h["log"]:
        if r.get("kind") == "start":
            segs.setdefault(r["seg"], {})["start"] = r.get("tDone", r["tRequested"])
        elif r.get("kind") == "stop":
            segs.setdefault(r["seg"], {})["end"] = r["tRequested"]
            segs[r["seg"]]["pgDumpT"] = {c: v["t"] for c, v in (r.get("pgDump") or {}).items()}
    return {k: v for k, v in segs.items() if "start" in v and "end" in v}


def phases(d):
    meta = load_json(d, "meta.json")
    return {p["name"]: (p["start"], p["end"]) for p in meta["phases"]} if meta else {}


def requests_in(d, rtype, t0, t1, ok_only=False):
    import csv
    n = 0
    for r in csv.DictReader(open(os.path.join(d, "requests.csv"))):
        if r["type"] != rtype or not r["epoch_send"]:
            continue
        if t0 <= float(r["epoch_send"]) < t1 and (not ok_only or r["ok"] == "1"):
            n += 1
    return n


def seg_type(phase):
    """'product:steady' -> 'product'; 'product@5:steady' -> 'product'; factorial cells keep their name."""
    return phase.split(":")[0].split("@")[0]


SCHEDULED_WIDTH_S = 3     # a firing of payment's checkOpen* jobs (both at once) is a 2-s burst (approx3 windows)


def scheduled_jobs():
    """CpuData's masks for the domain's scheduled operations (trigger `schedule: "cron <spring cron> ..."`): per
    (service, cron) the app and DB containers of the service, masked for SCHEDULED_WIDTH_S at every firing."""
    jobs = {}
    for o in domain().get("operations", []):
        sch = (o.get("trigger") or {}).get("schedule") or ""
        if not sch.startswith("cron "):
            continue
        cron = " ".join(sch.split()[1:7])
        svc = o["id"].split(".")[0]
        j = jobs.setdefault((svc, cron), {"keys": [f"{PREFIX}{svc}-1", f"{PREFIX}{svc}-db-1"], "cron": cron,
                                          "widthS": SCHEDULED_WIDTH_S, "ops": []})
        j["ops"].append(o["id"])
    return list(jobs.values())


def firings_in_measured(d):
    """Firings of the domain's scheduled jobs inside the phases the analyses use (calibration/scripts/cronjobs.py
    guard_plan: idle, idle_end and each segment's pre/trans/warm phases up to steady; session plans: the steady
    phases), with the guard's margins: [(phase, firing epoch)]. Empty in a window run with --clear-cron (excluded by
    construction)."""
    if CAL_SCRIPTS not in sys.path:
        sys.path.insert(0, CAL_SCRIPTS)
    from cronjobs import GUARDED, cron_instants
    meta = load_json(d, "meta.json")
    if not meta:
        return []
    clear = (load_json(d, "hooks.json", {}) or {}).get("clear") or {}
    pre, post = clear.get("beforeS", 2), clear.get("afterS", 6)
    sessions = meta["plan"].get("kind") == "sessions"
    fire = sorted({f for c in {j["cron"] for j in scheduled_jobs()} for f in cron_instants(c, meta["t0"] - 60,
                                                                                           meta["t_end"] + 60)})
    out = []
    for p in meta["phases"]:
        kind = p["name"].rpartition(":")[2]
        used = kind == "steady" if sessions else (kind in GUARDED or p["name"] in ("idle", "idle_end"))
        if used and not p.get("hold"):
            out += [(p["name"], f) for f in fire if p["start"] - post < f < p["end"] + pre]
    return out


def cpu_data(d):
    os.environ.setdefault("MISARCH_STACK", "kotlin")
    if CAL_SCRIPTS not in sys.path:
        sys.path.insert(0, CAL_SCRIPTS)
    from cpuan import CpuData
    return CpuData(d, scheduled=scheduled_jobs())


def factorial_fits(fj):
    """The fits of factorial.json used downstream: its `primary` (README.md §3.6: OLS)."""
    return fj[fj["primary"]]


def domain():
    return json.load(open(DOMAIN))


def parts_operation(pj, o):
    """An operation's entry of a parts.json: `operations`, else `rareOperations`, else None."""
    return pj["operations"].get(o) or (pj.get("rareOperations") or {}).get(o)


def request_parts(e, t):
    """{ownCpuMs, accesses} of an operation's parts.json entry e per request of type t (README.md §3.5): its
    byRequest[t] (per execution) x executionsPerRequest (1 where the parts predate it); where t did not measure the
    operation, its means (per execution)."""
    br = e["byRequest"].get(t)
    if br is None:
        return {"ownCpuMs": e["ownCpuMs"], "accesses": e["accesses"]}
    x = br.get("executionsPerRequest", 1.0)
    if x == 1.0:
        return br
    sc = lambda v: None if v is None else v * x
    return {"ownCpuMs": br["ownCpuMs"] * x,
            "accesses": [{**a, **{f: sc(a.get(f)) for f in ("calls", "rows", "dbMs", "dbExecMs", "dbExecXkDbMs",
                                                             "mapCpuMs") if f in a}} for a in br["accesses"]]}


# --- the segment offset --------------------------------------------------------------------------------------------
# A segment's containers that did no work in it still show net CPU (steady rate - their idle baseline): a shift the
# segment shares across a role's containers (DB containers: sd 1.2 ms/s between segments, 0.5 within one; -2.1 to
# +3.5 ms/s), the same in the containers that worked (the off/on ratios of the touched DB containers 3.6x tighter
# with it removed, app 1.4x, dapr 1.2x; -ecs none, so it keeps its value). Per segment and role the median net rate
# of the containers of the services the segment does not touch is removed from every container of that role; a
# segment with fewer than OFFSET_MIN_UNTOUCHED such containers (a session mix) keeps its values.
# TIMING_SEGMENT_OFFSET=0: without it.
OFFSET_ROLES = {"app": "", "db": "-db", "dapr": "-dapr"}
OFFSET_MIN_UNTOUCHED = 3


def offset_enabled():
    return os.environ.get("TIMING_SEGMENT_OFFSET", "1") != "0"


def touched_services(mp, rtype):
    """The services a request type's operations (plan, calls, callbacks, follow-ups: queries.Mapping.request_ops) belong
    to; None for a type the mapping does not know (its segment keeps its values)."""
    ops = mp.request_ops(rtype)
    return {mp.ops[o]["service"] for o, _ in ops} if ops else None


def offset_role(c, services):
    """The role of container c (short name) whose segment offset applies to it (OFFSET_ROLES), else None."""
    for role, suf in OFFSET_ROLES.items():
        if c.endswith(suf) and c[:len(c) - len(suf)] in services:
            return role
    return None


def segment_offsets(net, touched, services):
    """{role: (cores, n)} of one segment: per role of OFFSET_ROLES the median net rate (cores, steady minus baseline)
    over the n containers of `services` not in `touched`; (0.0, n) with fewer than OFFSET_MIN_UNTOUCHED."""
    out = {}
    for role, suf in OFFSET_ROLES.items():
        v = [net[s + suf] for s in services if s not in touched and net.get(s + suf) is not None]
        out[role] = (statistics.median(v), len(v)) if len(v) >= OFFSET_MIN_UNTOUCHED else (0.0, len(v))
    return out
