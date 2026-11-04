#!/usr/bin/env python3
"""Stage the MDEO project of a case: copy the core's MDEO sources and the case's MDEO files into one project
root, build/project/<case>/, in the layout mdeo and the harness read (/metamodel, /models, /optimize, /scripts,
/transform; the files' `using` and import lines are relative to that layout and are never rewritten).

    stage_project.py [--case misarch] [--out DIR]       stage; prints the staged root
    stage_project.py [--case misarch] --staged FILE...  the staged path (project-relative) of source files
    stage_project.py [--case misarch] --source REL...   the source file of staged project paths
    stage_project.py [--case misarch] --list            every staged path and its source

Copies, no symlinks: mdeo accepts files under one project root only. A file is copied again when its size or
modification time differs from the staged one (copies keep the time); a staged file without a source is
removed (except dot files: other tools' work files), so the staged root equals its sources. Two sources of one staged path are an error.
Tools that work on a staged root take it from ARCH_PROJECT (set by the entry point that staged it) and
stage only when it is not set.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # the repository root
# the core's MDEO sources: <dir> -> staged <dir>
CORE_MDEO = ROOT / "core" / "mdeo"
CORE_DIRS = ("metamodel", "optimize", "transform")
SKIP = {"__pycache__"}
# the case's MDEO files by role (case.json `mdeo`: role -> case-relative dir) -> staged dir
CASE_ROLES = {"models": "models", "seeds": "models", "configs": "optimize/domain"}


def case_dir(case):
    return ROOT / "cases" / case


def manifest(case):
    return json.loads((case_dir(case) / "case.json").read_text())


def sources(case):
    """[(source dir, staged dir)]: the core's, then the case's (CASE_ROLES)."""
    out = [(CORE_MDEO / d, d) for d in CORE_DIRS]
    for role, src in manifest(case)["mdeo"].items():
        if role not in CASE_ROLES:
            sys.exit(f"stage_project: {case}: unknown mdeo role {role} (one of {', '.join(CASE_ROLES)})")
        out.append(((case_dir(case) / src).resolve(), CASE_ROLES[role]))
    return out


def plan(case):
    """staged path (project-relative, '/'-separated) -> source file."""
    files = {}
    for src, dest in sources(case):
        if not src.is_dir():
            sys.exit(f"stage_project: no directory {src}")
        for dirpath, dirnames, filenames in os.walk(src):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith("."))
            for f in sorted(filenames):
                if f.startswith("."):
                    continue
                s = Path(dirpath) / f
                rel = (Path(dest) / s.relative_to(src)).as_posix()
                if rel in files and files[rel] != s:
                    sys.exit(f"stage_project: {rel} has two sources, {files[rel]} and {s}")
                files[rel] = s
    return files


def default_out(case):
    return ROOT / "build" / "project" / case


def stage(case, out=None):
    out = Path(out or default_out(case)).resolve()
    files = plan(case)
    out.mkdir(parents=True, exist_ok=True)
    copied = 0
    for rel, s in files.items():
        d = out / rel
        st = s.stat()
        if d.is_symlink() or not d.exists() or d.stat().st_size != st.st_size or d.stat().st_mtime_ns != st.st_mtime_ns:
            # atomically: another process may read the staged root meanwhile
            d.parent.mkdir(parents=True, exist_ok=True)
            tmp = d.parent / f".{d.name}.stage-{os.getpid()}"
            shutil.copy2(s, tmp)
            os.replace(tmp, d)
            copied += 1
    removed = 0
    for dirpath, dirnames, filenames in os.walk(out, topdown=False):
        for f in filenames:
            p = Path(dirpath) / f
            # dot files are other tools' work files (core/tools/sync_model.py's staged copies, copies in flight)
            if not f.startswith(".") and p.relative_to(out).as_posix() not in files:
                p.unlink()
                removed += 1
        if Path(dirpath) != out and not os.listdir(dirpath):
            os.rmdir(dirpath)
    print(f"stage_project: {out}: {len(files)} files ({copied} copied, {removed} removed)", file=sys.stderr)
    return out


def staged_of(case, path):
    """The staged project path of a source file (or of a path already relative to a staged root)."""
    p = Path(path).resolve()
    for rel, s in plan(case).items():
        if s == p:
            return rel
    sys.exit(f"stage_project: {path} is not a source of the {case} project")


def source_of(case, rel):
    rel = rel.lstrip("/")
    f = plan(case).get(rel)
    if f is None:
        sys.exit(f"stage_project: no source of {rel}")
    return f


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case", default=os.environ.get("ARCH_CASE", "misarch"))
    ap.add_argument("--out")
    ap.add_argument("--staged", nargs="+")
    ap.add_argument("--source", nargs="+")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.staged:
        print("\n".join(staged_of(a.case, p) for p in a.staged))
    elif a.source:
        print("\n".join(os.path.relpath(source_of(a.case, r), ROOT) for r in a.source))
    elif a.list:
        for rel, s in plan(a.case).items():
            print(f"{rel}\t{os.path.relpath(s, ROOT)}")
    else:
        print(stage(a.case, a.out))


if __name__ == "__main__":
    main()
