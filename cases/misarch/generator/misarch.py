"""MiSArch's adapter to the core's derivation (core/generator/derive.py; DESIGN.md AB52): what the derivation of
MiSArch's optimisation models needs beyond the case's data files.

The core derives a microservice system of this style: one component per domain class (its operations' SEFFs) and one
schema per class, an entry component that serves every request type of the usage model (MiSArch's GraphQL gateway,
with federation joins as call mechanisms), a message broker that delivers every event, an authentication component
that serves the login, and pools of application containers and database servers. A case names these fixed parts,
writes their objects (components with their SEFFs, containers, deployables, prices) through the builder the core
hands it, and supplies its rules (which requests the usage model leaves to the authentication, the federation glue,
how a trigger names the class it belongs to) and its calibration constants (business criticality, change rates,
cache TTL). Everything else (the decisions, mechanisms, quality model, the domain section) is the core's.

The derivation loads this module from case.json `generator.adapter`.
"""
import re

# --- names ------------------------------------------------------------------------------------------------------
NAME = "MiSArch"                       # the System's and the Domain's name
REPOSITORY = "MiSArchRepository"
TITLE = "MiSArch (misarch-kotlin main)"
ENTRY, ENTRY_IFACE = "Gateway", "IGateway"          # serves every request type of the usage model
BROKER, BROKER_IFACE = "Broker", "IBroker"           # delivers every message (RemoteCalls.broker)
AUTH, AUTH_IFACE, AUTH_SIG = "Keycloak", "IKeycloak", "token"   # serves the AUTH_REQUEST
AUTH_REQUEST = "login"                 # the usage model's request that is the authentication's, not a request type
ENTRY_CONTAINER, BROKER_CONTAINER, AUTH_CONTAINER = "GatewayServer", "BrokerServer", "KeycloakServer"
ENTRY_CPU = "gatewayRequestCpuMs"      # the platform parameter of the entry's own CPU per request
FIXED = (ENTRY, BROKER, AUTH)          # the fixed components, after the classes' and their schemas'
PROVIDED = ((ENTRY, ENTRY_IFACE), (AUTH, AUTH_IFACE))   # the System's provided roles
FIXED_PLACEMENT = {ENTRY: ENTRY_CONTAINER, BROKER: BROKER_CONTAINER, AUTH: AUTH_CONTAINER}
DOMAIN_SOURCE = "A's cases/misarch/domain/misarch-domain.json"      # how the Domain object's comment names the extraction

# --- the seeds' descriptions (the models' headers) --------------------------------------------------------------
SEED_TEXT = {"neutral": "a neutral start: every class in one container, every schema on the shared database "
                        "server, every call synchronous, every saga choreographed",
             "today": "today's cut: the 16 services of misarch-kotlin main (classes by owner service, one "
                      "database server per service), today's mechanisms (copies, gateway joins, events)",
             "monolith": "the monolith: every class in one container, one database server, events in "
                         "process (asynchronous), gateway joins resolved locally"}

# --- calibration --------------------------------------------------------------------------------------------------
# DESIGN.md AB25 (user decision 2026-10-23): business criticality of a process's asynchronous work
# (domain.mm Process.criticality). Buy and Return 1.0: a failed step leaves an order paid but not
# fulfilled, or an order or return stuck. Registration 0.3: customer-visible and recoverable, no
# money involved. Work of no process (e.g. notifications, if they ran as work of their own) gets
# DEFAULT_CRITICALITY (Domain.defaultCriticality); work that only maintains copies counts 0 in
# metrics.fn (a retrying broker only delays it; the staleness is O4's). Every saga of the domain needs an entry.
PROCESS_CRITICALITY = {"Buy": 1.0, "Return": 1.0, "Registration": 0.3}
DEFAULT_CRITICALITY = 0.3
# O2, O3: the system changes as often as in the unified project (16 aggregates, a release a week
# each): 16 x 52 releases a year, shared by the classes (F11; 26.8 per class on average over 31), by their
# domain operations (core: change_rates).
CHANGES_PER_YEAR = 52.0 * 16
CHANGES_TEXT = "the unified project's 16 x 52, F11"
# O4's staleness window of a cache (DESIGN.md AB23): misarch-kotlin libs/common EntityCache:
# misarch.knee.entity-cache.ttl-seconds, default 60
CACHE_TTL_S = 60.0
CACHE_TEXT = "MiSArch's entity cache"
COST_TEXT = "msa's cost rule, as the unified project's MiSArch models."


# --- rules --------------------------------------------------------------------------------------------------------
def skip_request(key):
    """A request of the usage model that is no request type of the entry (the login is the authentication's)."""
    return key == AUTH_REQUEST


def glue(d, ops):
    """Federation glue (DESIGN.md AB43): a subgraph's resolver of another service's entity it contributes fields
    to, which only finds the representation the gateway hands it (no access, an existence check of the entity, or
    its data loader's lookup by id: one row of the entity's own class, e.g. review._entities.ProductVariant, whose
    type is the id alone): not a domain operation, but what the gateway's fetch costs the subgraph."""
    contributes = {g["entityResolver"]: g["entity"] for g in d["gatewayJoins"]
                   if g.get("entityResolver") and g["kind"] == "contributes"}

    def finds(a, e):
        return a["mode"] == "read" and a["class"] == e and (
            a.get("op") == "exists" or (a.get("op") == "select" and a.get("rows") == 1 and a.get("shape") in ("one", "batch")))
    return {x for x, e in contributes.items() if x in ops and all(finds(a, e) for a in ops[x]["accesses"])}


def trigger_type(o):
    """The type an operation's GraphQL trigger belongs to (`_entities(T)` or `T.field`), or None."""
    g = o["trigger"].get("graphql", "")
    m = re.match(r"_entities\((\w+)\)", g) or re.match(r"(\w+)\.", g)
    return m.group(1) if m else None


def role_sig(req, entry_sig):
    """The System's provided role and signature of a request of the usage model (entry_sig: the entry's)."""
    if req == AUTH_REQUEST:
        return f"{NAME}_provides_{AUTH_IFACE}", f"{AUTH_IFACE}_{AUTH_SIG}"
    return f"{NAME}_provides_{ENTRY_IFACE}", entry_sig


# --- the fixed parts, through the core's builder b ------------------------------------------------------------------
def entry_comments(b, S):
    return b.wrap(f"Gateway: the GraphQL gateway. One SEFF per request type of the usage model: "
                  f"gatewayRequestCpuMs {S['gatewayRequestCpuMs']} and the call of the request's root "
                  f"resolver; gateway joins are decisions of the resolver's field calls (F5).")


def components(b, S):
    """The broker and the authentication: their components and SEFFs (after the classes' and the entry's)."""
    b.component(BROKER, [f"Broker: the message broker; one `deliver` per message, brokerCpuMs {S['brokerCpuMs']}."],
                BROKER_IFACE)
    base = b.seff(BROKER, BROKER_IFACE, "deliver")
    b.internal(base, base, "cpu", S["brokerCpuMs"])
    b.beh_close(base, base)
    b.component(AUTH, [f"Keycloak: one password grant per login, authCpuMs {S['authCpuMs']}."], AUTH_IFACE)
    base = b.seff(AUTH, AUTH_IFACE, AUTH_SIG)
    b.internal(base, base, "cpu", S["authCpuMs"])
    b.beh_close(base, base)


def containers(b, S):
    b.container(ENTRY_CONTAINER, [f"The gateway's pod: CPU limit {S['gatewayCpuLimit']}, sidecar "
                                  f"{S['gatewaySidecarCores']} cores."], [("CPU", 1)])
    b.container(BROKER_CONTAINER, [f"The message broker: brokerCores {S['brokerCores']}."], [("CPU", int(S["brokerCores"]))])
    b.container(AUTH_CONTAINER, [f"Keycloak: authCores {S['authCores']}."], [("CPU", int(round(S["authCores"])))])


def deployables(b, S):
    """The entry's deployable (the classes' application containers are the core's)."""
    o, d = b.o, f"deploy_{ENTRY_CONTAINER}"
    o.link("decisions", "deployables", d)
    o.obj(d, "Deployable", ["The gateway: autoscaled, a CPU quota per replica."],
          cpuPerReplica=S["gatewayCpuLimit"], sidecarCores=int(S["gatewaySidecarCores"]), quota=True)
    o.link(d, "container", ENTRY_CONTAINER)
    o.link(d, "autoscaling", "autoscaler")


def prices(S):
    """[(price name, price, containers)] of the fixed containers (after the core's database servers')."""
    return [("price_gateway", S["gatewayCores"] * S["costPerCore"], [ENTRY_CONTAINER]),
            ("price_broker", S["brokerCores"] * S["costPerCore"], [BROKER_CONTAINER]),
            ("price_keycloak", 0.0, [AUTH_CONTAINER])]
