#!/usr/bin/env python3
"""Check a case against the core's case interface (docs/case-interface.md): its manifest (case.json against
core/generator/schema/case.schema.json), that every input and MDEO directory exists, its JSON inputs against their
schemas (core/generator/schema/*.schema.json; needs the python package jsonschema, else only the manifest's paths
and the adapter are checked), and that its adapter defines every name the derivation uses.

    check_case.py [--case misarch]
"""
import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import case as case_  # noqa: E402

ROOT = case_.ROOT
SCHEMAS = ROOT / "core" / "generator" / "schema"
INPUT_SCHEMAS = {"domain": "domain", "sessions": "sessions", "platform": "platform", "parts": "parts",
                 "envelopeEstimate": "envelope-estimate", "latencyFit": "latency-fit", "cacheHits": "cache-hits"}
OPTIONAL = {"latencyFit", "budgets", "bounds", "envelopeEstimate"}     # the derivation copes without them
ADAPTER = ["NAME", "REPOSITORY", "TITLE", "ENTRY", "ENTRY_IFACE", "BROKER", "BROKER_IFACE", "AUTH", "AUTH_IFACE",
           "AUTH_SIG", "AUTH_REQUEST", "ENTRY_CONTAINER", "BROKER_CONTAINER", "AUTH_CONTAINER", "ENTRY_CPU", "FIXED",
           "PROVIDED", "FIXED_PLACEMENT", "DOMAIN_SOURCE", "SEED_TEXT", "PROCESS_CRITICALITY", "DEFAULT_CRITICALITY",
           "CHANGES_PER_YEAR", "CHANGES_TEXT", "CACHE_TTL_S", "CACHE_TEXT", "COST_TEXT", "skip_request", "glue",
           "trigger_type", "role_sig", "entry_comments", "components", "containers", "deployables", "prices"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case", default=os.environ.get("ARCH_CASE", "misarch"))
    a = ap.parse_args()
    c = case_.load(a.case)
    bad = []
    try:
        import jsonschema
    except ImportError:
        jsonschema = None
        print("jsonschema not installed: the inputs' contents are not checked")

    def validate(what, data, schema):
        if jsonschema is None:
            return
        try:
            jsonschema.validate(data, json.loads((SCHEMAS / f"{schema}.schema.json").read_text()))
            print(f"valid    {what}")
        except jsonschema.ValidationError as e:
            bad.append(what)
            print(f"INVALID  {what}: {e.message} at {'/'.join(map(str, e.absolute_path))}")
    validate("case.json", c.m, "case")
    for k in c.m.get("inputs", {}):
        f = c.path(k)
        if not f.exists():
            if k not in OPTIONAL:
                bad.append(k)
            print(f"{'missing ' if k not in OPTIONAL else 'absent  '} {k}: {c.rel(k)}")
            continue
        if k in INPUT_SCHEMAS:
            validate(f"{k}: {c.rel(k)}", json.loads(f.read_text()), INPUT_SCHEMAS[k])
        else:
            print(f"exists   {k}: {c.rel(k)}")
    for role in ("models", "seeds", "configs"):
        if not c.path(f"mdeo.{role}").is_dir():
            bad.append(f"mdeo.{role}")
            print(f"missing  mdeo.{role}: {c.rel(f'mdeo.{role}')}")
    spec = importlib.util.spec_from_file_location("adapter", c.path("generator.adapter"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    missing = [n for n in ADAPTER if not hasattr(m, n)]
    if missing:
        bad.append("adapter")
    print(f"adapter  {c.rel('generator.adapter')}: " + (f"MISSING {', '.join(missing)}" if missing else "complete"))
    if c.path("domain").exists():
        sagas = {s["name"] for s in json.loads(c.path("domain").read_text()).get("sagas", [])}
        if sagas - set(getattr(m, "PROCESS_CRITICALITY", {})):
            bad.append("criticality")
            print(f"adapter  PROCESS_CRITICALITY lacks the sagas {sorted(sagas - set(m.PROCESS_CRITICALITY))}")
    print("case ok" if not bad else f"case NOT ok: {', '.join(bad)}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
