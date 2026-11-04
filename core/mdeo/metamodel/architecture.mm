// The architecture decisions of the Palladio architecture optimisation, on top of plain PCM
// (./palladio.mm; DESIGN.md §B): the decisions and their options, the mechanisms and workflows they
// choose among (local copies included, DESIGN.md AB49), the completions that realise the local
// copies, the load profile and the quality data of the evaluation, and the traces of the copy sync
// and of the realisation.
//
// The decisions only point at PCM elements; they never change PCM classes. The model holds its own
// realisation: the transformations of transform/ (realise.mt, and the repair each operator runs) turn
// the decisions into plain PCM in place and keep it consistent, so that the Palladio plugin only sees
// PCM. Their semantics are those of the earlier plugin translation, in its order:
//   - completions, workflows and homes: every Colocation allocates its assembly with its host; an
//     orchestrated workflow's steps move into its trigger's SEFF; across containers, a composed call
//     moves to its composer; a Redirect re-points its call; a Notification adds its work and its
//     asynchronous deliveries after its action; a Home's calls go to its chosen option;
//   - mechanisms: an ASYNC call is wrapped in an asynchronous fork (through the broker: the publish
//     on the caller's path, the rest in the background), a CACHED call in a probabilistic branch
//     (hit: CPU on the caller, miss: the call);
//   - remote calls: a call between two containers gets the middleware costs of RemoteCalls, as calls
//     into a middleware component per container (on its sidecar); a synchronous one into a service with a
//     ReceivingEnvelope also the callee's receiving envelope, in the callee's container (DESIGN.md AB56);
//   - replicas: a container with n replicas of q cores gets n·⌈q⌉ cores at speed q/⌈q⌉ (with `quota`:
//     full speed); with an Autoscaling the realised container is one pod, and the simulation's
//     autoscaler (SimOxide's HPA) scales it (DESIGN.md AB2).
// Every design is evaluated by simulations of the realised model (DESIGN.md AB1, the plugin's
// pcmEvaluate, transform/metrics.fn); nothing is computed from offered loads any more. Placement needs
// no realisation: the allocation is PCM, and the optimiser changes it directly.
//
// Option objects (ReplicaOption, the Mechanism and Coordination classes, a Home's HomeOptions) are
// fixed. Operators re-point a decision to another option among the allowed ones; they never create or
// edit behaviour. The realisation treats a LocalCopy as the call as modelled: the copy sync
// (optimize/sync-microservices.mt, DESIGN.md H10-H16, AB49) realises it with the completions, and
// every operator of the MiSArch configs runs it after its change.

import "./palladio.mm"

// ═══ Root ═════════════════════════════════════════════════════════════════════════════

// All architecture decisions of one model. Exactly one per model.
class ArchitectureDecisions {
    // Milliseconds per time unit of the PCM model: 1000 when its rates and demands are per
    // second, 1 when they are per millisecond. Converts the *Ms attributes below.
    msPerTimeUnit: double
}

ArchitectureDecisions.placements[*] *--> Placement.decisions[1]
ArchitectureDecisions.homes[*] *--> Home.decisions[1]
ArchitectureDecisions.unitGroups[*] *--> UnitGroup.decisions[1]
ArchitectureDecisions.couplings[*] *--> Coupling.decisions[1]
ArchitectureDecisions.deployables[*] *--> Deployable.decisions[1]
ArchitectureDecisions.replicaOptions[*] *--> ReplicaOption.decisions[1]
ArchitectureDecisions.autoscalings[*] *--> Autoscaling.decisions[1]
ArchitectureDecisions.remoteCalls[0..1] *--> RemoteCalls.decisions[1]
ArchitectureDecisions.envelopes[*] *--> ReceivingEnvelope.decisions[1]
ArchitectureDecisions.latency[0..1] *--> Latency.decisions[1]
ArchitectureDecisions.callSites[*] *--> CallSite.decisions[1]
ArchitectureDecisions.mechanisms[*] *--> Mechanism.decisions[1]
ArchitectureDecisions.workflows[*] *--> Workflow.decisions[1]
ArchitectureDecisions.coordinations[*] *--> Coordination.decisions[1]
ArchitectureDecisions.copyFeeds[*] *--> CopyFeed.decisions[1]

ArchitectureDecisions.colocations[*] *--> Colocation.decisions[1]
ArchitectureDecisions.redirects[*] *--> Redirect.decisions[1]
ArchitectureDecisions.notifications[*] *--> Notification.decisions[1]
ArchitectureDecisions.work[*] *--> Work.decisions[1]

ArchitectureDecisions.loadProfile[0..1] *--> LoadProfile.decisions[1]
ArchitectureDecisions.costModel[0..1] *--> CostModel.decisions[1]
ArchitectureDecisions.reliability[0..1] *--> Reliability.decisions[1]
ArchitectureDecisions.changeUnits[*] *--> ChangeUnit.decisions[1]
ArchitectureDecisions.changeCoupling[0..1] *--> ChangeCoupling.decisions[1]
ArchitectureDecisions.consistency[0..1] *--> Consistency.decisions[1]
ArchitectureDecisions.operationLatencyBudgets[*] *--> OperationLatencyBudget.decisions[1]
ArchitectureDecisions.latencyBudgetPolicy[0..1] *--> LatencyBudgetPolicy.decisions[1]
ArchitectureDecisions.peakCapacity[0..1] *--> PeakCapacity.decisions[1]
ArchitectureDecisions.objectiveBounds[*] *--> ObjectiveBound.decisions[1]

// derived (the copy sync): the copy stores and the Notifications of the copy feeds' writers
ArchitectureDecisions.copyStores[*] *--> CopyStore.decisions[1]
ArchitectureDecisions.feedNotifications[*] --> Notification
// derived (the realisation): its trace
ArchitectureDecisions.realisation[0..1] *--> Realisation.decisions[1]

// ═══ Placement ════════════════════════════════════════════════════════════════════════

// The optimiser may move the component of `allocation` to any container in `candidates`. The
// current container should be one of them. A component without a Placement stays where it is.
class Placement {}

Placement.allocation[1] --> AllocationContext
Placement.candidates[1..*] --> ResourceContainer

// ═══ Homes ════════════════════════════════════════════════════════════════════════════

// The home (entry point) of an operation as a decision (DESIGN.md AB38, AB41): an operation with writes bound to its
// home class by a transaction may enter at any class it writes in that transaction. Each option is the operation
// on one candidate class: its SEFFs (`seffs`: the work, the step form of an effect step, a request's root SEFF), on
// the candidate's interface (`interface`, the same signature names as on the written option's) and assembly
// (`provider`), its schema (`schema`, for an effect step's in-transaction condition). `calls` are every call into
// the operation (the gateway's root call, the effect steps of events, other operations' calls), written to the
// option `written`; `home` is the decision. The realisation re-targets each of them to the chosen option before it
// plans the call's mechanism (transform/realise/homes.mt: provider, role, the signature of the same name, and the
// call site's stepService, joinedService and providerSchema), so the home and the mechanism are independent. The
// SEFFs of the options not chosen are not reached; the metrics leave their structure out (metrics.fn
// inactiveSeffs). `operation` and `cls` are names for matching across models (crossover).
class Home {
    operation: string
}

Home.calls[1..*] --> ExternalCallAction
Home.options[1..*] *--> HomeOption.owner[1]
Home.home[1] --> HomeOption
Home.written[1] --> HomeOption

class HomeOption {
    cls: string
}

HomeOption.provider[1] --> AssemblyContext
HomeOption.interface[1] --> OperationInterface
HomeOption.seffs[1..*] --> ResourceDemandingSEFF
HomeOption.schema[0..1] --> AssemblyContext

// ═══ Groups ═══════════════════════════════════════════════════════════════════════════
// Hints for the group operators (DESIGN.md G8), not decisions: nothing realises them.

// Movable components that move-unit moves together into one container: a feature's classes, a
// binding group (classes bound by a transaction, a cross-class statement or a composition, DESIGN.md
// A1, A6), an aggregate. It constrains no cut (a cut may separate its members; the realisation prices
// that). `kind` names where it comes from ("feature", "binding", ...), for reports; no operator reads it.
class UnitGroup {
    kind: string[?]
}

UnitGroup.members[1..*] --> Placement

// An undirected coupling of two movable components, with a strength (e.g. calls or accesses
// between them per request, or transactions spanning both, from the domain layer). When a model has
// couplings, the group operators grow regions along them instead of along assembly connectors,
// stronger ones more often (DESIGN.md G8).
class Coupling {
    strength: double
}

Coupling.ends[2..2] --> Placement

// ═══ Deployment and scaling ═══════════════════════════════════════════════════════════

// A container run as `replicas` identical replicas behind an ideal load balancer, each limited
// to `cpuPerReplica` cores. Its CPU's processingRate is the speed of one full core. A container
// without a Deployable keeps its PCM processing resources unchanged.
class Deployable {
    cpuPerReplica: double
    // Cores of each replica's sidecar when RemoteCalls.sidecar is set (absent: 1). Sidecars run
    // at full speed and are not limited by cpuPerReplica.
    sidecarCores: int[?]
    // How the limit q slows a replica (absent: false). false: limit-speed, each of its ⌈q⌉ cores
    // runs at q/⌈q⌉ of full speed. true: a CPU quota; since DESIGN.md AB2 its ⌈q⌉ cores run at
    // full speed (the quota's slowdown under load was an analytic speed; Palladio has no CPU
    // quota), and the autoscaler measures its utilisation against q cores.
    quota: boolean[?]
}

Deployable.container[1] --> ResourceContainer
// The fixed replica count. Not needed (and ignored) with autoscaling.
Deployable.replicas[0..1] --> ReplicaOption
// The autoscaler that scales the container instead of a fixed count (DESIGN.md AB2: the simulation's
// HPA).
Deployable.autoscaling[0..1] --> Autoscaling

// A replica count that Deployable.replicas can point to.
class ReplicaOption {
    count: int
}

// The autoscaler of every Deployable that points here. Since DESIGN.md AB2 it is a Kubernetes
// HorizontalPodAutoscaler in the simulation that evaluates a design (SimOxide's HPA, SPD; the
// scripts pass every used Deployable's container as a scaling group to pcmEvaluate): CPU
// utilisation target targetUtilisation (per pod, against its CPU request), Kubernetes' defaults
// (sync 15 s, tolerance 0.1, scale-up rate limits), minReplicas (absent: 1), maxReplicas (absent:
// the scripts' default, transform/metrics.fn), the pods at the start initialReplicas (absent:
// minReplicas), the start-up delay of a new pod startupSeconds (absent: 30) and the scale-down
// stabilisation window scaleDownSeconds (absent: Kubernetes' 300 s). Cost counts the pods the run
// measured.
class Autoscaling {
    targetUtilisation: double
    maxReplicas: int[?]
    minReplicas: int[?]
    startupSeconds: double[?]
    scaleDownSeconds: double[?]
    initialReplicas: int[?]
}

// ═══ Remote calls and waits ═══════════════════════════════════════════════════════════

// Middleware costs of a call whose two ends sit in different containers. CPU is in milliseconds
// of one full core. A synchronous call costs callerCpuMs, latencyMs and calleeCpuMs; an
// asynchronous one through the broker costs publishCpuMs, the broker's SEFF, latencyMs and
// deliverCpuMs. With `sidecar`, the CPU runs on a sidecar container next to each container
// (full-speed cores per replica, Deployable.sidecarCores) instead of on the container's own CPU.
// networkMs (DESIGN.md AB39; absent: 0): the one-way network delay of one message between two pods on
// different nodes, which a single-host measurement does not contain (latencyMs and Latency.publishWaitMs are
// the measured part, loopback included). A remote hop carries two messages: a synchronous call request and
// response, an asynchronous one sender -> broker -> subscriber; the publisher's wait the broker's
// acknowledgement round trip. So the transit is latencyMs + 2 networkMs and the publish wait
// Latency.publishWaitMs + 2 networkMs (transform/realise/middleware.mt). Within a container no hop, no delay.
// The sidecars' CPU only: what the callee's application spends on receiving a synchronous call (its
// envelope) is a ReceivingEnvelope's, in the callee's container, because the middleware runs on the sidecar.
class RemoteCalls {
    callerCpuMs: double
    calleeCpuMs: double
    latencyMs: double
    publishCpuMs: double
    deliverCpuMs: double
    sidecar: boolean
    networkMs: double[?]
}

// The message broker: an assembly whose component provides one operation, run once per
// asynchronous message. Without a broker, an asynchronous remote call costs what a synchronous
// one costs, in the background.
RemoteCalls.broker[0..1] --> AssemblyContext
// Containers reached without the middleware, such as database servers that clients reach
// through their own driver: a call into them gets no stub and skeleton and costs nothing extra.
RemoteCalls.direct[*] --> ResourceContainer

// The receiving envelope of a synchronous call across containers (DESIGN.md AB56): what the callee's application
// spends on a request it receives over the network (receiving and parsing the GraphQL/HTTP request, the dispatch,
// decoding, serialising the answer), on the callee's own CPU. Within a container the caller calls the callee's
// work directly, without it. `services` are the operations of one component that a call reaches this way (reads
// of its class, calls of its operations, request fields, their federation fetches and provider caches);
// `envelope` that component's operation whose SEFF is the envelope's demand. The realisation
// (transform/realise/blocks.mt, rule `bv`) adds, after every synchronous call into one of `services` that has its
// hop (a MiddlewareBlock "before"), a call of `envelope` through the call's own role (a MiddlewareBlock of size 1,
// position "envelope"), so the CPU runs in the callee's container and follows composition, the fetch and cache
// re-pointing and moves; removed with the hop. Not for an effect step's step form (its envelope is in it, AB37),
// a commit, a joined call or the gateway's call of a request's root. cpuMs and estimate are documentation of the
// value the generator wrote into the envelope's SEFF (k_c applied) and whether it is an estimate.
class ReceivingEnvelope {
    cpuMs: double[?]
    estimate: boolean[?]
}

ReceivingEnvelope.services[1..*] --> OperationSignature
ReceivingEnvelope.envelope[1] --> OperationSignature

// Latency without CPU (DESIGN.md AB33.3): waits that cost time but no processing. stmtRoundTripMs
// per database statement and commitDelayMs per commit are the database round trips and the commit's
// WAL flush; the generator writes them into each database access (a DELAY demand of statements ×
// stmtRoundTripMs + commits × commitDelayMs on the database server's DELAY resource). publishWaitMs
// is the publisher's wait for the broker per message sent through it (a DELAY demand of the
// middleware's publish, on the publisher's path; transform/realise/middleware.mt). They change
// response times (O5, C1), not CPU. Absent (or no Latency): no such waits.
class Latency {
    stmtRoundTripMs: double[?]
    commitDelayMs: double[?]
    publishWaitMs: double[?]
}

// ═══ Call mechanisms ══════════════════════════════════════════════════════════════════

// A decision point for one external call. Without a CallSite, a call stays synchronous.
// `allowed` encodes validity: AsyncCall only where the caller does not use the result,
// CachedCall only for reads.
class CallSite {
    // Whether the call changes the callee's state (a command). Read by the inconsistency
    // exposure (DESIGN.md D54): a write to another container leaves the caller's transaction.
    writes: boolean[?]
    // The hit ratio of a cache at this site (a CachedCall, or a ComposedCall with a cache across
    // containers), from the site's own key stream (DESIGN.md AB33.2, the case's cache hits:
    // MiSArch's cases/misarch/generator/cache_hits.py); it replaces the mechanism's hitRatio for
    // this site. Absent: the mechanism's.
    hitRatio: double[?]
    // The share of this site's cache hits whose key was written after the entry was stored (per-key
    // staleness, AB33.2). O4 weighs the site's hits with it instead of the class-level
    // min(1, w × Consistency.cacheTtlSeconds) (AB23). Absent: the class-level rule.
    staleShare: double[?]
}

CallSite.call[1] --> ExternalCallAction
CallSite.mechanism[1] --> Mechanism
CallSite.allowed[1..*] --> Mechanism
// The composer's call into the operation that makes this call, for a ComposedCall mechanism.
CallSite.composer[0..1] --> ExternalCallAction
// The cache as built (DESIGN.md AB33.1): with a ComposedCall that has a cache, the composer calls
// this operation of the provider instead of the call's own (re-pointed while the cache is used,
// RealisedCall.originalService). Its SEFF, in the base model, is the provider-side cache: a hit
// costs the provider its hit CPU, a miss its miss CPU and then the call's own operation. So a hit
// keeps the compose CPU and the middleware of the call, and only the provider's work is saved
// (MiSArch's entity cache sits behind the provider's sidecar). Absent: the composer's own cache
// (hitCpuMs on the composer, no call on a hit).
CallSite.cachedService[0..1] --> OperationSignature
// A federation fetch (DESIGN.md AB43): with a ComposedCall without a cache, across containers the composer calls
// this operation of the provider instead of the call's own (re-pointed while composed, RealisedCall.originalService).
// Its SEFF, in the base model, is the provider's resolution of the entity the composer hands it (a field a subgraph
// contributes to another service's entity: MiSArch's `_entities` resolvers), then the call's own operation. Within
// one container the caller makes the call itself, as written: there is nothing to resolve.
CallSite.fetchService[0..1] --> OperationSignature
// An effect step (DESIGN.md AB37): the call goes, as written, to the provider's step form
// (`stepService`: the receiving envelope of a step in its own transaction, the step's work, its commit).
// With an InTransaction mechanism, while caller and provider share a container and `callerSchema` and
// `providerSchema` sit on one database server, the realisation re-points the call to `joinedService`
// (the step's work only: no envelope, no commit of its own; RealisedCall.originalService keeps the step
// form). The metrics skip the step form's own call of its work (not a second execution).
CallSite.joinedService[0..1] --> OperationSignature
CallSite.stepService[0..1] --> OperationSignature
CallSite.callerSchema[0..1] --> AssemblyContext
CallSite.providerSchema[0..1] --> AssemblyContext

// How a call is made. The subclass is the kind.
abstract class Mechanism {
    // The share of the callee's changes that break a caller in another container that uses this
    // mechanism (absent: ChangeCoupling.contractBreak). Read by the change coupling (D54).
    breakProbability: double[?]
    // How much a call between two containers couples them in the modularity (D32, D44; absent:
    // by class: ComposedCall 0.5, AsyncCall 0.3, any other class 1).
    couplingWeight: double[?]
    // The share of the calls with this mechanism between two containers that read data that may
    // be stale (absent: 0), e.g. a copy of the callee's data kept up to date asynchronously. In
    // the inconsistency exposure (D54) each weighs the probability that the data changed within
    // Consistency.replicationLagSeconds (DESIGN.md AB23; 1 without it). A cache's hits may be
    // stale anyway (window Consistency.cacheTtlSeconds).
    staleReads: double[?]
}

// The call as modelled: the caller waits for the callee.
class SyncCall extends Mechanism {}

// Fire and forget: the call runs in an asynchronous fork, and the caller does not wait.
class AsyncCall extends Mechanism {}

// In the caller's transaction (DESIGN.md AB37): the callee's work runs as a local call inside the
// caller's transaction, without its own envelope and commit (CallSite.joinedService), while caller and
// provider share a container and the site's two schemas a database server (and the call is not an
// orchestrated workflow step). Otherwise it is a synchronous step, as SyncCall.
class InTransaction extends Mechanism {}

// A cache in front of the call: with probability hitRatio the caller spends hitCpuMs instead of
// making the call.
class CachedCall extends Mechanism {
    hitRatio: double
    hitCpuMs: double
}

// Across containers, the call is made by a composer instead of the caller: right after the
// composer's call into the caller's operation (CallSite.composer), the composer spends
// composeCpuMs and then makes the call, so the caller no longer waits for it. With a hitRatio
// the composer keeps a cache: with that probability it spends hitCpuMs instead of the call.
// Within one container the caller makes the call itself, as written (there is nothing to
// compose). Example: an API gateway that joins the answers of two components.
// At a site with a cachedService the cache is the provider's, as built (DESIGN.md AB33.1): hitCpuMs
// and missCpuMs (absent: 0) are then the provider's CPU per hit and per miss (on top of the call),
// which the generator writes into the cachedService's SEFF; the composer only composes.
class ComposedCall extends Mechanism {
    composeCpuMs: double
    hitRatio: double[?]
    hitCpuMs: double[?]
    missCpuMs: double[?]
}

// Read a local copy instead of calling the owner (its feed: CopyFeed). Times are milliseconds at
// full speed. readCpuMs (absent: 0) is CPU the reader spends per read, e.g. when it evaluates the
// owner's query logic on the copy. Across containers a copy read may be stale (Mechanism.staleReads
// 1: with the probability that the copied data changed within Consistency.replicationLagSeconds,
// DESIGN.md AB23) and couples the two like a composed call (Mechanism.couplingWeight 0.5).
class LocalCopy extends Mechanism {
    readDbMs: double
    writeCpuMs: double
    writeDbMs: double
    readCpuMs: double[?]
}

// ═══ Workflows ════════════════════════════════════════════════════════════════════════

// A chain of calls that `trigger` starts. `steps` are the calls that make up the chain, in the
// SEFFs of the components along it; a step follows another when its call sits in the SEFF that
// the other one calls. `style` says who makes the steps: each component its own (Choreographed,
// the model as written), or the trigger's component (Orchestrated).
class Workflow {
    // The steps are writes in the trigger's transaction (DESIGN.md AB35): a step co-located with
    // the orchestrator is a local call in that transaction, so orchestrated it costs no
    // coordination CPU. Absent: every orchestrated step costs stepCpuMs.
    transactional: boolean[?]
}

Workflow.trigger[1] --> ResourceDemandingSEFF
Workflow.steps[1..*] --> ExternalCallAction
Workflow.style[1] --> Coordination
Workflow.allowed[1..*] --> Coordination

// How a workflow's steps are made. Fixed option objects, like the mechanisms.
abstract class Coordination {}

// Every component makes its own steps, as the SEFFs say.
class Choreographed extends Coordination {}

// The trigger's component (the orchestrator) makes every step, at the end of the trigger's SEFF:
// stepCpuMs on its CPU, then the step's call, with the step's own loop or branch. A step runs
// after the steps it follows; a step that follows several waits for the whole previous level.
// Steps whose callee lost its own step calls run as if those were gone. An asynchronous step is
// a request and a reply through the broker (publish, broker, latency, deliver each way), and the
// orchestrator waits for the reply. The whole orchestration runs in the background when the
// first step is an asynchronous call to another container.
class Orchestrated extends Coordination {
    stepCpuMs: double
}

// ═══ Local copies ═════════════════════════════════════════════════════════════════════
// A consumer reads its own copy of another component's data, kept up to date by events from the
// writers (DESIGN.md H10-H16, AB49). optimize/sync-microservices.mt realises them in PCM and the
// completions below:
// - every consumer assembly that keeps copies (CopyFeed.store) has a copy store, a PCM component
//   with a read and a write operation per copy (readCpuMs and readDbMs, writeCpuMs and writeDbMs
//   at the rates of the store's container); while one of its copies is read, an assembly of it
//   sits with the consumer (a Colocation);
// - a call whose CallSite has a LocalCopy mechanism gets a Redirect to its copy's read operation;
// - every write that feeds a read copy gets a published Notification with one Delivery of the
//   copy's write operation per copy it feeds: it publishes once, then sends each copy one message
//   (through the broker, when the copy is in another container). A writer in the store's own
//   container sends nothing: there the copy is its own data.
// What the sync makes it finds through its trace (section Copy sync trace).

// Which writes feed the copy that `site` reads when its mechanism is a LocalCopy, and where the
// copy is stored. `writers` are ExternalCallActions or InternalActions of the owner's SEFFs,
// directly in a SEFF (not in a loop, branch or fork); `store` is an assembly of the consumer (its
// database, or the reader itself) whose container keeps the copy; that container needs a CPU and
// an HDD. The call of `site` must sit directly in a SEFF too.
class CopyFeed {}

CopyFeed.site[1] --> CallSite
// No writers: the copy comes with messages the consumer gets anyway (event-carried state), so no
// write is replicated to it; only its reads cost.
CopyFeed.writers[*] --> AbstractAction
CopyFeed.store[1] --> AssemblyContext

// ═══ Completions ══════════════════════════════════════════════════════════════════════
// Generic building blocks that the realisation (transform/realise.mt) realises first, before the
// mechanisms. None of them is a decision and no operator touches them: the copy sync maintains the
// Colocations, Redirects, Notifications and Deliveries of the local copies (above), the generator
// writes the Work of its SEFFs, and a modeller may write any of them by hand.

// `assembly` has no AllocationContext of its own: it is deployed in the container of `host`,
// wherever that sits (e.g. a component's local data store). The realisation allocates it there
// (transform/realise/colocations.mt, a RealisedAllocation).
class Colocation {}

Colocation.assembly[1] --> AssemblyContext
Colocation.host[1] --> AssemblyContext

// The call is answered by `service` of `provider` instead of by its callee (e.g. a copy of the
// callee's data that the caller keeps, a read model): the realisation re-points the call there,
// through a role of the caller's component, and drops its parameters. The callee does not run.
class Redirect {}

Redirect.call[1] --> ExternalCallAction
Redirect.provider[1] --> AssemblyContext
Redirect.service[1] --> OperationSignature

// Work that follows an action (an ExternalCallAction or InternalAction) of a component: right
// after `after`, the component spends cpuMs (absent: none) on its own CPU, then makes its
// deliveries in the background, in one asynchronous fork. With `published` (absent: false) the
// deliveries are one message: with a broker (RemoteCalls.broker) it is published once
// (publishCpuMs, by the publisher on the component's sidecar), and every delivery to another
// container travels through the broker without a publish of its own (broker, latency, deliver).
// Without `published`, or without a broker, each delivery is a plain call.
class Notification {
    cpuMs: double[?]
    published: boolean[?]
}

Notification.after[1] --> AbstractAction
Notification.deliveries[1..*] *--> Delivery.notification[1]

// One call of a Notification: `service` of `provider`.
class Delivery {}

Delivery.provider[1] --> AssemblyContext
Delivery.service[1] --> OperationSignature

// The demands of `action`, in milliseconds of one full core of its container's CPU and of its
// HDD (as every *Ms of this file): transform/realise/work.mt adds them to the action as exponential
// demands at the base rates of the container its component sits in (RealisedContainer), CPU first;
// a time of 0 adds nothing. For behaviour derived from times in ms (core/generator/derive.py writes its
// SEFFs' work so), which then keeps its times wherever its component is placed.
class Work {
    cpuMs: double[?]
    hddMs: double[?]
}

Work.action[1] --> InternalAction

// ═══ Evaluation ═══════════════════════════════════════════════════════════════════════
// How a design is simulated. Not a decision: the operators never touch it.

// The load over time of the simulation that evaluates a design (DESIGN.md AB3): from each step's
// time on, a usage scenario's arrival rate (an open workload's; a closed workload's population)
// is the model's times the step's factor, until the scenario's next step. A step with a scenario
// applies to that scenario only and overrides the steps without one (every scenario); before a
// scenario's first step its factor is 1. The objectives and constraints are measured from
// warmUpSeconds to endSeconds, the end of the run. The simulation: seed (absent: 1), SimOxide's
// usage streams (common random numbers across designs; absent: true), at most maxPods pods
// created by the autoscalers (absent: 400; beyond, the run stops and the design is infeasible).
// `name` names the profile (e.g. day, steady). `replications` (absent: 1; DESIGN.md AB26):
// simulations per evaluation, with the seeds seed, seed + 1, …; the objectives and constraints
// combine them (means; C1 the mean statistic per request type against references averaged over
// the same seeds; C2 the maximum): the day's tail is bimodal over seeds.
class LoadProfile {
    warmUpSeconds: double
    endSeconds: double
    name: string[?]
    seed: int[?]
    usageStreams: boolean[?]
    maxPods: int[?]
    replications: int[?]
}
LoadProfile.steps[1..*] *--> LoadStep.profile[1]

// A step of a LoadProfile: from `seconds` on, the load of `scenario` (absent: of every scenario)
// times `factor`.
class LoadStep {
    seconds: double
    factor: double
}
LoadStep.scenario[0..1] --> UsageScenario

// ═══ Objectives ═══════════════════════════════════════════════════════════════════════
// Data for the objectives O1-O4 (transform/metrics.fn; DESIGN.md D53-D55, AB). None of it is a
// decision: the operators never touch it. Every value is an assumption or a measurement of the
// system; the model says where it comes from.

// Cost of a design (O1). Only containers that host a component count: perContainer each, perCore
// per core (replicas × cpuPerReplica, or the CPU's numberOfReplicas), perReplicaOverhead per
// replica. perCache per call site whose mechanism is a CachedCall. An autoscaled container's
// replicas are the simulation's (DESIGN.md AB2): its pods, ready or starting, averaged over the
// measured window for perCore (and a ContainerPrice), its mean ready pods for perReplicaOverhead.
class CostModel {
    perContainer: double
    perCore: double
    perReplicaOverhead: double
    perCache: double
}

CostModel.prices[*] *--> ContainerPrice.costModel[1]

// A fixed price for each of `containers` that hosts a component, instead of the CostModel's rule
// (e.g. a managed database server, or infrastructure priced as a constant). With perCore (DESIGN.md
// AB30): `price` per container plus perCore × the cores it is sized to, its CPU's busiest bin
// (PeakCapacity's) at PeakCapacity.limit, at least minCores (absent: 0): a container that does not
// autoscale is provisioned for its peak.
class ContainerPrice {
    price: double
    perCore: double[?]
    minCores: double[?]
}

ContainerPrice.containers[1..*] --> ResourceContainer

// Failures (O2). A change unit fails a share of its releases, each until restored:
// u(unit) = changes · changeFailureRate · restoreHours / periodHours. A container with movable
// components fails as a whole (shared fate): u = processUnavailability + Σ u(units on it). A
// directly reached container (a database server) fails with serverUnavailability plus
// tenantShare · Σ u(units on it) (migrations, runaway queries of its tenants). The realised
// metrics (transform/metrics.fn, DESIGN.md §W) count a release once per request: it takes down
// all of its unit's containers together (the servers with probability tenantShare).
// asyncWeight (absent: 0, the synchronous paths only; DESIGN.md AB24.2, AB25): the weight of a
// failed run of asynchronous work (what a SEFF's asynchronous forks run, transitively: event
// deliveries and their handlers, saga steps, callbacks, fire-and-forget calls; not copy updates)
// against a failed session in O2, a global factor on the business criticality of the work's process
// (domain.mm Process.criticality); it fails when a source is down that touches its containers and not
// those the triggering SEFF had just used synchronously.
class Reliability {
    changeFailureRate: double
    restoreHours: double
    periodHours: double
    processUnavailability: double
    serverUnavailability: double
    tenantShare: double
    asyncWeight: double[?]
}

// Components developed and released together (e.g. one repository), with the number of
// changes in Reliability.periodHours (O2, O3; the domain models: by the class's operations, AB24.1).
class ChangeUnit {
    changes: double
}

ChangeUnit.components[1..*] --> AssemblyContext

// Change coupling (O3): the share of a unit's changes that break a caller in another container,
// for calls whose mechanism has no breakProbability.
// sharedServerCoupling (absent: 0, DESIGN.md U2): a unit with a component on a directly reached
// container (a database server) also touches, with this weight, every other application
// container that holds a component of a change unit with a component on the same server.
class ChangeCoupling {
    contractBreak: double
    sharedServerCoupling: double[?]
}

// Inconsistency exposure (O4, transform/metrics.fn): the weight of a write to another container,
// made synchronously or asynchronously (the outcome is also late). A possibly stale read weighs
// the probability that the data it reads changed within its staleness window (DESIGN.md AB23):
// min(1, w × window), w the simulated write rate of the data (writes per second). The windows:
// replicationLagSeconds for a copy kept up to date asynchronously (Mechanism.staleReads, a
// LocalCopy): the time from a write to the copy being updated; cacheTtlSeconds for a cache's hits
// (CachedCall, ComposedCall.hitRatio): how long an entry is served without revalidation. Absent:
// every possibly stale read weighs 1 (before AB23).
class Consistency {
    syncWriteWeight: double
    asyncWriteWeight: double
    replicationLagSeconds: double[?]
    cacheTtlSeconds: double[?]
}

// ═══ Constraints ══════════════════════════════════════════════════════════════════════
// Data for the constraints C1 and C2 and for objectives as constraints (transform/metrics.fn), and
// for O5, whose budgets are C1's. Not decisions either.

// A latency budget of one request type that is a system operation (DESIGN.md L1, AB6): with
// session scenarios a scenario's response time includes think times, so the request type is the
// operation the entry-level system calls invoke (e.g. a gateway's provided operation). Its
// simulated 95th percentile response time in the measured window (the system operation's, over
// all its calls) must stay at most at `ms`, unless a LatencyBudgetPolicy says otherwise.
class OperationLatencyBudget {
    ms: double
    // The reference the policy's budget is taken from (DESIGN.md AB20): the request type's
    // simulated statistics in the reference design (today's cut) under the model's load profile,
    // and its completions there. Absent: `ms` is the budget of the p95.
    referenceMeanMs: double[?]
    referenceP50Ms: double[?]
    referenceP90Ms: double[?]
    referenceP95Ms: double[?]
    referenceP99Ms: double[?]
    referenceCount: int[?]
}

OperationLatencyBudget.operation[1] --> OperationSignature

// How C1 measures a request type against its budget (DESIGN.md AB20): `statistic` (mean, p50, p90,
// p95 or p99) of its simulated response times in the window must stay at most at `factor` × the
// same statistic of the reference (OperationLatencyBudget.reference*); request types with fewer
// than `minCompletions` completions in the reference run get no budget (their statistic is noise).
// O5 counts the share of requests slower than these budgets. Without a policy: p95 against
// OperationLatencyBudget.ms.
class LatencyBudgetPolicy {
    statistic: string
    factor: double
    minCompletions: int
}

// C2: containers that no autoscaler scales (database servers, a broker). Since DESIGN.md AB6: the
// largest utilisation of their processing resources over the time bins of binSeconds (absent: 10)
// in the simulated window must stay at most at `limit`.
class PeakCapacity {
    limit: double
    binSeconds: double[?]
}

PeakCapacity.containers[1..*] --> ResourceContainer

// An objective as a constraint against a reference (DESIGN.md AB30.3): metrics.fn's `objective` (its
// function name, e.g. changeCoupling) must stay at most at `factor` × `reference` (today's value under
// the same profile and seeds); the constraint functions *Bound report the relative excess.
class ObjectiveBound {
    objective: string
    reference: double
    factor: double
}

// ═══ Copy sync trace ══════════════════════════════════════════════════════════════════
// Written by the copy sync (optimize/sync-microservices.mt, optimize/sync/) only: it finds what it
// made through these references.

// The copy store, the copy's read and write operations, the Redirect of the call while the copy is
// read, the Deliveries of its writes.
CopyFeed.copyStore[0..1] --> CopyStore
CopyFeed.read[0..1] --> OperationSignature
CopyFeed.write[0..1] --> OperationSignature
CopyFeed.redirect[0..1] --> Redirect
CopyFeed.deliveries[*] --> Delivery

// The copy store of one consumer assembly (`store`): a PCM component with an interface of its own,
// and while one of its copies is read an assembly of it with the consumer.
class CopyStore {}

CopyStore.store[1] --> AssemblyContext
CopyStore.component[1] --> BasicComponent
CopyStore.copies[1] --> OperationInterface
CopyStore.assembly[0..1] --> AssemblyContext
CopyStore.colocation[0..1] --> Colocation

// ═══ Realisation trace ════════════════════════════════════════════════════════════════
// Written by the transformations of transform/ only (DESIGN.md §B); nothing here is a decision, and
// no operator matches it. The realisation finds what it made only through these references, so a
// hand-made PCM element is never changed. Every PCM element the realisation creates is reachable from
// here; every base element it edits in place is named here with what is needed to undo the edit.

// The root of the trace. At most one per model. `fixed` is set once the fixed parts (what no
// operator changes: base rates, sidecars, middleware, owned behaviours, the RealisedCalls of base
// calls, the workflows' plans) are made; they are made only once (DESIGN.md B3).
class Realisation {
    fixed: boolean[?]
}

// The derived interface of the middleware components (operations send, transit, receive,
// publish, deliver).
Realisation.middleware[0..1] --> OperationInterface
Realisation.containers[*] *--> RealisedContainer.realisation[1]
Realisation.behaviours[*] *--> OwnedBehaviour.realisation[1]
Realisation.calls[*] *--> RealisedCall.realisation[1]
Realisation.links[*] *--> MiddlewareLink.realisation[1]
Realisation.blocks[*] *--> MiddlewareBlock.realisation[1]
Realisation.demands[*] *--> RealisedDemand.realisation[1]
Realisation.allocations[*] *--> RealisedAllocation.realisation[1]
Realisation.notifications[*] *--> RealisedNotification.realisation[1]
Realisation.workflows[*] *--> RealisedWorkflow.realisation[1]
Realisation.plans[*] *--> WorkflowPlan.realisation[1]
Realisation.units[*] *--> MovedUnit.realisation[1]
Realisation.groups[*] *--> ComposedGroup.realisation[1]
Realisation.deployables[*] *--> RealisedDeployable.realisation[1]
Realisation.roles[*] *--> RealisedRole.realisation[1]
Realisation.placements[*] *--> RealisedPlacement.realisation[1]
// Marks of the placement repair (transform/repair/placement.mt), empty outside it: the placements
// whose context moved, and the calls it has to look at (an end of theirs moved, or new).
Realisation.moved[*] --> RealisedPlacement
Realisation.dirty[*] --> RealisedCall

// A container with a CPU: its base rates as written before the realisation (the Deployable's
// realisation, transform/realise/deployables.mt, changes the CPU's rate), and, unless it is reached
// directly, its middleware: a component with the middleware operations whose assembly runs on `host`
// (the sidecar with RemoteCalls.sidecar, else the container itself).
class RealisedContainer {
    cpuRate: string
    hddRate: string[?]
    // The rate of the DELAY resource of `host` (the middleware's latency).
    delayRate: string[?]
}
RealisedContainer.container[1] --> ResourceContainer
RealisedContainer.cpu[1] --> ProcessingResourceSpecification
RealisedContainer.sidecar[0..1] --> ResourceContainer
RealisedContainer.host[0..1] --> ResourceContainer
RealisedContainer.component[0..1] --> BasicComponent
RealisedContainer.assembly[0..1] --> AssemblyContext
RealisedContainer.allocation[0..1] --> AllocationContext

// A behaviour of a base SEFF (the SEFF itself, or nested in its branches, loops and forks), with
// the SEFF and the SEFF-level action that holds it (none for the SEFF): found once, so that a
// call at any depth is reached in one step.
class OwnedBehaviour {}
OwnedBehaviour.behaviour[1] --> ResourceDemandingBehaviour
OwnedBehaviour.seff[1] --> ResourceDemandingSEFF
OwnedBehaviour.unit[0..1] --> AbstractAction

// A call the realisation knows: every base ExternalCallAction with a connector, and every call it
// creates (deliveries). `caller` and `provider` are the assemblies it currently runs between
// (after a composition, an orchestration or a redirect); `logicalCaller` and `logicalProvider` the
// base connector's ends (base calls only). `anchor` is the action whose expected count is the
// call's count in the model as written (the call, or the cache branch around it).
// The realisation plans before it changes anything (DESIGN.md B3): `shape` is the structure the
// call should have (plain, async, cache, composed, composedCache, step, redirect; gone: a delivery
// whose Delivery was removed), `kind` the middleware it needs across containers (sync, async,
// published, reply); `built` is the structure it has. Middleware blocks are keyed by shape and
// kind, so a call's blocks are removed before its structure changes.
class RealisedCall {
    shape: string
    built: string
    kind: string
}
RealisedCall.action[1] --> ExternalCallAction
RealisedCall.caller[1] --> AssemblyContext
RealisedCall.provider[1] --> AssemblyContext
RealisedCall.logicalCaller[0..1] --> AssemblyContext
RealisedCall.logicalProvider[0..1] --> AssemblyContext
RealisedCall.seff[0..1] --> ResourceDemandingSEFF
RealisedCall.unit[0..1] --> AbstractAction
RealisedCall.anchor[0..1] --> AbstractAction
RealisedCall.site[0..1] --> CallSite
// The derived action around the call (an asynchronous fork, a cache branch).
RealisedCall.wrapper[0..1] --> AbstractAction
// What a re-pointed call pointed at before (Redirect, composition, orchestration).
RealisedCall.originalRole[0..1] --> OperationRequiredRole
RealisedCall.originalService[0..1] --> OperationSignature
RealisedCall.redirect[0..1] --> Redirect
// A Home's call re-targeted to an option that is not the written one (DESIGN.md AB41,
// transform/realise/homes.mt): the option, and the call's role as written (restored when the call
// goes back to the written option).
RealisedCall.home[0..1] --> HomeOption
RealisedCall.writtenRole[0..1] --> OperationRequiredRole
RealisedCall.delivery[0..1] --> Delivery
// The notification a delivery call belongs to.
RealisedCall.notification[0..1] --> RealisedNotification
// The derived actions of its structure: the cache hit, the composer's compose CPU, the
// orchestrator's coordination CPU; the branch of a composed group or of an orchestration level
// that holds its unit.
RealisedCall.hit[0..1] --> InternalAction
RealisedCall.compose[0..1] --> InternalAction
RealisedCall.branch[0..1] --> ForkedBehaviour
RealisedCall.group[0..1] --> ComposedGroup

// A derived required role of `source`'s component and its connector from `source`: to the
// middleware of the container of `target` (kind "self": `target` = `source`, its own side; kind
// "peer": the provider's side), or to the broker (kind "broker", `target` the broker's assembly).
// A move re-targets the connector; the role stays.
class MiddlewareLink {
    kind: string
}
MiddlewareLink.source[1] --> AssemblyContext
MiddlewareLink.target[1] --> AssemblyContext
MiddlewareLink.role[1] --> OperationRequiredRole
MiddlewareLink.connector[1] --> AssemblyConnector

// Derived calls into middleware next to a remote call, a contiguous part of a chain from `first`
// to `last` (`size` actions). `position`: before (the call), after (the call), ahead (of the
// call's wrapper), envelope (the callee's ReceivingEnvelope right after a synchronous call, DESIGN.md
// AB56: a call into the callee's component, not into middleware). `shape` and `kind`: the call's when the
// block was made.
class MiddlewareBlock {
    size: int
    position: string
    shape: string
    kind: string
}
MiddlewareBlock.realised[1] --> RealisedCall
MiddlewareBlock.first[1] --> AbstractAction
MiddlewareBlock.last[1] --> AbstractAction

// A derived demand given in ms of one full core (or of the HDD) of the container that `owner`
// sits in, written as StoEx text over that container's base rate `rate` (DESIGN.md B1.5). The
// demands of `Work` (with `work`) and of the derived CPU actions (cache hit, compose,
// coordinate, notify). Without an owner (its assembly was removed) the demand goes.
class RealisedDemand {
    ms: double
    kind: string
    rate: string
}
RealisedDemand.demand[1] --> ParametricResourceDemand
RealisedDemand.owner[0..1] --> AssemblyContext
RealisedDemand.work[0..1] --> Work

// A derived AllocationContext (entity name "realised"): of a colocated assembly, in the
// container of the Colocation's host.
class RealisedAllocation {}
RealisedAllocation.allocation[1] --> AllocationContext
RealisedAllocation.colocation[0..1] --> Colocation

// The realisation of a Notification after its action: the CPU (when cpuMs > 0), the
// asynchronous fork with its behaviour `body`, and in it the publish (published, with a broker)
// and a call per Delivery (RealisedCall.notification).
class RealisedNotification {}
RealisedNotification.notification[0..1] --> Notification
RealisedNotification.owner[1] --> AssemblyContext
RealisedNotification.fork[1] --> ForkAction
RealisedNotification.body[1] --> ForkedBehaviour
RealisedNotification.cpu[0..1] --> InternalAction
RealisedNotification.publish[0..1] --> ExternalCallAction

// The plan of a workflow (fixed: its steps and trigger do not change): the orchestrator (the
// trigger's assembly), the levels of its steps (longest-path levels, transform/realise/workflow-plan.mt)
// and `first`, the step of level 0 earliest in the trigger's SEFF (whose mechanism and placement
// decide whether an orchestration runs in the background). `cursor`: a helper while `first` is
// searched.
class WorkflowPlan {}
WorkflowPlan.workflow[1] --> Workflow
WorkflowPlan.orchestrator[1] --> AssemblyContext
WorkflowPlan.first[0..1] --> RealisedCall
WorkflowPlan.cursor[0..1] --> AbstractAction
WorkflowPlan.levels[*] *--> WorkflowLevel.plan[1]
WorkflowPlan.steps[*] *--> WorkflowStep.plan[1]

class WorkflowLevel {
    level: int
}
// The synchronous fork of the level in the orchestration's body, while orchestrated.
WorkflowLevel.fork[0..1] --> ForkAction

class WorkflowStep {
    level: int
}
WorkflowStep.call[1] --> RealisedCall

// An orchestrated workflow: its body (a fork, asynchronous in the background, else synchronous;
// its behaviour `behaviour` holds the level forks in order) at the end of the trigger's SEFF.
class RealisedWorkflow {}
RealisedWorkflow.plan[0..1] --> WorkflowPlan
RealisedWorkflow.body[1] --> ForkAction
RealisedWorkflow.behaviour[1] --> ForkedBehaviour

// A SEFF-level action (a step's or a composed call, or the loop or branch around it) moved out
// of its chain: where it was, to put it back. `placeholder` is an empty InternalAction (entity
// name "moved", no demand) left in the chain where the unit was; the unit goes back in its place.
// Neighbours may be wrapped, unwrapped, moved or removed meanwhile without losing the position
// (DESIGN.md B4.12).
class MovedUnit {}
MovedUnit.unit[1] --> AbstractAction
MovedUnit.behaviour[1] --> ResourceDemandingBehaviour
MovedUnit.placeholder[1] --> InternalAction
MovedUnit.call[1] --> RealisedCall

// The composed calls after one composer call: a synchronous fork right after it, one forked
// behaviour per composed call.
class ComposedGroup {}
ComposedGroup.after[1] --> ExternalCallAction
ComposedGroup.fork[1] --> ForkAction

// A Deployable as realised: the replicas its CPU and sidecar have.
class RealisedDeployable {
    replicas: int
}
RealisedDeployable.deployable[1] --> Deployable

// The container an AllocationContext had when the realisation last saw it (DESIGN.md B4.9). A
// placement repair finds the moved contexts in one scan of these and repairs only what touches
// them. Without a context (it was removed) the placement goes.
class RealisedPlacement {}
RealisedPlacement.allocation[0..1] --> AllocationContext
RealisedPlacement.container[1] --> ResourceContainer

// A derived required role of a base component and its connector (a Redirect's, a delivery's, a
// composer's, an orchestrator's). Kept once made.
class RealisedRole {}
RealisedRole.source[1] --> AssemblyContext
RealisedRole.target[1] --> AssemblyContext
RealisedRole.role[1] --> OperationRequiredRole
RealisedRole.connector[1] --> AssemblyConnector
