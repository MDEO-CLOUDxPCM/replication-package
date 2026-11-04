#!/usr/bin/env python3
"""1 Hz CPU sampler for all MiSArch containers (cgroup v2 cpu.stat), the Docker engine, own tools and the host.

    cpumon.py --out DIR [--interval 1.0] [--duration S] [--own-pids 123,456]

Writes DIR/cpu.csv (long format: t, key, usage_usec, throttled_usec, nr_throttled), DIR/host.csv
(t, host_busy_usec, loadavg1, foreign_usec_est, top_foreign) and DIR/containers.json (name -> id, cpu.max).
Keys: container names of the selected stack (misarch-* or misarch-kotlin-*, see stack.py; --stack kotlin), "engine:docker", "engine:containerd", "own:<pid>", "host".
Stops on SIGTERM/SIGINT or after --duration.
"""
import argparse
import json
import os
import signal
import subprocess
import time

from stack import is_stack

CG = "/sys/fs/cgroup"
HZ = os.sysconf("SC_CLK_TCK")


def containers():
    out = subprocess.run(["docker", "ps", "--format", "{{.Names}} {{.ID}}", "--no-trunc"], capture_output=True,
                         text=True).stdout.split("\n")
    res = {}
    for line in out:
        if not line.strip():
            continue
        name, cid = line.split()
        if is_stack(name):
            res[name] = cid
    return res


def read_stat(path):
    d = {}
    try:
        with open(path) as f:
            for line in f:
                k, v = line.split()
                d[k] = int(v)
    except (FileNotFoundError, ProcessLookupError, ValueError):
        return None
    return d


def host_busy_usec():
    with open("/proc/stat") as f:
        parts = f.readline().split()[1:]
    vals = list(map(int, parts))
    idle = vals[3] + vals[4]
    total = sum(vals[:8])
    return (total - idle) * 1_000_000 // HZ


def host_steal_usec():
    """Hypervisor steal time of the whole VM (cumulative)."""
    with open("/proc/stat") as f:
        parts = f.readline().split()[1:]
    return int(parts[7]) * 1_000_000 // HZ


def proc_usec(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            s = f.read()
        fields = s[s.rindex(")") + 2:].split()
        return (int(fields[11]) + int(fields[12]) + int(fields[13]) + int(fields[14])) * 1_000_000 // HZ
    except Exception:
        return None


def top_foreign(misarch_ids, n=5):
    """Top processes by CPU% (ps lifetime-avg is useless, so use a 1 s /proc delta) that are not in misarch cgroups."""
    def snap():
        res = {}
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            u = proc_usec(pid)
            if u is not None:
                res[pid] = u
        return res
    a = snap()
    time.sleep(0.5)
    b = snap()
    deltas = sorted(((b[p] - a.get(p, b[p]), p) for p in b), reverse=True)[:40]
    out = []
    for d, p in deltas:
        if d <= 0:
            break
        try:
            cg = open(f"/proc/{p}/cgroup").read()
            comm = open(f"/proc/{p}/comm").read().strip()
        except Exception:
            continue
        if any(cid in cg for cid in misarch_ids) or "docker.service" in cg or "containerd.service" in cg:
            continue
        out.append(f"{comm}:{p}:{d / 5000:.0f}%")  # % of one core over 0.5 s
        if len(out) >= n:
            break
    return " ".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--duration", type=float, default=0)
    ap.add_argument("--own-pids", default="")
    ap.add_argument("--top-every", type=int, default=10)
    ap.add_argument("--stack", help="original|kotlin (see stack.py)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cs = containers()
    info = {}
    paths = {}
    for name, cid in cs.items():
        p = f"{CG}/system.slice/docker-{cid}.scope"
        try:
            cmax = open(f"{p}/cpu.max").read().strip()
        except FileNotFoundError:
            cmax = None
        info[name] = {"id": cid, "cpu.max": cmax}
        paths[name] = f"{p}/cpu.stat"
    paths["engine:docker"] = f"{CG}/system.slice/docker.service/cpu.stat"
    paths["engine:containerd"] = f"{CG}/system.slice/containerd.service/cpu.stat"
    json.dump({"containers": info, "nproc": os.cpu_count(), "started": time.time()},
              open(os.path.join(a.out, "containers.json"), "w"), indent=1)
    own = [int(x) for x in a.own_pids.split(",") if x] + [os.getpid()]
    ids = [c["id"] for c in info.values()]
    stop = {"v": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__("v", True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__("v", True))
    fc = open(os.path.join(a.out, "cpu.csv"), "w")
    fh = open(os.path.join(a.out, "host.csv"), "w")
    fc.write("t,key,usage_usec,throttled_usec,nr_throttled\n")
    fh.write("t,host_busy_usec,load1,top_foreign,pswpin,pswpout,pgmajfault,steal_usec\n")
    t_start = time.time()
    k = 0
    next_t = t_start
    while not stop["v"] and (a.duration <= 0 or time.time() - t_start < a.duration):
        t = time.time()
        rows = []
        for key, path in paths.items():
            st = read_stat(path)
            if st:
                rows.append(f"{t:.3f},{key},{st['usage_usec']},{st.get('throttled_usec', 0)},{st.get('nr_throttled', 0)}")
        for pid in own:
            u = proc_usec(pid)
            if u is not None:
                rows.append(f"{t:.3f},own:{pid},{u},0,0")
        fc.write("\n".join(rows) + "\n")
        load1 = open("/proc/loadavg").read().split()[0]
        tf = top_foreign(ids) if (k % a.top_every == 0) else ""
        vm = {}
        for line in open("/proc/vmstat"):
            vk, vv = line.split()
            if vk in ("pswpin", "pswpout", "pgmajfault"):
                vm[vk] = vv
        fh.write(f"{t:.3f},{host_busy_usec()},{load1},{tf},{vm.get('pswpin')},{vm.get('pswpout')},{vm.get('pgmajfault')},"
                 f"{host_steal_usec()}\n")
        k += 1
        if k % 10 == 0:
            fc.flush()
            fh.flush()
        next_t += a.interval
        time.sleep(max(0.0, next_t - time.time()))
    fc.close()
    fh.close()


if __name__ == "__main__":
    main()
