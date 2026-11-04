"""Stub of a case's adapter to the core's derivation (core/generator/derive.py; docs/case-interface.md). Copy it to
cases/<case>/generator/adapter.py, name it in case.json `generator.adapter` and fill in every item; MiSArch's
(cases/misarch/generator/misarch.py) is the worked example. `b` is the core's builder: b.o (the model being
written: o.obj(name, class, comments, **attrs), o.link(source, reference, target)), b.wrap(text) (comment lines),
b.component(name, comments, interface), b.seff(component, interface, signature[, comments]) -> behaviour,
b.internal(behaviour, behaviour, name, cpu ms), b.beh_close(behaviour, behaviour), b.container(name, comments,
[(resource kind, replicas)]). S is the case's platform.json `parameters`.
"""

# --- names (the fixed topology) -----------------------------------------------------------------------------------
NAME = "CASE"                          # the System's and the Domain's name
REPOSITORY = "CASERepository"
TITLE = "CASE (source and ref)"        # the models' header: "<TITLE> derived from the domain model ..."
ENTRY, ENTRY_IFACE = "Gateway", "IGateway"          # the component that serves every request type
BROKER, BROKER_IFACE = "Broker", "IBroker"           # the component that delivers every message
AUTH, AUTH_IFACE, AUTH_SIG = "Auth", "IAuth", "token"  # the component that serves AUTH_REQUEST
AUTH_REQUEST = "login"
ENTRY_CONTAINER, BROKER_CONTAINER, AUTH_CONTAINER = "GatewayServer", "BrokerServer", "AuthServer"
ENTRY_CPU = "gatewayRequestCpuMs"      # the platform parameter of the entry's CPU per request
FIXED = (ENTRY, BROKER, AUTH)
PROVIDED = ((ENTRY, ENTRY_IFACE), (AUTH, AUTH_IFACE))
FIXED_PLACEMENT = {ENTRY: ENTRY_CONTAINER, BROKER: BROKER_CONTAINER, AUTH: AUTH_CONTAINER}
DOMAIN_SOURCE = "the case's domain/CASE-domain.json"
SEED_TEXT = {"neutral": "...", "today": "...", "monolith": "..."}

# --- calibration --------------------------------------------------------------------------------------------------
PROCESS_CRITICALITY = {}               # saga name -> business criticality of its asynchronous work (every saga)
DEFAULT_CRITICALITY = 0.3
CHANGES_PER_YEAR = 52.0 * 10           # releases a year of the whole system
CHANGES_TEXT = "..."
CACHE_TTL_S = 60.0
CACHE_TEXT = "..."
COST_TEXT = "..."


# --- rules --------------------------------------------------------------------------------------------------------
def skip_request(key):
    """True for a request of the usage model that is no request type of the entry (e.g. the login)."""
    return key == AUTH_REQUEST


def glue(d, ops):
    """The operations that are glue of the entry's joins, not domain operations (set of operation ids)."""
    return set()


def trigger_type(o):
    """The class (or type) an operation's trigger belongs to, or None."""
    return None


def role_sig(req, entry_sig):
    """The System's provided role and signature of a usage-model request (entry_sig: the entry's signature)."""
    if req == AUTH_REQUEST:
        return f"{NAME}_provides_{AUTH_IFACE}", f"{AUTH_IFACE}_{AUTH_SIG}"
    return f"{NAME}_provides_{ENTRY_IFACE}", entry_sig


# --- the fixed parts ----------------------------------------------------------------------------------------------
def entry_comments(b, S):
    return b.wrap("The entry: one SEFF per request type of the usage model.")


def components(b, S):
    raise NotImplementedError("the broker's and the authentication's components and SEFFs")


def containers(b, S):
    raise NotImplementedError("the entry's, the broker's and the authentication's containers")


def deployables(b, S):
    raise NotImplementedError("the entry's Deployable")


def prices(S):
    return []                          # [(price name, price, [containers])]
