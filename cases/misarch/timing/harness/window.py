#!/usr/bin/env python3
"""One measurement window of the timing campaign: calibration/scripts/measure.py (MEASURING.lock protocol,
cpumon, validity) wrapped, not modified, plus the per-segment instrumentation hooks (README.md §2.3, §9).

Run with the calibration venv (aiohttp, redis):
    $PY window.py --name W --plan P.json [--purpose TEXT] [--profile] [--pgstat] [--spans] [--pilot]
                  [--interval 10ms] [--max-wait-min 240] [--min-gap-min 5]

- Output: $TIMING_RAW/windows/<W>/ (default timing/raw/windows): measure.py's files (requests.csv, meta.json,
  cpu.csv, host.csv, containers.json, window.json) plus volume_before.json, hooks.json, asprof/*.collapsed.gz,
  pgstat/<segment>.json, spans.json.gz.
- Request types: the ExtGen and session dispatch of timing/requests/run.py (install()) are installed when present, so
  plans may use all 36 request types; otherwise loadgen.py's 26.
- Hooks fire on loadgen phase changes (the generator's `phase` attribute; ExtGen inherits it):
    entering `<seg>:steady`  -> pg_stat_statements_reset() on every Postgres (--pgstat), asprof start (--profile);
                                and a pg_stat_database/pg_stat_wal snapshot (--pgstat) -> pgxact.json deltas
    leaving  `<seg>:steady`  -> asprof stop -> asprof/<seg>__<app>.collapsed, pg_stat_statements dump (--pgstat)
    entering/leaving `idle`  -> asprof start/stop only (the idle baseline of the buckets, §3.1)
  Every hook action is timestamped in hooks.json; analyses use those times, not the phase boundaries. A runner that
  A session plan ("kind": "sessions", sessiongen.py) gets one segment `run:steady` around the whole plan.
- --spans: Zipkin is cleared (restarted) before the window, and afterwards the spans are fetched in time slices
  (spans.py; spans_fetch.json says whether the fetch is complete).
- --cache-counts (block 6): the entity cache counters of catalog and shipment and order's caller-cache counters (stackctl cache-counts) at every
  segment start and end -> hooks.json and cache_counts.json (hits/misses per steady segment). They do not depend
  on the span fetch. volume_after.json (row counts after the window) is written for every window.
- Speed gate (off in the campaign: --no-speed, README.md §4.2): once measure.py's quiet check has passed (lock held as a reservation),
  speedprobe.py measures the regime (CPU bench + Dapr placement over --speed-placement-s). In the slow regime the
  lock is released and the probe repeated every --speed-retry-s, up to --speed-max-wait-min; then the window runs
  anyway, flagged `speedRegime: slow`. All probes -> speed.json, the last one also in window.json and meta.json (`speedRegime`, `speedProbe`); a bench at
  the end of every steady segment -> hooks.json (`speedBench`). --no-speed (and --pilot) skip the gate.
- --counters (instrumented windows): GET /timing/counters of every app (misarch-kotlin timing build, README.md §2.2) at
  every steady segment's start and end -> hooks.json and counters.json (per segment and app: the deltas of the
  statement and operation counters and of threadCpuNsTotal).
- --clear-cron SPEC (campaign.py: the domain's scheduled jobs): no firing in a measured phase;
  cronjobs.guard_plan marks idle, idle_end and every pre..steady run, loadgen holds before them (`<seg>:hold`).
- The gap rule (>= --min-gap-min since the last window) is checked against calibration's last_window_end of the
  Kotlin stack as well as ours, so windows of other agents on the same stack are respected.
"""
import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TIMING = os.path.dirname(HERE)
CAL = os.path.join(TIMING, "calibration")
CAL_SCRIPTS = os.path.join(CAL, "scripts")
CAL_PY = os.path.join(CAL, ".venv", "bin", "python")
SHARED_LAST = os.path.join(CAL, "results-kotlin", "raw", "last_window_end")
RAW = os.environ.get("TIMING_RAW") or os.path.join(TIMING, "raw")
WINDOWS = os.path.join(RAW, "windows")
ASPROF_HOST = os.path.join(TIMING, "raw", "_asprof")   # bind-mounted at /timing (docker-compose.timing.yaml)

os.environ.setdefault("MISARCH_STACK", "kotlin")
sys.path.insert(0, CAL_SCRIPTS)
sys.path.insert(0, HERE)
import stackctl  # noqa: E402
from cronjobs import guard_plan  # noqa: E402
import spans as zspans  # noqa: E402
import speedprobe  # noqa: E402


def segname(phase):
    return phase.replace(":", "_").replace("/", "_")


class Hooks:
    """Serialised hook actions in one worker thread, so the load generator's event loop is never blocked."""

    def __init__(self, name, out, profile, pgstat, interval, cache_counts=False, counters=False, speed=True):
        self.name, self.out, self.profile, self.pgstat, self.interval = name, out, profile, pgstat, interval
        self.cache_counts, self.counters, self.speed = cache_counts, counters, speed
        self.log = []
        self.q = []
        self.cv = threading.Condition()
        self.open = None
        self.fired = False
        self.whole = False
        self.done = False
        self.th = threading.Thread(target=self.run, daemon=True)
        self.th.start()
        os.makedirs(os.path.join(ASPROF_HOST, name), exist_ok=True)
        os.chmod(os.path.join(ASPROF_HOST, name), 0o777)
        os.makedirs(os.path.join(out, "pgstat"), exist_ok=True)

    def submit(self, kind, seg):
        with self.cv:
            self.q.append((kind, seg, time.time()))
            self.cv.notify()

    def run(self):
        while True:
            with self.cv:
                while not self.q and not self.done:
                    self.cv.wait()
                if not self.q and self.done:
                    return
                kind, seg, t_req = self.q.pop(0)
            try:
                self.act(kind, seg, t_req)
            except Exception as e:  # never break the window
                self.log.append({"kind": kind, "seg": seg, "tRequested": t_req, "error": repr(e)})

    def act(self, kind, seg, t_req):
        rec = {"kind": kind, "seg": seg, "tRequested": t_req}
        pg = self.pgstat and seg != "idle"
        if self.cache_counts and seg != "idle":
            rec["cacheCounts"] = stackctl.cache_counts()
        if self.counters and seg != "idle" and kind == "start":
            rec["counters"] = stackctl.counters()
        if pg and seg.endswith(":steady"):
            rec["pgXact"] = stackctl.xact()
        if kind == "start":
            if pg:
                rec["pgReset"] = stackctl.reset()
            if self.profile:
                rec["asprofStart"] = stackctl.asprof_start(self.interval)
        else:
            if self.profile:
                rec["asprofStop"] = stackctl.asprof_stop(self.name, segname(seg))
            if pg:
                d = stackctl.dump()
                rec["pgDump"] = {c: {"t": v["t"], "n": len(v["rows"]), "error": v.get("error")} for c, v in d.items()}
                json.dump(d, open(os.path.join(self.out, "pgstat", segname(seg) + ".json"), "w"))
            if self.counters and seg != "idle":
                rec["counters"] = stackctl.counters()
            if self.speed and seg.endswith(":steady"):     # after the stop actions: ~0.25 CPU s in the drain phase
                rec["speedBench"] = speedprobe.bench()
        rec["tDone"] = time.time()
        self.log.append(rec)

    # phase transitions ------------------------------------------------------------------------------------------
    @staticmethod
    def profiled(phase):
        return phase is not None and (phase.endswith(":steady") or phase == "idle")

    def phase(self, old, new):
        self.fired = True
        if self.whole:
            return
        if self.open is not None and new != self.open:
            self.submit("stop", self.open)
            self.open = None
        if self.profiled(new) and self.open is None:
            self.submit("start", new)
            self.open = new

    def finish(self):
        if self.open is not None:
            self.submit("stop", self.open)
            self.open = None
        with self.cv:
            self.done = True
            self.cv.notify()
        self.th.join(timeout=600)


def install_runner(hooks, clear=None):
    import loadgen as L
    try:                                    # the 36 request types + session dispatch, when present
        sys.path.insert(0, os.path.join(TIMING, "requests"))
        import run as reqrun
        reqrun.install()
        runner = "timing/requests/run.py install() (ExtGen)"
    except Exception as e:
        runner = f"loadgen.py ({type(e).__name__}: {e})"
    base = L.Gen

    class HookedGen(base):
        @property
        def phase(self):
            return self.__dict__.get("_phase")

        @phase.setter
        def phase(self, v):
            old = self.__dict__.get("_phase")
            self.__dict__["_phase"] = v
            if old != v:
                hooks.phase(old, v)

    L.Gen = HookedGen
    orig = L.run_plan

    async def run_plan(plan, out_dir, seed):
        if clear and clear["cron"]:
            guard_plan(plan, clear["cron"], clear["beforeS"], clear["afterS"])
        if plan.get("kind") == "sessions":   # session load (block 7): one segment `run:steady` around the plan
            hooks.whole = True
            hooks.submit("start", "run:steady")
            hooks.open = "run:steady"
        return await orig(plan, out_dir, seed)
    L.run_plan = run_plan
    return runner


def cache_count_deltas(hlog):
    """hooks.json records -> {segment: {container: {hits, misses, hitRatio, seconds}}} between start and stop."""
    starts, res = {}, {}
    for r in hlog:
        cc = r.get("cacheCounts")
        if not cc:
            continue
        if r["kind"] == "start":
            starts[r["seg"]] = cc
            continue
        s0 = starts.get(r["seg"], {})
        for c, v in cc.items():
            v0 = s0.get(c, {})
            if "hits" not in v or "hits" not in v0:
                continue
            h, m = v["hits"] - v0["hits"], v["misses"] - v0["misses"]
            e = res.setdefault(r["seg"], {})[stackctl.short(c)] = {
                "hits": h, "misses": m, "hitRatio": round(h / (h + m), 4) if h + m else None,
                "seconds": round(v["t"] - v0["t"], 1)}
            for tg, x in (v.get("byTarget") or {}).items():     # order's caller cache, per invoked app
                x0 = (v0.get("byTarget") or {}).get(tg, {"hits": 0, "misses": 0})
                hh, mm = x["hits"] - x0["hits"], x["misses"] - x0["misses"]
                e.setdefault("byTarget", {})[tg] = {"hits": hh, "misses": mm,
                                                    "hitRatio": round(hh / (hh + mm), 4) if hh + mm else None}
    return res


def counter_deltas(hlog):
    """hooks.json records -> {segment: {app: {seconds, threadCpuNs, statements: {key: {...}}, operations: {key: {...}}}}}
    between the segment's start and stop snapshots of GET /timing/counters (cumulative counters; README.md §2.2)."""
    starts, res = {}, {}
    for r in hlog:
        cc = r.get("counters")
        if not cc:
            continue
        if r["kind"] == "start":
            starts[r["seg"]] = cc
            continue
        s0 = starts.get(r["seg"], {})
        for c, v in cc.items():
            v0 = s0.get(c)
            if not v0 or "error" in v or "error" in v0 or not v.get("enabled"):
                continue
            res.setdefault(r["seg"], {})[stackctl.short(c)] = stackctl.counter_delta(v0, v)
    return res


def xact_deltas(hlog):
    """{segment: {db container: {commits, rollbacks, walSync, walRecords, walBytes, seconds}}} per steady segment
    (commit and WAL-sync counts per request for the latency fit; pg_stat_database counts every transaction,
    read-only autocommit statements included, pg_stat_wal's sync the WAL flushes)."""
    starts, res = {}, {}
    for r in hlog:
        x = r.get("pgXact")
        if not x:
            continue
        if r["kind"] == "start":
            starts[r["seg"]] = x
            continue
        for c, v in x.items():
            v0 = starts.get(r["seg"], {}).get(c)
            if not v0 or "error" in v or "error" in v0:
                continue
            db = stackctl.short(c)[:-3]
            d1, d0 = (v.get("dbs") or {}).get(db, {}), (v0.get("dbs") or {}).get(db, {})
            res.setdefault(r["seg"], {})[stackctl.short(c)] = {
                "commits": d1.get("commit", 0) - d0.get("commit", 0),
                "rollbacks": d1.get("rollback", 0) - d0.get("rollback", 0),
                "walSync": (v["wal"] or {}).get("sync", 0) - (v0["wal"] or {}).get("sync", 0),
                "walRecords": (v["wal"] or {}).get("records", 0) - (v0["wal"] or {}).get("records", 0),
                "walBytes": int(float((v["wal"] or {}).get("bytes", 0)) - float((v0["wal"] or {}).get("bytes", 0))),
                "seconds": round(v["t"] - v0["t"], 2)}
    return res


def install_speed_gate(measure, a, rec):
    """Wrap measure.py's quiet wait: after it returns with the lock held, probe the speed regime; slow -> release the
    lock, wait, probe again (up to a.speed_max_wait_min), then run anyway with the regime recorded."""
    orig = measure.wait_quiet_reserving

    def gated(max_wait_min, quiet_cores, min_gap_min, log, name, purpose, reserve_max_min=15):
        t0 = time.time()
        while True:
            if not orig(max_wait_min, quiet_cores, min_gap_min, log, name, purpose, reserve_max_min):
                return False
            p = speedprobe.probe(a.speed_placement_s)
            rec["probes"].append(p)
            pl, bn = p.get("placement") or {}, p.get("bench") or {}
            log(f"speed probe: placement {pl.get('medianMsPerS')} ms/s, bench {bn.get('medianMs')} ms "
                f"(x{bn.get('ratio')}) -> {p['regime']}")
            rec.update(regime=p["regime"], probe=p, waitedS=round(time.time() - t0, 1))
            if p["regime"] != "slow":
                return True
            if time.time() - t0 + a.speed_retry_s > a.speed_max_wait_min * 60:
                rec["gaveUp"] = True
                log(f"still slow after {(time.time() - t0) / 60:.0f} min: running anyway, flagged speedRegime=slow")
                return True
            try:
                os.remove(measure.LOCK)
            except FileNotFoundError:
                pass
            log(f"slow regime: lock released, next probe in {a.speed_retry_s:.0f} s")
            time.sleep(a.speed_retry_s)
    measure.wait_quiet_reserving = gated


def gap_wait(min_gap_min, log):
    while True:
        last = 0.0
        for p in (SHARED_LAST, os.path.join(WINDOWS, "last_window_end")):
            try:
                last = max(last, float(open(p).read()))
            except Exception:
                pass
        wait = last + min_gap_min * 60 - time.time()
        if wait <= 0:
            return
        log(f"gap: waiting {wait:.0f}s since the last window")
        time.sleep(min(wait + 1, 60))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--purpose", default="")
    ap.add_argument("--profile", action="store_true")
    ap.add_argument("--pgstat", action="store_true")
    ap.add_argument("--spans", action="store_true")
    ap.add_argument("--pilot", action="store_true", help="measure.py --pilot: no lock, no quiet wait, invalid")
    ap.add_argument("--interval", default="10ms")
    ap.add_argument("--max-wait-min", default="240")
    ap.add_argument("--min-gap-min", type=float, default=5)
    ap.add_argument("--seed")
    ap.add_argument("--cache-counts", action="store_true", help="block 6: entity cache counters per segment")
    ap.add_argument("--counters", action="store_true", help="GET /timing/counters of every app per steady segment")
    ap.add_argument("--clear-cron", action="append", default=[],
                    help="Spring cron of a scheduled job no measured interval may overlap (repeatable; guard_plan)")
    ap.add_argument("--clear-before-s", type=float, default=2)
    ap.add_argument("--clear-after-s", type=float, default=6, help="the firing's CPU burst lasts ~2.5 s")
    ap.add_argument("--no-speed", dest="speed", action="store_false", help="no speed gate, no per-segment bench")
    ap.add_argument("--speed-max-wait-min", type=float, default=float(os.environ.get("TIMING_SPEED_MAX_WAIT_MIN", 30)))
    ap.add_argument("--speed-retry-s", type=float, default=180)
    ap.add_argument("--speed-placement-s", type=float, default=60)
    a = ap.parse_args()
    out = os.path.join(WINDOWS, a.name)
    if os.path.exists(os.path.join(out, "window.json")):
        sys.exit(f"{out} exists already")
    os.makedirs(out, exist_ok=True)

    def log(msg):
        print(f"[{time.strftime('%F %T')}] {a.name}: {msg}", flush=True)

    import stack
    stack.RAW = WINDOWS                     # measure.py's output and its last_window_end go to our raw dir
    import measure
    measure.RAW = WINDOWS
    measure.LAST = os.path.join(WINDOWS, "last_window_end")
    if not a.pilot:
        gap_wait(a.min_gap_min, log)
    json.dump(stackctl.volume(), open(os.path.join(out, "volume_before.json"), "w"))
    if a.spans:     # an empty in-memory store per window (a store shared by windows fills up)
        zc = zspans.clear()
        json.dump(zc, open(os.path.join(out, "zipkin_clear.json"), "w"))
        log(f"zipkin cleared: {zc}")
        if not zc["ok"]:
            sys.exit("zipkin did not come back after the restart")
    if a.profile:   # load the agent into every JVM before the window, so the attach cost is not in the idle baseline
        pre = stackctl.asprof_start(a.interval)
        pre2 = stackctl.pmap(lambda c: stackctl.asprof_stop_one(c, "/tmp/timing-preload.collapsed"), list(pre))
        bad = [c for c, v in pre.items() if not v["ok"]] + [c for c, v in pre2.items() if not v["ok"]]
        if bad:
            sys.exit(f"async-profiler attach failed in {bad}: {[pre.get(c, {}).get('msg') for c in bad][:3]}")
    hooks = Hooks(a.name, out, a.profile, a.pgstat, a.interval, a.cache_counts, a.counters, a.speed)
    speed = {"probes": [], "regime": None, "gate": bool(a.speed and not a.pilot),
             "maxWaitMin": a.speed_max_wait_min, "retryS": a.speed_retry_s}
    if a.counters:
        c0 = stackctl.counters()
        bad = [c for c, v in c0.items() if "error" in v or not v.get("enabled")]
        log(f"counters: {len(c0) - len(bad)} of {len(c0)} apps answer" + (f" (not: {[stackctl.short(c) for c in bad]})" if bad else ""))
    clear = {"cron": a.clear_cron, "beforeS": a.clear_before_s, "afterS": a.clear_after_s}
    runner = install_runner(hooks, clear)
    log(f"runner: {runner}; profile={a.profile} pgstat={a.pgstat} spans={a.spans}")
    if a.profile or a.pgstat:
        st = stackctl.status()
        if a.pgstat and "pg_stat_statements" not in (st.get("preload") or ""):
            sys.exit("pg_stat_statements is not preloaded: bring the stack up with timing-up.sh up --mode on")
    sys.argv = ["measure.py", "--name", a.name, "--plan", a.plan, "--purpose", a.purpose or a.name,
                "--stack", "kotlin", "--max-wait-min", a.max_wait_min, "--min-gap-min", str(a.min_gap_min)]
    if a.pilot:
        sys.argv.append("--pilot")
    elif a.speed:
        install_speed_gate(measure, a, speed)
    if a.seed:
        sys.argv += ["--seed", a.seed]
    rc = 0
    poller = None
    if a.spans:     # fetch while the window runs: the in-memory store evicts the oldest traces when full
        poller = zspans.Poller(zspans.Fetcher(time.time() * 1000 - 5000))
        poller.start()
    try:
        measure.main()
    except SystemExit as e:
        rc = e.code or 0
    finally:
        hooks.finish()
        if poller:
            poller.stop.set()
            poller.join(timeout=120)
    json.dump({"runner": runner, "profile": a.profile, "pgstat": a.pgstat, "interval": a.interval, "clear": clear,
               "stack": stackctl.status(), "log": hooks.log}, open(os.path.join(out, "hooks.json"), "w"), indent=1)
    try:
        json.dump(stackctl.volume(), open(os.path.join(out, "volume_after.json"), "w"))
    except Exception as e:
        log(f"volume_after: {e!r}")
    if a.cache_counts:
        json.dump(cache_count_deltas(hooks.log), open(os.path.join(out, "cache_counts.json"), "w"), indent=1)
    if a.counters:
        json.dump(counter_deltas(hooks.log), open(os.path.join(out, "counters.json"), "w"), indent=1)
    if a.pgstat:
        json.dump(xact_deltas(hooks.log), open(os.path.join(out, "pgxact.json"), "w"), indent=1)
    if not speed["probes"] and a.speed:          # pilot: record one probe anyway (bench + placement)
        try:
            speed["probes"].append(speedprobe.probe(a.speed_placement_s if not a.pilot else 0))
            speed.update(regime=speed["probes"][-1]["regime"], probe=speed["probes"][-1], after=True)
        except Exception as e:
            log(f"speed probe: {e!r}")
    json.dump(speed, open(os.path.join(out, "speed.json"), "w"), indent=1)
    for fn in ("window.json", "meta.json"):     # the regime next to measure.py's validity
        p = os.path.join(out, fn)
        if os.path.exists(p):
            try:
                w = json.load(open(p))
                w["speedRegime"] = speed["regime"]
                w["speedProbe"] = {"placementMsPerS": ((speed.get("probe") or {}).get("placement") or {}).get("medianMsPerS"),
                                   "benchMs": ((speed.get("probe") or {}).get("bench") or {}).get("medianMs"),
                                   "benchRatio": ((speed.get("probe") or {}).get("bench") or {}).get("ratio"),
                                   "probes": len(speed["probes"]), "waitedS": speed.get("waitedS"),
                                   "gaveUp": speed.get("gaveUp", False)}
                json.dump(w, open(p, "w"), indent=1)
            except Exception as e:
                log(f"speed -> {fn}: {e!r}")
    # collect the folded stacks (written by the containers' uid into the bind mount) and compress them
    src = os.path.join(ASPROF_HOST, a.name)
    if os.path.isdir(src):
        dst = os.path.join(out, "asprof")
        os.makedirs(dst, exist_ok=True)
        for f in sorted(os.listdir(src)):
            with open(os.path.join(src, f), "rb") as fi, gzip.open(os.path.join(dst, f + ".gz"), "wb") as fo:
                shutil.copyfileobj(fi, fo)
            os.remove(os.path.join(src, f))
        os.rmdir(src)
    if a.spans and os.path.exists(os.path.join(out, "meta.json")):
        try:
            sampler = float(stackctl.status().get("sampler") or 0) or None
            r = zspans.fetch(out, fetcher=poller.fetcher, sampler=sampler, polls=poller.polls)
            log(f"spans: {r['spans']} spans, {r['traces']} traces, {r['queries']} queries, {r.get('splits', 0)} splits, "
                f"{r['polls']} polls, {len(r['emptySegments'])} empty segments, complete={r['complete']}, "
                f"{r['seconds']} s")
        except Exception as e:
            log(f"spans: fetch failed: {e!r}")
    log(f"done rc={rc}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
