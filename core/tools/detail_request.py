#!/usr/bin/env python3
"""The request of `palladio-sim-service detail` from the evaluation request that
transform/metrics.fn's (optimize/domain/detail.fn's) detailRequest() printed:

    detail_request.py MODEL.model.json EVAL.log [EXTRA.json|""] OUT.json

MODEL is the realised design (instance names), EVAL.log the harness evaluate log with the REQUEST
(key=value settings), PERCENTILE, GROUP, OVERRIDE, STEP and IGNOREFORKS lines (entity names), EXTRA the detail's own
fields (budgetsMs, histogramPerDecade, assemblyOperations, ...), which never override the evaluation's.
IGNOREFORKS <n>: metrics.fn::copyForks as the request's asyncIgnoreForks: the forks of
the RealisedNotifications whose Notification is a copy feed's (ArchitectureDecisions.feedNotifications);
ForkActions have no unique entity names, so the same rule is applied to
the model here and checked against the n the script found."""
import json
import sys

model, log, extra, out = sys.argv[1:5]
m = json.load(open(model))
inst = {i["name"]: i for i in m["instances"]}
ent = lambda i: i["properties"].get("entityName") or i["name"]
by_entity = {}
for i in m["instances"]:
    if i["className"] in ("ResourceContainer", "UsageScenario"):
        by_entity[(i["className"], ent(i))] = i["name"]
cpu_of = {}
for l in m["links"]:
    if l["sourceProperty"] == "activeResourceSpecifications":
        spec = inst.get(l["targetName"])
        if spec and (spec["properties"].get("activeResourceType") or {}).get("enum") == "CPU":
            cpu_of[ent(inst[l["sourceName"]])] = spec["name"]


def container(name):
    return by_entity[("ResourceContainer", name)]


req = json.loads(open(extra).read()) if extra else {}
groups, overrides, profile, percentiles, settings, ignore_n = [], [], [], [], None, None


def copy_forks():
    """metrics.fn::copyForks on the model data: the instance names of the copy-maintenance forks."""
    out = {}
    for l in m["links"]:
        out.setdefault((l["sourceName"], l["sourceProperty"]), []).append(l["targetName"])
    notes = set()
    for i in m["instances"]:
        if i["className"] in ("ArchitectureDecisions", "MicroserviceDecisions"):
            notes.update(out.get((i["name"], "feedNotifications"), []))
    forks = []
    for i in m["instances"]:
        if i["className"] == "RealisedNotification":
            n, f = out.get((i["name"], "notification"), []), out.get((i["name"], "fork"), [])
            if n and n[0] in notes and f and f[0] not in forks:
                forks.append(f[0])
    return forks


def value(v):
    if v in ("true", "false"):
        return v == "true"
    f = float(v)
    return int(f) if f.is_integer() and "." not in v else f


for line in open(log):
    w = line.split()
    if not w:
        continue
    if w[0] == "REQUEST":
        settings = {k: value(v) for k, v in (x.split("=", 1) for x in w[1:])}
    elif w[0] == "PERCENTILE":
        percentiles.append(float(w[1]))
    elif w[0] == "GROUP":
        c, mn, mx, target, initial, startup, down, cpu = w[1:9]
        g = dict(container=container(c), min=int(float(mn)), max=int(float(mx)), target=float(target),
                 initial=int(float(initial)), startupS=float(startup), cpuRequest=float(cpu))
        if float(down) >= 0:
            g["scaleDownS"] = float(down)
        groups.append(g)
    elif w[0] == "OVERRIDE":
        c, n, rate = w[1:4]
        overrides.append(dict(resource=cpu_of[c], replicas=int(float(n)), rate=float(rate)))
    elif w[0] == "IGNOREFORKS":
        ignore_n = int(w[1])
    elif w[0] == "STEP":
        sc, t, f = w[1:4]
        s = dict(timeS=float(t), factor=float(f))
        if sc != "*":
            s["scenario"] = by_entity[("UsageScenario", sc)]
        profile.append(s)
if settings is None:
    sys.exit(f"{log}: no REQUEST line (detail.fn::detailRequest did not run)")
for k in ("autoscaling", "sources"):
    req.pop(k, None)
req.update(settings, overrides=overrides, groups=groups, services=[], profile=profile, percentiles=percentiles)
if ignore_n is not None:
    forks = copy_forks()
    if len(forks) != ignore_n:
        sys.exit(f"{model}: {len(forks)} copy-maintenance forks, but metrics.fn's copyForks found {ignore_n}")
    req["asyncIgnoreForks"] = forks
json.dump(req, open(out, "w"))
print(f"request: {len(groups)} groups, {len(overrides)} overrides, {len(profile)} steps, percentiles {percentiles}, "
      f"window {settings['warmUpS']:g}-{settings['durationS']:g} s", file=sys.stderr)
