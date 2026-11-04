"""Request plans: which operations a client request of the round-2 workload runs, and where the
gateway joins subgraphs.

The request documents are those of the round-2 load generator
(../timing/calibration/scripts/loadgen.py, Q_* constants: the first nine verbatim
from Ceres' Gatling buy scenario, the others from MiSArch's user journeys). Each document is
walked against the subgraph schemas the gateway composes (reference/schemas on `main`): a root
field runs in the subgraph that defines it; a field of an entity that the current subgraph does
not define makes the gateway fetch it from the subgraph that does (`_entities`, a gateway join);
a field with a resolver function (an operation of the curated data) runs that operation.
"""

import re
from pathlib import Path

import sdl

LOADGEN = Path(__file__).resolve().parents[1] / "timing" / "calibration" / "scripts" / "loadgen.py"

# request type (calibration name) -> loadgen constant, as in loadgen.py's request table
REQUESTS = {
    "products": "Q_PRODUCTS", "product": "Q_PRODUCT", "users": "Q_USER", "address": "Q_ADDRESS",
    "createShoppingcartItem": "Q_CART", "shipmentMethods": "Q_SHIPMENT_METHODS",
    "paymentInformations": "Q_PAYMENT_INFOS", "createOrder": "Q_CREATE_ORDER", "placeOrder": "Q_PLACE_ORDER",
    "orderTracking": "Q_ORDER_TRACKING", "wishlistView": "Q_WISHLIST_VIEW", "addToWishlist": "Q_WISHLIST_ADD",
    "createReview": "Q_REVIEW", "adminUpdateProduct": "Q_ADMIN_UPDATE_PRODUCT",
    "adminNewPrice": "Q_ADMIN_NEW_PRICE", "adminCreateVariant": "Q_ADMIN_CREATE_VARIANT",
    "adminCreateProduct": "Q_ADMIN_CREATE_PRODUCT",
}


def documents():
    src = LOADGEN.read_text()
    docs = {}
    for rtype, const in REQUESTS.items():
        m = re.search(rf"^{const}\s*=\s*\(?((?:\s*'[^']*'\s*)+)\)?", src, re.M)
        docs[rtype] = "".join(re.findall(r"'([^']*)'", m.group(1)))
    return docs


def _parse_selection(text, i):
    """Parse `{ a b(args) { ... } }` from text[i] == '{' -> ([(name, children, args text)], next index)."""
    assert text[i] == "{", text[i:i + 30]
    i += 1
    out = []
    while True:
        while text[i].isspace():
            i += 1
        if text[i] == "}":
            return out, i + 1
        m = re.match(r"(\w+)", text[i:])
        name = m.group(1)
        i += len(name)
        while text[i].isspace():
            i += 1
        args = ""
        if text[i] == "(":
            depth, a0 = 0, i
            while True:
                depth += {"(": 1, ")": -1}.get(text[i], 0)
                i += 1
                if depth == 0:
                    break
            args = text[a0 + 1:i - 1]
            while text[i].isspace():
                i += 1
        children = []
        if text[i] == "{":
            children, i = _parse_selection(text, i)
        out.append((name, children, args))


def parse_document(doc):
    m = re.match(r"\s*(query|mutation)\b\s*\w*\s*", doc)
    kind = m.group(1) if m else "query"
    start = m.end() if m else 0
    if doc[start:].lstrip().startswith("("):  # variable definitions may contain `{}` defaults
        depth, i = 0, doc.index("(", start)
        while True:
            depth += {"(": 1, ")": -1}.get(doc[i], 0)
            i += 1
            if depth == 0:
                break
        start = i
    sel, _ = _parse_selection(doc, doc.index("{", start))
    return kind, sel


def plan(doc, op_ids):
    """[(step)] for one document; op_ids: the curated operation ids (to name resolvers)."""
    schemas = {svc: sdl.parse(f"reference/schemas/{svc}.graphql") for svc in sdl.services()}
    fed = sdl.federation()["entities"]
    kind, sel = parse_document(doc)
    root = "Query" if kind == "query" else "Mutation"
    steps = []

    def definer(tname, fname, prefer):
        if prefer and fname in schemas[prefer]["types"].get(tname, {}).get("fields", {}):
            return prefer
        for svc, s in schemas.items():
            if fname in s["types"].get(tname, {}).get("fields", {}) and \
                    (tname in ("Query", "Mutation") or s["types"][tname]["keys"]):
                return svc
        return None

    # `parent`: the index of the step whose objects the field is resolved on (the root's for its fields, a gateway
    # step's for the fields of the entities it resolves); None for the root
    def walk(tname, fields, svc, depth, parent):
        joined = {}
        for fname, children, args in fields:
            if fname in ("__typename",):
                continue
            d = definer(tname, fname, svc)
            if d is None:
                steps.append({"type": tname, "field": fname, "unresolved": True})
                continue
            f = schemas[d]["types"][tname]["fields"][fname]
            via = "root" if tname in (root,) else ("local" if d == svc else "gateway")
            if via == "gateway" and d not in joined:
                joined[d] = len(steps)
                steps.append({"op": f"{d}._entities.{tname}", "via": "gateway", "from": svc, "type": tname,
                              "known": f"{d}._entities.{tname}" in op_ids, "parent": parent})
            at = joined[d] if via == "gateway" else parent
            if tname in ("Query", "Mutation"):
                opid = f"{d}.{fname}"
            else:
                opid = f"{d}.{tname}.{fname}"
            own = parent
            base = f["base"]
            if opid in op_ids:
                own = len(steps)
                steps.append({"op": opid, "via": via if via != "gateway" else "local", "type": tname, "field": fname,
                              "parent": at})
                if base.endswith("Connection") and base in schemas[d]["types"]:
                    # what the document selects of the connection (its statements run only when selected) and
                    # whether it gives `first` (the probe of hasNextPage needs it)
                    steps[-1]["selects"] = [c for c, _, _ in children]
                    steps[-1]["first"] = bool(re.search(r"\bfirst\s*:", args))
            if children:
                t = schemas[d]["types"].get(base)
                if t and base.endswith("Connection"):
                    for cname, cchildren, _ in children:
                        if cname == "nodes" and cchildren:
                            node_t = schemas[d]["types"][base]["fields"]["nodes"]["base"]
                            walk(node_t, cchildren, d, depth + 1, own)
                elif t:
                    walk(base, children, d, depth + 1, own)
    walk(root, sel, None, 0, None)
    return steps


if __name__ == "__main__":
    import json
    for k, v in documents().items():
        print(k, json.dumps(plan(v, set()))[:300])
