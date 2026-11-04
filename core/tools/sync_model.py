#!/usr/bin/env python3
"""Apply the copy sync (optimize/sync-microservices.mt) to models, with the
headless harness (core/harness/harness.sh apply; ARCH_WT selects the mdeo worktree).

    sync_model.py MODEL.m...                    the seed pipeline: sync each project model
                                                (models/*.m of the staged project root,
                                                ARCH_PROJECT, else the case staged now:
                                                core/tools/stage_project.py) and write the derived
                                                elements back into it, formatted
                                                (core/tools/format_model.py); a model elsewhere is
                                                synced as a copy in the staged models/
                                                (sync_outside)
    sync_model.py --json IN.model.json... --out DIR
                                                model data (e.g. designs of a run): the synced
                                                model data in DIR, same file names

Either way the elements the sync created get readable names (paths, as the plugin named them
when it still translated layer 3: Assembly_Order_copyStore, ..._copies_read_<site>), the model
keeps its order (the instances and links that were there first, then the derived ones), and a
second application of the sync must change nothing, which is checked.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
P = HERE.parents[1]                       # the repository root
sys.path.insert(0, str(HERE))
import stage_project  # noqa: E402

# the staged project root the harness exports (staged once here, unless a caller staged it)
PROJ = Path(os.environ.get("ARCH_PROJECT") or stage_project.stage(os.environ.get("ARCH_CASE", "misarch"))).resolve()
SYNC = "/optimize/sync-microservices.mt"
BUILD = P / "build" / "misarch"


def lk(l):
    return (l["sourceName"], l["sourceProperty"], l["targetName"], l.get("targetProperty"))


def ordered(pre, post):
    """`post` in the order of `pre`: what was there keeps its place, the new follows."""
    by = {i["name"]: i for i in post["instances"]}
    names = [i["name"] for i in pre["instances"] if i["name"] in by]
    seen = set(names)
    names += [i["name"] for i in post["instances"] if i["name"] not in seen]
    plinks = {lk(l): l for l in post["links"]}
    keys = [lk(l) for l in pre["links"] if lk(l) in plinks]
    s = set(keys)
    keys += [lk(l) for l in post["links"] if lk(l) not in s]
    return {**post, "instances": [by[n] for n in names], "links": [plinks[k] for k in keys]}


def readable_names(model, before):
    """New names for the instances of `model` that are not in `before` (the sync's, named after
    its pattern variables), derived from the layer-3 trace."""
    old = {i["name"] for i in before["instances"]}
    cls = {i["name"]: i["className"] for i in model["instances"]}
    out = defaultdict(list)
    for l in model["links"]:
        out[(l["sourceName"], l["sourceProperty"])].append(l["targetName"])
    one = lambda n, f: (out.get((n, f)) or [None])[0]
    new = {}

    def name(n, want):
        if n is not None and n not in old and n not in new:
            new[n] = want

    def seff_parts(seff, base):
        for s in out.get((seff, "steps"), []):
            c = cls[s]
            if c == "StartAction":
                name(s, f"{base}_start")
            elif c == "StopAction":
                name(s, f"{base}_stop")
            elif c == "InternalAction":
                ia = f"{base}_{'readCopy' if '_read_' in base else 'writeCopy'}"
                name(s, ia)
                for w in [x for x, cx in cls.items() if cx == "Work" and one(x, "action") == s]:
                    name(w, f"{ia}_work")

    for st in [n for n, c in cls.items() if c == "CopyStore"]:
        s = one(st, "store")
        comp, iface = one(st, "component"), one(st, "copies")
        name(st, f"copyStore_{s}")
        name(comp, f"{s}_copyStore")
        name(iface, f"{s}_copies")
        for r in out.get((comp, "providedRoles"), []):
            name(r, f"{s}_copyStore_provides_{s}_copies")
        name(one(st, "assembly"), f"Assembly_{s}_copyStore")
        name(one(st, "colocation"), f"colocation_{s}")
    for f in [n for n, c in cls.items() if c == "CopyFeed"]:
        site, st = one(f, "site"), one(f, "copyStore")
        s = one(st, "store") if st else None
        for kind in ("read", "write"):
            sig = one(f, kind)
            name(sig, f"{s}_copies_{kind}_{site}")
            comp = one(st, "component") if st else None
            for seff in out.get((comp, "serviceEffectSpecifications"), []):
                if one(seff, "describedService") == sig:
                    base = f"{s}_copyStore_{kind}_{site}"
                    name(seff, base)
                    seff_parts(seff, base)
        name(one(f, "redirect"), f"redirect_{site}")
        for d in out.get((f, "deliveries"), []):
            n = next(x for x, cx in cls.items() if cx == "Notification" and d in out.get((x, "deliveries"), []))
            name(d, f"{one(n, 'after')}_delivery_{site}")
    for n in out.get((next((x for x, c in cls.items() if c == "ArchitectureDecisions"), None), "feedNotifications"), []):
        name(n, f"{one(n, 'after')}_publication")
    taken = set(old)
    for k, v in list(new.items()):
        base, i = v, 2
        while v in taken:
            v, i = f"{base}_{i}", i + 1
        taken.add(v)
        new[k] = v
    return new


def renamed(model, new):
    r = lambda n: new.get(n, n)
    return {**model,
            "instances": [{**i, "name": r(i["name"])} for i in model["instances"]],
            "links": [{**l, "sourceName": r(l["sourceName"]), "targetName": r(l["targetName"])} for l in model["links"]]}


def diff(pre, post):
    a, b = {i["name"]: i for i in pre["instances"]}, {i["name"]: i for i in post["instances"]}
    la, lb = {lk(l) for l in pre["links"]}, {lk(l) for l in post["links"]}
    return dict(added=[n for n in b if n not in a], removed=[n for n in a if n not in b],
                changed=[n for n in a if n in b and a[n] != b[n]],
                addedLinks=sorted(lb - la), removedLinks=sorted(la - lb))


def harness(*args, env=None):
    e = dict(os.environ, MALLOC_ARENA_MAX="2", ARCH_HEAP=os.environ.get("ARCH_HEAP", "3g"), ARCH_PROJECT=str(PROJ),
             **(env or {}))
    r = subprocess.run([str(P / "core" / "harness" / "harness.sh"), *args], env=e, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"harness {' '.join(args)} failed:\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}")
    return r.stdout


def sync_dir(src_dir, out_name):
    """Applies the sync to every *.model.json of `src_dir` (inside build/misarch); returns the
    synced models by file name, after a check that a second run changes nothing."""
    harness("apply", SYNC, out_name, env=dict(ARCH_MODELS_DIR=str(src_dir)))
    report = json.loads((BUILD / out_name / "apply.json").read_text())
    bad = [n for n, x in report.items() if not x["applied"] or not x["consistent"]]
    if bad:
        sys.exit(f"the sync failed or was not idempotent on {bad}: see {BUILD / out_name / 'apply.json'}")
    return {n: json.loads((BUILD / out_name / n).read_text()) for n in report}, report


def sync_models(pres, work):
    """pres: {file name: model data}. Returns {file name: synced, ordered, renamed model data}."""
    src = BUILD / work
    if src.exists():
        for f in src.glob("*.model.json"):
            f.unlink()
    src.mkdir(parents=True, exist_ok=True)
    for n, m in pres.items():
        (src / n).write_text(json.dumps(m))
    posts, report = sync_dir(src, work + "-synced")
    out = {}
    for n, pre in pres.items():
        m = ordered(pre, posts[n])
        out[n] = renamed(m, readable_names(m, pre))
    return out, report


# ---------------------------------------------------------------------------------------------
# the seed pipeline: derived elements back into the .m file

def m_literal(v):
    if isinstance(v, dict) and "enum" in v:
        return v["enum"]
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return json.dumps(v)
    if isinstance(v, float):
        return repr(v)
    return str(v)




def derived_section(pre, post):
    """.m text of what `post` adds to `pre`: the new objects and every new link."""
    d = diff(pre, post)
    if d["removed"] or d["changed"] or d["removedLinks"]:
        sys.exit(f"the sync changed or removed elements of a fresh model: {d['removed'][:5]} {d['changed'][:5]} "
                 f"{d['removedLinks'][:5]}")
    by = {i["name"]: i for i in post["instances"]}
    enums = {"requiredResource": "ProcessingResourceType", "activeResourceType": "ProcessingResourceType"}
    lines = ["", "", "// ═══ Derived: the copy sync's realisation (core/mdeo/optimize/sync-microservices.mt, DESIGN.md H10-H16) ═══", "",
             "// Made by core/tools/sync_model.py with the sync; edit the sync or the copy feeds, not this section.", ""]
    for n in sorted(d["added"]):
        i = by[n]
        attrs = [(k, v) for k, v in i["properties"].items() if v is not None and v != []]
        if not attrs:
            lines.append(f"{n} : {i['className']} {{ }}")
        else:
            lines.append(f"{n} : {i['className']} {{")
            for k, v in attrs:
                val = f"{enums[k]}.{v['enum']}" if isinstance(v, dict) and "enum" in v else m_literal(v)
                lines.append(f"    {k} = {val}")
            lines.append("}")
    pl = {lk(l): l for l in post["links"]}
    for k in d["addedLinks"]:
        l = pl[k]
        lines.append(f"{l['sourceName']}.{l['sourceProperty']} -- {l['targetName']}")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", action="store_true", help="the files are model data (*.model.json)")
    ap.add_argument("--out", help="output directory (--json)")
    ap.add_argument("--no-format", action="store_true")
    a = ap.parse_args()
    if a.json:
        pres = {Path(f).name: json.loads(Path(f).read_text()) for f in a.files}
        out, report = sync_models(pres, "sync-in")
        Path(a.out).mkdir(parents=True, exist_ok=True)
        for n, m in out.items():
            (Path(a.out) / n).write_text(json.dumps(m))
            print(f"{n}: {len(m['instances'])} instances ({report[n]['ms']:.0f} ms, again {report[n]['againMs']:.0f} ms)")
        return
    files = [Path(f).resolve() for f in a.files]
    inside = [f for f in files if f.parent == PROJ / "models"]
    if inside:
        sync_project_models(inside, a.no_format)
    for f in files:
        if f.parent != PROJ / "models":
            sync_outside(f, a.no_format)


USING = re.compile(r'^using "[^"]*/metamodel/architecture\.mm"$', re.M)


def sync_outside(f, no_format):
    """A model outside the staged models/ (e.g. a reference design a validation script generated): the harness
    exports only the project's models, so it is synced as a copy in the staged models/ (its `using`
    line pointed there) and written back with its own `using` line."""
    text = f.read_text()
    m = USING.search(text)
    if not m:
        sys.exit(f"{f}: no `using` line of architecture.mm")
    staged = PROJ / "models" / f".sync-{os.getpid()}-{f.name}"
    staged.write_text(text[:m.start()] + 'using "../metamodel/architecture.mm"' + text[m.end():])
    try:
        sync_project_models([staged], no_format)
        synced = staged.read_text()
        f.write_text(USING.sub(lambda _: m.group(0), synced, count=1))
    finally:
        staged.unlink(missing_ok=True)
        (BUILD / f"{staged.stem}.model.json").unlink(missing_ok=True)


def sync_project_models(files, no_format):
    names = ",".join(f.name for f in files)
    harness("export", "--only", "mm")
    harness("export", "--only", "models", "--models", names)
    pres = {f"{f.stem}.model.json": json.loads((BUILD / f"{f.stem}.model.json").read_text()) for f in files}
    if any(i["className"] in ("CopyStore", "Redirect") for m in pres.values() for i in m["instances"]):
        sys.exit("a model already holds derived elements: regenerate it first (core/generator/derive.py)")
    out, report = sync_models(pres, "sync-in")
    for f in files:
        n = f"{f.stem}.model.json"
        f.write_text(f.read_text().rstrip("\n") + "\n" + derived_section(pres[n], out[n]))
        if not no_format:
            subprocess.run([sys.executable, str(HERE / "format_model.py"), "-i", str(f)], check=True)
        print(f"{f.name}: +{len(out[n]['instances']) - len(pres[n]['instances'])} derived instances "
              f"(sync {report[n]['ms']:.0f} ms)")
    # the result must be consistent: exported again, the sync changes nothing
    harness("export", "--only", "models", "--models", names)
    again = {f"{f.stem}.model.json": json.loads((BUILD / f"{f.stem}.model.json").read_text()) for f in files}
    src = BUILD / "sync-check"
    src.mkdir(parents=True, exist_ok=True)
    for g in src.glob("*.model.json"):
        g.unlink()
    for n, m in again.items():
        (src / n).write_text(json.dumps(m))
    posts, _ = sync_dir(src, "sync-check-synced")
    for n, m in again.items():
        d = diff(m, posts[n])
        if any(d.values()):
            sys.exit(f"{n}: the synced model is not consistent: {d}")
    print(f"consistent: a second sync changes nothing in {', '.join(again)}")


if __name__ == "__main__":
    main()
