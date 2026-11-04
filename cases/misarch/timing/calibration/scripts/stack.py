"""Which MiSArch stack the calibration tooling targets: the original deployment or the Kotlin port (misarch-kotlin,
the one the timing campaign measures).

Selected by `--stack original|kotlin` on the command line of any calibration script (read here, before argparse) or
by the environment variable MISARCH_STACK; default `original` (the timing campaign passes `--stack kotlin` or sets
MISARCH_STACK=kotlin). The choice is exported to MISARCH_STACK so that subprocesses (cpumon.py, redisq.py) follow it.

| | original | kotlin |
|---|---|---|
| containers | misarch-<svc>-1 (compose project misarch) | misarch-kotlin-<svc>-1 (project misarch-kotlin) |
| results | calibration/results/ | calibration/results-kotlin/ |
| deployment tooling | calibration/{up,down,set_limits}.sh | misarch-kotlin/deploy/compose/{up,down,set_limits}.sh |
| known defect deliveries (reaper) | review, invoice, user (README "Functional defects") | none (fixed) |
"""
import os
import sys

CAL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def _checkout(root, name):
    """The submodule <name>/ of the repository if it is checked out, else ../<name> beside the repository."""
    sub = os.path.join(root, name)
    return sub if os.path.isdir(sub) and os.listdir(sub) else os.path.join(os.path.dirname(root), name)


KOTLIN_REPO = os.environ.get("MISARCH_KOTLIN_REPO", _checkout(os.path.normpath(os.path.join(CAL, "..", "..", "..", "..")), "misarch-kotlin"))


def _from_argv():
    for i, a in enumerate(sys.argv):
        if a == "--stack" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if a.startswith("--stack="):
            return a.split("=", 1)[1]
    return None


STACK = _from_argv() or os.environ.get("MISARCH_STACK") or "original"
if STACK not in ("original", "kotlin"):
    raise SystemExit(f"unknown stack {STACK!r} (original|kotlin)")
os.environ["MISARCH_STACK"] = STACK
KOTLIN = STACK == "kotlin"

PREFIX = "misarch-kotlin-" if KOTLIN else "misarch-"
RESULTS = os.path.join(CAL, "results-kotlin" if KOTLIN else "results")

# Architecture variant of the Kotlin stack (misarch-kotlin docs/ARCHITECTURE-VARIANTS.md): MISARCH_ARCH=<variant> (or
# --arch <variant>) selects deploy/compose/docker-compose.<variant>.topology.json (written by gen_compose.py --variant)
# and the results directory results-kotlin/variants/<variant>/. Unset: everything as before.
ARCH = None
TOPOLOGY = None
for _i, _a in enumerate(sys.argv):
    if _a == "--arch" and _i + 1 < len(sys.argv):
        ARCH = sys.argv[_i + 1]
    elif _a.startswith("--arch="):
        ARCH = _a.split("=", 1)[1]
ARCH = ARCH or os.environ.get("MISARCH_ARCH") or None
if ARCH:
    if not KOTLIN:
        raise SystemExit("MISARCH_ARCH needs the kotlin stack")
    import json as _json
    os.environ["MISARCH_ARCH"] = ARCH
    _topo = os.path.join(KOTLIN_REPO, "deploy", "compose", f"docker-compose.{ARCH}.topology.json")
    if not os.path.exists(_topo):
        raise SystemExit(f"missing {_topo} (python3 gen_compose.py --variant variants/{ARCH}.yaml)")
    TOPOLOGY = _json.load(open(_topo))
    RESULTS = os.path.join(RESULTS, "variants", ARCH)
RAW = os.path.join(RESULTS, "raw")
STATE = os.environ.get("MISARCH_STATE") or os.path.join(RESULTS, "seed", "state.json")
POOLS = os.environ.get("MISARCH_POOLS") or os.path.join(RESULTS, "pools.json")
TOKENS = os.environ.get("MISARCH_TOKENS") or os.path.join(RESULTS, "tokens.json")
SET_LIMITS = os.path.join(KOTLIN_REPO, "deploy", "compose", "set_limits.sh") if KOTLIN else os.path.join(CAL, "set_limits.sh")

# Dapr pub/sub deliveries that fail because of known functional defects of the stack; the measurement reaper acks them
# after their first attempt (README "Functional defects"). The Kotlin stack fixes all of them: nothing is reaped, and
# window.json's redis_before/after show any pending entry.
DEFECT_GROUPS = [] if KOTLIN else [("discount/order/validation-succeeded", "invoice"),
                                   ("address/vendor-address/created", "invoice"),
                                   ("catalog/product-variant/created", "review"), ("user/user/create", "user")]


AGG = "sum:"   # key prefix of summed CPU series of replicated units (CpuData, architecture variants only)


def _arch_resolve(svc, live):
    """Architecture variant: plain-stack short name -> compose service of the variant (live=True: a running container,
    replica 1) or result key (live=False: the summed series `sum:<plain name>` for replicated units)."""
    conts, aggs, smap = TOPOLOGY["containers"], TOPOLOGY["aggregates"], TOPOLOGY["services"]
    if svc in conts:
        return svc
    if svc in aggs:
        return aggs[svc][0] if live else AGG + svc
    base, role = svc, "app"
    for suffix, r in (("-dapr", "dapr"), ("-ecs", "ecs"), ("-db", "db")):
        if svc.endswith(suffix) and svc[: -len(suffix)] in smap:
            base, role = svc[: -len(suffix)], r
    if base in smap:
        if role == "app" and not live:   # the app of a deployable is its unit (container total of all members)
            unit = smap[base]["unit"]
            return AGG + unit if unit in aggs else unit
        if role in smap[base]:
            return smap[base][role]
    return svc


def cname(svc):
    """service/container short name (e.g. 'order', 'order-dapr', 'dapr-redis') -> container name of this stack.
    Architecture variant: the result key that stands for it (replicated -> summed series, deployable member -> its
    deployable's container)."""
    if TOPOLOGY:
        r = _arch_resolve(svc, live=False)
        return f"{AGG}{PREFIX}{r[len(AGG):]}-1" if r.startswith(AGG) else f"{PREFIX}{r}-1"
    return f"{PREFIX}{svc}-1"


def live(svc):
    """Container to talk to (docker exec, IP): as cname(), but in an architecture variant a running container (replica
    1; a shared DB server for `<svc>-db`)."""
    if TOPOLOGY:
        return f"{PREFIX}{_arch_resolve(svc, live=True)}-1"
    return f"{PREFIX}{svc}-1"


def aggregates():
    """Architecture variant: {result key `sum:<prefix><name>-1`: [container names]} of replicated units, else {}."""
    if not TOPOLOGY:
        return {}
    return {f"{AGG}{PREFIX}{k}-1": [f"{PREFIX}{c}-1" for c in v] for k, v in TOPOLOGY["aggregates"].items()}


def is_stack(name):
    """True for the containers of the selected stack (the original's prefix 'misarch-' also matches the Kotlin one)."""
    if KOTLIN:
        return name.startswith("misarch-kotlin-")
    return name.startswith("misarch-") and not name.startswith("misarch-kotlin-")


def short(name):
    """container name -> short name without stack prefix and replica suffix ('misarch-kotlin-order-1' -> 'order';
    summed series of an architecture variant 'sum:misarch-kotlin-catalog-1' -> 'catalog')."""
    if name.startswith(AGG):
        name = name[len(AGG):]
    for p in ("misarch-kotlin-", "misarch-"):
        if name.startswith(p):
            n = name[len(p):]
            return n[:-2] if n.endswith("-1") else n
    return name


def restart_groups(svc):
    """Architecture variant: [[app container, its sidecars...] per replica] hosting `svc` (campaign.sh restart)."""
    conts = TOPOLOGY["containers"]
    unit = TOPOLOGY["services"].get(svc, {}).get("unit", svc)
    groups = []
    for c, e in conts.items():
        if (e["role"] == "app" and e.get("unit") == unit) or (c == svc and e["role"] in ("app", "infra")):
            side = [s for s, f in conts.items() if f.get("host") == c]
            groups.append([f"{PREFIX}{x}-1" for x in [c] + side])
    return groups


if __name__ == "__main__":   # stack.py restart-groups SVC... -> one line per app container: app sidecar...
    if len(sys.argv) > 2 and sys.argv[1] == "restart-groups":
        for s_ in sys.argv[2:]:
            for g in (restart_groups(s_) if TOPOLOGY else [[cname(s_)] + [cname(f"{s_}-{x}") for x in ("dapr", "ecs")]]):
                print(" ".join(g))
