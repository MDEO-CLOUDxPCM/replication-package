#!/usr/bin/env python3
"""Run one measurement window under the machine-load protocol.

    measure.py --name NAME --plan PLAN.json [--max-wait-min 240] [--min-gap-min 5]

1. wait until the machine is quiet: foreign CPU (host busy minus MiSArch containers, Docker engine and own tools)
   below --quiet-cores for 30 s and no heavy foreign process (cargo/rustc/java/gradle/node/cc/ld > 30 % of a core);
   and at least --min-gap-min minutes since the end of the previous window
2. create MEASURING.lock in the repository root (purpose, start, expected end)
3. start cpumon (1 Hz cgroup sampling) and the defect reaper (acks the failed deliveries of the known functional
   defects after their first attempt so that Dapr does not redeliver them every 60 s, and counts them)
4. run the load plan (loadgen.run_plan), including idle/warm-up/steady/drain phases
5. stop everything, remove the lock, judge validity (foreign CPU during the window), write window.json

Stack: --stack original (default) | kotlin (the timing campaign: misarch-kotlin-* containers, results-kotlin/raw/, no
reaper because the Kotlin stack has no known failing deliveries); see stack.py.

Output: results/raw/<NAME>/{requests.csv, meta.json, cpu.csv, host.csv, containers.json, window.json, redis_*.json}
"""
import argparse
import asyncio
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CAL = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import loadgen  # noqa: E402
from cpuan import CpuData  # noqa: E402
from stack import DEFECT_GROUPS, RAW, STACK, TOPOLOGY, cname, is_stack, live  # noqa: E402

LOCK = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(CAL)))), "MEASURING.lock")   # the repository root (README.md; CAL = cases/misarch/timing/calibration)
LAST = os.path.join(RAW, "last_window_end")   # per stack (results/raw or results-kotlin/raw)
HEAVY = re.compile(r"^(cargo|rustc|java|gradle|node|cc1|cc1plus|ld|lld|clang|gcc|mvn|npm|tsc|esbuild|python3?|pytest|"
                   r"rust-analyzer|kotlin|sccache|cmake|make|ninja|go|docker-buildx|buildkitd)", re.I)


def host_info():
    """Host the window ran on (the dev VM had 8, later 21 vCPU); recorded in window.json."""
    model = next((l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name")), None)
    mem = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo") if l.split(":")[0] in ("MemTotal", "SwapTotal")}
    return {"nproc": os.cpu_count(), "cpuModel": model, "memTotalGB": round(mem["MemTotal"] / 2**20, 1),
            "swapTotalGB": round(mem["SwapTotal"] / 2**20, 1), "hostname": os.uname().nodename}


def disk_free_gb(path="/"):
    st = os.statvfs(path)
    return round(st.f_bavail * st.f_frsize / 2**30, 2)


def mem_snapshot():
    """Available RAM, swap in use, anonymous memory (MB) of the stack's containers (cgroup memory.stat); taken at the
    start and end of a window (docker CLI only outside the loaded part)."""
    mi = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo")}
    out = subprocess.run(["docker", "ps", "--no-trunc", "--format", "{{.Names}} {{.ID}}"], capture_output=True,
                         text=True).stdout.split("\n")
    anon = {}
    for line in out:
        if line.strip() and is_stack(line.split()[0]):
            n, i = line.split()
            try:
                st = dict(x.split() for x in open(f"/sys/fs/cgroup/system.slice/docker-{i}.scope/memory.stat"))
                anon[n] = round(int(st["anon"]) / 2**20)
            except Exception:
                pass
    top = dict(sorted(anon.items(), key=lambda kv: -kv[1])[:6])
    return {"t": time.time(), "availableGB": round(mi["MemAvailable"] / 2**20, 2),
            "swapUsedGB": round((mi["SwapTotal"] - mi["SwapFree"]) / 2**20, 2),
            "gatewayAnonMB": anon.get(live("gateway")), "stackAnonGB": round(sum(anon.values()) / 1024, 2),
            "topAnonMB": top}


def misarch_cgroups():
    out = subprocess.run(["docker", "ps", "--no-trunc", "--format", "{{.Names}} {{.ID}}"], capture_output=True,
                         text=True).stdout.split("\n")
    paths = []
    for line in out:
        if line.strip() and is_stack(line.split()[0]):
            paths.append(f"/sys/fs/cgroup/system.slice/docker-{line.split()[1]}.scope/cpu.stat")
    paths += ["/sys/fs/cgroup/system.slice/docker.service/cpu.stat",
              "/sys/fs/cgroup/system.slice/containerd.service/cpu.stat"]
    return paths


def cg_usec(p):
    try:
        for line in open(p):
            if line.startswith("usage_usec"):
                return int(line.split()[1])
    except FileNotFoundError:
        return 0
    return 0


def host_usec():
    vals = list(map(int, open("/proc/stat").readline().split()[1:9]))
    return (sum(vals) - vals[3] - vals[4]) * 1_000_000 // os.sysconf("SC_CLK_TCK")


def own_usec():
    s = open(f"/proc/{os.getpid()}/stat").read()
    f = s[s.rindex(")") + 2:].split()
    return (int(f[11]) + int(f[12]) + int(f[13]) + int(f[14])) * 1_000_000 // os.sysconf("SC_CLK_TCK")


def foreign_now(seconds=30):
    paths = misarch_cgroups()
    a_h, a_c, a_o = host_usec(), sum(cg_usec(p) for p in paths), own_usec()
    time.sleep(seconds)
    b_h, b_c, b_o = host_usec(), sum(cg_usec(p) for p in paths), own_usec()
    return ((b_h - a_h) - (b_c - a_c) - (b_o - a_o)) / 1e6 / seconds


def heavy_foreign():
    """Foreign processes with > 30 % of a core over 2 s whose name looks like a build/test tool."""
    ids = [p.split("docker-")[1].split(".scope")[0] for p in misarch_cgroups() if "docker-" in p]

    def snap():
        r = {}
        for pid in os.listdir("/proc"):
            if pid.isdigit():
                try:
                    s = open(f"/proc/{pid}/stat").read()
                    f = s[s.rindex(")") + 2:].split()
                    r[pid] = int(f[11]) + int(f[12])
                except Exception:
                    pass
        return r
    a = snap()
    time.sleep(2)
    b = snap()
    out = []
    hz = os.sysconf("SC_CLK_TCK")
    for pid, v in b.items():
        d = (v - a.get(pid, v)) / hz / 2
        if d < 0.3 or pid == str(os.getpid()):
            continue
        try:
            cg = open(f"/proc/{pid}/cgroup").read()
            comm = open(f"/proc/{pid}/comm").read().strip()
        except Exception:
            continue
        if any(i in cg for i in ids) or "docker.service" in cg or "containerd.service" in cg:
            continue
        out.append((comm, pid, round(d, 2), bool(HEAVY.match(comm))))
    return out


def wait_quiet_reserving(max_wait_min, quiet_cores, min_gap_min, log, name, purpose, reserve_max_min=15):
    """Machine shared with build agents whose Gradle limiter waits for MEASURING.lock: once the gap has passed and no
    lock exists, take the lock as a reservation (new heavy work stops starting), wait up to reserve_max_min for the
    running work to finish, then return True with the lock held. If it never gets quiet, release the lock, back off
    5 minutes and retry."""
    t0 = time.time()
    while time.time() - t0 < max_wait_min * 60:
        try:
            gap_ok = time.time() - float(open(LAST).read()) >= min_gap_min * 60
        except Exception:
            gap_ok = True
        if os.path.exists(LOCK) or not gap_ok:
            log("lock exists or gap not over; waiting" if gap_ok else "gap not over; waiting")
            time.sleep(30)
            continue
        with open(LOCK, "w") as f:
            f.write(f"calibration agent (architecture-optimization cases/misarch/timing/calibration): RESERVED for measurement window '{name}' "
                    f"({purpose}); waiting since {time.strftime('%H:%M:%S')} for running work to finish "
                    f"(max {reserve_max_min} min), then <= 30 min of measurement; pid {os.getpid()}\n")
        log("lock taken as reservation; waiting for quiet machine")
        r0 = time.time()
        while time.time() - r0 < reserve_max_min * 60:
            f = foreign_now(30)
            hv = heavy_foreign()
            ok = f < quiet_cores and not any(h[2] > 0.3 for h in hv)
            log(f"quiet check (reserved): foreign={f:.2f} cores, procs>30%={hv} -> {'QUIET' if ok else 'busy'}")
            if ok:
                return True
        os.remove(LOCK)
        log("not quiet within the reservation time; lock released, backing off 5 min")
        time.sleep(300)
    return False


def wait_quiet(max_wait_min, quiet_cores, min_gap_min, log):
    t0 = time.time()
    while True:
        gap_ok = True
        try:
            last = float(open(LAST).read())
            gap_ok = time.time() - last >= min_gap_min * 60
        except Exception:
            pass
        if os.path.exists(LOCK):
            log(f"lock exists ({open(LOCK).read()[:120]!r}); waiting")
            ok = False
        else:
            f = foreign_now(30)
            hv = heavy_foreign()
            ok = gap_ok and f < quiet_cores and not any(h[2] > 0.3 for h in hv)
            log(f"quiet check: foreign={f:.2f} cores, procs>30%={hv}, gap_ok={gap_ok} -> {'QUIET' if ok else 'busy'}")
        if ok:
            return True
        if time.time() - t0 > max_wait_min * 60:
            return False
        time.sleep(60)


class Reaper(threading.Thread):
    """Ack failed deliveries of known functional defects after their first attempt (idle > 3 s)."""

    def __init__(self):
        super().__init__(daemon=True)
        import redis
        ip = loadgen.container_ip(live("dapr-redis"))
        self.r = redis.Redis(host=ip, port=6379, password="redis", decode_responses=True)
        self.stop = threading.Event()
        self.acked = {f"{s}|{g}": 0 for s, g in DEFECT_GROUPS}

    def sweep(self, min_idle_ms=3000):
        for s, g in DEFECT_GROUPS:
            try:
                ents = self.r.xpending_range(s, g, min="-", max="+", count=1000, idle=min_idle_ms)
            except Exception:
                continue
            ids = [e["message_id"] for e in ents]
            if ids:
                self.r.xack(s, g, *ids)
                self.acked[f"{s}|{g}"] += len(ids)

    def run(self):
        while not self.stop.wait(5):
            self.sweep()


def redis_state():
    out = subprocess.run([sys.executable, os.path.join(HERE, "redisq.py"), "report"], capture_output=True, text=True)
    try:
        return json.loads(out.stdout)
    except Exception:
        return {"error": out.stderr[-500:]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--purpose", default="")
    ap.add_argument("--max-wait-min", type=float, default=300)
    ap.add_argument("--quiet-cores", type=float, default=0.3)
    ap.add_argument("--min-gap-min", type=float, default=5)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--no-reaper", action="store_true")
    ap.add_argument("--pilot", action="store_true", help="setup/smoke run: no quiet wait, no lock, marked invalid")
    ap.add_argument("--stack", help="original|kotlin (see stack.py): container prefix, results dir, reaper groups")
    ap.add_argument("--min-free-gb", type=float, default=8.0, help="refuse to start with less free space on /")
    a = ap.parse_args()
    out = os.path.join(RAW, a.name)
    os.makedirs(out, exist_ok=True)
    if TOPOLOGY:   # architecture variant: container -> service mapping and replica sums for the analyses (cpuan.py)
        json.dump(TOPOLOGY, open(os.path.join(out, "topology.json"), "w"), indent=1)
    logf = open(os.path.join(out, "window.log"), "a")

    def log(msg):
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    plan = json.load(open(a.plan))
    dur = sum(p["duration"] for p in plan["phases"]) + plan.get("settle", 0) + 60
    if dur > 30 * 60:
        log(f"plan duration {dur}s exceeds the 30 min window limit")
        sys.exit(2)
    if not a.pilot and not wait_quiet_reserving(a.max_wait_min, a.quiet_cores, a.min_gap_min, log, a.name,
                                                 a.purpose or plan.get("name")):
        log("machine never became quiet; giving up")
        sys.exit(3)
    free0 = disk_free_gb()
    if free0 < a.min_free_gb:
        if not a.pilot:
            try:
                os.remove(LOCK)
            except FileNotFoundError:
                pass
        log(f"only {free0} GB free on / (< {a.min_free_gb}); not starting")
        sys.exit(4)
    t_lock = time.time()
    with open(LOCK if not a.pilot else os.devnull, "w") as f:
        f.write(f"calibration agent (architecture-optimization cases/misarch/timing/calibration, stack {STACK}): measurement window '{a.name}' "
                f"({a.purpose or plan.get('name')}); started {time.strftime('%Y-%m-%d %H:%M:%S')}; "
                f"expected end {time.strftime('%H:%M:%S', time.localtime(t_lock + dur))}; pid {os.getpid()}\n")
    log(f"lock created; plan {plan.get('name')} ~{dur:.0f}s")
    mon = None
    reaper = None
    meta = None
    try:
        mem0 = mem_snapshot()
        json.dump(redis_state(), open(os.path.join(out, "redis_before.json"), "w"))
        mon = subprocess.Popen([sys.executable, os.path.join(HERE, "cpumon.py"), "--out", out, "--own-pids",
                                str(os.getpid())], stdout=subprocess.DEVNULL, stderr=open(os.path.join(out, "cpumon.err"), "w"))
        if not a.no_reaper and DEFECT_GROUPS:
            reaper = Reaper()
            reaper.sweep(min_idle_ms=0)   # clear leftovers of earlier runs before the window starts
            reaper.acked = {k: 0 for k in reaper.acked}
            reaper.start()
        time.sleep(3)
        meta = asyncio.run(loadgen.run_plan(plan, out, a.seed if a.seed is not None else int(time.time())))
    finally:
        if reaper:
            reaper.stop.set()
            reaper.sweep()
        time.sleep(2)
        if mon:
            mon.send_signal(signal.SIGTERM)
            mon.wait(timeout=20)
        if not a.pilot:
            try:
                os.remove(LOCK)
            except FileNotFoundError:
                pass
        t_end = time.time()
        if not a.pilot:
            open(LAST, "w").write(str(t_end))
        log(f"lock removed after {t_end - t_lock:.0f}s")
    json.dump(redis_state(), open(os.path.join(out, "redis_after.json"), "w"))
    meta["host"] = host_info()
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=1)
    # validity: foreign CPU during the loaded part of the window
    cd = CpuData(out)
    t1, t2 = meta["t0"], meta["t_end"]
    prof = cd.foreign_profile(t1, t2, step=10)
    fmean = cd.foreign_cores(t1, t2)
    tops = cd.top_foreign(t1, t2)
    heavy = [x for x in tops for tok in x.split() if HEAVY.match(tok) and int(tok.split(":")[-1].rstrip("%")) > 30]
    valid = (not a.pilot) and fmean < a.quiet_cores and (max(prof) if prof else 0) < 2 * a.quiet_cores + 0.5
    w = {"name": a.name, "stack": STACK, "purpose": a.purpose, "plan": plan.get("name"), "lock_start": t_lock, "lock_end": t_end,
         "t0": t1, "t_end": t2, "foreign_mean_cores": round(fmean, 3), "foreign_10s_profile": prof,
         "foreign_top_samples": tops[:200], "heavy_foreign_samples": heavy, "valid": bool(valid),
         "reaper_acked": reaper.acked if reaper else None, "limits": cd.info.get("containers"),
         "swap_in_out_majflt_per_s": cd.swap(t1, t2), "host": host_info(),
         "diskFreeGB": {"start": free0, "end": disk_free_gb()}, "memory": {"start": mem0, "end": mem_snapshot()}}
    # RAM pressure flag (not part of `valid`): sustained swap-in over the loaded part of the window, or bursts
    sw = w["swap_in_out_majflt_per_s"]
    if sw is not None:
        prof_sw = [cd.swap(t, min(t + 10, t2))[0] for t in range(int(t1), int(t2) - 5, 10)]
        w["swapInMax10s"] = max(prof_sw) if prof_sw else None
        w["swapSuspect"] = sw[0] > 100 or (w["swapInMax10s"] or 0) > 300
    json.dump(w, open(os.path.join(out, "window.json"), "w"), indent=1)
    log(f"window {a.name}: foreign mean {fmean:.2f} cores, max10s {max(prof) if prof else None}, "
        f"valid={valid}, reaper={w['reaper_acked']}, swap(in,out,majflt)/s={w['swap_in_out_majflt_per_s']}, "
        f"swapInMax10s={w.get('swapInMax10s')}, swapSuspect={w.get('swapSuspect')}, "
        f"mem(avail GB, swap GB, gateway anon MB) start={[w['memory']['start'][k] for k in ('availableGB', 'swapUsedGB', 'gatewayAnonMB')]} "
        f"end={[w['memory']['end'][k] for k in ('availableGB', 'swapUsedGB', 'gatewayAnonMB')]}")


if __name__ == "__main__":
    main()
