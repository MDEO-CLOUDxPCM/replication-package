#!/usr/bin/env python3
"""MiSArch's platform parameters (generator/platform.json, the core's `platform` input; DESIGN.md AB52): the
middleware, infrastructure and cost constants the derivation reads as S[...] (core/generator/derive.py).

    platform.py            write generator/platform.json

Values: the System of round 2's msa model (../domain/msa/misarch-kotlin.m: calibrated hop, gateway, publish and
delivery costs, cores and cost rules), then the timing campaign's mechanism parameters that replace or extend them
(mechanisms(): ../timing/parts.json `mechanisms.parameters`, version 3, timing/RESULTS.md §5; DESIGN.md AB32, AB64).
The hop, gateway, publish and delivery costs stay round 2's (AB32.3; parts.json `middleware` is round 2's too).
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
MSA_MODEL = HERE.parent / "domain" / "msa" / "misarch-kotlin.m"     # round 2's msa model (was misarch-optimization, AB48)
OUT = HERE / "platform.json"
PARTS = HERE.parent / "timing" / "parts.json"                        # the campaign's parts (version 3)
# a cache's hit ratio where a site has none of its own: an assumption (a workload property; parts.json
# cacheHitRatio / callerCacheHitRatio: "not measured", the hot sets are 4 keys by construction)
CACHE_HIT_RATIO = 0.8


def mechanisms():
    """The campaign's mechanism parameters (parts.json `mechanisms.parameters`, timing/RESULTS.md §5; DESIGN.md AB64):
    - local copies: readDbMs per copy-read statement; readCpuMs the reader's net app CPU per createOrder answered from
      copies over its copy-read statements (approximate); writeCpuMs per delivered copy event (whole handler,
      approximate); writeDbMs per copy upsert;
    - the caller-side cache (CachedCall.hitCpuMs): the caller's app CPU per hit net of the saved call's client work
      (callerCacheHitCpuMs, -0.35 ms in v3: a hit saves the caller CPU), at least 0: the caller's measured own CPU
      keeps that client work and a demand cannot be negative;
    - the provider's entity cache (joinCache as built, DESIGN.md AB33.1): its CPU per hit (cacheHitCpuMs); a miss
      costs nothing more in the model (cacheMissOverheadCpuMs is `inModel: false`);
    - the orchestrator's step (Orchestrated.stepCpuMs, derived, AB33.7): one copy-upsert handler without its inbound
      part (replicaWriteCpuMs.extraUpsertOnly)."""
    pj = json.loads(PARTS.read_text())
    if pj.get("version") != 3:
        raise SystemExit(f"{PARTS}: version {pj.get('version')}, platform.py reads the mechanisms of version 3")
    m = pj["mechanisms"]["parameters"]
    reads = pj["mechanisms"]["localCopies"]["createOrder"]["copyRead"]["statementsPerRequest"]
    return dict(replicaReadDbMs=m["replicaReadDbMs"]["value"],
                replicaReadCpuMs=round(m["replicaReadCpuMs"]["value"] / reads, 4),
                replicaWriteCpuMs=m["replicaWriteCpuMs"]["value"],
                replicaWriteDbMs=m["replicaWriteDbMs"]["value"],
                cacheHitCpuMs=max(0.0, m["callerCacheHitCpuMs"]["value"]),
                cacheHitRatio=CACHE_HIT_RATIO,
                entityCacheHitCpuMs=m["cacheHitCpuMs"]["value"],
                entityCacheMissCpuMs=0.0,
                orchestratorStepCpuMs=m["replicaWriteCpuMs"]["extraUpsertOnly"])


def msa_system():
    text = MSA_MODEL.read_text()
    m = re.search(r"system : System \{(.*?)\n\}", text, re.S)
    out = {}
    for k, v in re.findall(r"(\w+) = (\S+)", m.group(1)):
        try:
            out[k] = float(v)
        except ValueError:
            pass
    return out


def main():
    s = msa_system()
    s.update(mechanisms())
    doc = {"about": "MiSArch's platform parameters (S[...] of core/generator/derive.py), written by "
                    "cases/misarch/generator/platform.py: round 2's msa System (domain/msa/misarch-kotlin.m), then the "
                    "campaign v3's mechanism parameters (timing/parts.json mechanisms.parameters)", "parameters": s}
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"{OUT}: {len(s)} parameters")


if __name__ == "__main__":
    main()
