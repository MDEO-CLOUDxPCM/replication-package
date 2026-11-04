#!/usr/bin/env python3
"""Inspect / clean Dapr Redis-streams pub/sub state.

  redisq.py report            -> JSON: per stream: length, per consumer group: pending, lag
  redisq.py ack STREAM GROUP  -> XACK all pending entries of that group (stops infinite redelivery of a failed message)
  redisq.py ack-known         -> ack the pending entries of the known functional defects (see README "Functional defects")
  redisq.py lengths           -> total XLEN per stream (used to count published messages per window)
  redisq.py trim [KEEP]       -> per stream, delete the entries every consumer group has received and acknowledged,
                                 keeping the newest KEEP (default 2000). Dapr's component sets no maxLenApprox, so the
                                 streams kept every message ever published (750 MB in memory over the calibration runs, rewritten to
                                 disk by RDB saves every minute under load); maintenance only, never inside a window.

Dapr redis pubsub redelivers un-acked (failed, HTTP 500) messages every redeliverInterval (60 s) forever, because
MiSArch configures no resiliency policy. A single broken subscription therefore creates permanent background load.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stack import DEFECT_GROUPS, cname  # noqa: E402  (--stack kotlin / MISARCH_STACK)

R = ["docker", "exec", cname("dapr-redis"), "redis-cli", "-a", "redis", "--no-auth-warning"]
KNOWN = list(DEFECT_GROUPS)   # empty for the Kotlin stack (defects fixed)


def rc(*args):
    out = subprocess.run(R + list(args), capture_output=True, text=True, check=True).stdout
    return out


def streams():
    keys = rc("--scan", "--pattern", "*").split()
    return sorted(k for k in keys if rc("TYPE", k).strip() == "stream")


def groups(stream):
    lines = rc("XINFO", "GROUPS", stream).splitlines()
    res, cur = [], {}
    for i in range(0, len(lines) - 1, 2):
        k, v = lines[i], lines[i + 1]
        if k == "name" and cur:
            res.append(cur)
            cur = {}
        cur[k] = v
    if cur:
        res.append(cur)
    return res


def report():
    out = {}
    for s in streams():
        out[s] = {"len": int(rc("XLEN", s).strip()),
                  "groups": {g["name"]: {"pending": int(g.get("pending", 0)), "lag": g.get("lag")} for g in groups(s)}}
    return out


def ack(stream, group):
    n = 0
    while True:
        lines = [x for x in rc("XPENDING", stream, group, "-", "+", "1000").splitlines() if x.strip()]
        ids = [lines[i] for i in range(0, len(lines), 4)]
        if not ids:
            return n
        rc("XACK", stream, group, *ids)
        n += len(ids)


def _id(x):
    a, _, b = x.partition("-")
    return (int(a), int(b or 0))


def trim(keep=2000):
    out = {}
    for s in streams():
        n = int(rc("XLEN", s).strip())
        if n <= keep:
            continue
        lines = rc("XREVRANGE", s, "+", "-", "COUNT", str(keep)).splitlines()
        ids = [x for x in lines if "-" in x and x.replace("-", "").isdigit()]
        cut = ids[-1] if ids else None
        for g in groups(s):
            last = g.get("last-delivered-id")
            if last and (cut is None or _id(last) < _id(cut)):
                cut = last   # entries after last-delivered-id were not delivered to this group yet
            if int(g.get("pending", 0)):
                lo = rc("XPENDING", s, g["name"]).splitlines()[1]
                if _id(lo) < _id(cut):
                    cut = lo
        if cut:
            out[s] = int(rc("XTRIM", s, "MINID", cut).strip())
    return out


if __name__ == "__main__":
    args = [x for i, x in enumerate(sys.argv[1:], 1) if x != "--stack" and sys.argv[i - 1] != "--stack"
            and not x.startswith("--stack=")]
    sys.argv = [sys.argv[0]] + args
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    if cmd == "report":
        print(json.dumps(report(), indent=1))
    elif cmd == "lengths":
        print(json.dumps({s: int(rc("XLEN", s).strip()) for s in streams()}))
    elif cmd == "ack":
        print(ack(sys.argv[2], sys.argv[3]))
    elif cmd == "ack-known":
        print({f"{s}|{g}": ack(s, g) for s, g in KNOWN})
    elif cmd == "trim":
        print(json.dumps(trim(int(sys.argv[2]) if len(sys.argv) > 2 else 2000)))
    elif cmd == "pending":
        rep = report()
        print(json.dumps({f"{s}|{g}": v["pending"] for s, d in rep.items() for g, v in d["groups"].items()
                          if v["pending"]}))
