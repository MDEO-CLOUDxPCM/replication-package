#!/usr/bin/env python3
"""The project files a set of configs needs (configs, every .mt/.fn/.mm/.m they reach through
`using`, `import ... from`, `model =`, `metamodel =`), relative to the staged project root (ARCH_PROJECT,
core/tools/stage_project.py), one per line.

    ARCH_PROJECT=<staged root> closure.py optimize/domain/a.config ...
"""
import os
import re
import sys

ROOT = os.environ.get("ARCH_PROJECT") or sys.exit("closure.py: ARCH_PROJECT (the staged project root) not set")
REF = re.compile(r'(?:^\s*(?:using|import)\s+|\bfrom\s+|^\s*(?:meta)?model\s*=\s*)"([^"]+)"', re.M)
seen, todo = set(), [os.path.normpath(a) for a in sys.argv[1:]]
while todo:
    f = todo.pop()
    if f in seen:
        continue
    seen.add(f)
    text = open(os.path.join(ROOT, f)).read()
    text = re.sub(r"//[^\n]*", "", text)
    for ref in REF.findall(text):
        g = os.path.normpath(os.path.join(os.path.dirname(f), ref))
        if not os.path.exists(os.path.join(ROOT, g)):
            sys.exit(f"{f}: missing {g}")
        todo.append(g)
print("\n".join(sorted(seen)))
