#!/usr/bin/env python3
"""Generates the pinned variants of realisation statements: for each leaf file
of transform/realise/ given, transform/pinned/<file> with the same statements, each of whose
`<p>Call: RealisedCall` is bound to the input `pc` (mdeo's planner then walks from that call).
A statement whose only call is the witness of a `require` block gets that block's links in its
pattern, bound to `pc`; one without a call is kept when an anchor `var=ref` names one of its
variables (`pc.ref -- var` is added). Statements that delete their call or have none are left
out. The whole-model files stay the source of truth; rerun after changing them:
  core/tools/pin.py plan-sites.mt build.mt ...   core/tools/pin.py links.mt --anchor abSource=caller"""
import re, sys
from pathlib import Path

# mdeo f419a121 resolves a property constraint on a referenced object (`pc { shape == "x" }`, no
# class in the pattern) by the property's name across the runtime metamodel's classes: with
# domain.mm (whose Access also has a `shape`) it reads and writes RealisedCall's `built` instead.
# A `where pc.shape == "x"` is typed and reads the right property, so the
# constraints on `pc` become `where` clauses. Assignments stay (only the plan files assign `pc`;
# the repairs plan through ../transform/repair/plan-*-dirty instead). `--rewrite` applies this to
# the files already in transform/pinned/.
PC_BLOCK = re.compile(r"^    pc \{\n((?:        .*\n)*?)    \}\n", re.M)


def typed_constraints(c):
    def fix(m):
        keep, wheres = [], []
        for l in m.group(1).rstrip("\n").split("\n"):
            k = re.match(r"^        (\w+) (==|!=|<=|>=|<|>) (.*)$", l)
            if k:
                wheres.append(f"    where pc.{k.group(1)} {k.group(2)} {k.group(3)}\n")
            else:
                keep.append(l + "\n")
        block = "    pc {\n" + "".join(keep) + "    }\n" if keep else "    pc { }\n"
        return block + "".join(wheres)
    return PC_BLOCK.sub(fix, c)


# The realisation's root (`<x>Root: Realisation`) is the container of every RealisedCall: a statement
# that has one is anchored at `pc` through it (`<x>Root.calls -- pc`, the same match on a model with
# its single Realisation), so the planner walks to the root and from it to the middleware interface
# instead of scanning OperationInterfaces.
ROOT = re.compile(r"^    (\w+Root): Realisation \{ \}\n", re.M)


# Only when no other unconnected part of the pattern holds anything but the model's singletons
# (the system, the decisions): with such a part (e.g. the broker's interface reached from
# RemoteCalls) mdeo main's planner paired that part's scans once the root was anchored (a cross
# product of interfaces, signatures and assemblies, ~0.3 s per call), so those statements stay as
# they were.
NODE = re.compile(r"^    (?:delete )?(\w+): (\w+) \{", re.M)
LINK = re.compile(r"^    (?:delete )?(\w+)\.`?\w+`? -- (\w+)$", re.M)
SINGLETONS = {"System", "ArchitectureDecisions"}


def only_singletons_apart(c, extra):
    cls = dict(NODE.findall(c))
    cls["pc"] = "RealisedCall"
    parent = {n: n for n in cls}
    def find(n):
        while parent[n] != n:
            n = parent[n]
        return n
    for a, b in LINK.findall(c) + [extra]:
        if a in parent and b in parent:
            parent[find(a)] = find(b)
    return all(cls[n] in SINGLETONS for n in cls if find(n) != find("pc"))


def anchored_root(c):
    m = ROOT.search(c)
    if not m or re.search(r"^    " + m.group(1) + r"\.calls -- pc$", c, re.M):
        return c
    if not only_singletons_apart(c, (m.group(1), "pc")):
        return c
    return c[:m.end()] + f"    {m.group(1)}.calls -- pc\n" + c[m.end():]


# A statement's `where` clauses that read only `pc` are necessary for any match; they guard the
# statement (`if match { pc { } where ... } then { statement }`), so a call it cannot apply to costs a
# one-node match instead of building and running the whole pattern's traversal. Within
# a `while`, only the statement itself could make them true, and it cannot run while they are false.
# Consecutive statements with the same guard share one `if match`.
def guards(c):
    return tuple(l for l in c.split("\n") if l.startswith("    where ")
                 and set(re.findall(r"\b(\w+)\.", l[10:])) == {"pc"})


def guarded(chunks):
    out, i = [], 0
    while i < len(chunks):
        g = guards(chunks[i])
        j = i + 1
        while g and j < len(chunks) and guards(chunks[j]) == g:
            j += 1
        if not g:
            out.append(chunks[i])
        else:
            body = "\n\n".join(chunks[i:j])
            body = "\n".join(("    " + l) if l else l for l in body.split("\n"))
            out.append("if match {\n    pc { }\n" + "\n".join(g) + "\n} then {\n" + body + "\n}")
        i = j
    return out


if sys.argv[1:] == ["--rewrite"]:
    for f in sorted((Path(__file__).resolve().parents[2] / "core/mdeo/transform/pinned").glob("*.mt")):
        t = f.read_text()
        n = typed_constraints(t)
        if n != t:
            f.write_text(n)
            print("rewrote", f.name)
    sys.exit(0)
P = Path(__file__).resolve().parents[2]          # the repository root
SRC, OUT = P / "core/mdeo/transform/realise", P / "core/mdeo/transform/pinned"


def statements(text):
    lines = text.split("\n")
    # the header: `using`, imports, the file's comment (the first comment block), `in`/`out`
    # declarations; a comment after them belongs to the first statement
    t = 0
    while t < len(lines) and re.match(r"^(using |import |\s*$)", lines[t]):
        t += 1
    while t < len(lines) and lines[t].startswith("//"):
        t += 1
    while t < len(lines) and re.match(r"^((in|out) \w+\s*:|\s*$)", lines[t]):
        t += 1
    t -= 1
    chunks, buf, cur = [], [], None
    for l in lines[t + 1:]:
        if cur is None:
            if re.match(r"^(for|while) match \{", l):
                cur, buf = buf + [l], []
            elif l.strip():
                buf.append(l)
        else:
            cur.append(l)
            if l == "}" and cur[-2] == "} do {":
                chunks.append("\n".join(cur))
                cur = None
    return lines[:t], lines[t], chunks


args = sys.argv[1:]
anchors = [args[i + 1].split("=") for i, a in enumerate(args) if a == "--anchor"]
names = [a for i, a in enumerate(args) if a != "--anchor" and (i == 0 or args[i - 1] != "--anchor")]
REQUIRE = re.compile(r"^    require \w+ \{\n        (\w+Call): RealisedCall \{ \}\n((?:        .*\n)*?)    \}\n", re.M)
for name in names:
    head, trans, chunks = statements((SRC / name).read_text())
    out = []
    for c in chunks:
        m = re.search(r"^    (\w+Call): RealisedCall \{", c, re.M)
        if not m:
            r = REQUIRE.search(c)
            if r:
                body = "".join(l[4:] + "\n" for l in r.group(2).rstrip("\n").split("\n"))
                c = c[:r.start()] + "    pc { }\n" + re.sub(r"\b" + r.group(1) + r"\b", "pc", body) + c[r.end():]
                out.append(c)
                continue
            for var, ref in anchors:
                if re.search(r"\b" + var + r"\b", c):
                    first, rest = c.split("\n", 1)
                    out.append(first + f"\n    pc {{ }}\n    pc.{ref} -- {var}\n" + rest)
                    break
            continue
        if re.search(r"^    delete \w+Call: RealisedCall", c, re.M):
            continue
        v = m.group(1)
        c = re.sub(r"^    " + v + r": RealisedCall \{", "    pc {", c, flags=re.M)
        c = re.sub(r"\b" + v + r"\b", "pc", c)
        out.append(c)
    out = guarded([anchored_root(typed_constraints(c)) for c in out])
    using = [l for l in head if l.startswith("using")][0].replace('"../../', '"../../')
    text = (using + "\n\n// Generated by core/tools/pin.py from ../realise/" + name + " (DESIGN.md B4.5): its statements\n"
            "// about one call, bound to `pc`. Do not edit; edit the source and regenerate.\n"
            "in pc: RealisedCall\n\n" + "\n\n".join(out) + "\n")
    (OUT / name).write_text(text)
    print(name, len(chunks), "->", len(out))
