#!/usr/bin/env python3
"""MiSArch's session usage model (../workload/sessions.json, ../workload/WORKLOAD.md): its calibration against
round 2 and the CLI (checks and PCM output). The interpreter of the session model (expectations, the usage model's
PCM text, the load profile) is the core's, core/generator/sessions.py, imported here, so that this module offers
both (timing/sessiongen.py and the derivation import it as `gen_sessions`). MiSArch's own: round 2's rates from the
msa model (load_msa, round2_rates, SESSIONS_PER_LOAD_FACTOR), the admin class's requests (ADMIN_MSA), the login
(LOGIN, Keycloak's role) and the workloads' design load (workload_rates).

    gen_sessions.py --check                      rates per operation and mix, compared with round 2
    gen_sessions.py --pcm OUT.m [--workload realistic|round2] [--sessions S]
                                                 the usage model as mdeo model text (the style of
                                                 the earlier unified project's gen_misarch.py, no
                                                 longer checked out: UsageScenario, OpenWorkload,
                                                 ScenarioBehaviour, Delay, Branch, Loop,
                                                 EntryLevelSystemCall; monitors per operation)
    gen_sessions.py --loadprofile OUT.json [--profile day|steady]
                                                 SimOxide's per-scenario load profile
                                                 (docs/guide/load-profile.md) for the profile

Calls name requests (`requests` in sessions.json): work package A's request types (round 2's
loadgen documents) or A's operation ids, each with its operations (A's plan) and its msa name.
Visit rates come out per request, per A operation and per msa operation.

A sketch: the PCM text uses the role and signature names of the unified project's MiSArch models
(MiSArch_provides_IGateway / IGateway_<op>, MiSArch_provides_IKeycloak / IKeycloak_token) and is
meant to replace their 36 one-call scenarios; the derivation in mdeo (step 4) will produce the
same structure from the domain model.
"""

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "core" / "generator"))
from sessions import *  # noqa: E402,F401,F403  (the core's interpreter)
from sessions import load_model as _load_model, usage_model  # noqa: E402

SESSIONS = HERE.parent / "workload" / "sessions.json"
MSA_MODEL = HERE.parent / "domain" / "msa" / "misarch-kotlin.m"
SESSIONS_PER_LOAD_FACTOR = 1.4074     # round 2: sessions/s at msa loadFactor 1 (msa DESIGN E26)
LOGIN = "login"


# ---------------------------------------------------------------------------------------------
# inputs

def load_model(path=SESSIONS):
    return _load_model(path)


def load_msa(path=MSA_MODEL):
    """Operations of the msa model: name -> dict(rate, cpu, db, kind); and System attributes."""
    ops, system = {}, {}
    for line in Path(path).read_text().splitlines():
        m = re.match(r"\s*op_\w+ : Operation \{(.*?)\}", line)
        if m:
            a = dict(re.findall(r'(\w+) = ("[^"]*"|\S+)', m.group(1)))
            name = a["name"].strip('"')
            ops[name] = dict(kind=a["kind"].split(".")[-1], rate=float(a["rate"]), cpu=float(a["cpuMs"]),
                             db=float(a["dbMs"]))
    text = Path(path).read_text()
    m = re.search(r"system : System \{(.*?)\n\}", text, re.S)
    if m:
        for k, v in re.findall(r"(\w+) = (\S+)", m.group(1)):
            try:
                system[k] = float(v)
            except ValueError:
                pass
    return ops, system


# ---------------------------------------------------------------------------------------------
# expectations over a behaviour

# ---------------------------------------------------------------------------------------------
# workloads

def round2_rates(msa_ops, sessions):
    """Round 2's client requests/s per operation at `sessions` (logins = sessions)."""
    lf = sessions / SESSIONS_PER_LOAD_FACTOR
    r = {k: o["rate"] * lf for k, o in msa_ops.items() if o["rate"] > 0}
    r[LOGIN] = sessions
    return r


ADMIN_MSA = {"createProductItemBatch", "createProductVariantVersion", "updateProduct", "createProduct",
             "createProductVariant", "updateProductVariant", "uploadMedia", "createDiscount", "createCoupon",
             "createCategory", "createTaxRate", "createTaxRateVersion", "createShipmentMethod",
             "createVendorAddress"}


def msa_of(model, req):
    return model["requests"][req]["msa"] or req          # login has no msa operation


def admin_reqs(model):
    return {r for r, x in model["requests"].items() if x["msa"] in ADMIN_MSA}


def to_msa(model, rates):
    out = {}
    for r, v in rates.items():
        k = msa_of(model, r)
        out[k] = out.get(k, 0.0) + v
    return out


def workload_rates(model, msa_ops, workload, mix=None, volume=1.0, sessions=None):
    """Per class: sessions/s; per operation: requests/s (customers and admin) for a workload
    (`round2` or `realistic`), a mix (realistic) and a volume factor."""
    w = model["workloads"][workload]
    stats = {c: class_stats(model, c) for c in model["classes"]}
    classes = {}
    if workload == "round2":
        design = sessions or w["designSessions"]
        for c, share in w["customers"].items():
            classes[c] = design * share * volume
        lf = design / SESSIONS_PER_LOAD_FACTOR
        classes[w["admin"]["class"]] = w["admin"]["sessionsPerSecondAtLoadFactor1"] * lf * volume
    else:
        r2 = model["workloads"][w["requestsEquivalentTo"]]
        r2_design = r2["designSessions"]
        target = sum(v for k, v in round2_rates(msa_ops, r2_design).items() if k not in ADMIN_MSA)
        base = w["mixes"][w["baseMix"]]["shares"]
        per_session = sum(base[c] * stats[c]["requests"] for c in base)
        design = target / per_session
        if sessions:
            design = sessions
        shares = w["mixes"][mix or w["baseMix"]]["shares"]
        tot = sum(shares.values())
        for c, s in shares.items():
            classes[c] = design * volume * s / tot
        admin_ops = sum(v for k, v in round2_rates(msa_ops, r2_design).items() if k in ADMIN_MSA)
        a = w["admin"]["class"]
        per = sum(x for k, x in stats[a]["visits"].items() if k != LOGIN)
        classes[a] = admin_ops / per          # constant: no volume
    ops = {}
    for c, rate in classes.items():
        for k, x in stats[c]["visits"].items():
            ops[k] = ops.get(k, 0.0) + rate * x
    return dict(design=design, classes=classes, ops=ops, stats=stats)


def request_rates(model, workload="realistic"):
    """{session request: requests/s} of a workload at its design load and base mix (workload_rates; derive.py weighs
    an operation's per-request parts by them, DESIGN.md AB69)."""
    msa_ops, _ = load_msa()
    return workload_rates(model, msa_ops, workload)["ops"]


def demand(msa_ops, system, ops, model=None):
    """CPU+DB ms per second of the operations' own work (msa demands) plus Keycloak's per login;
    `ops` keyed by msa name, or by request id with `model`."""
    if model is not None:
        ops = to_msa(model, ops)
    auth = system.get("authCpuMs", 15.7)
    d = 0.0
    for k, r in ops.items():
        if k == LOGIN:
            d += r * auth
        else:
            d += r * (msa_ops[k]["cpu"] + msa_ops[k]["db"])
    return d


def check(model):
    msa_ops, system = load_msa()
    browse = set(model["browseOperations"])
    r2 = model["workloads"]["round2"]["designSessions"]
    want = round2_rates(msa_ops, r2)
    got = workload_rates(model, msa_ops, "round2")
    got_msa = to_msa(model, got["ops"])
    bad = [(k, want.get(k, 0), got_msa.get(k, 0)) for k in sorted(set(want) | set(got_msa))
           if abs(want.get(k, 0) - got_msa.get(k, 0)) > 1e-6 * max(1.0, want.get(k, 0))]
    print(f"round2 as sessions at {r2} sessions/s: {len(want)} operations, "
          + ("rates equal round 2's" if not bad else f"MISMATCH {bad}"))
    stats = got["stats"]
    print("\nclasses: requests per session (logins included), mean think time per session")
    for c, s in stats.items():
        print(f"  {c:14s} {s['requests']:6.2f} req  {s['think']:6.1f} s   logins {s['visits'].get(LOGIN, 0):.2f}")
    r2_req = sum(v for k, v in want.items() if k not in ADMIN_MSA)
    r2_dem = demand(msa_ops, system, want)
    print(f"\nround 2 at {r2} sessions/s: {r2_req:.1f} customer req/s, {want[LOGIN]:.1f} logins/s, "
          f"{want['placeOrder']:.2f} orders/s, own demand {r2_dem / 1000:.2f} cores")
    w = model["workloads"]["realistic"]
    pg = page_shares(model)
    print("\npages per session (sampled; a page = the requests between two think times): pages, order pages")
    for c, (a, b) in pg.items():
        print(f"  {c:14s} {a:5.2f} {b:5.2f}")
    print(f"\nrealistic (design sessions from the {w['baseMix']} mix):")
    rows = []
    for mix in w["mixes"]:
        x = workload_rates(model, msa_ops, "realistic", mix)
        cust = {k: v for k, v in x["ops"].items() if k not in admin_reqs(model)}
        req = sum(cust.values())
        order = sum(v for k, v in cust.items() if k not in browse)
        sessions = sum(v for c, v in x["classes"].items() if c in w["mixes"][mix]["shares"])
        dem = demand(msa_ops, system, x["ops"], model)
        rows.append((mix, x))
        sh = w["mixes"][mix]["shares"]
        pages = sum(sh[c] * pg[c][0] for c in sh)
        opages = sum(sh[c] * pg[c][1] for c in sh)
        print(f"  {mix:9s} {sessions:6.1f} sessions/s  {req:6.1f} req/s  order share {order / req:5.1%}  "
              f"order pages {opages / pages:5.1%}  logins {cust.get(LOGIN, 0):5.1f}/s  orders {cust.get('placeOrder', 0):5.2f}/s  "
              f"own demand {dem / 1000:5.2f} cores ({dem / r2_dem:4.0%} of round 2)  "
              f"admin {x['classes'][w['admin']['class']]:.3f} sessions/s")
    x = dict(rows)[w["baseMix"]]
    print(f"\nper request at the design load (request id, msa name): round 2, realistic {w['baseMix']}:")
    xr = x["ops"]
    for r in sorted(model["requests"], key=lambda r: (-want.get(msa_of(model, r), 0), r)):
        print(f"  {r:38s} {msa_of(model, r):28s} {want.get(msa_of(model, r), 0):9.3f} {xr.get(r, 0):9.3f}")
    r2_ops = to_operations(model, got["ops"])
    re_ops = to_operations(model, xr)
    print(f"\nper A operation (domain/misarch-domain.json ids) at the design load: round 2, realistic {w['baseMix']}:")
    for op in sorted(set(r2_ops) | set(re_ops), key=lambda k: (-re_ops.get(k, 0), k)):
        print(f"  {op:44s} {r2_ops.get(op, 0):9.3f} {re_ops.get(op, 0):9.3f}")
    prof = model["profiles"]["day"]
    print("\nday profile:")
    t_end = prof["endSeconds"]
    phases = prof["phases"]
    acc_req, acc_t = 0.0, 0.0
    for i, ph in enumerate(phases):
        t1 = phases[i + 1]["from"] if i + 1 < len(phases) else t_end
        y = workload_rates(model, msa_ops, "realistic", ph["mix"], ph["volume"])
        req = sum(v for k, v in y["ops"].items() if k not in admin_reqs(model))
        lo = max(ph["from"], prof["warmUpSeconds"])
        if t1 > lo:
            acc_req += req * (t1 - lo)
            acc_t += t1 - lo
        dem = demand(msa_ops, system, y["ops"], model)
        print(f"  {ph['from']:6.0f}-{t1:6.0f} s {ph['name']:10s} volume {ph['volume']:.1f} {ph['mix']:9s} "
              f"{req:6.1f} req/s ({req / r2_req:4.0%} of round 2's design load; own demand {dem / r2_dem:4.0%})")
    print(f"  measured window mean: {acc_req / acc_t:.1f} req/s ({acc_req / acc_t / r2_req:.0%})")


# ---------------------------------------------------------------------------------------------
# outputs

def role_sig(model, req):
    """The unified project's role and signature of a request (by its msa name)."""
    if req == LOGIN:
        return "MiSArch_provides_IKeycloak", "IKeycloak_token"
    return "MiSArch_provides_IGateway", f"IGateway_{model['requests'][req]['msa']}"


def pcm(model, workload, sessions=None):
    msa_ops, _ = load_msa()
    x = workload_rates(model, msa_ops, workload, sessions=sessions)
    lines = usage_model(model, x, role_sig, "MiSArch")
    head = [f"// Session usage model ({workload}), generated by cases/misarch/generator/gen_sessions.py from "
            "cases/misarch/workload/sessions.json;",
            f"// design load {x['design']:.3f} sessions/s. Fragment: the usage model, monitors and measuring points of",
            "// the unified project's MiSArch models (their 36 one-call scenarios and RT monitors are replaced).", ""]
    return "\n".join(head + lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--pcm")
    ap.add_argument("--workload", default="realistic", choices=["realistic", "round2"])
    ap.add_argument("--sessions", type=float, help="design sessions/s (default: the workload's)")
    ap.add_argument("--loadprofile")
    ap.add_argument("--profile", default="day")
    a = ap.parse_args()
    model = load_model()
    if a.check:
        check(model)
    if a.pcm:
        Path(a.pcm).write_text(pcm(model, a.workload, a.sessions))
        print(f"wrote {a.pcm}")
    if a.loadprofile:
        lp = loadprofile(model, a.profile)
        rows = [f'  {{"scenarios": {json.dumps(e["scenarios"])}, "points": {json.dumps(e["points"])}}}'
                for e in lp["profiles"]]
        Path(a.loadprofile).write_text('{"profiles": [\n' + ",\n".join(rows) + "\n]}\n")
        print(f"wrote {a.loadprofile}")
    if not (a.check or a.pcm or a.loadprofile):
        ap.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
