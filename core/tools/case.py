#!/usr/bin/env python3
"""A case's manifest (cases/<case>/case.json): the names and paths of the inputs a case provides to the core.

    case.py [--case misarch] path KEY       the repository-relative path of an input (KEY: a key of `inputs`,
                                            dotted for nested ones, e.g. inputs.domain or mdeo.models)
    case.py [--case misarch] show           the manifest with every path resolved

From Python: `import case; c = case.load("misarch"); c.path("domain")` (a Path) or `c.rel("domain")`.
Paths in the manifest are relative to the case's directory.
"""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # the repository root


class Case:
    def __init__(self, name):
        self.name = name
        self.dir = ROOT / "cases" / name
        f = self.dir / "case.json"
        if not f.exists():
            sys.exit(f"no case {name}: {f} missing")
        self.m = json.loads(f.read_text())

    def get(self, key):
        """The manifest's value at a dotted key; a bare key is one of `inputs`."""
        v = self.m
        for k in (key.split(".") if "." in key else ["inputs", key]):
            if not isinstance(v, dict) or k not in v:
                raise KeyError(f"{self.name}: no {key} in case.json")
            v = v[k]
        return v

    def path(self, key):
        return (self.dir / self.get(key)).resolve()

    def rel(self, key):
        return os.path.relpath(self.path(key), ROOT)


def load(name=None):
    return Case(name or os.environ.get("ARCH_CASE", "misarch"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case", default=os.environ.get("ARCH_CASE", "misarch"))
    ap.add_argument("what", choices=["path", "show"])
    ap.add_argument("key", nargs="?")
    a = ap.parse_args()
    c = load(a.case)
    if a.what == "path":
        print(c.rel(a.key))
    else:
        def walk(v):
            if isinstance(v, dict):
                return {k: walk(x) for k, x in v.items()}
            if isinstance(v, str) and not v.startswith("http") and "/" in v or isinstance(v, str) and v.endswith((".json", ".py", ".m")):
                return os.path.relpath((c.dir / v).resolve(), ROOT)
            return v
        print(json.dumps(walk(c.m), indent=1))


if __name__ == "__main__":
    main()
