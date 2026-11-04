"""A small, regex-based Kotlin source index: classes, functions with body spans, string literals,
constructor fields. Enough for the persistence inventory and the reachability cross-check; not a
parser. Offsets refer to the original text (comments and strings are blanked in a copy of the
same length, so braces inside them do not count)."""

import functools
import re

import gitsrc

STR_RE = re.compile(r'"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)\'')
COMMENT_RE = re.compile(r"//[^\n]*|/\*[\s\S]*?\*/")


def _blank(m):
    return re.sub(r"[^\n]", " ", m.group(0))


@functools.lru_cache(maxsize=None)
def masked(path):
    """Source with comments blanked and string contents blanked (quotes kept)."""
    src = gitsrc.read(path)
    out, i = [], 0
    pat = re.compile(r'"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|//[^\n]*|/\*[\s\S]*?\*/')
    for m in pat.finditer(src):
        out.append(src[i:m.start()])
        tok = m.group(0)
        if tok.startswith('"'):
            q = '"""' if tok.startswith('"""') else '"'
            out.append(q + re.sub(r"[^\n]", " ", tok[len(q):-len(q)]) + q)
        else:
            out.append(re.sub(r"[^\n]", " ", tok))
        i = m.end()
    out.append(src[i:])
    return "".join(out)


@functools.lru_cache(maxsize=None)
def strings(path):
    """[(offset, content)] of string literals outside comments (templates kept verbatim)."""
    src = gitsrc.read(path)
    ms = masked(path)
    res = []
    for m in re.finditer(r'"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"', src):
        if ms[m.start()] != '"':
            continue  # inside a comment
        q = 3 if m.group(0).startswith('"""') else 1
        res.append((m.start(), m.group(0)[q:-q]))
    return res


def _match_brace(text, open_pos):
    depth = 0
    for i in range(open_pos, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
    return len(text) - 1


@functools.lru_cache(maxsize=None)
def classes(path):
    """[{name, kind, start, end, header, supertypes}] (nested classes included)."""
    ms = masked(path)
    res = []
    for m in re.finditer(r"\b(class|interface|object)\s+(\w+)", ms):
        if m.group(1) == "class" and ms[max(0, m.start() - 1)] == ":":
            continue  # `::class`
        # header up to the body brace (or end of declaration)
        j, depth = m.end(), 0
        while j < len(ms):
            c = ms[j]
            if c in "(<":
                depth += 1
            elif c in ")>":
                depth -= 1
            elif c == "{" and depth <= 0:
                break
            elif c == "\n" and depth <= 0 and not ms[m.end():j].strip().endswith((",", ":")) \
                    and re.match(r"\s*(?:@|class|interface|object|fun|val|private|internal|data|enum|abstract|open|$)", ms[j + 1:j + 40]):
                break
            j += 1
        header = ms[m.start():j]
        end = _match_brace(ms, j) if j < len(ms) and ms[j] == "{" else j
        sup = ""
        hm = re.search(r"\)\s*:\s*(.*)$|^[^(]*?:\s*(.*)$", header, re.S)
        if hm:
            sup = hm.group(1) or hm.group(2) or ""
        res.append({"name": m.group(2), "kind": m.group(1), "start": m.start(), "end": end,
                    "header": header, "supertypes": sup})
    return res


@functools.lru_cache(maxsize=None)
def functions(path):
    """[{name, cls, start, end, bodyStart, line}] - `end` is the end of the body (or the line for
    expression bodies / abstract declarations)."""
    ms = masked(path)
    res = []
    cls = classes(path)
    for m in re.finditer(r"\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(", ms):
        # parameter list
        depth, j = 0, m.end() - 1
        while j < len(ms):
            if ms[j] == "(":
                depth += 1
            elif ms[j] == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        k = j + 1
        # return type, then `{` or `=` or end of line
        rest = ms[k:k + 400]
        bm = re.match(r"[^{=\n]*(?:\n\s*[^{=\n]*)?", rest)
        p = k
        while p < len(ms) and ms[p] not in "{=\n":
            if ms[p] == "<":  # generic return type may contain `=`? no; skip
                pass
            p += 1
        if p < len(ms) and ms[p] == "{":
            end = _match_brace(ms, p)
            body = p
        elif p < len(ms) and ms[p] == "=":
            # expression body: up to the next declaration at the same or lower indentation
            nxt = re.search(r"\n\s*(?:(?:@\w+[^\n]*\n\s*)*)(?:(?:private|public|internal|protected|override|suspend|open|abstract|inline|operator)\s+)*(?:fun|val|var|class|object|interface|companion|init)\b|\n\s*}", ms[p:])
            end = p + (nxt.start() if nxt else len(ms) - p)
            body = p
        else:
            end, body = p, p
        owner = None
        for c in cls:
            if c["start"] < m.start() <= c["end"] and (owner is None or c["start"] > owner["start"]):
                owner = c
        res.append({"name": m.group(1), "cls": owner["name"] if owner else None, "start": m.start(),
                    "end": end, "bodyStart": body, "line": gitsrc.line_of(path, m.start())})
    return res


def enclosing_function(path, offset):
    best = None
    for f in functions(path):
        if f["start"] <= offset <= f["end"] and (best is None or f["start"] > best["start"]):
            best = f
    return best


def enclosing_class(path, offset):
    best = None
    for c in classes(path):
        if c["start"] <= offset <= c["end"] and (best is None or c["start"] > best["start"]):
            best = c
    return best


def kotlin_files(svc):
    return gitsrc.glob(f"services/{svc}/src/main/kotlin/", ".kt")


@functools.lru_cache(maxsize=None)
def constants(svc):
    """`const val NAME = "value"` and `val NAME = "value"` string constants of a service (+ libs/common)."""
    res = {}
    for path in kotlin_files(svc):
        src = gitsrc.read(path)
        for m in re.finditer(r'\b(?:const\s+)?val\s+(\w+)\s*(?::\s*String\s*)?=\s*"((?:[^"\\\n]|\\.)*)"', src):
            res.setdefault(m.group(1), m.group(2))
    return res


@functools.lru_cache(maxsize=None)
def string_exprs(path):
    """Like strings(), but literals concatenated with `+` are merged: [(offset, text)]."""
    src = gitsrc.read(path)
    res = []
    lits = strings(path)
    i = 0
    while i < len(lits):
        off, text = lits[i]
        end = off + len(text) + 2
        j = i + 1
        while j < len(lits):
            # end of literal i..: find its closing quote position
            between = src[end:lits[j][0]]
            if re.fullmatch(r'"*\s*\+\s*', between):
                text += lits[j][1]
                end = lits[j][0] + len(lits[j][1]) + 2
                j += 1
            else:
                break
        res.append((off, text))
        i = j
    return res
