#!/usr/bin/env python3
"""Zipkin side of the instrumented windows: clear Zipkin before a window, fetch its spans in time
slices so that no single query can time out, and check the result for completeness.

    spans.py clear                       restart zipkin-all-in-one (in-memory store emptied), wait until healthy
    spans.py fetch WINDOW_DIR [--slice 10]
                                         -> WINDOW_DIR/spans.json.gz (same format as calibration's traces.py fetch:
                                            a list of Zipkin v2 spans, heartbeat/config noise dropped) and
                                            spans_fetch.json (slices, queries, splits, failures, counts)
    spans.py check WINDOW_DIR            per segment: requests, traces, spans, spans per request

Fetch: the window [t0 - 5 s, t_end + 5 s] is cut into slices (default 10 s). Each slice is one
`/api/v2/traces?endTs=..&lookback=..&limit=..` query over all services (timeout 60 s, 3 attempts). A slice whose
answer reaches the limit, or that keeps failing, is split in halves (down to 0.25 s), so every query stays small.
Traces that cross a slice boundary come back from both slices and are merged by (traceId, spanId, kind, service).
(Per-service queries of up to 2000 traces time out on a full in-memory store.)
"""
import argparse
import collections
import csv
import gzip
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

PREFIX = "misarch-kotlin-"
ZIPKIN = f"{PREFIX}zipkin-all-in-one-1"
NOISE = ("pubsub/heartbeat", "pubsub/config/", "/v1.0/publish/experiment-config-pubsub", "calllocal/experiment-config",
         "/_ecs/")
LIMIT = 1000
MIN_SLICE_MS = 250
NO_GATEWAY = ("login",)   # Keycloak only: no gateway trace, so no request traces to expect
POLL_S = 120
LAG_S = 15          # a poll stops this far before now: younger traces may still be exporting (OTel batches ~5 s)


def zipkin_url():
    ip = subprocess.run(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", ZIPKIN],
                        capture_output=True, text=True).stdout.split()
    if not ip:
        raise SystemExit(f"{ZIPKIN} is not running")
    return f"http://{ip[0]}:9411"


def get(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


def healthy(z):
    try:
        with urllib.request.urlopen(f"{z}/health", timeout=5) as r:
            return r.status == 200 and b"UP" in r.read()
    except Exception:
        return False


def clear(wait_s=180):
    """Restart Zipkin (its in-memory store is emptied) and wait until it answers again."""
    t0 = time.time()
    r = subprocess.run(["docker", "restart", ZIPKIN], capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise RuntimeError(f"docker restart {ZIPKIN}: {r.stderr.strip()[-200:]}")
    z = zipkin_url()
    while time.time() - t0 < wait_s:
        if healthy(z):
            return {"t": t0, "seconds": round(time.time() - t0, 1), "ok": True}
        time.sleep(2)
    return {"t": t0, "seconds": round(time.time() - t0, 1), "ok": False}


class Fetcher:
    """Collects the spans of [cursor, b] slice by slice and advances the cursor. Used once after the window, or
    every POLL_S while it runs: Zipkin's in-memory store evicts the oldest traces when MEM_MAX_SPANS is reached,
    which at sampler 1.0 takes ~12 min (the evicted slices answer empty, not with an error)."""

    def __init__(self, start_ms, slice_s=10.0, limit=LIMIT):
        self.z = zipkin_url() + "/api/v2"
        self.cursor, self.step, self.limit, self.slice_s = int(start_ms), int(slice_s * 1000), limit, slice_s
        self.spans, self.stat, self.failures = {}, collections.Counter(), []
        self.started, self.lock = time.time(), threading.Lock()

    def fetch_until(self, t1):
        with self.lock:
            t1 = int(t1)
            todo = collections.deque((s, min(s + self.step, t1)) for s in range(self.cursor, t1, self.step))
            while todo:
                a, b = todo.popleft()
                q = urllib.parse.urlencode({"endTs": b, "lookback": b - a, "limit": self.limit})
                trs, err = None, None
                for attempt in range(3):
                    try:
                        self.stat["queries"] += 1
                        trs = get(f"{self.z}/traces?{q}")
                        break
                    except Exception as e:
                        err = f"{type(e).__name__}: {e}"[:160]
                        time.sleep(2 * (attempt + 1))
                full = trs is not None and len(trs) >= self.limit
                if (trs is None or full) and b - a > MIN_SLICE_MS:
                    m = (a + b) // 2
                    todo.appendleft((m, b))
                    todo.appendleft((a, m))
                    self.stat["splits"] += 1
                    continue
                if trs is None:
                    self.failures.append({"from": a, "to": b, "error": err})
                    continue
                if full:
                    self.stat["fullAtMinSlice"] += 1
                self.stat["slices"] += 1
                for tr in trs:
                    for s in tr:
                        if any(x in s.get("name", "") for x in NOISE):
                            continue
                        key = (s["traceId"], s["id"], s.get("kind"), s.get("localEndpoint", {}).get("serviceName"))
                        self.spans.setdefault(key, s)
            self.cursor = max(self.cursor, t1)


class Poller(threading.Thread):
    """Fetches up to now - LAG_S every POLL_S while the window runs (the queries are a few seconds per poll)."""

    def __init__(self, fetcher, poll_s=POLL_S, lag_s=LAG_S):
        super().__init__(daemon=True)
        self.fetcher, self.poll_s, self.lag_s, self.stop, self.polls = fetcher, poll_s, lag_s, threading.Event(), 0

    def run(self):
        while not self.stop.wait(self.poll_s):
            try:
                self.fetcher.fetch_until((time.time() - self.lag_s) * 1000)
                self.polls += 1
            except Exception as e:
                self.fetcher.failures.append({"poll": time.time(), "error": f"{type(e).__name__}: {e}"[:160]})


def fetch(d, slice_s=10.0, limit=LIMIT, fetcher=None, sampler=None, polls=0):
    """The window's spans -> spans.json.gz. With `fetcher` (a Poller ran during the window) only the rest is fetched.
    A steady segment whose requests should have left traces (requests x sampler >= 10) but has fewer than 0.3 x
    the expected request traces makes the fetch incomplete (`emptySegments`): an empty answer is not an error."""
    meta = json.load(open(os.path.join(d, "meta.json")))
    t0, t1 = int(meta["t0"] * 1000) - 5000, int(meta["t_end"] * 1000) + 5000
    if fetcher is None:
        fetcher = Fetcher(t0, slice_s, limit)
    fetcher.fetch_until(t1)
    out = list(fetcher.spans.values())
    with gzip.open(os.path.join(d, "spans.json.gz"), "wt") as f:
        json.dump(out, f)
    empty = []
    if sampler:
        for seg, c in check(d).items():
            if seg.split(":")[0].split(".")[0] in NO_GATEWAY:
                continue
            if c["requests"] * sampler >= 10 and c["requestTraces"] < 0.3 * sampler * c["requests"]:
                empty.append({"segment": seg, "requests": c["requests"], "requestTraces": c["requestTraces"]})
    res = dict(fetcher.stat, spans=len(out), traces=len({s["traceId"] for s in out}), failures=fetcher.failures,
               emptySegments=empty, polls=polls, sampler=sampler, sliceS=fetcher.slice_s, limit=fetcher.limit,
               seconds=round(time.time() - fetcher.started, 1), complete=not fetcher.failures and not empty)
    json.dump(res, open(os.path.join(d, "spans_fetch.json"), "w"), indent=1)
    return res


def check(d):
    """Per steady segment: requests sent (ok), traces and spans that start in the segment, spans per request."""
    spans = json.load(gzip.open(os.path.join(d, "spans.json.gz"), "rt"))
    meta = json.load(open(os.path.join(d, "meta.json")))
    seg = collections.defaultdict(lambda: [1e20, 0.0, 0])
    with open(os.path.join(d, "requests.csv")) as f:
        for r in csv.DictReader(f):
            if not r["phase"].endswith(":steady") or r["ok"] != "1":
                continue
            t = float(r["epoch_send"])
            x = seg[r["phase"]]
            x[0], x[1], x[2] = min(x[0], t), max(x[1], t), x[2] + 1
    first = {}
    for s in spans:                       # a trace belongs to the segment its first span starts in
        t = s["timestamp"] / 1e6
        if s["traceId"] not in first or t < first[s["traceId"]]:
            first[s["traceId"]] = t
    per_trace = collections.Counter(s["traceId"] for s in spans)
    # request traces: the gateway's sidecar calls a subgraph (the gateway itself exports nothing); everything else is
    # background (scheduled jobs, Dapr, event follow-ups that start their own trace)
    gw = {s["traceId"] for s in spans if s.get("localEndpoint", {}).get("serviceName") == "gateway"}
    res = {}
    for name, (a, b, n) in sorted(seg.items(), key=lambda kv: kv[1][0]):
        tids = [t for t, ts in first.items() if a - 0.2 <= ts <= b + 1.0]
        req = [t for t in tids if t in gw]
        ns = sum(per_trace[t] for t in req)
        res[name] = {"requests": n, "requestTraces": len(req), "requestSpans": ns,
                     "requestTracesPerRequest": round(len(req) / n, 3) if n else None,
                     "requestSpansPerRequest": round(ns / n, 2) if n else None,
                     "backgroundTracesPerS": round((len(tids) - len(req)) / max(b - a, 1e-9), 2)}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["clear", "fetch", "check"])
    ap.add_argument("dir", nargs="?")
    ap.add_argument("--slice", type=float, default=10.0)
    ap.add_argument("--limit", type=int, default=LIMIT)
    a = ap.parse_args()
    if a.cmd == "clear":
        r = clear()
    elif a.cmd == "fetch":
        r = fetch(a.dir, a.slice, a.limit)
    else:
        r = check(a.dir)
    print(json.dumps(r, indent=1))
    return 0 if (a.cmd != "clear" or r["ok"]) and (a.cmd != "fetch" or r["complete"]) else 1


if __name__ == "__main__":
    sys.exit(main())
