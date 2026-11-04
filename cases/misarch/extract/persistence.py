"""Persistence inventory: every method that runs SQL, with the tables it reads and writes.

Sources, per service:
- Spring Data repositories (`interface X : CoroutineCrudRepository<E, UUID>`): declared methods
  (derived queries by name, `@Query` SQL) and the inherited CRUD methods that are called somewhere;
- functions containing SQL string literals (stores of the ported services, `databaseClient.sql`);
- connections (`BaseConnection` / `NullableNodesConnection` subclasses; `join = "..."` adds the joined table);
- `R2dbcEntityTemplate` calls (`select/insert/update/delete(XEntity::class...)`);
- libs/common `connectionQuery(XEntity::class, ..)` calls (keyed by the enclosing function or initialised property);
- libs/common `ConditionQueries` calls (`conditionQueries.findAll<XEntity>(..)`, `insert(XEntity(..))`).

An entity class's table is the one its `@Table` annotation names (`@Table("x")`, `@Table(name = "x")`), or, for
a bare `@Table` or none, the simple class name (MisarchNamingStrategy); it must be a table of the service's
migrations. An entity named by a repository, connection, template or ConditionQueries call whose table the migrations
do not create raises PersistenceError (a missing table would silently empty the method's reads and writes); so does
a `@Table` class whose table does not exist.

A method's key is `Class.method`. Statements touching several tables are cross-class joins.
"""

import functools
import re

import gitsrc
import kt
import sql_schema

SQL_START = re.compile(r"^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|LOCK)\b")
SQL_ANY = re.compile(r"\b(SELECT\s.+?\sFROM|INSERT\s+INTO|UPDATE\s+\$?\{?\w+\}?\s+SET|DELETE\s+FROM)\b", re.S)
CRUD_READ = {"findById", "findAllById", "findAll", "existsById", "count"}
CRUD_WRITE = {"save", "saveAll", "deleteById", "delete", "deleteAll", "deleteAllById"}


def tables_in_sql(sql, known):
    """(reads, writes) table names (lower case, restricted to `known`) of one SQL text."""
    s = re.sub(r"\s+", " ", sql)
    writes = {t.lower() for t in re.findall(r"(?i)\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)", s)}
    reads = {t.lower() for t in re.findall(r"(?i)\b(?:FROM|JOIN|USING)\s+(\w+)", s)}
    reads -= {w for w in writes if re.search(rf"(?i)DELETE FROM\s+{w}\b", s)} - \
        {t.lower() for t in re.findall(r"(?i)\bJOIN\s+(\w+)", s)}
    return sorted(reads & known), sorted(writes & known)


CONTAINER_TYPES = {"List", "MutableList", "Set", "MutableSet", "Collection", "Iterable", "Sequence", "Flow", "Map",
                   "Pair", "Deferred"}


def _call_text(src, open_pos):
    """The text of a call from its `(` at `open_pos` to the matching `)` (inclusive)."""
    depth, i = 0, open_pos
    while i < len(src):
        depth += {"(": 1, ")": -1}.get(src[i], 0)
        i += 1
        if depth == 0:
            break
    return src[open_pos:i]


def _derived_kind(name):
    if re.match(r"(find|get|read|query|search|stream|exists|count)", name):
        return "read"
    if re.match(r"(delete|remove)", name):
        return "write"
    return None


class PersistenceError(Exception):
    pass


TABLE_ANN = re.compile(r'@Table\b(?:\s*\(\s*(?:(?:value|name)\s*=\s*)?"([^"]*)"\s*\))?'
                       r'(?:\s*@\w+(?:\([^)]*\))?)*\s*(?:(?:data|open|abstract|sealed|internal|public|private)\s+)*class\s+(\w+)')


@functools.lru_cache(maxsize=None)
def entity_tables(svc):
    """{entity class: (table key (lower case), evidence)} of the service's `@Table` classes."""
    tables, _ = sql_schema.schema(svc) if svc in sql_schema.services_with_db() else ({}, [])
    out = {}
    for path in kt.kotlin_files(svc):
        src, ms = gitsrc.read(path), kt.masked(path)
        for m in TABLE_ANN.finditer(src):
            if ms[m.start()] != "@":
                continue  # inside a comment or string
            cls, name = m.group(2), m.group(1) or m.group(2)
            ev = f"{path}:{gitsrc.line_of(path, m.start())}"
            if name.lower() not in tables:
                raise PersistenceError(f"{ev}: entity {cls} maps to table {name!r}, which the migrations of {svc} "
                                       f"do not create (tables: {', '.join(sorted(t['table'] for t in tables.values()))})")
            if cls in out:
                raise PersistenceError(f"{ev}: two @Table classes named {cls} in {svc}")
            out[cls] = (name.lower(), ev)
    return out


@functools.lru_cache(maxsize=None)
def inventory(svc):
    tables, _ = sql_schema.schema(svc) if svc in sql_schema.services_with_db() else ({}, [])
    known = set(tables)
    entities = entity_tables(svc)
    methods = {}

    def table_of(cls, path, offset, what):
        if cls in entities:
            return entities[cls][0]
        if cls.lower() in known:  # no @Table: Spring Data maps the class by the naming strategy (simple name)
            return cls.lower()
        raise PersistenceError(f"{path}:{gitsrc.line_of(path, offset)}: {what} names entity {cls}: no @Table names its "
                               f"table and no table {cls} exists in the migrations of {svc}")

    def add(key, path, offset, reads, writes, how, sql=None):
        ev = f"{path}:{gitsrc.line_of(path, offset)}"
        m = methods.setdefault(key, {"method": key, "service": svc, "reads": set(), "writes": set(),
                                     "statements": [], "evidence": ev, "how": how})
        m["reads"] |= set(reads)
        m["writes"] |= set(writes)
        if sql is not None or reads or writes:
            m["statements"].append({"sql": (sql or "").strip()[:400], "reads": sorted(reads),
                                    "writes": sorted(writes), "evidence": ev})

    repos = {}
    for path in kt.kotlin_files(svc):
        src = gitsrc.read(path)
        # --- repositories
        for c in kt.classes(path):
            rm = re.search(r"CoroutineCrudRepository<\s*(\w+)\s*,", c["supertypes"])
            if c["kind"] == "interface" and rm:
                table = table_of(rm.group(1), path, c["start"], f"repository {c['name']}")
                repos[c["name"]] = table
                for f in kt.functions(path):
                    if f["cls"] != c["name"]:
                        continue
                    prev_end = max([g["end"] for g in kt.functions(path) if g["end"] < f["start"]] + [c["start"]])
                    pre = src[prev_end:f["start"]]
                    qm = re.search(r'@Query\(\s*((?:"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"\s*\+?\s*)+)\)\s*(?:@\w+[^\n]*\s*)*(?:suspend\s+)?$', pre)
                    if qm:
                        sql = "".join(re.findall(r'"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)"', qm.group(1))[i][j]
                                      for i in range(len(re.findall(r'"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)"', qm.group(1))))
                                      for j in (0, 1))
                        r, w = tables_in_sql(sql, known)
                        add(f"{c['name']}.{f['name']}", path, f["start"], r, w, "@Query", sql)
                    else:
                        kind = _derived_kind(f["name"])
                        add(f"{c['name']}.{f['name']}", path, f["start"],
                            [table] if kind == "read" and table else [],
                            [table] if kind == "write" and table else [], "derived query")
                for crud in sorted(CRUD_READ | CRUD_WRITE):
                    add(f"{c['name']}.{crud}", path, c["start"],
                        [table] if crud in CRUD_READ and table else [],
                        [table] if crud in CRUD_WRITE and table else [], "CRUD (inherited)")
        # --- SQL literals inside functions (stores, services, connections)
        consts = kt.constants(svc)
        for off, text in kt.string_exprs(path):
            if not (SQL_START.match(text) or SQL_ANY.search(text)):
                continue
            if re.search(r"@Query\(\s*$", src[max(0, off - 40):off]):
                continue  # repository @Query, handled above
            # string templates naming a constant (`$TABLE`) are resolved
            text = re.sub(r"\$\{?([A-Z_][A-Z0-9_]*)\}?", lambda m: consts.get(m.group(1), m.group(0)), text)
            f = kt.enclosing_function(path, off)
            c = kt.enclosing_class(path, off)
            owner = f"{(f or {}).get('cls') or (c or {}).get('name') or path.rsplit('/', 1)[1][:-3]}.{f['name'] if f else '<init>'}"
            r, w = tables_in_sql(text, known)
            dyn = re.findall(r"(?i)\b(?:FROM|JOIN|INTO|UPDATE)\s+\$\{?(\w+)", text)
            if dyn:
                owner_m = methods.setdefault(owner, {"method": owner, "service": svc, "reads": set(), "writes": set(),
                                                     "statements": [], "evidence": f"{path}:{gitsrc.line_of(path, off)}",
                                                     "how": "SQL literal"})
                owner_m.setdefault("dynamicTables", sorted(set(dyn)))
            add(owner, path, off, r, w, "SQL literal", text)
        # --- connections
        for c in kt.classes(path):
            # libs/common's connection base classes (BaseConnection, NullableNodesConnection, AbstractConnection)
            cm = re.search(r"\b(?:Base|NullableNodes|Abstract)Connection<\s*[\w.]+\s*,\s*(\w+)\s*>", c["supertypes"]) or \
                re.search(r"\b(?:Base|NullableNodes)Connection<\s*[\w.]+\s*,\s*(\w+)\s*>", src[c["start"]:c["end"]])
            if cm:
                table = table_of(cm.group(1), path, c["start"], f"connection {c['name']}")
                body = src[c["start"]:c["end"]]
                joins = [t.lower() for t in re.findall(r"(?i)JOIN\s+(\w+)", body)]
                reads = sorted({table, *[j for j in joins if j in known]} - {None})
                add(f"{c['name']}.nodes", path, c["start"], reads, [], "connection (BaseConnection)")
                add(f"{c['name']}.totalCount", path, c["start"], reads, [], "connection (BaseConnection)")
        # --- connections of the ported services: a function that builds a ConnectionQuery (libs/common, the
        # statements of BaseConnection without its GraphQL type: page, COUNT, probe, each when its field is selected)
        # over a table literal (`ConnectionQuery(db, "order_items", ...)`); `join = "..."` adds the joined table
        for m in re.finditer(r'\bConnectionQuery\s*\(', src):
            if kt.masked(path)[m.start()] != "C":
                continue  # inside a comment or string
            f = kt.enclosing_function(path, m.start())
            if not f:
                continue
            call_text = _call_text(src, m.end() - 1)
            tm = re.match(r'\(\s*\w+\s*,\s*"(\w+)"', call_text) or re.search(r'\btable\s*=\s*"(\w+)"', call_text)
            if not tm:
                raise PersistenceError(f"{path}:{gitsrc.line_of(path, m.start())}: ConnectionQuery without a table literal")
            if tm.group(1).lower() not in known:
                raise PersistenceError(f"{path}:{gitsrc.line_of(path, m.start())}: ConnectionQuery over {tm.group(1)!r}, "
                                       f"which the migrations of {svc} do not create")
            joins = [t.lower() for t in re.findall(r'(?i)\bJOIN\s+(\w+)', call_text)]
            reads = sorted({tm.group(1).lower(), *joins} & known)
            add(f"{f['cls'] or path.rsplit('/', 1)[1][:-3]}.{f['name']}", path, m.start(), reads, [],
                "connection (ConnectionQuery)")
        # --- libs/common `entityTemplate.connectionQuery(XEntity::class, ..)` (page, COUNT, probe over the entity's
        # table, each when its field is selected): keyed by the enclosing function, or by the property it initialises
        # (`private val query = entityTemplate.connectionQuery(..)` -> `XConnection.query`)
        for m in re.finditer(r'\bconnectionQuery\s*\(\s*(\w+)::class', src):
            if kt.masked(path)[m.start()] != "c":
                continue  # inside a comment or string
            f = kt.enclosing_function(path, m.start())
            c = kt.enclosing_class(path, m.start())
            if f:
                key = f"{f['cls'] or path.rsplit('/', 1)[1][:-3]}.{f['name']}"
            else:
                pm = re.search(r'\bva[lr]\s+(\w+)\s*(?::[^=]*)?=\s*[\w.]*$', src[max(0, m.start() - 200):m.start()].rstrip())
                if not (pm and c):
                    raise PersistenceError(f"{path}:{gitsrc.line_of(path, m.start())}: connectionQuery outside a function "
                                           f"or property initialiser")
                key = f"{c['name']}.{pm.group(1)}"
            call_text = _call_text(src, src.index("(", m.start()))
            table = table_of(m.group(1), path, m.start(), "connectionQuery")
            joins = [t.lower() for t in re.findall(r'(?i)\bJOIN\s+(\w+)', call_text)]
            add(key, path, m.start(), sorted({table, *joins} & known), [], "connection (connectionQuery)")
        # --- libs/common ConditionQueries: findAll/findFirst/count/existingIds/exists read, delete/insert write the entity's table
        for m in re.finditer(r'\b(\w*[cC]onditionQueries)\s*\.\s*(findAll|findFirst|count|existingIds|exists|delete|insert)\b'
                             r'\s*(?:<\s*(\w+)\s*>)?\s*\(', src):
            if kt.masked(path)[m.start()] == " ":
                continue  # inside a comment
            f = kt.enclosing_function(path, m.start())
            call_text = _call_text(src, m.end() - 1)
            cls = m.group(3)
            if not cls:
                am = re.match(r'\(\s*(\w+)\s*(::class|\(|[,)])', call_text)
                if am and (am.group(2) == "::class" or am.group(2) == "(" and am.group(1)[0].isupper()):
                    cls = am.group(1)  # findAll(XEntity::class, ..) / insert(XEntity(..))
                elif m.group(2) == "insert" and am and f:  # a variable: its declared type or its constructor
                    body = src[f["start"]:m.start()]
                    vm = re.search(rf'\b{am.group(1)}\s*:\s*(\w+)', body) or \
                        re.search(rf'\bva[lr]\s+{am.group(1)}\s*=\s*(\w+)\s*\(', body)
                    cls = vm.group(1) if vm else None
                elif f:  # a reified type inferred from the expected type: a typed val, else the function's return type
                    stmt = src[max(f["bodyStart"], src.rfind("\n", 0, m.start())):m.start()]
                    tm = re.search(r'\bva[lr]\s+\w+\s*:\s*([\w<>?, .]+?)\s*=\s*$', stmt)
                    if not tm:
                        tm = re.search(r'\)\s*:\s*([\w<>?, .]+?)\s*(?:=|\{)?\s*$', src[f["start"]:f["bodyStart"]])
                    names = [n for n in re.findall(r'\b[A-Z]\w*', tm.group(1)) if n not in CONTAINER_TYPES] if tm else []
                    cls = names[-1] if names else None
            if not cls:
                raise PersistenceError(f"{path}:{gitsrc.line_of(path, m.start())}: cannot tell the entity of "
                                       f"{m.group(1)}.{m.group(2)}(...)")
            what = f"{m.group(1)}.{m.group(2)}"
            header = src[f["start"]:f["bodyStart"]] if f else ""
            if f and re.match(rf'fun\s*<[^>]*\b{cls}\b', header):
                # the type parameter of a generic helper (`fun <reified E : Any> f(..) = conditionQueries.findAll<E>(..)`):
                # the entities its callers in the same file pass
                args = re.findall(rf'\b{f["name"]}\s*<\s*(\w+)\s*>\s*\(', src)
                if not args:
                    raise PersistenceError(f"{path}:{gitsrc.line_of(path, m.start())}: {what} on type parameter {cls} "
                                           f"of {f['name']}, which no call in the file instantiates")
                tabs = sorted({table_of(c, path, m.start(), what) for c in args})
            else:
                tabs = [table_of(cls, path, m.start(), what)]
            joins = sorted({t.lower() for t in re.findall(r'(?i)\bJOIN\s+(\w+)', call_text)} & known)
            write = m.group(2) in ("delete", "insert")
            key = f"{f['cls'] or path.rsplit('/', 1)[1][:-3]}.{f['name']}" if f else path
            add(key, path, m.start(), sorted({*tabs, *joins}) if not write else [], tabs if write else [],
                "ConditionQueries")
        # --- entity template
        for m in re.finditer(r"entityTemplate\s*\.\s*(select|insert|update|delete)\s*\(\s*(\w+)::class", src):
            f = kt.enclosing_function(path, m.start())
            table = table_of(m.group(2), path, m.start(), f"entityTemplate.{m.group(1)}")
            key = f"{f['cls']}.{f['name']}" if f else path
            add(key, path, m.start(), [table] if m.group(1) == "select" and table else [],
                [table] if m.group(1) != "select" and table else [], "R2dbcEntityTemplate")
    for m in methods.values():
        m["reads"], m["writes"] = sorted(m["reads"]), sorted(m["writes"])
        m["joins"] = [s for s in m["statements"] if len(set(s["reads"]) | set(s["writes"])) > 1]
    return {"methods": methods, "repositories": repos}


if __name__ == "__main__":
    import sys
    svcs = sys.argv[1:] or sql_schema.services_with_db()
    for svc in svcs:
        inv = inventory(svc)
        print(f"== {svc}: {len(inv['methods'])} methods, repos {inv['repositories']}")
        for k, m in sorted(inv["methods"].items()):
            if m["how"] == "CRUD (inherited)":
                continue
            print(f"  {k:60s} R{m['reads']} W{m['writes']} {'JOIN' if m['joins'] else ''} {m.get('dynamicTables', '')} {gitsrc.short(m['evidence'])}")
