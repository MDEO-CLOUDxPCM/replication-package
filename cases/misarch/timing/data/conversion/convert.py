#!/usr/bin/env python3
"""Carry the data baseline's databases over to misarch-kotlin's squashed migrations (README.md).

    convert.py status  (--images TAG | --repo DIR [--ref REF])   per service: old / converted / unknown history
    convert.py convert (--images TAG | --repo DIR [--ref REF])   convert, verify and swap in every <svc>_baseline
                                                                  template with the old history; refresh the live DB
    convert.py record OUT.json                                    the snapshot's Flyway history per service (after
                                                                  reset.sh snapshot; read by needs-migration)
    convert.py needs-migration --repo DIR [--ref REF]             exit 1 if the snapshot lacks (or differs from) the
                                                                  migrations of misarch-kotlin REF (default main)
Options: --db-container FMT (default misarch-kotlin-{svc}-db-1), --services a,b,..., --no-flyway (skip the Flyway
CLI checks), --record FILE / --counts FILE (default data/baseline_migrations.json, data/baseline_counts.json), env
FLYWAY_IMAGE (default flyway/flyway:13.10.0, the version of misarch-kotlin's libs.versions.toml).

A service is converted when this directory has <svc>/old/ and the image's (or ref's) migrations start with a
V1_1__create_relations.sql that old/ does not have (all 15 database services). The template's history must be a
prefix of <svc>/old/ (byte-identical copies of the migrations before the squash; the snapshot has the first ones) or
exactly <svc>/squashed/ (an earlier squashed V1_1, invoice and wishlist). In one transaction on a copy of the template
the conversion applies the old migrations the history lacks and <svc>/cleanup.sql (or <svc>/restyle.sql after
squashed/: the deliberate clean-ups), then replaces flyway_schema_history by the row Flyway writes for the new V1_1
(version, description, script, checksum; installed_by and installed_on of the old first row). Then it fails unless the
copy's schema-only dump equals the dump of an empty database migrated with the new V1_1 (Flyway CLI, or psql without
it), the history rows equal Flyway's, and Flyway `validate` passes against the new migration set (later forward
migrations, e.g. block 6's V2__local_copies, may be pending). Only then the copy replaces the template (the old
template is dropped) and the live database. A failure leaves the template and the live database as they were.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.dirname(HERE)
TIMING = os.path.dirname(DATA)
ROOT = os.path.abspath(os.path.join(TIMING, "..", "..", ".."))   # the repository root: the locks live there
sys.path.insert(0, os.path.join(TIMING, "harness"))
from migrations import flyway_checksum, parse_name, vkey  # noqa: E402

MIG_DIR = "/app/BOOT-INF/classes/db/migration"
TARGET = "V1_1__create_relations.sql"
FLYWAY_IMAGE = os.environ.get("FLYWAY_IMAGE", "flyway/flyway:13.10.0")
PASSWORD = os.environ.get("PGPASSWORD_STACK", "postgres")
RECORD = os.path.join(DATA, "baseline_migrations.json")
COUNTS = os.path.join(DATA, "baseline_counts.json")
ALL_SVCS = ("address catalog discount inventory invoice notification order payment return review shipment "
            "shoppingcart tax user wishlist").split()


class Fail(Exception):
    pass


def converted_services():
    return sorted(d for d in os.listdir(HERE) if os.path.isdir(os.path.join(HERE, d, "old")))


def run(args, input=None, timeout=600):
    r = subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


class Pg:
    """psql/pg_dump in a service's Postgres container (user postgres)."""

    def __init__(self, fmt, svc):
        self.container = fmt.format(svc=svc)

    def psql(self, db, sql, check=True, timeout=3600):
        rc, out, err = run(["docker", "exec", "-i", self.container, "psql", "-q", "-X", "-U", "postgres", "-d", db,
                            "-v", "ON_ERROR_STOP=1", "-tA", "-F", "\t"], sql, timeout)
        if check and rc:
            raise Fail(f"{self.container}/{db}: psql failed: {err.strip()[-1500:]}")
        return out

    def rows(self, db, sql):
        return [ln.split("\t") for ln in self.psql(db, sql).splitlines() if ln]

    def dump(self, db):
        rc, out, err = run(["docker", "exec", self.container, "pg_dump", "-U", "postgres", "--schema-only", "--no-owner",
                            "--exclude-table=flyway_schema_history", db])
        if rc:
            raise Fail(f"{self.container}/{db}: pg_dump failed: {err.strip()[-500:]}")
        keep = [ln for ln in out.splitlines()
                if not ln.startswith(("--", "SET ", "SELECT pg_catalog.set_config", "\\restrict", "\\unrestrict"))]
        return re.sub(r"\n{3,}", "\n\n", "\n".join(keep)).strip() + "\n"

    def history(self, db):
        out = self.psql(db, "SELECT coalesce(json_agg(json_build_object('rank', installed_rank, 'version', version, "
                            "'description', description, 'type', type, 'script', script, 'checksum', checksum, "
                            "'success', success) ORDER BY installed_rank), '[]') FROM flyway_schema_history;")
        return json.loads(out.strip() or "[]")

    def counts(self, db):
        tables = [r[0] for r in self.rows(db, "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = "
                                              "c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' "
                                              "AND relname <> 'flyway_schema_history' ORDER BY 1")]
        if not tables:
            return {}
        q = " UNION ALL ".join(f"SELECT '{t}', count(*) FROM public.\"{t}\"" for t in tables)
        return {t: int(n) for t, n in self.rows(db, q + ";")}

    def exists(self, db):
        return bool(self.rows("postgres", f"SELECT 1 FROM pg_database WHERE datname = '{db}';"))


def files_of(path):
    """[{version, description, script, checksum, sql}] of a directory of Flyway migrations, in version order."""
    out = []
    for fn in os.listdir(path):
        m = parse_name(fn)
        if m:
            with open(os.path.join(path, fn), encoding="utf-8") as f:
                m["sql"] = f.read()
            m["checksum"] = flyway_checksum(m["sql"])
            out.append(m)
    return sorted(out, key=lambda m: vkey(m["version"]))


def new_set_from_image(svc, tag, tmp):
    image = f"misarch-kotlin/{svc}:{tag}"
    rc, cid, err = run(["docker", "create", image])
    if rc:
        raise Fail(f"{svc}: no image {image}: {err.strip()}")
    cid = cid.strip()
    try:
        dest = os.path.join(tmp, svc)
        rc, _, err = run(["docker", "cp", f"{cid}:{MIG_DIR}", dest])
        if rc:
            raise Fail(f"{svc}: {image} has no {MIG_DIR}: {err.strip()}")
    finally:
        run(["docker", "rm", cid])
    return files_of(dest)


def repo_set(repo, ref, svc):
    path = f"services/{svc}/src/main/resources/db/migration/"
    rc, out, err = run(["git", "-C", repo, "ls-tree", "--name-only", ref, path])
    if rc:
        raise Fail(f"git ls-tree {ref} {path}: {err.strip()}")
    res = []
    for p in out.split():
        m = parse_name(os.path.basename(p))
        if m:
            rc, sql, err = run(["git", "-C", repo, "show", f"{ref}:{p}"])
            m["sql"] = sql
            m["checksum"] = flyway_checksum(sql)
            res.append(m)
    return sorted(res, key=lambda m: vkey(m["version"]))


def write_set(dirpath, migs):
    os.makedirs(dirpath, exist_ok=True)
    os.chmod(dirpath, 0o755)
    for m in migs:
        p = os.path.join(dirpath, m["script"])
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(m["sql"])
        os.chmod(p, 0o644)


def is_squashed(new, old):
    """The new set starts with a V1_1 that the old set does not have (the 8 Kotlin-origin services' own V1_1 counts
    as squashed once its content changed)."""
    if not new or new[0]["script"] != TARGET:
        return False
    first = [m for m in old if m["script"] == TARGET]
    return not first or first[0]["checksum"] != new[0]["checksum"]


def classify(hist, old, new, squashed=()):
    """'old' (a prefix of the old set), 'squashed' (exactly the earlier squashed set <svc>/squashed/), 'converted'
    (only versions of the new set, incl. V1_1) or 'unknown: ...'."""
    if any(not h["success"] for h in hist):
        return "unknown: a failed migration in flyway_schema_history"
    applied = [h for h in hist if h["version"] is not None]
    if any(h["type"] != "SQL" for h in hist):
        return "unknown: non-SQL rows (baseline?) in flyway_schema_history"
    key = lambda ms: [(m["version"], m["script"], m["checksum"]) for m in ms]  # noqa: E731
    have = key(applied)
    newmap = {m["version"]: m for m in new}
    if have and all(v in newmap and newmap[v]["script"] == s and newmap[v]["checksum"] == c for v, s, c in have) \
            and new[0]["version"] in [v for v, _, _ in have]:
        return "converted"
    if have and have == key(old)[:len(have)]:
        return "old"
    if squashed and have == key(squashed):
        return "squashed"
    return f"unknown: history {[(v, s) for v, s, _ in have]} matches neither the old set nor the new one"


def sql_literal(s):
    return "'" + s.replace("'", "''") + "'"


def conversion_sql(svc, pending, target, step="cleanup.sql"):
    """pending old migrations, then <step> (cleanup.sql after the old set, restyle.sql after the squashed one), then
    the history row of the new V1_1, in one transaction"""
    with open(os.path.join(HERE, svc, step), encoding="utf-8") as f:
        cleanup = f.read()
    # no parallel index builds: the containers' /dev/shm (64 MB) is too small for them at full size (README of data/)
    parts = ["BEGIN;", "SET LOCAL max_parallel_maintenance_workers = 0;"]
    for m in pending:
        parts += [f"-- conversion/{svc}/old/{m['script']}", m["sql"], ";"]
    parts += [f"-- conversion/{svc}/{step}", cleanup, ";",
              "CREATE TEMP TABLE conversion_first ON COMMIT DROP AS SELECT installed_by, installed_on, "
              "(SELECT sum(execution_time) FROM flyway_schema_history)::int AS execution_time "
              "FROM flyway_schema_history ORDER BY installed_rank LIMIT 1;",
              "DELETE FROM flyway_schema_history;",
              "INSERT INTO flyway_schema_history (installed_rank, version, description, type, script, checksum, "
              "installed_by, installed_on, execution_time, success) "
              f"SELECT 1, {sql_literal(target['version'])}, {sql_literal(target['description'])}, 'SQL', "
              f"{sql_literal(target['script'])}, {target['checksum']}, installed_by, installed_on, execution_time, true "
              "FROM conversion_first;",
              "COMMIT;"]
    return "\n".join(parts) + "\n"


def flyway(pg, db, locdir, *args):
    return run(["docker", "run", "--rm", "--network", f"container:{pg.container}", "-v", f"{locdir}:/flyway/sql:ro",
                FLYWAY_IMAGE, f"-url=jdbc:postgresql://localhost:5432/{db}", "-user=postgres", f"-password={PASSWORD}",
                "-locations=filesystem:/flyway/sql", *args], timeout=900)


def have_flyway():
    return run(["docker", "image", "inspect", FLYWAY_IMAGE])[0] == 0


def verify(pg, svc, conv, new, tmp, use_flyway):
    """Fail unless <conv> has exactly the schema and history of an empty database migrated with new[0]."""
    target = new[0]
    fresh = f"{svc}_fresh"
    pg.psql("postgres", f'DROP DATABASE IF EXISTS "{fresh}" WITH (FORCE);\nCREATE DATABASE "{fresh}";')
    try:
        tdir = os.path.join(tmp, f"{svc}-target")
        write_set(tdir, [target])
        if use_flyway:
            rc, out, err = flyway(pg, fresh, tdir, "migrate")
            if rc:
                raise Fail(f"{svc}: Flyway migrate of {fresh} failed: {(out + err).strip()[-1500:]}")
        else:
            pg.psql(fresh, f"BEGIN;\n{target['sql']}\n;\nCOMMIT;\n")
        a, b = pg.dump(conv), pg.dump(fresh)
        if a != b:
            diff = "".join(difflib.unified_diff(b.splitlines(True), a.splitlines(True), f"{fresh} (new V1_1)", conv))
            raise Fail(f"{svc}: the converted schema differs from the new migrations':\n{diff}")
        fields = ("version", "description", "type", "script", "checksum", "success")
        hc = [{k: h[k] for k in fields} for h in pg.history(conv)]
        want = [{"version": target["version"], "description": target["description"], "type": "SQL",
                 "script": target["script"], "checksum": target["checksum"], "success": True}]
        if use_flyway:
            hf = [{k: h[k] for k in fields} for h in pg.history(fresh)]
            if hf != want:
                raise Fail(f"{svc}: Flyway wrote {hf}, expected {want}")
        if hc != want:
            raise Fail(f"{svc}: converted history {hc} != {want}")
        if use_flyway:
            adir = os.path.join(tmp, f"{svc}-all")
            write_set(adir, new)
            rc, out, err = flyway(pg, conv, adir, "validate", "-ignoreMigrationPatterns=*:pending")
            if rc:
                raise Fail(f"{svc}: Flyway validate of the converted database failed: {(out + err).strip()[-1500:]}")
        return ("schema = new V1_1, history = Flyway's row, flyway validate ok" if use_flyway else
                "schema = new V1_1, history row as computed (Flyway CLI not used)")
    finally:
        pg.psql("postgres", f'DROP DATABASE IF EXISTS "{fresh}" WITH (FORCE);', check=False)


def convert_one(pg, svc, new, tmp, use_flyway, dry=False):
    old = files_of(os.path.join(HERE, svc, "old"))
    sq_dir = os.path.join(HERE, svc, "squashed")
    squashed = files_of(sq_dir) if os.path.isdir(sq_dir) else []
    if not is_squashed(new, old):
        return f"nothing to convert: these migrations are not squashed ({', '.join(m['script'] for m in new)})"
    base, conv = f"{svc}_baseline", f"{svc}_conv"
    if not pg.exists(base):
        raise Fail(f"{svc}: no template database {base} in {pg.container}")
    pg.psql("postgres", f'DROP DATABASE IF EXISTS "{conv}" WITH (FORCE);\n'
                        f'CREATE DATABASE "{conv}" TEMPLATE "{base}" STRATEGY FILE_COPY;')
    try:
        state = classify(pg.history(conv), old, new, squashed)
        if state not in ("old", "squashed") or dry:
            return state
        applied = {h["version"] for h in pg.history(conv)}
        pending = [m for m in old if m["version"] not in applied] if state == "old" else []
        step = "cleanup.sql" if state == "old" else "restyle.sql"
        before = pg.counts(conv)
        t0 = time.time()
        pg.psql(conv, conversion_sql(svc, pending, new[0], step))
        took = time.time() - t0
        after = pg.counts(conv)
        how = verify(pg, svc, conv, new, tmp, use_flyway)
        # swap: the verified copy becomes the template, the live database a copy of it
        pg.psql("postgres", f"SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '{conv}';")
        for stmt in (f'BEGIN;\nALTER DATABASE "{base}" RENAME TO "{base}_old";\nALTER DATABASE "{conv}" RENAME TO '
                     f'"{base}";\nALTER DATABASE "{base}" ALLOW_CONNECTIONS false;\nCOMMIT;',
                     f'DROP DATABASE "{base}_old";',
                     f'DROP DATABASE IF EXISTS "{svc}" WITH (FORCE);',
                     f'CREATE DATABASE "{svc}" TEMPLATE "{base}" STRATEGY FILE_COPY;'):
            pg.psql("postgres", stmt)
        nb, na = sum(before.values()), sum(after.values())
        return (f"converted ({', '.join(m['script'] for m in pending) or 'no old migrations'} + {step}, "
                f"{took:.0f} s); {how}; rows {nb} -> {na}" + ("" if nb == na else f" (CHANGED: {before} -> {after})"))
    finally:
        if pg.exists(conv):
            pg.psql("postgres", f'DROP DATABASE IF EXISTS "{conv}" WITH (FORCE);', check=False)


def new_sets(a, svcs, tmp):
    if a.images:
        return {s: new_set_from_image(s, a.images, tmp) for s in svcs}
    return {s: repo_set(a.repo, a.ref, s) for s in svcs}


def cmd_convert(a, dry):
    if os.path.exists(os.path.join(ROOT, "MEASURING.lock")):
        print("MEASURING.lock exists - not touching the databases", file=sys.stderr)
        return 3
    svcs = a.services.split(",") if a.services else converted_services()
    use_flyway = not a.no_flyway and have_flyway()
    if not dry and not a.no_flyway and not use_flyway:
        print(f"note: {FLYWAY_IMAGE} not present (docker pull it for the Flyway checks); checksums are computed instead")
    tmp = tempfile.mkdtemp(prefix="baseline-conversion-")
    bad = False
    try:
        sets = new_sets(a, svcs, tmp)
        for s in svcs:
            try:
                r = convert_one(Pg(a.db_container, s), s, sets[s], tmp, use_flyway, dry)
            except Fail as e:
                r, bad = f"FAILED: {e}", True
            bad |= r.startswith("unknown")
            print(f"{s}: {r}", flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 1 if bad else 0


def cmd_record(a):
    out = {"recorded": time.strftime("%Y-%m-%d %H:%M:%S"), "countsSha256": sha256(a.counts), "services": {}}
    for s in (a.services.split(",") if a.services else ALL_SVCS):
        h = Pg(a.db_container, s).history(s)
        out["services"][s] = [{"version": x["version"], "script": x["script"], "checksum": x["checksum"]}
                              for x in h if x["version"] is not None and x["success"]]
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(f"recorded the snapshot's migrations of {len(out['services'])} services in {a.out}")
    return 0


def sha256(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def cmd_needs(a):
    """0: the snapshot has exactly the migrations of the repository's REF; 1: it must be migrated (reason printed)."""
    rec = None
    if os.path.exists(a.record):
        with open(a.record) as f:
            rec = json.load(f)
        if rec.get("countsSha256") != sha256(a.counts):
            print(f"{os.path.basename(a.record)} predates the current snapshot (baseline_counts.json changed): ignored")
            rec = None
    if rec is not None:
        diff = []
        for s in (a.services.split(",") if a.services else ALL_SVCS):
            want = {(m["version"], m["checksum"]) for m in repo_set(a.repo, a.ref, s)}
            have = {(m["version"], m["checksum"]) for m in rec["services"].get(s, [])}
            if want != have:
                diff.append(f"{s} (missing {sorted(v for v, _ in want - have)}, "
                            f"not in {a.ref} {sorted(v for v, _ in have - want)})")
        if diff:
            print("the snapshot's migrations differ from misarch-kotlin " + a.ref + ": " + "; ".join(diff))
            return 1
        return 0
    # no record of the snapshot: main's table names and at least as many applied migrations as main has files; a
    # squashed service needs the conversion (whether the snapshot has it is only known from the record)
    with open(a.counts) as f:
        b = json.load(f)
    need = {"order": "ordercompensationtoorderitementity", "invoice": "invoiceentity", "review": "reviewentity",
            "inventory": "productvariantentity", "wishlist": "wishlisttoproductvariantentity"}
    miss = [f"{s}.{t}" for s, t in need.items() if t not in b.get(s, {})]
    for s in sorted(k for k, v in b.items() if isinstance(v, dict)):   # per service: {table: rows}
        n = len(repo_set(a.repo, a.ref, s))
        if b[s].get("flyway_schema_history", 0) < n:
            miss.append(f"{s}: {b[s].get('flyway_schema_history', 0)} of {a.ref}'s {n} migrations")
    if miss:
        print(f"the snapshot lacks the schema of misarch-kotlin {a.ref}: {miss}")
        return 1
    squashed = [s for s in converted_services()
                if is_squashed(repo_set(a.repo, a.ref, s), files_of(os.path.join(HERE, s, "old")))]
    if squashed:
        print(f"misarch-kotlin {a.ref} has squashed migrations ({', '.join(squashed)}) and the snapshot's migrations "
              f"are not recorded ({os.path.basename(a.record)})")
        return 1
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("cmd", choices=["status", "convert", "record", "needs-migration"])
    p.add_argument("out", nargs="?", default=RECORD)
    p.add_argument("--images")
    p.add_argument("--repo")
    p.add_argument("--ref", default="main")
    p.add_argument("--db-container", default="misarch-kotlin-{svc}-db-1")
    p.add_argument("--services")
    p.add_argument("--no-flyway", action="store_true")
    p.add_argument("--record", default=RECORD, help="needs-migration: the record file")
    p.add_argument("--counts", default=COUNTS, help="record, needs-migration: baseline_counts.json")
    a = p.parse_args()
    if a.cmd in ("status", "convert") and not (a.images or a.repo):
        p.error("--images TAG or --repo DIR")
    if a.cmd == "needs-migration" and not a.repo:
        p.error("--repo DIR")
    try:
        if a.cmd == "record":
            return cmd_record(a)
        if a.cmd == "needs-migration":
            return cmd_needs(a)
        return cmd_convert(a, dry=a.cmd == "status")
    except Fail as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
