"""Read misarch-kotlin sources from a git ref (default `main`), independent of the checkout.

All extraction scripts read through this module, so they see `main` even though the working tree of
misarch-kotlin is on another branch. misarch-kotlin is the repository's submodule `misarch-kotlin/` or, without
it, a checkout `../misarch-kotlin` beside the repository; in a clone without a local branch `main` (a submodule)
the ref is read as `origin/main`. Paths are repository-relative (`services/order/src/...`).

Evidence strings are `path:line` (repository-relative, 1-based) on the commit printed in the output.
Curated facts name code by an *anchor* instead of a line number: `path#text` (first line of the file
containing `text`), `path#text@n` (n-th such line), or `path:line` (taken as is, checked to exist).
Anchors keep curated data valid when lines move; `resolve()` turns them into `path:line`.
"""

import functools
import os
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[2]          # the repository root (cases/misarch/extract)


def _checkout(name):
    """The repository's submodule `<name>/` if it is checked out, else `../<name>` beside the repository."""
    sub = PROJECT / name
    return sub if sub.is_dir() and any(sub.iterdir()) else PROJECT.parent / name


REPO = Path(os.environ.get("MISARCH_KOTLIN", _checkout("misarch-kotlin")))
REF = os.environ.get("MISARCH_REF", "main")


def _git(*args):
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True).stdout


@functools.lru_cache(maxsize=None)
def commit():
    for ref in (REF, f"origin/{REF}"):
        r = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--verify", "-q", f"{ref}^{{commit}}"],
                           capture_output=True)
        if r.returncode == 0:
            return r.stdout.decode().strip()
    raise SystemExit(f"misarch-kotlin at {REPO} has no ref {REF} (nor origin/{REF}); MISARCH_KOTLIN, MISARCH_REF")


@functools.lru_cache(maxsize=None)
def files():
    out = _git("ls-tree", "-r", "--name-only", commit()).decode()
    return tuple(sorted(out.splitlines()))


def glob(prefix="", suffix=""):
    return [f for f in files() if f.startswith(prefix) and f.endswith(suffix)]


@functools.lru_cache(maxsize=None)
def read(path):
    return _git("show", f"{commit()}:{path}").decode("utf-8")


@functools.lru_cache(maxsize=None)
def lines(path):
    return tuple(read(path).split("\n"))


def line_of(path, offset):
    """1-based line number of character offset `offset` in `path`."""
    return read(path).count("\n", 0, offset) + 1


def service_of(path):
    m = re.match(r"services/([^/]+)/", path)
    return m.group(1) if m else None


KOTLIN_ROOT = "services/{svc}/src/main/kotlin/org/misarch/{pkg}/"


def kotlin_root(svc):
    return KOTLIN_ROOT.format(svc=svc, pkg=svc.replace("return", "return"))


def expand(svc, path):
    """A curated path may be short: relative to the service's Kotlin package root
    (`service/OrderService.kt`), to the service (`src/main/resources/...`), or repository-relative."""
    if path in files():
        return path
    for base in (kotlin_root(svc) if svc else None, f"services/{svc}/" if svc else None):
        if base and base + path in files():
            return base + path
    raise KeyError(f"no file {path!r} (service {svc}) on {REF}")


class AnchorError(Exception):
    pass


def resolve(anchor, svc=None):
    """`path#text[@n]` or `path:line[-line]` -> `repo/path:line` (string)."""
    if "#" in anchor:
        path, text = anchor.split("#", 1)
        n = 1
        m = re.match(r"^(.*)@(\d+)$", text)
        if m:
            text, n = m.group(1), int(m.group(2))
        full = expand(svc, path)
        hits = [i + 1 for i, l in enumerate(lines(full)) if text in l]
        if len(hits) < n:
            raise AnchorError(f"anchor {anchor!r}: {len(hits)} match(es) of {text!r} in {full}")
        return f"{full}:{hits[n - 1]}"
    m = re.match(r"^(.*):(\d+)(?:-(\d+))?$", anchor)
    if not m:
        raise AnchorError(f"anchor {anchor!r}: neither path#text nor path:line")
    path, a, b = m.group(1), int(m.group(2)), m.group(3)
    full = expand(svc, path)
    if not 1 <= a <= len(lines(full)) or (b and not a <= int(b) <= len(lines(full))):
        raise AnchorError(f"anchor {anchor!r}: line out of range in {full}")
    return f"{full}:{a}" + (f"-{b}" if b else "")


def short(evidence):
    """`services/order/src/main/kotlin/org/misarch/order/service/X.kt:12` -> `order service/X.kt:12`."""
    m = re.match(r"services/([^/]+)/src/main/kotlin/org/misarch/[^/]+/(.*)$", evidence)
    if m:
        return f"{m.group(1)} {m.group(2)}"
    m = re.match(r"services/([^/]+)/src/main/(.*)$", evidence)
    if m:
        return f"{m.group(1)} {m.group(2)}"
    return evidence
