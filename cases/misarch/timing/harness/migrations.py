#!/usr/bin/env python3
"""Flyway migrations after a data reset (README.md §4.2).

    migrations.py check          per service: migrations in the running image vs applied in its database
    migrations.py apply          apply the missing ones (SQL from the image, history row as Flyway writes it)

The data baseline (timing/data/reset.sh) is a database snapshot. An image with a migration the snapshot does not
have (block 6's order V2__local_copies, or an index migration newer than the snapshot) applies it when its JVM
starts, and the reset then drops it again. Restarting the app after every reset (Flyway at start) would throw its
compiled code away, so the missing migrations are applied from outside instead and the JVMs stay warm
(harness/bursts.py). The SQL comes from the running container (/app/BOOT-INF/classes/db/migration, the exploded
Spring Boot jar), the history row gets Flyway's checksum (CRC32 over the lines without line breaks, signed 32 bit)
so a later JVM start validates it. A migration that fails is reported and left out (exit 1).
"""
import json
import re
import subprocess
import sys
import zlib

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import stackctl as S  # noqa: E402

MIG_DIR = "/app/BOOT-INF/classes/db/migration"
FILE = re.compile(r"^V(\d+(?:[._]\d+)*)__(.+)\.sql$")


def flyway_checksum(text):
    """Flyway's ChecksumCalculator: CRC32 updated with each line (BOM stripped, line break removed), signed int."""
    if text.startswith("﻿"):
        text = text[1:]
    lines = re.split(r"\r\n|\r|\n", text)
    if lines and lines[-1] == "":
        lines = lines[:-1]
    c = 0
    for ln in lines:
        c = zlib.crc32(ln.encode("utf-8"), c)
    return c - (1 << 32) if c >= (1 << 31) else c


def parse_name(fn):
    m = FILE.match(fn)
    if not m:
        return None
    return {"version": m.group(1).replace("_", "."), "description": m.group(2).replace("_", " "), "script": fn}


def image_migrations(app):
    rc, out, err = S.sh(["docker", "exec", app, "sh", "-c", f"ls {MIG_DIR} 2>/dev/null"])
    return [m for m in (parse_name(f.strip()) for f in out.split()) if m]


def applied(db, name):
    rc, out, err = S.psql(db, "SELECT coalesce(json_agg(json_build_object('version', version, 'success', success, "
                              "'checksum', checksum, 'rank', installed_rank)), '[]') FROM flyway_schema_history;", name)
    if rc:
        return None
    return json.loads(out.strip() or "[]")


def vkey(v):
    return tuple(int(x) for x in v.split("."))


def services():
    apps = S.apps()
    dbs = set(S.dbs())
    out = []
    for a in apps:
        svc = S.short(a)
        db = f"{S.PREFIX}{svc}-db-1"
        if db in dbs:
            out.append((svc, a, db))
    return out


def check():
    res = {}
    for svc, app, db in services():
        img = image_migrations(app)
        have = applied(db, svc)
        if have is None:
            res[svc] = {"error": "no flyway_schema_history"}
            continue
        ok = {h["version"] for h in have if h["success"] and h["version"]}
        res[svc] = {"image": [m["version"] for m in img], "applied": sorted(ok, key=vkey),
                    "missing": [m for m in img if m["version"] not in ok]}
    return res


def apply_one(svc, app, db, m, have):
    rc, sql, err = S.sh(["docker", "exec", app, "cat", f"{MIG_DIR}/{m['script']}"])
    if rc:
        return {"script": m["script"], "ok": False, "error": err.strip()[-200:]}
    rank = max([h["rank"] for h in have] or [0]) + 1
    cs = flyway_checksum(sql)
    esc = lambda s: s.replace("'", "''")  # noqa: E731
    stmt = (f"BEGIN;\n{sql}\n;\nINSERT INTO flyway_schema_history (installed_rank, version, description, type, script, "
            f"checksum, installed_by, execution_time, success) VALUES ({rank}, '{esc(m['version'])}', "
            f"'{esc(m['description'])}', 'SQL', '{esc(m['script'])}', {cs}, current_user, 0, true);\nCOMMIT;\n")
    rc, out, err = S.psql(db, stmt, svc, timeout=300)
    return {"script": m["script"], "ok": rc == 0, "checksum": cs, "error": err.strip()[-300:] if rc else None}


def apply():
    res, bad = {}, False
    for svc, app, db in services():
        have = applied(db, svc)
        if have is None:
            continue
        ok = {h["version"] for h in have if h["success"] and h["version"]}
        for m in sorted((m for m in image_migrations(app) if m["version"] not in ok), key=lambda m: vkey(m["version"])):
            r = apply_one(svc, app, db, m, have)
            res.setdefault(svc, []).append(r)
            bad |= not r["ok"]
            have = applied(db, svc) or have
    return res, bad


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        r = check()
        print(json.dumps({k: (v if "error" in v else {"missing": [m["script"] for m in v["missing"]],
                                                       "applied": v["applied"]}) for k, v in r.items()}, indent=1))
        return 0
    if cmd == "apply":
        r, bad = apply()
        print(json.dumps(r, indent=1) if r else "no missing migrations")
        return 1 if bad else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
