// Domain layer of the MiSArch architecture optimisation (DESIGN.md §A).
//
// What the system is, independent of how it is cut into services: the persisted domain classes
// and their references, the operations that work on them (GraphQL queries, mutations and field
// resolvers, reactions to domain events, callbacks of external systems), what each operation
// reads and writes (its accesses), which operations use other operations' logic (calls), the
// domain events that chain operations into business processes, and the statements and
// transactions that bind several classes together today.
//
// No microservice concept appears in the domain classes: services, the placement of classes, local
// copies, caches, gateway joins, saga styles and replicas belong to the architecture decisions and
// their realisation. Its instances are generated from a case's domain extraction (MiSArch's
// cases/misarch/domain/misarch-domain.json, extracted from misarch-kotlin `main`). Step 4 (DESIGN.md
// §F, core/generator/derive.py) derives the optimisation model from it: this file imports the layers
// (./architecture.mm, which imports ./palladio.mm), and the derivation trace at the end links each
// class, operation and access to the PCM that realises it, so that a derived model (MiSArch's
// cases/misarch/mdeo/models/domain-*.m) carries its domain.
//
// SEFFs are assembled from timed parts: an operation's own work (Operation.cpuMs) plus one part
// per access (Access.cpuMs, Access.dbMs). The cut decides how an access is realised (local, a
// synchronous call to the owner, a local copy, a cache, a gateway join, a saga step); the part
// timings here are those of the local realisation, measured by the timing campaign (step 2,
// MiSArch's cases/misarch/timing/parts.json; DESIGN.md AB32). Times are milliseconds at full core
// speed.
//
// Every multiplicity is written out on purpose.

import "./architecture.mm"

enum OperationKind {
    QUERY
    COMMAND
    REACTION
}

enum ReferenceKind {
    COMPOSITION
    ASSOCIATION
}

enum AccessMode {
    READ
    WRITE
}

// How an access is executed per execution of its operation:
//   ONE       one statement on one row, found by key
//   OPTIONAL  at most one such statement (conditional)
//   LIST      one statement over several rows (`rows` per statement)
//   BATCH     one statement for a set of keys collected first (DataLoader, IN list)
//   PER_ITEM  one statement per element of a collection the operation iterates
enum AccessShape {
    ONE
    OPTIONAL
    LIST
    BATCH
    PER_ITEM
}

// How current a read must be (DESIGN.md AB60; a case curates it for each strong read and call):
//   STRICT     current data only: sync, no copy and no cache (a copy only where today's code reads its own store)
//   STALE_OK   a copy or a cache may serve it; O4 prices a stale answer by the data's write rate
//   IMMUTABLE  as STALE_OK, but a stale answer cannot be wrong (at most missing a row created a moment ago):
//              O4 counts no staleness for it
enum ConsistencyLevel {
    STRICT
    STALE_OK
    IMMUTABLE
}

//   JOIN         one SQL statement reads (or writes) several classes
//   TRANSACTION  writes (and locks) of several classes commit together
//   COMPOSITION  a composition reference (the part's id refers to its whole)
enum GroupKind {
    JOIN
    TRANSACTION
    COMPOSITION
}

// ═══ Root ═════════════════════════════════════════════════════════════════════════════

// The domain of one system. Exactly one per model. `defaultCriticality` (absent: 1): the business
// criticality (O2, DESIGN.md AB25) of asynchronous work that belongs to no Process and does more
// than maintain copies.
class Domain {
    name: string
    defaultCriticality: double[?]
}

Domain.classes[1..*] *--> DomainClass.domain[1]
Domain.operations[1..*] *--> Operation.domain[1]
Domain.events[*] *--> DomainEvent.domain[1]
Domain.features[*] *--> Feature.domain[1]
Domain.processes[*] *--> Process.domain[1]

// ═══ Classes and references ═══════════════════════════════════════════════════════════

// A persisted domain class (a table of its owner, or the objects of a store). Join tables are
// references, not classes; copies of foreign data are mechanisms, not classes.
class DomainClass {
    name: string
    // mean size of one stored instance (bytes; from the schema)
    rowBytes: int
}

// A reference from one class to another: an id column, an id array or a join table, named by the
// source's field (Product.categories). `upper` is the multiplicity of the target end (1, or -1 for
// many). A snapshot reference copies attributes of the target into the source when the source is
// created (e.g. the price of an order item); reading them later needs no access to the target.
// `table`: held in a join table of its own (an m:n association), whose links are the source's data
// (they move with the source class) but not its rows; otherwise a column of the source's rows.
class Reference {
    name: string
    kind: ReferenceKind
    upper: int
    snapshot: boolean
    table: boolean
}

DomainClass.references[*] *--> Reference.source[1]
Reference.target[1] --> DomainClass

// ═══ Operations ═══════════════════════════════════════════════════════════════════════

// Something the system does on request: a GraphQL root field, a field resolver that does work
// (loads related classes), an entity resolver, a reaction to a domain event, or a callback of an
// external system. Its rate follows from the workload (the usage model's request types reach it).
// `cpuMs`: the operation's own work, without its accesses and calls. `envelopeMs` (DESIGN.md AB56; absent: 0): the part
// of cpuMs that is the callee's receiving envelope of today's invocation across services (measured inside it), which its
// SEFFs do not hold (the realisation's envelope block pays it where the call has its hop).
class Operation {
    name: string
    kind: OperationKind
    cpuMs: double
    envelopeMs: double[?]
}

// One kind of data access of an operation: what it reads or writes of one class, how often.
// `count`: statements per execution (expected value, including conditions and loops);
// `rows`: rows per statement (expected); `strong`: the extraction's flag that the read decides a
// write or check; `level` (reads; DESIGN.md AB60) what that means for its mechanisms: the curated
// consistency level of a strong read, STALE_OK for a read that is not strong, the strictest of
// them for an Access that stands for several (F3). `cpuMs` and `dbMs` are the timed part of the
// access when it is local: CPU in the accessing service (mapping, driver) and database time per
// execution of the operation.
class Access {
    mode: AccessMode
    shape: AccessShape
    count: double
    rows: double
    strong: boolean
    level: ConsistencyLevel[?]
    cpuMs: double
    dbMs: double
}

Operation.accesses[*] *--> Access.operation[1]
Access.target[1] --> DomainClass
// the reference the access reads or writes, if any (DESIGN.md AB42). With `target` its source and
// the reference in a join table (`table`), the access touches the reference's links only, not the
// target's rows: Product.categories reads the links of a product's categories (the categories
// themselves are a read of Category); a copy or cache of it is stale only when the links change.
Access.via[0..1] --> Reference

// An operation using another operation's logic (e.g. createOrder asks the discount logic for
// the applicable discounts). Whether this becomes a remote call depends on the cut.
// `count`: invocations per execution of the caller; `strong`, `level` as an Access's (AB60).
class Call {
    count: double
    strong: boolean
    level: ConsistencyLevel[?]
}

Operation.calls[*] *--> Call.caller[1]
Call.callee[1] --> Operation

// ═══ Domain events and processes ══════════════════════════════════════════════════════

// A business fact that triggers reactions (order placed, payment enabled, ...). Events that only
// feed local copies are not domain events: they belong to the copy mechanism.
class DomainEvent {
    name: string
}

// the classes whose data the event carries
DomainEvent.payload[*] --> DomainClass
// the reactions it triggers
DomainEvent.reactions[*] <--> Operation.trigger[0..1]

// An operation raising an event, with the probability per execution.
class Raise {
    probability: double
}

Operation.raises[*] *--> Raise.operation[1]
Raise.event[1] --> DomainEvent

// A business process: a client operation and the reactions that complete it (Buy, Return,
// Registration). Steps are listed in their order; whether a process runs as a choreography, an
// orchestration or inside one transaction is decided by the cut and the decision layer.
// `criticality` (absent: Domain.defaultCriticality) weighs a failed run of the process's
// asynchronous work in O2 against a failed session (DESIGN.md AB25): 1 when a lost step costs money
// or leaves a business case stuck (paid but nothing happens), less when it is customer-visible but
// recoverable. A unit of asynchronous work takes the criticality of the process whose trigger,
// step or compensation starts it; work that only maintains copies counts 0 (its delay is O4's
// staleness).
class Process {
    name: string
    criticality: double[?]
}

Process.trigger[1] --> Operation
Process.steps[1..*] --> Operation
Process.compensations[*] --> Operation

// ═══ Features ═════════════════════════════════════════════════════════════════════════

// A user-visible feature: the operations that belong to it (for group moves and change coupling).
class Feature {
    code: string
    name: string
}

Feature.operations[1..*] <--> Operation.feature[1]

// ═══ Derivation trace (step 4, DESIGN.md §F) ═══════════════════════════════════════════
// Written by core/generator/derive.py; read by transform/metrics.fn (O2's criticality, O4's data,
// C3's affinity graph) and the explorer; no operator reads or changes it (the group operators use
// the UnitGroups and Couplings of architecture.mm the generator derives from it).
// The service cut is the allocation of the class components (F1).

// The component that holds the class's operations and access parts, and its schema's component.
DomainClass.component[0..1] --> AssemblyContext
DomainClass.schema[0..1] --> AssemblyContext
// The SEFFs that run the operation: its own, and one per request type whose root resolver it is.
Operation.seffs[*] --> ResourceDemandingSEFF
// In a derived model an Access stands for all accesses of its operation to one class in one mode
// (F3); `actions` are the external calls that make it (one per SEFF of the operation), `sites`
// their call sites (none where only sync is allowed).
Access.actions[*] --> ExternalCallAction
Access.sites[*] --> CallSite

// Classes bound together (A6): separating them is allowed but priced (a saga, a rewrite of a
// statement, an id reference across services; F6). `operations`: those behind the binding. The
// default units of group moves (A1).
class Binding {
    kind: GroupKind
}

Domain.bindings[*] *--> Binding.domain[1]
Binding.classes[2..*] --> DomainClass
Binding.operations[*] --> Operation
