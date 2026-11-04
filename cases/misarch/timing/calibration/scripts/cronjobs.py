"""Scheduled jobs of the stack (Spring cron) and the timing campaign's guard against them (timing/README.md §4.2):
a firing (payment's two open-payment checks, a ~2 s scan on payment and payment-db every quarter hour) must not fall into an interval an analysis uses. guard_plan marks those intervals in a plan, loadgen
holds (zero load) before a marked phase while clear_hold says a firing would overlap it."""


def _cron_field(f, v):
    """Does value v match one field of a Spring cron expression (`*`, `?`, `n`, `a,b`, `*/n`, `a-b`, `a-b/n`)?"""
    for part in f.split(","):
        rng, _, step = part.partition("/")
        step = int(step) if step else 1
        if rng in ("*", "?"):
            lo, hi = 0, 59
        elif "-" in rng:
            lo, hi = (int(x) for x in rng.split("-"))
        else:
            lo = hi = int(rng)
            if step > 1:
                hi = 59
        if lo <= v <= hi and (v - lo) % step == 0:
            return True
    return False


def cron_instants(spec, t0, t1):
    """Firing times (epoch s) in [t0, t1] of a 6-field Spring cron "sec min hour dom mon dow", evaluated in UTC
    (the containers' zone). Only sec, min and hour may be restricted; dom, mon and dow must be `*` or `?`."""
    import datetime
    f = spec.split()
    if len(f) != 6 or any(x not in ("*", "?") for x in f[3:]):
        raise ValueError(f"unsupported cron {spec!r}")
    out = []
    t = int(t0) // 60 * 60
    while t <= t1:
        d = datetime.datetime.fromtimestamp(t, datetime.timezone.utc)
        if _cron_field(f[2], d.hour) and _cron_field(f[1], d.minute):
            out += [t + s for s in range(60) if _cron_field(f[0], s) and t0 <= t + s <= t1]
        t += 60
    return out


GUARDED = ("pre", "trans", "warm", "steady")   # a segment's phases from its local baseline to the end of steady


def guard_plan(plan, crons, before_s, after_s):
    """Scheduled jobs excluded by construction (README.md §4.2): every interval the analyses use gets a
    "clear" guard (clear_hold, a zero-load hold before it while a firing would fall into it). Request plans:
    idle and idle_end (the window baseline) and per segment the run of pre/trans/warm phases up to and including
    steady (local baseline, steady segment), each guarded at its first phase. Session plans (block 7, load levels
    without pauses): one guard on the first phase over all steady phases, i.e. the plan starts when its firings fall
    into transitions."""
    ph = plan["phases"]
    clear = {"cron": list(crons), "beforeS": before_s, "afterS": after_s}
    if plan.get("kind") == "sessions":
        spans, t = [], 0
        for p in ph:
            if p["name"].endswith(":steady"):
                spans.append([t, t + p["duration"]])
            t += p["duration"]
        ph[0]["clear"] = dict(clear, spans=spans)
        return plan
    i = 0
    while i < len(ph):
        seg, _, kind = ph[i]["name"].rpartition(":")
        j = i + 1
        if kind in GUARDED:
            while j < len(ph) and ph[j]["name"].rpartition(":")[0] == seg and ph[j]["name"].rpartition(":")[2] in GUARDED:
                j += 1
        elif ph[i]["name"] not in ("idle", "idle_end"):
            i = j
            continue
        ph[i]["clear"] = dict(clear, spans=[[0, sum(p["duration"] for p in ph[i:j])]])
        i = j
    return plan


def clear_hold(ph, t):
    """Seconds to hold before phase ph (due at t) so that none of its guarded spans [t + a, t + b] (ph["clear"]:
    "spans" as offsets from ph's start, or one span of "spanS") overlaps a firing f of the "cron" specs, taken as
    [f - beforeS, f + afterS]: the smallest such delay. 0 for a phase without "clear"."""
    c = ph.get("clear")
    if not c:
        return 0.0
    spans = c.get("spans") or [[0, c["spanS"]]]
    pre, post = c["beforeS"], c["afterS"]
    end = max(b for _, b in spans)
    fire = sorted({x for spec in c["cron"] for x in cron_instants(spec, t - post, t + end + pre + 3600)})
    for h in sorted({0.0} | {f + post - t - a for f in fire for a, _ in spans if f + post - t - a > 0}):
        if not any(t + h + a - post < f < t + h + b + pre for f in fire for a, b in spans):
            return h
    raise RuntimeError(f"no free start within an hour for {ph['name']}")


def expected_hold(plan, crons, before_s=2, after_s=6, step_s=5):
    """Mean and maximum total hold of a plan over start times spread across one hour (for estimates)."""
    import copy
    p = guard_plan(copy.deepcopy(plan), crons, before_s, after_s)
    t00 = 3600 * 500000
    tot = []
    for off in range(0, 3600, step_s):
        t = h = t00 + off
        for ph in p["phases"]:
            while x := clear_hold(ph, t):
                t += x
            t += ph["duration"]
        tot.append(t - h - sum(x["duration"] for x in p["phases"]))
    return sum(tot) / len(tot), max(tot)
