#!/usr/bin/env python3
"""Rewrite the headers of a case's committed realised seeds after their base models were regenerated with an
identical body (a move or a split of the generator's inputs changes only their `// Input:` lines): a seed's header
comment (everything before its `using` line) becomes its base model's, and its `// Source:` line names the base
model's repository path and content hash again, as core/platform/realised_to_m.py writes them. The seeds' content
(instances, links, their order and names) is left as it is, so their random streams stay; realising them again
would rename the elements the realisation creates (core/tools/realise-seeds.sh).

    seed_headers.py [--case misarch] [--check]      (--check: report, write nothing; exit 1 if one is not current)

A seed whose base model's body (all but the header comment) differs from the body it was realised from cannot be
detected here: run it only after checking that the regenerated base models' bodies are unchanged.
"""
import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import case as case_  # noqa: E402

ROOT = case_.ROOT
SOURCE = re.compile(r"^// Source: (\S+) sha256 ([0-9a-f]+)$", re.M)


def head(text):
    """(header lines before `using`, the rest from the `using` line on)."""
    lines = text.split("\n")
    for i, l in enumerate(lines):
        if l.startswith("using "):
            return lines[:i], "\n".join(lines[i:])
    sys.exit("no `using` line")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case", default=os.environ.get("ARCH_CASE", "misarch"))
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    c = case_.load(a.case)
    models, seeds = c.path("mdeo.models"), c.path("mdeo.seeds")
    stale = 0
    for f in sorted(seeds.glob("*-realised*.m")):
        base = models / (re.sub(r"-realised(-1sim)?\.m$", "", f.name) + ".m")
        btext = base.read_text()
        bhead, _ = head(btext)
        text = f.read_text()
        shead, rest = head(text)
        src = f"// Source: {os.path.relpath(base, ROOT)} sha256 {hashlib.sha256(btext.encode()).hexdigest()[:16]}"
        if len(SOURCE.findall(rest)) != 1:
            sys.exit(f"{f}: not exactly one `// Source:` line")
        new = "\n".join(bhead) + "\n" + SOURCE.sub(lambda _: src, rest, count=1)
        if new == text:
            print(f"{os.path.relpath(f, ROOT)}: current")
            continue
        stale += 1
        if a.check:
            print(f"{os.path.relpath(f, ROOT)}: NOT current")
        else:
            f.write_text(new)
            print(f"{os.path.relpath(f, ROOT)}: header and source rewritten ({src[3:]})")
    sys.exit(1 if a.check and stale else 0)


if __name__ == "__main__":
    main()
