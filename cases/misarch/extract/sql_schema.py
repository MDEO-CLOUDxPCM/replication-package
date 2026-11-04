"""Tables, columns, keys, indexes and triggers of every service database, from the Flyway migrations
(services/*/src/main/resources/db/migration/V*.sql), applied in version order.

Understood DDL (Postgres syntax; identifiers may be quoted or schema-qualified, keywords are case-insensitive):
- CREATE TABLE [IF NOT EXISTS] t (columns with inline PRIMARY KEY / UNIQUE / REFERENCES / NOT NULL,
  [CONSTRAINT name] PRIMARY KEY (..) | UNIQUE (..) | FOREIGN KEY (..) REFERENCES t (..) | CHECK (..));
- ALTER TABLE [IF EXISTS] [ONLY] t action [, action ...] with the actions RENAME TO, RENAME [COLUMN] a TO b,
  RENAME CONSTRAINT a TO b, ADD [COLUMN] [IF NOT EXISTS], DROP [COLUMN] [IF EXISTS], ADD [CONSTRAINT name]
  PRIMARY KEY (..) | UNIQUE (..) | FOREIGN KEY .. | CHECK .. (also `.. USING INDEX i`), DROP CONSTRAINT [IF EXISTS],
  ALTER [COLUMN] c [SET DATA] TYPE t [USING ..] | SET/DROP NOT NULL | SET/DROP DEFAULT;
- DROP TABLE [IF EXISTS] a [, b] [CASCADE];
- CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] i ON t [USING m] (cols), DROP INDEX, ALTER INDEX i RENAME TO j;
- CREATE FUNCTION (the tables its body reads/writes) and CREATE TRIGGER.
Anything else (DML, DO blocks, extensions, COMMENT) changes no structure here and is skipped; an ALTER TABLE action
this module does not understand, or one naming an unknown table, column or constraint, raises SchemaError (a silent
skip would leave a renamed or dropped table/column in the domain model). DO blocks are not interpreted: a constraint
they drop (e.g. a UNIQUE looked up in pg_constraint) stays listed.

Constraint names are Postgres's defaults where the migration gives none (`<table>_pkey`, `<table>_<cols>_key`,
`<table>_<col>_fkey`, `<table>_<col>_check`), so a later `DROP CONSTRAINT <default name>` finds them.

Row sizes are rough: fixed widths of the Postgres types, 32 bytes for a text/varchar/json column
(MiSArch's values are short names and ids), 24 bytes of tuple header. They only rank classes.
"""

import re

import gitsrc

TYPE_BYTES = {
    "uuid": 16, "boolean": 1, "bool": 1, "int": 4, "integer": 4, "serial": 4, "smallint": 2,
    "bigint": 8, "bigserial": 8, "double": 8, "real": 4, "float": 8, "numeric": 16,
    "timestamptz": 8, "timestamp": 8, "date": 4, "text": 32, "varchar": 32, "character": 32,
    "json": 64, "jsonb": 64,
}
TUPLE_HEADER = 24

ID = r'(?:"[^"]+"|[A-Za-z_][\w$]*)'
QID = rf'(?:{ID}\s*\.\s*)?{ID}'           # optionally schema-qualified
TYPE_RE = re.compile(r'(?i)(double precision|character varying|[\w]+(?:\([^)]*\))?(?:\[\])?)')


class SchemaError(Exception):
    pass


def _version_key(path):
    m = re.search(r"/V(\d+)(?:_(\d+))?__", path)
    return (int(m.group(1)), int(m.group(2) or 0)) if m else (0, 0)


def migrations(svc):
    files = gitsrc.glob(f"services/{svc}/src/main/resources/db/migration/", ".sql")
    return sorted(files, key=_version_key)


def _statements(src):
    """(statement text, offset) with comments blanked; `$$ ... $$` bodies stay inside one statement."""
    clean = re.sub(r"--[^\n]*", lambda m: " " * len(m.group(0)), src)
    out, start, i, in_dollar = [], 0, 0, False
    while i < len(clean):
        if clean.startswith("$$", i):
            in_dollar = not in_dollar
            i += 2
            continue
        if clean[i] == ";" and not in_dollar:
            out.append((clean[start:i], start))
            start = i + 1
        i += 1
    if clean[start:].strip():
        out.append((clean[start:], start))
    return [(s, off + (len(s) - len(s.lstrip()))) for s, off in out if s.strip()]


def _split_top(body):
    parts, depth, cur, quoted = [], 0, "", False
    for ch in body:
        if ch == "'":
            quoted = not quoted
        elif not quoted and ch == "(":
            depth += 1
        elif not quoted and ch == ")":
            depth -= 1
        if ch == "," and depth == 0 and not quoted:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return [p.strip() for p in parts]


def _name(tok):
    """An identifier as written, without quotes and schema (`public."OrderEntity"` -> `OrderEntity`)."""
    tok = tok.strip()
    parts = re.findall(ID, tok)
    return parts[-1].strip('"') if parts else tok


def _names(text):
    return [_name(c) for c in _split_top(text)]


def _type_bytes(t):
    base = re.match(r"[a-zA-Z]+", t).group(0).lower()
    if t.strip().endswith("[]"):
        return 64
    return TYPE_BYTES.get(base, 16)


class _Schema:
    def __init__(self, svc):
        self.svc = svc
        self.tables = {}
        self.triggers, self.functions = [], {}

    # ---------------------------------------------------------------- lookups
    def table(self, name, ev):
        t = self.tables.get(_name(name).lower())
        if t is None:
            raise SchemaError(f"{ev}: unknown table {_name(name)!r}")
        return t

    @staticmethod
    def col(t, name, ev):
        n = _name(name).lower()
        hit = next((c for c in t["columns"] if c.lower() == n), None)
        if hit is None:
            raise SchemaError(f"{ev}: {t['table']} has no column {_name(name)!r}")
        return hit

    # ---------------------------------------------------------------- constraints
    @staticmethod
    def _default_name(t, kind, cols):
        base = t["table"].lower()
        if kind == "pk":
            return f"{base}_pkey"
        suffix = {"unique": "key", "fk": "fkey", "check": "check"}[kind]
        return "_".join([base, *[c.lower() for c in cols], suffix]) if cols else f"{base}_{suffix}"

    def add_constraint(self, t, part, ev):
        """A table constraint (`[CONSTRAINT n] PRIMARY KEY (..)` etc.); False if `part` is none."""
        m = re.match(rf"(?is)(?:CONSTRAINT\s+({ID})\s+)?(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE)\b\s*(.*)$", part)
        if not m:
            return False
        name, kind, rest = (_name(m.group(1)) if m.group(1) else None), " ".join(m.group(2).upper().split()), m.group(3)
        um = re.match(rf"(?i)USING\s+INDEX\s+({ID})", rest)
        if um and kind in ("PRIMARY KEY", "UNIQUE"):
            idx = next((i for i in t["indexes"] if i["name"].lower() == _name(um.group(1)).lower()), None)
            if idx is None:
                raise SchemaError(f"{ev}: {t['table']} has no index {_name(um.group(1))!r}")
            t["indexes"].remove(idx)  # the index becomes the constraint's
            cols, name = idx["columns"], name or idx["name"]
        elif kind in ("PRIMARY KEY", "UNIQUE", "FOREIGN KEY"):
            cm = re.match(r"\(([^)]*)\)", rest)
            if not cm:
                raise SchemaError(f"{ev}: {kind} without columns: {part!r}")
            cols = [self.col(t, c, ev) for c in _names(cm.group(1))]
        else:
            cols = []
        if kind == "PRIMARY KEY":
            t["primaryKey"] = cols
            for c in cols:
                t["columns"][c]["notNull"] = True
            t["_constraints"][(name or self._default_name(t, "pk", cols)).lower()] = ("pk", cols)
        elif kind == "UNIQUE":
            t["unique"].append(cols)
            t["_constraints"][(name or self._default_name(t, "unique", cols)).lower()] = ("unique", cols)
        elif kind == "FOREIGN KEY":
            rm = re.match(rf"(?is)\([^)]*\)\s*REFERENCES\s+({QID})", rest)
            if not rm:
                raise SchemaError(f"{ev}: FOREIGN KEY without REFERENCES: {part!r}")
            fks = [{"column": c, "references": _name(rm.group(1)), "evidence": ev} for c in cols]
            t["foreignKeys"].extend(fks)
            t["_constraints"][(name or self._default_name(t, "fk", cols)).lower()] = ("fk", fks)
        else:  # CHECK / EXCLUDE: no structure, only the name
            t["_constraints"][(name or self._default_name(t, "check", [])).lower()] = ("check", None)
        return True

    def drop_constraint(self, t, name, if_exists, ev):
        kind, payload = t["_constraints"].pop(_name(name).lower(), (None, None))
        if kind is None:
            if not if_exists:
                raise SchemaError(f"{ev}: {t['table']} has no constraint {_name(name)!r}")
        elif kind == "pk":
            t["primaryKey"] = []
        elif kind == "unique":
            t["unique"].remove(payload)
        elif kind == "fk":
            t["foreignKeys"] = [f for f in t["foreignKeys"] if not any(f is p for p in payload)]

    # ---------------------------------------------------------------- columns
    def add_column(self, t, part, ev):
        cm = re.match(rf"(?is)({ID})\s+(.+)$", part)
        if not cm:
            raise SchemaError(f"{ev}: cannot read column definition {part!r}")
        col, rest = _name(cm.group(1)), cm.group(2)
        if any(c.lower() == col.lower() for c in t["columns"]):
            raise SchemaError(f"{ev}: {t['table']} already has a column {col!r}")
        typ = TYPE_RE.match(rest).group(1)
        is_pk = bool(re.search(r"(?i)PRIMARY KEY", rest))
        t["columns"][col] = {"type": typ.lower(), "notNull": bool(re.search(r"(?i)NOT NULL", rest)) or is_pk}
        if is_pk:
            t["primaryKey"] = [col]
            t["_constraints"][self._default_name(t, "pk", [col])] = ("pk", [col])
        if re.search(r"(?i)\bUNIQUE\b", rest):
            t["unique"].append([col])
            t["_constraints"][self._default_name(t, "unique", [col])] = ("unique", [col])
        rm = re.search(rf"(?i)REFERENCES\s+({QID})", rest)
        if rm:
            fk = {"column": col, "references": _name(rm.group(1)), "evidence": ev}
            t["foreignKeys"].append(fk)
            t["_constraints"][self._default_name(t, "fk", [col])] = ("fk", [fk])
        if re.search(r"(?i)\bCHECK\s*\(", rest):
            t["_constraints"][self._default_name(t, "check", [col])] = ("check", None)

    def drop_column(self, t, col):
        """The column and everything built on it (its keys, indexes, foreign keys)."""
        t["columns"].pop(col)
        if col in t["primaryKey"]:
            t["primaryKey"] = []
        t["unique"] = [u for u in t["unique"] if col not in u]
        t["indexes"] = [i for i in t["indexes"] if col not in i["columns"]]
        t["foreignKeys"] = [f for f in t["foreignKeys"] if f["column"] != col]
        for name, (kind, payload) in list(t["_constraints"].items()):
            cols = [f["column"] for f in payload] if kind == "fk" else payload or []
            if col in cols:
                del t["_constraints"][name]

    def rename_column(self, t, old, new):
        t["columns"] = {(new if c == old else c): v for c, v in t["columns"].items()}
        ren = lambda cols: [new if c == old else c for c in cols]  # noqa: E731
        t["primaryKey"] = ren(t["primaryKey"])
        t["unique"] = [ren(u) for u in t["unique"]]
        for i in t["indexes"]:
            i["columns"] = ren(i["columns"])
        for f in t["foreignKeys"]:
            if f["column"] == old:
                f["column"] = new
        t["_constraints"] = {n: (k, ren(p) if k in ("pk", "unique") else p) for n, (k, p) in t["_constraints"].items()}

    # ---------------------------------------------------------------- statements
    def create_table(self, name, body, ev):
        if name.lower() in self.tables:
            raise SchemaError(f"{ev}: table {name!r} exists already")
        t = self.tables[name.lower()] = {
            "table": name, "service": self.svc, "evidence": ev, "columns": {}, "primaryKey": [],
            "foreignKeys": [], "unique": [], "indexes": [], "_constraints": {},
        }
        parts = _split_top(body)
        for part in parts:  # columns first: table constraints may name later columns
            if not re.match(rf"(?i)(?:CONSTRAINT\s+{ID}\s+)?(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE|LIKE)\b", part):
                self.add_column(t, part, ev)
        for part in parts:
            if re.match(r"(?i)LIKE\b", part):
                raise SchemaError(f"{ev}: CREATE TABLE ... (LIKE ...) is not supported")
            if re.match(rf"(?i)(?:CONSTRAINT\s+{ID}\s+)?(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|EXCLUDE)\b", part):
                self.add_constraint(t, part, ev)

    def alter_table(self, name, actions, ev):
        t = self.table(name, ev)
        rm = re.match(rf"(?is)RENAME\s+TO\s+({ID})\s*$", actions)
        if rm:  # a rename is the only action of its statement
            old, new = t["table"], _name(rm.group(1))
            if new.lower() in self.tables and new.lower() != old.lower():
                raise SchemaError(f"{ev}: cannot rename {old} to {new}: the table exists")
            del self.tables[old.lower()]
            t["table"] = new
            self.tables[new.lower()] = t
            for other in self.tables.values():
                for f in other["foreignKeys"]:
                    if f["references"].lower() == old.lower():
                        f["references"] = new
            for tr in self.triggers:
                if tr["table"] == old.lower():
                    tr["table"] = new.lower()
            return
        for act in _split_top(actions):
            self.alter_action(t, act, ev)

    def alter_action(self, t, act, ev):
        act = act.strip()
        m = re.match(rf"(?is)RENAME\s+CONSTRAINT\s+({ID})\s+TO\s+({ID})\s*$", act)
        if m:
            entry = t["_constraints"].pop(_name(m.group(1)).lower(), None)
            if entry is None:
                raise SchemaError(f"{ev}: {t['table']} has no constraint {_name(m.group(1))!r}")
            t["_constraints"][_name(m.group(2)).lower()] = entry
            return
        m = re.match(rf"(?is)RENAME\s+(?:COLUMN\s+)?({ID})\s+TO\s+({ID})\s*$", act)
        if m:
            old, new = self.col(t, m.group(1), ev), _name(m.group(2))
            if any(c.lower() == new.lower() for c in t["columns"]) and new.lower() != old.lower():
                raise SchemaError(f"{ev}: {t['table']} already has a column {new!r}")
            self.rename_column(t, old, new)
            return
        m = re.match(r"(?is)ADD\s+(.*)$", act)
        if m:
            rest = m.group(1)
            if self.add_constraint(t, rest, ev):
                return
            cm = re.match(r"(?is)(?:COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(.*)$", rest)
            if cm.group(1):
                col = re.match(ID, cm.group(2).strip())
                if col and any(c.lower() == _name(col.group(0)).lower() for c in t["columns"]):
                    return
            self.add_column(t, cm.group(2), ev)
            return
        m = re.match(rf"(?is)DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?({ID})(?:\s+(?:CASCADE|RESTRICT))?\s*$", act)
        if m:
            self.drop_constraint(t, m.group(2), bool(m.group(1)), ev)
            return
        m = re.match(rf"(?is)DROP\s+(?:COLUMN\s+)?(IF\s+EXISTS\s+)?({ID})(?:\s+(?:CASCADE|RESTRICT))?\s*$", act)
        if m:
            n = _name(m.group(2)).lower()
            hit = next((c for c in t["columns"] if c.lower() == n), None)
            if hit is None and not m.group(1):
                raise SchemaError(f"{ev}: {t['table']} has no column {_name(m.group(2))!r}")
            if hit is not None:
                self.drop_column(t, hit)
            return
        m = re.match(rf"(?is)ALTER\s+(?:COLUMN\s+)?({ID})\s+(.*)$", act)
        if m:
            c = t["columns"][self.col(t, m.group(1), ev)]
            what = m.group(2).strip()
            tm = re.match(r"(?is)(?:SET\s+DATA\s+)?TYPE\s+(.*)$", what)
            if tm:
                typ = TYPE_RE.match(tm.group(1).strip())
                if not typ:
                    raise SchemaError(f"{ev}: cannot read type in {act!r}")
                c["type"] = typ.group(1).lower()
            elif re.match(r"(?i)SET\s+NOT\s+NULL\s*$", what):
                c["notNull"] = True
            elif re.match(r"(?i)DROP\s+NOT\s+NULL\s*$", what):
                c["notNull"] = False
            elif re.match(r"(?is)(SET\s+DEFAULT\b|DROP\s+DEFAULT\s*$|SET\s+STATISTICS\b|SET\s+STORAGE\b|"
                          r"SET\s+COMPRESSION\b|DROP\s+IDENTITY\b|ADD\s+GENERATED\b|SET\s*\(|RESET\s*\()", what):
                pass  # no structural effect
            else:
                raise SchemaError(f"{ev}: unsupported column change {act!r}")
            return
        if re.match(r"(?is)(OWNER\s+TO|SET\s+(?:LOGGED|UNLOGGED|TABLESPACE|SCHEMA|\()|RESET\s*\(|"
                    r"(?:ENABLE|DISABLE)\s+(?:ROW\s+LEVEL\s+SECURITY|TRIGGER|RULE)|FORCE|NO\s+FORCE|CLUSTER|"
                    r"SET\s+WITHOUT|VALIDATE\s+CONSTRAINT|REPLICA\s+IDENTITY)\b", act):
            return  # no structural effect
        raise SchemaError(f"{ev}: unsupported ALTER TABLE action {act!r} on {t['table']}")

    def statement(self, s, ev):
        m = re.match(rf"(?is)CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+"
                     rf"(?:IF\s+NOT\s+EXISTS\s+)?({QID})\s*\((.*)\)\s*$", s)
        if m:
            name = _name(m.group(1))
            if re.search(r"(?i)IF\s+NOT\s+EXISTS", s[:m.start(1)]) and name.lower() in self.tables:
                return
            self.create_table(name, m.group(2), ev)
            return
        m = re.match(rf"(?is)ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(?:ONLY\s+)?({QID})\s*\*?\s+(.*)$", s)
        if m:
            if m.group(1) and _name(m.group(2)).lower() not in self.tables:
                return
            self.alter_table(m.group(2), m.group(3), ev)
            return
        m = re.match(r"(?is)DROP\s+TABLE\s+(IF\s+EXISTS\s+)?(.*?)(?:\s+(?:CASCADE|RESTRICT))?\s*$", s)
        if m:
            for n in _names(m.group(2)):
                if n.lower() not in self.tables:
                    if m.group(1):
                        continue
                    raise SchemaError(f"{ev}: unknown table {n!r}")
                del self.tables[n.lower()]
                self.triggers = [tr for tr in self.triggers if tr["table"] != n.lower()]
            return
        m = re.match(rf"(?is)CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?({ID})?\s*ON\s+"
                     rf"(?:ONLY\s+)?({QID})\s*(?:USING\s+\w+\s*)?\((.*?)\)\s*(?:INCLUDE\s*\(|WHERE\b|WITH\b|TABLESPACE\b|$)", s)
        if m:
            t = self.table(m.group(4), ev)
            name = _name(m.group(3)) if m.group(3) else None
            if m.group(2) and name and any(i["name"].lower() == name.lower() for i in t["indexes"]):
                return
            cols = []
            for c in _split_top(m.group(5)):
                cm = re.match(rf"\s*({ID})\s*(?:ASC|DESC|NULLS\s+\w+|COLLATE\s+\S+|\w+_ops|\s)*$", c, re.I)
                cols.append(self.col(t, cm.group(1), ev) if cm else c.strip())  # an expression stays as written
            t["indexes"].append({"name": name or "_".join([t["table"].lower(), *[c.lower() for c in cols], "idx"]),
                                 "unique": bool(m.group(1)), "columns": cols, "evidence": ev})
            return
        m = re.match(r"(?is)DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(IF\s+EXISTS\s+)?(.*?)(?:\s+(?:CASCADE|RESTRICT))?\s*$", s)
        if m:
            for n in _names(m.group(2)):
                hit = [t for t in self.tables.values() if any(i["name"].lower() == n.lower() for i in t["indexes"])]
                if not hit and not m.group(1):
                    raise SchemaError(f"{ev}: unknown index {n!r}")
                for t in hit:
                    t["indexes"] = [i for i in t["indexes"] if i["name"].lower() != n.lower()]
            return
        m = re.match(rf"(?is)ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?({QID})\s+RENAME\s+TO\s+({ID})\s*$", s)
        if m:
            old = _name(m.group(1)).lower()
            for t in self.tables.values():
                for i in t["indexes"]:
                    if i["name"].lower() == old:
                        i["name"] = _name(m.group(2))
                if old in t["_constraints"]:  # a constraint's index carries its name
                    t["_constraints"][_name(m.group(2)).lower()] = t["_constraints"].pop(old)
            return
        m = re.match(rf"(?is)CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+({QID})", s)
        if m:
            reads = sorted({_name(x).lower() for x in re.findall(rf"(?i)\b(?:FROM|JOIN)\s+({QID})", s)} & set(self.tables))
            writes = sorted({_name(x).lower() for x in re.findall(rf"(?i)\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+({QID})", s)}
                            & set(self.tables))
            self.functions[_name(m.group(1))] = (reads, writes)
            return
        m = re.match(rf"(?is)CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+({ID})\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(.*?)\s+ON\s+"
                     rf"({QID})\s.*EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+({QID})", s)
        if m:
            self.triggers.append({"name": _name(m.group(1)), "events": m.group(2), "table": _name(m.group(3)).lower(),
                                  "function": _name(m.group(4)), "evidence": ev})
            return
        m = re.match(r"(?is)DROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?(\S+)\s+ON\s+(\S+)", s)
        if m:
            self.triggers = [tr for tr in self.triggers if not (tr["name"].lower() == _name(m.group(2)).lower()
                                                               and tr["table"] == _name(m.group(3)).lower())]

    def result(self):
        for t in self.tables.values():
            t.pop("_constraints", None)
            t["rowBytes"] = TUPLE_HEADER + sum(_type_bytes(c["type"]) for c in t["columns"].values())
        for tr in self.triggers:
            tr["readsTables"], tr["writesTables"] = self.functions.get(tr["function"], ([], []))
        return self.tables, self.triggers


def apply(svc, sources):
    """The schema after applying `sources` [(path, text)] in order: ({table_lower: {...}}, [trigger])."""
    sch = _Schema(svc)
    for path, src in sources:
        for stmt, off in _statements(src):
            ev = f"{path}:{src.count(chr(10), 0, off) + 1}"
            s = " ".join(stmt.split()).lstrip(") ")  # a stray `)` precedes a function in discount V1_1
            sch.statement(s, ev)
    return sch.result()


def schema(svc):
    """{table_lower: {...}}, [trigger] for one service."""
    return apply(svc, [(p, gitsrc.read(p)) for p in migrations(svc)])


def services_with_db():
    return sorted({gitsrc.service_of(f) for f in gitsrc.glob("services/", ".sql") if "/db/migration/" in f})


if __name__ == "__main__":
    for svc in services_with_db():
        tables, triggers = schema(svc)
        for t in tables.values():
            print(svc, t["table"], len(t["columns"]), t["rowBytes"], t["primaryKey"],
                  [f["column"] + "->" + f["references"] for f in t["foreignKeys"]])
        for tr in triggers:
            print("  trigger", tr["table"], tr["function"], tr["readsTables"], tr["writesTables"])
