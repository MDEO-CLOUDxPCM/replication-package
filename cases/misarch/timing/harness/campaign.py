#!/usr/bin/env python3
"""Timing campaign driver (README.md §4): blocks 1-7 as measure.py windows (window.py), stack modes through
timing-up.sh, maintenance and warm-ups between windows. Called by timing/run_campaign.sh (run-fourth-pass.sh,
run-rerun.sh).

    campaign.py [--variant approx4] [--blocks 1,2,7,6,3,4b,5] [--dry-run] [--plans DIR]
                [--timing-tag TAG] [--mech-tag TAG] [--off-images IMAGES] [--reset CMD | --no-reset]
    campaign.py --smoke [--types product,createShoppingcartItem] [--steady 60]
    campaign.py --smoke3 [--types ...] [--burst-scale 0.1] [--smoke3-mech JSON]

Plans (timing/plans/gen_plans.py, loadgen.py's format): the manifests <plans>/pilot/manifest.json (block 1) and
<plans>/approx3/manifest.json (the other blocks; windows named approx4_<name>); warm-ups <plans>/warm/
{warm_all,warm_mix}.json, else calibration's plans/kotlin/. A block without manifest windows is skipped.

Blocks run grouped by stack mode, so the stack is recreated as rarely as possible (order 1, 2, 7, 6 off, 6 on, 3, 4b,
5: one stack-mode change per step):
    1 pilot (off, --pilot, no lock) | 2 off totals (off) | 7 at-load curve (off, session plans)
    6 mechanisms: local copies, response caches (today's topology, timing images with catalog/shipment/order from
      misarch-kotlin timing-mechanisms; switches per window, README.md §4.1), off then on
    3 on shares (on, sampler 0.1) | 4b cardinality (on, 0.1) | 5 latency (on, 0.1, block 3's JVMs)
Per window (README.md §4.2): the warm-up bursts of its cold types (bursts.py, <plans>/approx3/bursts.json), the data
reset (--reset, default $TIMING_RESET or timing/data/reset.sh; a missing script is a warning and a no-op), the Flyway
migrations the snapshot lacks (migrations.py), a re-burst if the reset restarted an app, prep, block 6's switches and
copies backfill, the warm-up, then the window with per-segment counters (--counters) in the instrumented blocks, Zipkin
cleared before every instrumented window and spans fetched in time slices (window.py, spans.py), and the domain's
scheduled jobs excluded by construction: window.py --clear-cron for every cron trigger in the domain model (payment's
checks every quarter hour), so no firing falls into an idle, pre, warm or steady phase (cronjobs.py).
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.dirname(HERE)
C = os.path.join(T, "calibration")
PY = f"{C}/.venv/bin/python"
RAW = os.environ.get("TIMING_RAW") or os.path.join(T, "raw")
LOG = os.path.join(RAW, "campaign.log")
PLAN_SET = {"approx4": "approx3"}   # variant (window prefix) -> its plans (<plans>/<set>/)
CLEAR = []                          # --clear-cron of every window (the domain's scheduled jobs)
LOCK = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(T))), "MEASURING.lock")   # the repository root (README.md; T = cases/misarch/timing)

# block -> (plan dir, stack mode, images, sampler, window.py flags, purpose)
BLOCKS = {
    "1": ("pilot", "off", "cut", None, ["--pilot"], "pilot: rates (5 %/25 % of the busiest limit), data preconditions"),
    "2": ("off", "off", "cut", None, [], "off totals: isolation, production config, mid rate"),
    "7": ("atload", "off", "cut", None, [], "at-load curve: session workload on today's cut"),
    "3": ("on", "on", "TIMING", "0.1", ["--profile", "--pgstat", "--spans"], "on shares: instrumented, mid rate"),
    "4b": ("cardinality", "on", "TIMING", "0.1", ["--profile", "--pgstat", "--spans"], "cardinality sweep, order path"),
    # block 5 at sampler 0.1: the same JVMs as blocks 3 and 4b (no restart, no second round of bursts)
    "5": ("latency", "on", "TIMING", "0.1", ["--pgstat", "--spans"], "composition (latency), sampler 0.1"),
    "6off": ("mech", "off", "MECH", None, [], "mechanisms (local copies, caches), off totals"),
    "6on": ("mech", "on", "MECH", "0.1", ["--profile", "--pgstat", "--spans"], "mechanisms (local copies, caches), on shares"),
}
ORDER = ["1", "2", "7", "6off", "6on", "3", "4b", "5"]   # off/cut, off/mech, on/mech, on/timing
BURST_PREP_S = 60                   # pools prep / stock top-up before a burst
REDIS_SETTLE_MAX_S = 180            # after a burst: until the Dapr streams have no pending entries
MIGRATIONS_S = 15
WINDOW_MIN_FREE_GB = float(os.environ.get("TIMING_WINDOW_MIN_FREE_GB", 10))   # measure.py itself refuses below 8
STACK_UP_S = 240                    # timing-up.sh up (recreate + health)
WARM_MIX_S = 600                    # once after every stack (re)start
WARM_S = 240 + 30                   # warm_all + maintain before each window
QUIET_S = 60                        # quiet check, lock reservation
GAP_S = 300                         # min gap between windows (warm-up runs inside it)
RESET_S = 60                        # data reset before every window (timing/data/reset.sh: ~28 s + checks)
MECH_SWITCH_S = 180                 # block 6: recreate order/catalog/shipment for a switch change, copies backfill


def log(msg):
    line = f"[{time.strftime('%F %T')}] {msg}"
    print(line, flush=True)
    os.makedirs(RAW, exist_ok=True)
    open(LOG, "a").write(line + "\n")


def manifest(plans, sub, prefix=None):
    """A manifest of gen_plans.py (timing/plans/<sub>/manifest.json): windows in run order with plan, config, block, prep, warm;
    window names <prefix>_<name> (prefix: sub)."""
    f = os.path.join(plans, sub, "manifest.json")
    if not os.path.exists(f):
        return []
    out = []
    for w in json.load(open(f))["windows"]:
        w = dict(w)
        w["planPath"] = os.path.join(plans, sub, w["plan"])
        w["warmPath"] = os.path.join(plans, sub, w["warm"]) if w.get("warm") else None
        w["block"] = str(w["block"])
        w["window"] = w["name"] if sub == "pilot" else f"{prefix or sub}_{w['name']}"
        out.append(w)
    return out


def plan_seconds(f):
    p = json.load(open(f))
    if p.get("kind") == "sessions":
        return sum(x.get("duration", 0) for x in p.get("phases", p.get("levels", []))) + p.get("settle", 0)
    return sum(x["duration"] for x in p["phases"]) + p.get("settle", 0)


def warm_plan(plans, name):
    f = os.path.join(plans, "warm", name)
    return f if os.path.exists(f) else os.path.join(C, "plans", "kotlin", name)


def block_of(b):
    return "6" if b.startswith("6") else b


def schedule(a):
    """[(block key, [window dicts], missing?)] in run order (grouped by stack mode). Windows come from the manifests
    (pilot + the variant's plans); a block without manifest windows is listed as missing (no windows) and skipped."""
    wins = manifest(a.plans, "pilot") + manifest(a.plans, PLAN_SET.get(a.variant, a.variant), a.variant)
    out = []
    for b in a.blocks:
        mode = BLOCKS[b][1]
        ws = [w for w in wins if w["block"] == block_of(b) and (not b.startswith("6") or w.get("config") == mode)]
        for w in ws:
            w["seconds"] = plan_seconds(w["planPath"])
        out.append((b, ws, not ws))
    return out


def dry_run(a):
    sch = schedule(a)
    mode = None
    prev_mech = {"localCopies": False, "entityCache": False, "cacheTtlS": 60}   # `up` starts with the switches off
    tot = tot_burst = 0
    table = burst_table(a)
    tab, warm_set = None, {}
    if table:
        import bursts
        tab = bursts.load(table)
        ahead = burst_lookahead(sch)
    print(f"variant {a.variant}; plans {a.plans}; off images {a.off_images}; timing images :{a.timing_tag}; "
          f"block 6 mechanism images :{a.mech_tag}")
    print(f"data reset before every window: {reset_desc(a)}")
    print(f"warm-up bursts: {table or 'off'}; counters: {'on (profiled windows)' if a.counters else 'off'}")
    print(f"scheduled jobs kept out of the measured phases: {', '.join(a.clear) or 'no'}")
    sys.path.insert(0, os.path.join(C, "scripts"))
    import cronjobs
    for b, wins, est in sch:
        for w in wins:
            if a.clear and w.get("planPath"):
                w["holdS"], w["holdMaxS"] = cronjobs.expected_hold(json.load(open(w["planPath"])), a.clear)
    print(f"{'block':6s} {'mode':22s} {'windows':>7s} {'measure':>9s} {'overhead':>9s} {'bursts':>7s} {'total':>8s}  plans")
    for b, wins, est in sch:
        sub, m, img, smp, flags, purpose = BLOCKS[b]
        if est:                             # run() skips it: no stack start, no windows
            print(f"{b:6s} {'':22s} {0:7d} {'':>9s} {'':>9s} {'':>7s} {'':>8s}  NO PLAN FILES (skipped)")
            continue
        key = (m, img, smp)
        over = burst = 0
        if key != mode:
            over += STACK_UP_S + WARM_MIX_S
            mode = key
            warm_set = {}                   # fresh JVMs
        meas = sum(w['seconds'] + w.get('holdS', 0) + 60 for w in wins)
        if b == "1":
            over += len(wins) * 10
        else:
            # reset, prep and warm-up run between two windows, inside the min gap
            over += len(wins) * (QUIET_S + max(WARM_S + (RESET_S if a.reset else 0), GAP_S))
        for w in wins:                      # block 6: recreating 3 apps for a switch change (+ copies backfill)
            if w.get("mechanisms") and w["mechanisms"] != prev_mech:
                over += MECH_SWITCH_S
                prev_mech = w["mechanisms"]
                warm_set = {t: v for t, v in warm_set.items() if not set(v) & {"order", "catalog", "shipment"}}
            if tab:
                cold = [t for t in ahead.get(w["window"], []) if tab["types"].get(t, {}).get("need") and t not in warm_set]
                if cold:
                    p = bursts.plan(tab, cold, scale=w.get("burstScale", 1.0))
                    w["burstS"] = p["durationS"] + BURST_PREP_S + 30
                    burst += w["burstS"]
                    for t in p["types"]:
                        warm_set[t] = tab["types"].get(t, {}).get("apps", [])
                over += MIGRATIONS_S
        tot += meas + over + burst
        tot_burst += burst
        print(f"{b:6s} {m + '/' + img.replace('TIMING', 'timing').replace('MECH', 'mech') + ('/' + smp if smp else ''):22s} {len(wins):7d} "
              f"{meas / 60:8.0f}m {over / 60:8.0f}m {burst / 60:6.0f}m {(meas + over + burst) / 3600:7.2f}h  "
              "manifest")
        for w in wins:
            print(f"         {w['window']:30s} {w['seconds'] / 60:5.1f} min"
                  f"{'  holds %.1f min (max %.1f)' % (w['holdS'] / 60, w['holdMaxS'] / 60) if 'holdS' in w else ''}"
                  f"{'  bursts %.1f min' % (w['burstS'] / 60) if w.get('burstS') else ''}"
                  f"{'  ' + mech_desc(w['mechanisms']) if w.get('mechanisms') else ''}")
    print(f"total machine time ~{tot / 3600:.1f} h, of which warm-up bursts {tot_burst / 3600:.2f} h")


def reset_desc(a):
    if not a.reset:
        return "off (--no-reset)"
    return f"{a.reset}" + ("" if reset_script(a) else "  (MISSING: warning + no-op at run time)")


def reset_script(a):
    """The reset command's script (first existing path among its words), or None."""
    return next((w for w in a.reset.split() if w.startswith("/") and os.path.exists(w)), None)


def data_reset(a, name):
    """The data reset (timing/data/), before the window's prep; a missing script is a warning, not an error."""
    if not a.reset:
        return False
    if not reset_script(a):
        log(f"WARNING: data reset {a.reset} does not exist - {name} runs without a reset")
        return False
    t0 = time.time()
    r = sh(["bash", "-c", a.reset], cwd=os.path.dirname(T), stdout=open(LOG, "a"), stderr=subprocess.STDOUT)
    log(f"data reset for {name}: rc={r.returncode}, {time.time() - t0:.0f} s")
    if r.returncode:
        sys.exit(f"data reset failed (rc={r.returncode}) before {name}")
    return True


# after a data reset (timing/data/README.md): no cart cleanup (it would delete the baseline's open carts),
# no restock, no shipment-method cleanup (pools and archived methods come from the baseline)
SKIP_AFTER_RESET = ("maintain.py", "run.py stock", "run.py cleanup")


def mech_desc(m):
    return (f"copies {'on' if m.get('localCopies') else 'off'}, cache {'on' if m.get('entityCache') else 'off'}"
            f"{' shared' if m.get('sharedCache') else ''}, caller cache {m.get('callerCache') or 'off'}"
            f" (ttl {m.get('cacheTtlS', 60)} s)")


def mech_switches(m, after_reset=False):
    """Block 6: the window's mechanism switches (recreates order/catalog/shipment only if one changes), and the
    copies filled from the source databases when they are on (outside the window, before the warm-up)."""
    args = [os.path.join(T, "timing-up.sh"), "mech", "--copies", "on" if m.get("localCopies") else "off",
            "--cache", "on" if m.get("entityCache") else "off", "--ttl", str(m.get("cacheTtlS", 60)),
            "--shared-cache", "on" if m.get("sharedCache") else "off", "--caller-cache", m.get("callerCache") or "off"]
    if after_reset and m.get("localCopies"):
        args.append("--recreate-order")     # the baseline snapshot has no V2__local_copies (LocalCopy*Entity): Flyway applies it at start
    if sh(args, stdout=open(LOG, "a"), stderr=subprocess.STDOUT).returncode:
        sys.exit("timing-up.sh mech failed")
    if m.get("localCopies"):
        r = sh([PY, os.path.join(HERE, "mech_backfill.py")], stdout=open(LOG, "a"), stderr=subprocess.STDOUT)
        if r.returncode:
            sys.exit("mech_backfill.py: copies incomplete")


# ---------------------------------------------------------------------------------------------------- warm-up bursts
PREP_POOLS = f"{PY} {T}/requests/run.py prep --n 400"
PREP_STOCK = f"{PY} {T}/requests/run.py stock"


def burst_table(a):
    f = os.path.join(a.plans, PLAN_SET.get(a.variant, a.variant), "bursts.json")
    return f if os.path.exists(f) else None


def _sum_key(x, keys):
    if isinstance(x, dict):
        return sum((v if k in keys and isinstance(v, (int, float)) else _sum_key(v, keys)) for k, v in x.items())
    if isinstance(x, list):
        return sum(_sum_key(v, keys) for v in x)
    return 0


def redis_settle(max_s=REDIS_SETTLE_MAX_S):
    """Seconds until no Dapr stream has pending or undelivered entries (the burst's async follow-ups are done), -1
    after max_s, None if redisq.py cannot report."""
    t0 = time.time()
    while True:
        r = subprocess.run([PY, os.path.join(C, "scripts", "redisq.py"), "report"], capture_output=True, text=True,
                           env=dict(os.environ, MISARCH_STACK="kotlin"))
        try:
            n = _sum_key(json.loads(r.stdout), ("pending", "lag"))
        except Exception:
            return None
        if n == 0:
            return round(time.time() - t0)
        if time.time() - t0 > max_s:
            log(f"redis: still {n} pending/undelivered entries after {max_s} s")
            return -1
        time.sleep(10)


def burst_lookahead(sch):
    """{window: burst types}: a window's own burstTypes plus those of the following windows that run in the same JVMs
    (same stack mode, same block-6 switches), so one packed burst before the first of them warms them all (the
    concurrent phases are shorter than one burst per window) and the later ones find their types warm."""
    flat = [(BLOCKS[b][1:4], json.dumps(w.get("mechanisms"), sort_keys=True), w) for b, wins, est in sch if not est
            for w in wins]
    out = {}
    for i, (key, mech, w) in enumerate(flat):
        types = list(w.get("burstTypes") or [])
        for key2, mech2, w2 in flat[i + 1:]:
            if key2 != key or mech2 != mech:
                break
            types += [t for t in (w2.get("burstTypes") or []) if t not in types]
        out[w["window"]] = types
    return out


def run_bursts(a, tab, ws, name, types, k, scale=1.0):
    """Bursts for the cold types among `types` (bursts.py), before the window's data reset. -> record for bursts.json"""
    import bursts
    import stackctl
    st = stackctl.starts()
    cold = ws.cold(tab, types, st)
    rec = {"round": k, "t": time.time(), "cold": cold}
    if not cold:
        log(f"{name}: all {len([t for t in types if tab['types'].get(t, {}).get('need')])} burst types warm")
        return rec
    p = bursts.plan(tab, cold, name=f"burst_{name}_{k}", scale=scale)
    for c in ([PREP_POOLS] if "return.createReturn" in p["types"] else []) + \
             ([PREP_STOCK] if any(t.startswith("fo") for t in p["types"]) else []):
        sh(["bash", "-c", c], cwd=T, stdout=open(LOG, "a"), stderr=subprocess.STDOUT)
    os.makedirs(os.path.join(RAW, "plans"), exist_ok=True)
    path = os.path.join(RAW, "plans", f"burst_{name}_{k}.json")
    json.dump(p, open(path, "w"), indent=1)
    log(f"{name}: burst {k} for {len(cold)} cold types ({', '.join(cold[:8])}{' ...' if len(cold) > 8 else ''}), "
        f"{len(p['phases']) - 1} phases, ~{p['durationS'] / 60:.1f} min")
    t0 = time.time()
    warm(path, f"burst_{name}_{k}")
    rec.update(seconds=round(time.time() - t0), planS=p["durationS"], plan=path, groups=p["groups"],
               redisSettleS=redis_settle())
    ws.mark(tab, [t for t in p["types"] if tab["types"].get(t, {}).get("need")], stackctl.starts())
    return rec


# migrations the data snapshot may lack because only the block-6 images have them; anything else missing after a reset
# means the snapshot predates the images: the pass stops (re-snapshot, data/README.md)
SNAPSHOT_MAY_LACK = {("order", "V2__local_copies.sql")}


def apply_migrations(name):
    import migrations
    try:
        chk = migrations.check()
        bad_snap = sorted((s, m["script"]) for s, v in chk.items() for m in v.get("missing", [])
                          if (s, m["script"]) not in SNAPSHOT_MAY_LACK)
        if bad_snap:
            sys.exit(f"the data snapshot lacks migrations of the running images: {bad_snap} - re-snapshot the "
                     f"baseline with these images (timing/data/reset.sh snapshot, data/README.md) before {name}")
        r, bad = migrations.apply()
    except Exception as e:
        log(f"{name}: migrations check failed: {e!r}")
        return {"error": repr(e)}
    if r:
        log(f"{name}: applied missing migrations after the reset: "
            + ", ".join(f"{s}:{x['script']}{'' if x['ok'] else ' FAILED'}" for s, xs in r.items() for x in xs))
    if bad:
        sys.exit(f"migrations failed before {name}: {r}")
    return r


def sh(args, **kw):
    log("$ " + " ".join(args))
    return subprocess.run(args, **kw)


def stack_mode(m, img, smp, a, purpose):
    images = {"TIMING": f"timing={a.timing_tag}" if a.timing_tag else "cut", "MECH": f"mech={a.mech_tag}",
              "cut": a.off_images}.get(img, img)
    if img == "MECH":
        os.environ["TIMING_IMAGES_TAG"] = a.timing_tag or "timing-20261101"
    args = [os.path.join(T, "timing-up.sh"), "up", "--mode", m, "--images", images, "--purpose", purpose]
    if smp:
        args += ["--sampler", smp]
    if sh(args).returncode:
        sys.exit("timing-up.sh up failed")


def maintain():
    sh([PY, os.path.join(C, "scripts", "maintain.py"), "--stack", "kotlin"], stdout=open(LOG, "a"),
       stderr=subprocess.STDOUT)


def warm(plan, name):
    while os.path.exists(LOCK):          # warm-ups are heavy work too: never during someone else's window
        time.sleep(15)
    runner = os.path.join(T, "requests", "run.py")
    out = os.path.join(RAW, "warm", f"{name}_{time.strftime('%H%M%S')}")
    if os.path.exists(runner):
        args = [PY, runner, "plan", "--plan", plan, "--out", out]
    else:
        args = [PY, os.path.join(C, "scripts", "loadgen.py"), "--stack", "kotlin", "--plan", plan, "--out", out]
    sh(args, stdout=open(LOG, "a"), stderr=subprocess.STDOUT)


def free_gb():
    st = os.statvfs("/")
    return st.f_bavail * st.f_frsize / 2**30


def scheduled_crons():
    """The Spring crons of the domain model's scheduled operations (analysis/common.py scheduled_jobs)."""
    sys.path.insert(0, os.path.join(T, "analysis"))
    import common
    return sorted({j["cron"] for j in common.scheduled_jobs()})


def window(name, plan, flags, purpose, extra=()):
    if free_gb() < WINDOW_MIN_FREE_GB:     # the stack itself (full profile + snapshot + reset copy) holds ~4 GB
        log(f"only {free_gb():.1f} GB free; stopping")
        sys.exit(4)
    # no speed gate and no speed bench (README.md §4.2: waiting for a "fast" regime selects the data and is a bigger
    # threat to validity than measuring through; the placement probe stays derivable from cpu.csv)
    args = [PY, os.path.join(HERE, "window.py"), "--name", name, "--plan", plan, "--purpose", purpose, "--no-speed"] \
        + [x for c in CLEAR for x in ("--clear-cron", c)] + flags + list(extra)
    r = sh(args, stdout=open(os.path.join(RAW, f"{name}.log"), "w"), stderr=subprocess.STDOUT)
    log(f"window {name}: rc={r.returncode}")
    return r.returncode


def run(a):
    mode = None
    sch = schedule(a)
    ahead = burst_lookahead(sch)
    tab = burst_table(a)
    if not tab:
        sys.exit(f"no burst table {os.path.join(a.plans, PLAN_SET.get(a.variant, a.variant), 'bursts.json')} "
                 "(plans/burst_table.py)")
    for b, wins, est in sch:
        if est:
            log(f"block {b}: no plan files in {a.plans} - skipped")
            continue
        sub, m, img, smp, flags, purpose = BLOCKS[b]
        if (m, img, smp) != mode:
            stack_mode(m, img, smp, a, f"timing block {b}")
            mode = (m, img, smp)
            if not (a.reset and reset_script(a)):   # with the data reset, every window starts from the baseline
                maintain()
            warm(warm_plan(a.plans, "warm_mix.json"), "warm_mix")
        for w in wins:
            name = w["window"]
            if os.path.exists(os.path.join(RAW, "windows", name, "window.json")):
                log(f"{name}: done already")
                continue
            run_window(a, b, w, name, flags, purpose, tab, ahead.get(name))
    log("campaign done")


def run_window(a, b, w, name, flags, purpose, table, ahead=None):
    """One window: switches -> bursts of the cold types -> data reset -> missing migrations -> re-burst if the reset
    restarted an app (once) -> prep -> copies backfill -> warm-up -> window."""
    import bursts
    import stackctl
    tab = bursts.load(table)
    ws = bursts.WarmState()
    recs = []
    if w.get("mechanisms"):        # a switch change recreates order/catalog/shipment: before the bursts, not after
        mech_switches(w["mechanisms"], False)
    types = w.get("burstTypes") or []
    scale = w.get("burstScale", 1.0)
    recs.append(run_bursts(a, tab, ws, name, ahead or types, 1, scale))
    was_reset = data_reset(a, name)
    mig = apply_migrations(name) if was_reset else None
    if was_reset:
        again = ws.cold(tab, types, stackctl.starts())
        if again:
            log(f"WARNING {name}: the reset restarted apps of {again}: re-burst and reset once more")
            recs.append(run_bursts(a, tab, ws, name, again, 2, scale))
            data_reset(a, name)
            mig = apply_migrations(name)
            left = ws.cold(tab, types, stackctl.starts())
            if left:
                log(f"WARNING {name}: still cold after the second reset: {left} (window flagged)")
                recs.append({"round": 3, "coldAtWindow": left})
    for c in w.get("prep") or []:
        if was_reset and any(x in c for x in SKIP_AFTER_RESET):
            continue
        sh(["bash", "-c", c], cwd=T, stdout=open(LOG, "a"), stderr=subprocess.STDOUT)
    if w.get("mechanisms"):        # unchanged switches: only the copies backfill (order's V2 came from migrations.py)
        mech_switches(w["mechanisms"], False)
    d = os.path.join(RAW, "windows", name)
    os.makedirs(d, exist_ok=True)
    json.dump({"bursts": recs, "migrations": mig, "table": table, "starts": stackctl.starts(),
               "coldAtWindow": ws.cold(tab, types, stackctl.starts())}, open(os.path.join(d, "bursts.json"), "w"),
              indent=1)
    if b != "1":                   # the pilot (block 1) runs without a warm-up
        warm(w.get("warmPath") or warm_plan(a.plans, "warm_all.json"), "warm")
    extra = (["--cache-counts"] if w.get("mechanisms") else []) + (["--counters"] if a.counters and "--profile" in flags
                                                                   else [])
    window(name, w["planPath"], flags + extra, f"{purpose} ({w['plan']})")


def smoke(a):
    """Functional end-to-end check (not a measurement): one off and one on window for a few request types,
    shortened phases, without bursts or data reset."""
    rates = {"product": 5.0, "createShoppingcartItem": 8.0, "products": 6.0, "users": 6.0}
    types = a.types.split(",")
    phases = [{"name": "idle", "duration": 30.0, "rates": {}}]
    for t in types:
        r = rates.get(t, 4.0)
        phases += [{"name": f"{t}:pre", "duration": 10.0, "rates": {}},
                   {"name": f"{t}:warm", "duration": 15.0, "rates": {t: r}},
                   {"name": f"{t}:steady", "duration": float(a.steady), "rates": {t: r}},
                   {"name": f"{t}:drain", "duration": 15.0, "rates": {}}]
    phases.append({"name": "idle_end", "duration": 15.0, "rates": {}})
    os.makedirs(os.path.join(RAW, "plans"), exist_ok=True)
    plan = os.path.join(RAW, "plans", "smoke.json")
    json.dump({"name": "timing_smoke", "phases": phases}, open(plan, "w"), indent=1)
    warmp = os.path.join(RAW, "plans", "smoke_warm.json")
    json.dump({"name": "timing_smoke_warm", "phases": [{"name": "warm", "duration": float(a.warm),
                                                         "rates": {t: rates.get(t, 4.0) for t in types}}]},
              open(warmp, "w"), indent=1)
    secs = sum(p["duration"] for p in phases)
    log(f"smoke: types {types}, window {secs:.0f}s")
    tag = a.tag or time.strftime("%m%d%H%M")
    for m in a.smoke_modes.split(","):
        img = f"timing={a.timing_tag}" if (m == "on" and a.timing_tag) else "cut"
        sh([os.path.join(T, "timing-up.sh"), "up", "--mode", m, "--images", img, "--purpose", f"smoke ({m})"])
        maintain()
        warm(warmp, "smoke_warm")
        flags = ["--profile", "--pgstat", "--spans"] if m == "on" else []
        if a.pilot:
            flags.append("--pilot")
        window(f"smoke_{tag}_{m}", plan, flags, f"smoke run ({m})", ["--min-gap-min", str(a.min_gap)])


def smoke3(a):
    """Functional run (not a measurement): one instrumented window for a few types with the whole flow of a window
    (run_window): warm-up bursts (scaled by --burst-scale), data reset, migrations, warm-up, counters, span polling."""
    a.counters = True
    table = burst_table(a)
    if not table:
        sys.exit("no plans/approx3/bursts.json")
    rates = json.load(open(os.path.join(a.plans, "rates.json")))["rates"]
    types = a.types.split(",")
    rate = lambda t: rates.get(t, rates.get(t.split(".hot")[0].split(".cold")[0], {})).get("mid", 4.0)  # noqa: E731
    phases = [{"name": "idle", "duration": 40.0, "rates": {}}]
    if "createOrder" in types:       # its carts, unmeasured (as in the block-6 windows)
        phases.append({"name": "createShoppingcartItem:fill", "duration": 30.0,
                       "rates": {"createShoppingcartItem": round(rate("createOrder") * (15 + a.steady) * 1.2 / 30 + 1, 3)}})
    for t in types:
        r = rate(t)
        phases += [{"name": f"{t}:pre", "duration": 10.0, "rates": {}},
                   {"name": f"{t}:warm", "duration": 15.0, "rates": {t: r}},
                   {"name": f"{t}:steady", "duration": float(a.steady), "rates": {t: r}},
                   {"name": f"{t}:drain", "duration": 15.0, "rates": {}}]
    phases.append({"name": "idle_end", "duration": 20.0, "rates": {}})
    os.makedirs(os.path.join(RAW, "plans"), exist_ok=True)
    plan = os.path.join(RAW, "plans", "smoke3.json")
    json.dump({"name": "timing_smoke3", "phases": phases}, open(plan, "w"), indent=1)
    warmp = os.path.join(RAW, "plans", "smoke3_warm.json")
    json.dump({"name": "timing_smoke3_warm", "phases": [{"name": "warm", "duration": float(a.warm),
               "rates": {t: round(rate(t) / 3, 3) for t in types
                         if t not in ("createOrder", "createOrder.hot")}}]}, open(warmp, "w"))
    tag = a.tag or time.strftime("%m%d%H%M")
    mech = json.loads(a.smoke3_mech) if a.smoke3_mech else None
    stack_mode("on", "MECH" if mech else "TIMING", "0.1", a, "smoke3")
    w = {"window": f"smoke3_{tag}", "plan": "smoke3.json", "planPath": plan, "warmPath": warmp, "burstTypes": types,
         "burstScale": a.burst_scale, "prep": []}
    if mech:
        w["mechanisms"] = mech
    run_window(a, "3", w, w["window"], ["--profile", "--pgstat", "--spans", "--min-gap-min", str(a.min_gap)],
               "smoke3 run", table)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="approx4", choices=list(PLAN_SET),
                    help="window prefix; its plans are <plans>/" + PLAN_SET["approx4"] + "/")
    ap.add_argument("--off-images", default=os.environ.get("TIMING_OFF_IMAGES", "cut"),
                    help="timing-up.sh --images of the off blocks 2 and 7 (run-fourth-pass.sh: timing=<cut tag>)")
    ap.add_argument("--no-counters", dest="counters", action="store_false",
                    help="no GET /timing/counters per segment in the profiled windows")
    ap.add_argument("--reset", default=os.environ.get("TIMING_RESET", "bash " + os.path.join(T, "data", "reset.sh")),
                    help="data reset command before every window (default $TIMING_RESET or timing/data/reset.sh)")
    ap.add_argument("--no-reset", dest="reset", action="store_const", const="")
    ap.add_argument("--blocks", default=",".join(ORDER))
    ap.add_argument("--plans", default=os.path.join(T, "plans"))
    ap.add_argument("--timing-tag", default="timing-20261101",
                    help="image tag of the instrumented build for the on blocks ('' = cut images)")
    ap.add_argument("--mech-tag", default="mech-20261101",
                    help="block 6: image tag of catalog, shipment, order (misarch-kotlin timing-mechanisms)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--smoke-modes", default="off,on")
    ap.add_argument("--smoke3", action="store_true", help="functional run of one window's whole flow (see smoke3)")
    ap.add_argument("--burst-scale", type=float, default=0.1, help="--smoke3: burst sizes x this")
    ap.add_argument("--smoke3-mech", default="", help="--smoke3 on the mechanisms images with these switches (JSON)")
    ap.add_argument("--types", default="product,createShoppingcartItem")
    ap.add_argument("--steady", type=float, default=60)
    ap.add_argument("--warm", type=float, default=90)
    ap.add_argument("--min-gap", type=float, default=5)
    ap.add_argument("--tag")
    ap.add_argument("--pilot", action="store_true", help="smoke: measure.py --pilot (no lock, no quiet wait)")
    a = ap.parse_args()
    a.blocks = [b for b in ORDER if b in a.blocks.split(",") or (b.startswith("6") and "6" in a.blocks.split(","))]
    a.clear = scheduled_crons()
    CLEAR[:] = a.clear
    if a.dry_run:
        return dry_run(a)
    if a.smoke3:
        return smoke3(a)
    if a.smoke:
        return smoke(a)
    return run(a)


if __name__ == "__main__":
    main()
