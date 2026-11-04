#!/usr/bin/env python3
"""Envelope vs work per event handler, publish per sender, delivery hops (timing/README.md §6).

    envelope.py WINDOW...                       per window: analysis/envelope.json (profile parts, deliveries, hops)

parts.py embeds the result as parts.json `envelope` (from_parts, over the --on windows).

Method (README.md §6.2). The instrumented windows run async-profiler on every app (asprof/*.collapsed.gz). Every
sample is classified twice: by buckets.yaml (profile_buckets.Classifier, as for the shares) and by the envelope
markers below. Instrumentation samples are left out, gc/jit are spread in proportion (as parts.py does). Scanning a
stack from the leaf, the first marker frame decides (tx, decode, publish, invoke); the scan stops at the first
business frame (bucket resolver or graphql, not a marker), so work running in a continuation under a commit or a body
decoder stays work. Without a marker: bucket dapr-client -> client (WebClient I/O of publishes and invocations, split
by their marker CPU), bucket http -> dispatch (Netty server, WebFlux dispatch, response write), else work (business
code, statements: db-driver, mapping, serialisation in the handler).

Per (request type, container): the parts' shares x the container's production CPU per request (parts.json
requests[t].containers[c].D) = ms per request; inbound requests per request (spans: SERVER spans of the app under a
subscriber daprd `pubsub/<topic>` span, and the other inbound SERVER spans: entry fetch, invocations, provider
callbacks) give dispatch + decode + tx per inbound request; publishes per request (app spans `publish <topic>`) give
the app's publish CPU per publish. Spans are sampled per trace (trace-id ratio), so the ratios are unbiased. The
gateway exports nothing and its sidecar starts one trace per subgraph fetch, so span_stats counts per request trace
(= per fetch); per_operation multiplies by the plan's fetches per request (compose_check.path_structure) to get per
request (two-fetch types: address, product, ...; at sampler 1: product 2.05 request traces per request).

Delivery hops (spans, wall time, one host clock): per topic and subscriber the sender app's publish span, the sender
daprd's publish span, broker = subscriber daprd span start - sender daprd span start, sidecarToApp = app SERVER span
start - subscriber daprd span start, deliveryOverhead = subscriber daprd span - app SERVER span (ecs proxy + daprd).
"""
import argparse
import collections
import gzip
import json
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import profile_buckets as pb  # noqa: E402

# marker frames (substring match); the first one from the leaf decides. Since misarch-kotlin unify every service
# publishes through libs/common's EventPublisher (EventJson), calls through DaprServiceInvoker and decodes its
# CloudEvent bodies with Spring's Jackson decoder (EventController's @RequestBody); the per-port frames (order's
# OrderEventPublisher, media's and invoice's own publish, nest's and the Rust ports' decoders) stay for the windows up
# to approx3. The mechanisms build's CallerCache (inside DaprServiceInvoker.graphql) stays work, as in approx3.
MARKERS = (
    ("publish", ("org/misarch/common/event/EventPublisher", "org/misarch/common/event/EventJson",
                 "org/misarch/order/event/OrderEventPublisher", "MediaService.publishMediaCreated",
                 "InvoiceService.publishInvoiceCreated")),
    ("invoke", ("org/misarch/common/event/DaprServiceInvoker",)),
    ("tx", ("org/springframework/r2dbc/connection/R2dbcTransactionManager",
            "org/springframework/transaction/reactive/AbstractReactiveTransactionManager",
            "io/r2dbc/pool/PooledConnection.beginTransaction", "io/r2dbc/pool/PooledConnection.commitTransaction",
            "io/r2dbc/pool/PooledConnection.rollbackTransaction",
            "io/r2dbc/postgresql/PostgresqlConnection.beginTransaction",
            "io/r2dbc/postgresql/PostgresqlConnection.commitTransaction",
            "io/r2dbc/postgresql/PostgresqlConnection.rollbackTransaction")),
    ("decode", ("org/springframework/core/codec/AbstractCharSequenceDecoder",
                "org/springframework/core/codec/AbstractDataBufferDecoder",
                "org/springframework/core/codec/StringDecoder", "org/springframework/core/codec/ByteArrayDecoder",
                "org/springframework/http/codec/AbstractJacksonDecoder", "org/springframework/http/codec/JacksonJsonDecoder",
                "org/springframework/http/codec/json/AbstractJackson", "org/springframework/http/codec/json/Jackson",
                "org/springframework/http/codec/DecoderHttpMessageReader",
                "org/springframework/web/reactive/result/method/annotation/AbstractMessageReaderArgumentResolver",
                "org/springframework/web/reactive/function/BodyExtractors",
                "org/misarch/common/nest/NestRest.parseBody", "org/misarch/common/nest/ClassValidator",
                "org/misarch/common/rust/AxumJson", "EventDataKt.decodeEnvelope", "/event/EventDtos")),
)
BUSINESS = ("resolver", "graphql")
# frames of the bucket resolver that are not business code: the event envelope's data classes (libs/common's
# CloudEvent, the services' event DTOs), run by the Jackson decoder (decode) or by EventJson (publish); the scan goes
# on past them to the marker that runs them, instead of stopping there as work
NOT_BUSINESS = ("org/misarch/common/event/CloudEvent", "/event/model/")
PUBLISH = dict(MARKERS)["publish"]
# outbound HTTP client frames (WebClient / Reactor Netty client): a decode or tx marker leaf-ward of these is the
# client's response processing, not the inbound envelope
CLIENT = ("org/springframework/web/reactive/function/client/", "reactor/netty/http/client/")
PARTS = ("dispatch", "decode", "tx", "publish", "invoke", "client", "work")
RECEIVE = ("dispatch", "decode", "tx")
DAPR_LIB = "dapr-diagnostics"


class EnvelopeClassifier:
    def __init__(self):
        self.cl = pb.Classifier()
        self.cache = {}

    def marker(self, f):
        r = self.cache.get(f)
        if r is None:
            r = ""
            for name, pats in MARKERS:
                if any(p in f for p in pats):
                    r = name
                    break
            if not r and self.cl.frame(f)[0] in BUSINESS and self.cl.frame(f)[1] \
                    and not any(p in f for p in NOT_BUSINESS):
                r = "!business"
            self.cache[f] = r
        return r

    def stack(self, frames):
        b = self.cl.stack(frames)
        if self.cl.parts.get(b) == "instrumentation":
            return "instrumentation"
        if b in ("gc", "jit", "gc+jit"):
            return b
        seg = []
        for f in reversed(frames):            # leaf -> root, up to the first business frame
            m = self.marker(f)
            if m == "!business":
                break
            seg.append((f, m))
        if any(f.startswith(CLIENT) for f, _ in seg):
            if any(any(p in f for p in PUBLISH) for f in frames):
                return "publish"
            if any("org/misarch/common/event/DaprServiceInvoker" in f for f in frames):
                return "invoke"
            return "client"
        for f, m in seg:
            if m:
                return m
        if b == "dapr-client":
            return "client"
        if b == "http":
            return "dispatch"
        return "work"


def classify_file(ec, path):
    c = collections.Counter()
    for frames, n in pb.read_folded(path):
        c[ec.stack(frames)] += n
    return c


def profile_parts(d, ec=None):
    """{segment: {container: {part: net ms}}} (idle rates subtracted per part, as profile_buckets does)."""
    ec = ec or EnvelopeClassifier()
    hooks = common.load_json(d, "hooks.json", {})
    ivms = pb.interval_ms(hooks)
    segs = common.segments(d)
    seg_by_file = {common.segname(s): s for s in segs}
    adir = os.path.join(d, "asprof")
    raw = {}
    if os.path.isdir(adir):
        for f in sorted(os.listdir(adir)):
            fseg, _, rest = f.partition("__")
            seg = seg_by_file.get(fseg)
            if seg is None:
                continue
            raw[(seg, rest.split(".collapsed")[0])] = classify_file(ec, os.path.join(adir, f))
    idle = {}
    if "idle" in segs:
        dur = segs["idle"]["end"] - segs["idle"]["start"]
        for (seg, c), b in raw.items():
            if seg == "idle" and dur > 0:
                idle[c] = {k: v * ivms / dur for k, v in b.items()}
    out = collections.defaultdict(dict)
    for (seg, c), b in raw.items():
        if seg == "idle":
            continue
        dur = segs[seg]["end"] - segs[seg]["start"]
        out[seg][c] = {k: round(max(0.0, v * ivms - idle.get(c, {}).get(k, 0.0) * dur), 1) for k, v in b.items()}
    return dict(out)


def shares(ms):
    """Part shares of a container's CPU without instrumentation and jit; gc spread in proportion. The client part
    (WebClient I/O) goes to publish and invoke in proportion to their marker CPU (all to publish if neither)."""
    p = {k: ms.get(k, 0.0) for k in PARTS}
    pub, inv = p["publish"], p["invoke"]
    if pub + inv > 0:
        p["publish"] += p["client"] * pub / (pub + inv)
        p["invoke"] += p["client"] * inv / (pub + inv)
    else:
        p["publish"] += p["client"]
    p["client"] = 0.0
    tot = sum(p.values())
    if tot <= 0:
        return None
    return {k: v / tot for k, v in p.items() if k != "client"}


# ------------------------------------------------------------------------------------------------ spans

def load_spans(d):
    p = os.path.join(d, "spans.json.gz")
    if not os.path.exists(p):
        return []
    with gzip.open(p, "rt") as f:
        return json.load(f)


def span_stats(d, spans=None):
    """Per steady segment type: request traces, inbound deliveries and publishes per request trace per app (a request
    trace is one gateway subgraph fetch: `*PerReq` here is per trace, per_operation scales it to per request);
    delivery hops per (topic, subscriber) over the window (µs lists summarised in ms)."""
    spans = spans if spans is not None else load_spans(d)
    segs = {s: v for s, v in common.segments(d).items() if s.endswith(":steady")}
    by_id = {x["id"]: x for x in spans}
    traces = collections.defaultdict(list)
    for x in spans:
        traces[x["traceId"]].append(x)
    out = {}
    for seg, iv in segs.items():
        t0, t1 = iv["start"] * 1e6, iv["end"] * 1e6
        n_req = 0
        deliv = collections.defaultdict(collections.Counter)
        pubs = collections.defaultdict(collections.Counter)
        inbound = collections.Counter()
        for tid, xs in traces.items():
            first = min(x["timestamp"] for x in xs)
            # a request trace the apps sampled (daprd samples every trace, the apps 1 in 1/sampler)
            if not (t0 <= first < t1) or not any(x["localEndpoint"]["serviceName"] == "gateway" for x in xs) \
                    or not any(x.get("kind") == "SERVER" and x.get("tags", {}).get("otel.library.name") != DAPR_LIB
                               for x in xs):
                continue
            n_req += 1
            for x in xs:
                svc = x["localEndpoint"]["serviceName"]
                if x.get("kind") == "SERVER" and x.get("tags", {}).get("otel.library.name") != DAPR_LIB:
                    p = by_id.get(x.get("parentId"))
                    if p and p.get("kind") == "CLIENT" and p["name"].startswith("pubsub/"):
                        deliv[svc][p["name"][len("pubsub/"):]] += 1
                    elif not any(h in x["name"] for h in ("health", "/dapr/", "/timing/")):
                        inbound[svc] += 1       # entry request, invocation, provider callback
                elif x.get("kind") == "CLIENT" and x["name"].startswith("/v1.0/publish/"):
                    pubs[svc][x["name"].split("/", 4)[4]] += 1      # sender daprd: /v1.0/publish/<pubsub>/<topic>
        if n_req:
            out[seg.split(":")[0]] = {
                "requestTraces": n_req,
                "otherInboundPerReq": {c: round(v / n_req, 4) for c, v in sorted(inbound.items())},
                "deliveriesPerReq": {c: {t: round(v / n_req, 4) for t, v in sorted(cnt.items()) if t != "heartbeat"}
                                     for c, cnt in sorted(deliv.items())},
                "publishesPerReq": {c: {t: round(v / n_req, 4) for t, v in sorted(cnt.items()) if t != "heartbeat"}
                                    for c, cnt in sorted(pubs.items())}}
    hops = collections.defaultdict(lambda: collections.defaultdict(list))
    for x in spans:
        if x.get("kind") != "CLIENT" or not x["name"].startswith("pubsub/"):
            continue
        topic = x["name"][len("pubsub/"):]
        if topic == "heartbeat":
            continue
        pub = by_id.get(x.get("parentId"))           # sender daprd /v1.0/publish/<pubsub>/<topic>
        if not pub or "/publish/" not in pub["name"]:
            continue
        key = (topic, x["localEndpoint"]["serviceName"])
        h = hops[key]
        h["daprPublish"].append(pub["duration"])
        h["broker"].append(x["timestamp"] - pub["timestamp"])
        post = by_id.get(pub.get("parentId"))
        app_pub = by_id.get(post.get("parentId")) if post else None
        if app_pub and app_pub["name"].startswith("publish "):
            h["appPublish"].append(app_pub["duration"])
        srv = [y for y in traces[x["traceId"]] if y.get("parentId") == x["id"] and y.get("kind") == "SERVER"]
        if srv:
            h["sidecarToApp"].append(srv[0]["timestamp"] - x["timestamp"])
            h["deliveryOverhead"].append(x["duration"] - srv[0]["duration"])
            h["handler"].append(srv[0]["duration"])
    hop_out = {}
    for (topic, sub), h in sorted(hops.items()):
        hop_out[f"{topic} -> {sub}"] = {"n": len(h["broker"]), **{
            k: {"p50": round(st.median(v) / 1000, 3), "mean": round(st.mean(v) / 1000, 3),
                "p90": round(sorted(v)[int(0.9 * (len(v) - 1))] / 1000, 3)} for k, v in h.items() if v}}
    return {"types": out, "hops": hop_out}


def analyse_window(d):
    d = common.window_dir(d)
    r = {"window": os.path.basename(d), "profileParts": profile_parts(d), **span_stats(d)}
    os.makedirs(os.path.join(d, "analysis"), exist_ok=True)
    json.dump(r, open(os.path.join(d, "analysis", "envelope.json"), "w"), indent=1)
    return r


def ensure(d):
    p = os.path.join(common.window_dir(d), "analysis", "envelope.json")
    if os.path.exists(p) and os.path.getmtime(p) >= os.path.getmtime(__file__):
        return json.load(open(p))
    return analyse_window(d)


# ------------------------------------------------------------------------------------------------ per operation

def handler_op(svc, topic, ops):
    """Operation id of the handler of `topic` in `svc` (domain ids `svc.on:<topic>`; shared routes join topics)."""
    for t in topic.split("|"):
        o = f"{svc}.on:{t}"
        if o in ops:
            return o
    return None


def fetches_of(mp):
    """t -> gateway subgraph fetches per request (request traces per request; at least 1)."""
    import compose_check
    return lambda t: max(1, compose_check.path_structure(mp, t)[1])


def check_inbound(rows, plan_services, fetches):
    """Every plan container gets at least one inbound request per request (its subgraph fetch), and the plan
    containers together at least one per fetch; sampling noise allowed (rows of >= 300 sampled ms). A request with
    two fetches counted per trace gives ~0.5 per container and 1 in all. -> list of problems."""
    out = []
    by_t = collections.defaultdict(dict)
    for r in rows:
        if r["entry"] and r["sampledMs"] >= 300:
            by_t[r["type"]][r["container"]] = r["otherInboundPerReq"]
    for t, cs in sorted(by_t.items()):
        low = {c: v for c, v in cs.items() if v < 0.75}
        if low:
            out.append(f"{t}: plan container(s) with < 1 inbound request per request: {low}")
        if set(cs) == set(plan_services(t)) and sum(cs.values()) < 0.85 * fetches(t):
            out.append(f"{t}: {round(sum(cs.values()), 4)} inbound requests per request over the plan containers "
                       f"{sorted(cs)}, {fetches(t)} subgraph fetches")
    return out


def per_operation(win_results, parts_json, ops, plan_services, fetches):
    """Combine windows: per (type, container) the receive envelope per inbound request, publish per publish, work per
    request; then per handler operation the median over the types it ran in. `plan_services(t)` -> services with a
    plan operation of t; `fetches(t)` -> gateway subgraph fetches per request, i.e. request traces per request (the
    span counts are per trace). Returns (operations, senders, rows)."""
    reqs = parts_json["requests"]
    rows = []
    for w in win_results:
        for seg, conts in w["profileParts"].items():
            t = seg.split(":")[0]
            if not seg.endswith(":steady") or t not in reqs or t not in w["types"]:
                continue
            sp = w["types"][t]
            f = fetches(t)
            for c, ms in conts.items():
                rc = reqs[t]["containers"].get(c)
                sh = shares(ms)
                if not rc or not sh or rc["D"] < 0.2:
                    continue
                D = rc["D"]
                dl = {k: round(v * f, 4) for k, v in sp["deliveriesPerReq"].get(c, {}).items()}
                other = sp.get("otherInboundPerReq", {}).get(c, 0.0) * f
                n_in = sum(dl.values()) + other
                n_pub = sum(sp["publishesPerReq"].get(c, {}).values()) * f
                rem = rc.get("requestOverheadMs")      # the counters remainder of the container
                rows.append({"type": t, "container": c, "D": D, "countersRemainderMs": rem,
                             "shares": {k: round(v, 4) for k, v in sh.items()},
                             "inboundPerReq": round(n_in, 4), "deliveriesPerReq": dl,
                             "publishesPerReq": round(n_pub, 4), "entry": c in plan_services(t),
                             "otherInboundPerReq": round(other, 4),
                             "sampledMs": round(sum(ms.values()), 1)})
    bad = check_inbound(rows, plan_services, fetches)
    if bad:
        raise ValueError("envelope: inbound requests per request inconsistent with the plan's subgraph fetches:\n  "
                         + "\n  ".join(bad))
    ops_out = collections.defaultdict(lambda: collections.defaultdict(list))
    senders = collections.defaultdict(list)
    for r in rows:
        D, sh = r["D"], r["shares"]
        if r["publishesPerReq"] >= 0.2 and r["sampledMs"] >= 300:
            senders[r["container"]].append(D * sh["publish"] / r["publishesPerReq"])
        if r["inboundPerReq"] < 0.2 or r["sampledMs"] < 300:
            continue
        per_in = {k: D * sh[k] / r["inboundPerReq"] for k in RECEIVE}
        if r.get("countersRemainderMs") is not None and not r["entry"]:
            per_in["countersRemainder"] = r["countersRemainderMs"] / r["inboundPerReq"]
        work_req = D * sh["work"]
        dl = r["deliveriesPerReq"]
        n_dl = sum(dl.values())
        for topic, n in dl.items():
            o = handler_op(r["container"], topic, ops)
            if o is None or n < 0.2:
                continue
            e = ops_out[o]
            for k, v in per_in.items():
                e[k].append(v)
            # work of the container in t, split over its handlers by the parts' own + access CPU of each handler
            # in t (per request: parts.json's values are per execution, README.md §3.5)
            eo = common.parts_operation(parts_json, o) or {}
            pe = common.request_parts(eo, r["type"]) if r["type"] in eo.get("byRequest", {}) else None
            if not r["entry"] and pe is not None:
                mine = pe["ownCpuMs"] + sum(a["mapCpuMs"] for a in pe["accesses"])
                allh = 0.0
                for t2, n2 in dl.items():
                    o2 = handler_op(r["container"], t2, ops)
                    e2 = (common.parts_operation(parts_json, o2) or {}) if o2 else {}
                    x = common.request_parts(e2, r["type"]) if r["type"] in e2.get("byRequest", {}) else None
                    if x:
                        allh += x["ownCpuMs"] + sum(a["mapCpuMs"] for a in x["accesses"])
                if allh > 0:
                    e["work"].append(work_req * mine / allh / n)
            elif not r["entry"] and n_dl > 0:
                e["work"].append(work_req / n_dl)
            e["types"].append(r["type"])
    return ops_out, senders, rows


def from_parts(pj, on_dirs):
    """parts.json `envelope` (parts.py): envelope.py on the instrumented windows with this parts.json's totals and
    per-operation splits (counters), the sidecar delivery CPU from its mechanisms section (block 6)."""
    import queries
    mp = queries.Mapping()
    wins = [ensure(d) for d in on_dirs]

    def plan_services(t):
        return {mp.ops[o]["service"] for o, role in mp.request_ops(t) if role == "plan"}

    ops_out, senders, rows = per_operation(wins, pj, mp.ops, plan_services, fetches_of(mp))
    mech = (pj.get("mechanisms") or {}).get("parameters", {})
    mw = pj.get("middleware", {})
    deliver = (mech.get("deliverCpuMs") or {}).get("value") or mw.get("deliverCpuMs")
    hops = collections.defaultdict(list)
    for w in wins:
        for k, h in w["hops"].items():
            hops[k].append(h)
    v3 = pj.get("version") == 3
    return build_output(ops_out, senders, rows, hops, pj, mp, deliver, mw.get("publishCpuMs"),
                        source=f"envelope.py on {','.join(os.path.basename(d) for d in on_dirs)} x this parts.json; "
                               f"deliveryCpuMs from {'mechanisms (block 6)' if mech.get('deliverCpuMs') else 'middleware'}",
                        flag="measured-v3" if v3 else "estimate-v2")


def med(v):
    return round(st.median(v), 4) if v else None


def build_output(ops_out, senders, rows, hops, pj, mp, deliver_ms, sidecar_publish_ms, source, flag):
    handlers = [o for o, x in mp.ops.items() if x["kind"] == "reaction" and "topic" in (x.get("trigger") or {})]
    # container-level fallback for handlers without an own measurement: median per inbound request of the container
    by_cont = collections.defaultdict(lambda: collections.defaultdict(list))
    for o, e in ops_out.items():
        for k in RECEIVE:
            by_cont[mp.ops[o]["service"]][k] += e[k]
    allc = collections.defaultdict(list)
    for c, e in by_cont.items():
        for k in RECEIVE:
            allc[k] += e[k]
    fr = collections.defaultdict(list)
    for r in rows:
        sh = r["shares"]
        den = sh["work"] + sum(sh[k] for k in RECEIVE)
        if den > 0 and r["sampledMs"] >= 300:
            fr[r["container"]].append(sh["work"] / den)
    rho_c = {c: st.median(v) for c, v in fr.items()}
    rho_all = st.median([x for v in fr.values() for x in v]) if fr else 0.5
    operations = {}
    for o in sorted(handlers):
        svc = mp.ops[o]["service"]
        e = ops_out.get(o)
        if e and e["dispatch"]:
            src, parts_ = "measured", {k: med(e[k]) for k in RECEIVE}
        elif by_cont.get(svc) and by_cont[svc]["dispatch"]:
            src, parts_ = "container", {k: med(by_cont[svc][k]) for k in RECEIVE}
        else:
            src, parts_ = "pooled", {k: med(allc[k]) for k in RECEIVE}
        idem = [a for a in mp.ops[o].get("accesses", []) if "idempot" in (a.get("note") or "").lower()]
        work = med(e["work"]) if e and e["work"] else None
        work_from = "profile x totals" if work is not None else None
        if work is None:
            pe = pj["operations"].get(o)
            if pe:     # own + access CPU of the operation (parts.json) x the container's work fraction
                rho = rho_c.get(svc) or rho_all
                work = round((pe["ownCpuMs"] + sum(a["mapCpuMs"] for a in pe["accesses"])) * rho, 4)
                work_from = f"parts.json own + access x work fraction {round(rho, 3)}"
        env_app = round(sum(v or 0 for v in parts_.values()), 4)
        operations[o] = {
            "service": svc, "topic": mp.ops[o]["trigger"]["topic"],
            "workCpuMs": work,
            "envelopeCpuMs": round(env_app + (deliver_ms or 0), 4),
            "envelopeParts": {"dispatchCpuMs": parts_["dispatch"], "decodeCpuMs": parts_["decode"],
                              "txCpuMs": parts_["tx"], "idempotencyCpuMs": 0.0,
                              "deliveryCpuMs": deliver_ms},
            "envelopeAppCpuMs": env_app,
            "idempotencyCheck": [f"{a['class']} {a['mode']} via {a.get('via') or a.get('at')}" for a in idem] or None,
            "countersRemainderCpuMs": med(e["countersRemainder"]) if e and e.get("countersRemainder") else None,
            "from": src, "workFrom": work_from, "types": sorted(set(e["types"])) if e else [], "flag": flag}
    # callee side of a synchronous invocation (Dapr invoke; the sync saga step): containers that only serve calls in t
    cal = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        if r["entry"] or r["deliveriesPerReq"] or r["otherInboundPerReq"] < 0.2 or r["sampledMs"] < 300:
            continue
        for k in RECEIVE:
            cal[r["container"]][k].append(r["D"] * r["shares"][k] / r["otherInboundPerReq"])
        cal[r["container"]]["types"].append(r["type"])
    callees = {c: {"dispatchCpuMs": med(e["dispatch"]), "decodeCpuMs": med(e["decode"]), "txCpuMs": med(e["tx"]),
                   "envelopeAppCpuMs": round(sum(med(e[k]) or 0 for k in RECEIVE), 4),
                   "types": sorted(set(e["types"])), "flag": flag} for c, e in sorted(cal.items())}
    send = {}
    pooled_pub = [v for vs in senders.values() for v in vs]
    for svc in sorted({mp.ops[o]["service"] for o, x in mp.ops.items() if x.get("publishes")}):
        v = senders.get(svc)
        app = med(v) if v else med(pooled_pub)
        send[svc] = {"publishAppCpuMs": app, "publishSidecarCpuMs": sidecar_publish_ms,
                     "publishCpuMs": round((app or 0) + (sidecar_publish_ms or 0), 4),
                     "from": "measured" if v else "pooled", "n": len(v or []), "flag": flag}
    hop_out = {}
    for k, hs in sorted(hops.items()):
        n = sum(h["n"] for h in hs)
        hop_out[k] = {"n": n, **{f: round(sum(h[f]["p50"] * h["n"] for h in hs if f in h) /
                                      sum(h["n"] for h in hs if f in h), 3)
                                 for f in ("appPublish", "daprPublish", "broker", "sidecarToApp", "deliveryOverhead",
                                           "handler") if any(f in h for h in hs)}}
    res = {
        "schema": "timing/ENVELOPE.md", "version": 1, "source": source, "flag": flag,
        "units": "CPU ms per delivered event (handlers), per publish (senders), per request (requestOverheadCpuMs); "
                 "hops: wall ms p50 (n-weighted over windows)",
        "handlers": operations, "senders": send, "callees": callees,
        "requestOverhead": request_overhead(pj, mp, rows),
        "hopsMs": hop_out,
        "rows": rows,
    }
    return res


def request_overhead(pj, mp, rows):
    """requestOverheadCpuMs per request type, charged to its entry operation (the root resolver): parts.json's
    counters remainder of the entry container (README.md §3.3: HTTP, GraphQL parse/validate, serialisation, GC/JIT
    outside the operation counters), `from: counters`. Without counters: the entry container's dispatch + decode per
    inbound request (profile parts), `from: profile`."""
    prof = collections.defaultdict(list)
    for r in rows:
        if r["entry"] and r["inboundPerReq"] > 0:
            prof[r["type"]].append((r["container"],
                                    r["D"] * (r["shares"]["dispatch"] + r["shares"]["decode"]) / r["inboundPerReq"]))
    out = {}
    for t, r in pj["requests"].items():
        plan = [o for o in r.get("operations", []) if o in mp.ops]
        entry = plan[0] if plan else None
        ov, src = None, None
        if entry:
            ov = pj["operations"].get(entry, {}).get("byRequest", {}).get(t, {}).get("requestOverheadCpuMs")
            src = "counters" if ov is not None else None
        by_c = {}
        for c, v in prof.get(t, []):
            by_c.setdefault(c, []).append(v)
        by_c = {c: med(v) for c, v in sorted(by_c.items())}
        if ov is None and entry and mp.ops[entry]["service"] in by_c:
            ov, src = by_c[mp.ops[entry]["service"]], "profile"
        out[t] = {"entryOperation": entry, "requestOverheadCpuMs": ov, "from": src,
                  "byPlanContainer": by_c or None}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("windows", nargs="+")
    a = ap.parse_args()
    for w in a.windows:
        r = analyse_window(w)
        print(w, len(r["profileParts"]), "segments,", len(r["hops"]), "hops")


if __name__ == "__main__":
    main()
