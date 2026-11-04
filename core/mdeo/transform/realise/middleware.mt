using "../../metamodel/architecture.mm"

// Fixed part of the realisation (DESIGN.md B1.3): the middleware of remote calls. Per container
// that is not reached directly: with RemoteCalls.sidecar a sidecar (a container with one full core
// of the container's base speed per replica and a DELAY resource), and a middleware component on
// the sidecar (else on the container) whose operations are the costs of RemoteCalls: send
// (callerCpuMs), transit (latencyMs, as a delay), receive (calleeCpuMs), publish (publishCpuMs),
// deliver (deliverCpuMs). It depends on RemoteCalls and the containers only; no operator changes
// it.

// ═══ Sidecars ═════════════════════════════════════════════════════════════════════════
for match {
    scRemote: RemoteCalls {
        sidecar == true
    }
    scRealised: RealisedContainer {
        delayRate = "1"
    }
    scContainer: ResourceContainer { }
    scEnvironment: ResourceEnvironment { }
    scRealised.container -- scContainer
    scEnvironment.resourceContainer -- scContainer

    forbid direct {
        scRemote.direct -- scContainer
    }
    forbid done {
        scExisting: ResourceContainer { }
        scRealised.sidecar -- scExisting
    }

    create scSidecar: ResourceContainer {
        entityName = scContainer.entityName + "_sidecar"
    }
    create scCpu: ProcessingResourceSpecification {
        schedulingPolicy = SchedulingPolicy.PROCESSOR_SHARING
        activeResourceType = ProcessingResourceType.CPU
        processingRate = scRealised.cpuRate
        numberOfReplicas = 1
    }
    create scDelay: ProcessingResourceSpecification {
        schedulingPolicy = SchedulingPolicy.DELAY
        activeResourceType = ProcessingResourceType.DELAY
        processingRate = "1"
    }
    create scEnvironment.resourceContainer -- scSidecar
    create scSidecar.activeResourceSpecifications -- scCpu
    create scSidecar.activeResourceSpecifications -- scDelay
    create scRealised.sidecar -- scSidecar
    create scRealised.host -- scSidecar
} do {
}

// A sidecar joins the linking resources of its container.
for match {
    slRealised: RealisedContainer { }
    slContainer: ResourceContainer { }
    slSidecar: ResourceContainer { }
    slLink: LinkingResource { }
    slRealised.container -- slContainer
    slRealised.sidecar -- slSidecar
    slLink.connectedResourceContainers -- slContainer
    forbid joined {
        slLink.connectedResourceContainers -- slSidecar
    }
    create slLink.connectedResourceContainers -- slSidecar
} do {
}

// Without sidecars the middleware runs on the container itself, with its DELAY resource (one of
// rate 1 is added where it has none).
for match {
    nsRemote: RemoteCalls {
        sidecar == false
    }
    nsRealised: RealisedContainer {
        delayRate = "1"
    }
    nsContainer: ResourceContainer { }
    nsRealised.container -- nsContainer
    forbid direct {
        nsRemote.direct -- nsContainer
    }
    forbid done {
        nsHost: ResourceContainer { }
        nsRealised.host -- nsHost
    }
    forbid delayed {
        nsExisting: ProcessingResourceSpecification {
            activeResourceType == ProcessingResourceType.DELAY
        }
        nsContainer.activeResourceSpecifications -- nsExisting
    }
    create nsDelay: ProcessingResourceSpecification {
        schedulingPolicy = SchedulingPolicy.DELAY
        activeResourceType = ProcessingResourceType.DELAY
        processingRate = "1"
    }
    create nsContainer.activeResourceSpecifications -- nsDelay
    create nsRealised.host -- nsContainer
} do {
}

for match {
    ndRemote: RemoteCalls {
        sidecar == false
    }
    ndRealised: RealisedContainer {
        delayRate = ndDelay.processingRate!!
    }
    ndContainer: ResourceContainer { }
    ndDelay: ProcessingResourceSpecification {
        activeResourceType == ProcessingResourceType.DELAY
    }
    ndRealised.container -- ndContainer
    ndContainer.activeResourceSpecifications -- ndDelay
    forbid direct {
        ndRemote.direct -- ndContainer
    }
    forbid done {
        ndHost: ResourceContainer { }
        ndRealised.host -- ndHost
    }
    create ndRealised.host -- ndContainer
} do {
}

// ═══ The middleware interface ═════════════════════════════════════════════════════════
if match {
    miRoot: Realisation { }
    miRemote: RemoteCalls { }
    forbid done {
        miExisting: OperationInterface { }
        miRoot.middleware -- miExisting
    }
} then {
    match {
        miRoot { }
        miRepository: Repository { }
        create miInterface: OperationInterface {
            entityName = "Middleware"
        }
        create miSend: OperationSignature {
            entityName = "send"
        }
        create miTransit: OperationSignature {
            entityName = "transit"
        }
        create miReceive: OperationSignature {
            entityName = "receive"
        }
        create miPublish: OperationSignature {
            entityName = "publish"
        }
        create miDeliver: OperationSignature {
            entityName = "deliver"
        }
        create miRepository.interfaces -- miInterface
        create miInterface.signatures -- miSend
        create miInterface.signatures -- miTransit
        create miInterface.signatures -- miReceive
        create miInterface.signatures -- miPublish
        create miInterface.signatures -- miDeliver
        create miRoot.middleware -- miInterface
    }
}

// The commit of a transactional write apart from its caller's transaction (DESIGN.md AB33.7): an
// operation of the middleware only with Latency.commitDelayMs. No block calls it any more (the
// commit blocks went with CallSite.transactional, AB50; an effect step's step form commits itself,
// AB37); kept so that the fixed parts of models realised before stay as they are.
for match {
    mkRoot: Realisation { }
    mkInterface: OperationInterface { }
    mkLatency: Latency { }
    mkRoot.middleware -- mkInterface
    where mkLatency.commitDelayMs != null && mkLatency.commitDelayMs!! > 0.0
    forbid done {
        mkExisting: OperationSignature {
            entityName == "commit"
        }
        mkInterface.signatures -- mkExisting
    }
    create mkCommit: OperationSignature {
        entityName = "commit"
    }
    create mkInterface.signatures -- mkCommit
} do {
}

// ═══ A middleware component per container ═════════════════════════════════════════════
// Its assembly runs on the host (an AllocationContext named "realised"); each operation is one
// InternalAction, whose demand the statements below add.
for match {
    mcRoot: Realisation { }
    mcInterface: OperationInterface { }
    mcRepository: Repository { }
    mcSystem: System { }
    mcAllocation: Allocation { }
    mcRealised: RealisedContainer { }
    mcContainer: ResourceContainer { }
    mcHost: ResourceContainer { }
    mcRoot.middleware -- mcInterface
    mcRealised.container -- mcContainer
    mcRealised.host -- mcHost
    forbid done {
        mcExisting: BasicComponent { }
        mcRealised.component -- mcExisting
    }

    var mcName = "middleware_" + mcContainer.entityName

    create mcComponent: BasicComponent {
        entityName = mcName
    }
    create mcProvides: OperationProvidedRole {
        entityName = mcName + "_provides"
    }
    create mcAssembly: AssemblyContext {
        entityName = "Assembly_" + mcName
    }
    create mcAllocationContext: AllocationContext {
        entityName = "realised"
    }
    create mcRepository.components -- mcComponent
    create mcComponent.providedRoles -- mcProvides
    create mcProvides.providedInterface -- mcInterface
    create mcSystem.assemblyContexts -- mcAssembly
    create mcAssembly.encapsulatedComponent -- mcComponent
    create mcAllocation.allocationContexts -- mcAllocationContext
    create mcAllocationContext.assemblyContext -- mcAssembly
    create mcAllocationContext.resourceContainer -- mcHost
    create mcRealised.component -- mcComponent
    create mcRealised.assembly -- mcAssembly
    create mcRealised.allocation -- mcAllocationContext
} do {
}

// One SEFF per operation: start, the operation's InternalAction, stop.
for match {
    msRoot: Realisation { }
    msInterface: OperationInterface { }
    msOperation: OperationSignature { }
    msRealised: RealisedContainer { }
    msComponent: BasicComponent { }
    msRoot.middleware -- msInterface
    msInterface.signatures -- msOperation
    msRealised.component -- msComponent
    forbid done {
        msExisting: ResourceDemandingSEFF { }
        msComponent.serviceEffectSpecifications -- msExisting
        msExisting.describedService -- msOperation
    }
    create msSeff: ResourceDemandingSEFF { }
    create msStart: StartAction { }
    create msAction: InternalAction {
        entityName = msOperation.entityName
    }
    create msStop: StopAction { }
    create msComponent.serviceEffectSpecifications -- msSeff
    create msSeff.describedService -- msOperation
    create msSeff.steps -- msStart
    create msSeff.steps -- msAction
    create msSeff.steps -- msStop
    create msStart.successor -- msAction
    create msAction.successor -- msStop
} do {
}

// The CPU demand of each operation (none for 0 ms), in ms of one full core of the container's base
// speed: Exp(1 / ((ms / msPerTimeUnit) * rate)), the earlier translation's arithmetic (B1.5).
for match {
    md0Decisions: ArchitectureDecisions { }
    md0Remote: RemoteCalls { }
    md0Realised: RealisedContainer { }
    md0Component: BasicComponent { }
    md0Seff: ResourceDemandingSEFF { }
    md0Operation: OperationSignature {
        entityName == "send"
    }
    md0Action: InternalAction { }
    md0Realised.component -- md0Component
    md0Component.serviceEffectSpecifications -- md0Seff
    md0Seff.describedService -- md0Operation
    md0Seff.steps -- md0Action
    where md0Remote.callerCpuMs > 0.0
    forbid done {
        md0Existing: ParametricResourceDemand { }
        md0Action.resourceDemand -- md0Existing
    }
    create md0Demand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (md0Remote.callerCpuMs / md0Decisions.msPerTimeUnit) + ") * (" + md0Realised.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create md0Action.resourceDemand -- md0Demand
} do {
}

for match {
    md1Decisions: ArchitectureDecisions { }
    md1Remote: RemoteCalls { }
    md1Realised: RealisedContainer { }
    md1Component: BasicComponent { }
    md1Seff: ResourceDemandingSEFF { }
    md1Operation: OperationSignature {
        entityName == "receive"
    }
    md1Action: InternalAction { }
    md1Realised.component -- md1Component
    md1Component.serviceEffectSpecifications -- md1Seff
    md1Seff.describedService -- md1Operation
    md1Seff.steps -- md1Action
    where md1Remote.calleeCpuMs > 0.0
    forbid done {
        md1Existing: ParametricResourceDemand { }
        md1Action.resourceDemand -- md1Existing
    }
    create md1Demand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (md1Remote.calleeCpuMs / md1Decisions.msPerTimeUnit) + ") * (" + md1Realised.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create md1Action.resourceDemand -- md1Demand
} do {
}

for match {
    md2Decisions: ArchitectureDecisions { }
    md2Remote: RemoteCalls { }
    md2Realised: RealisedContainer { }
    md2Component: BasicComponent { }
    md2Seff: ResourceDemandingSEFF { }
    md2Operation: OperationSignature {
        entityName == "publish"
    }
    md2Action: InternalAction { }
    md2Realised.component -- md2Component
    md2Component.serviceEffectSpecifications -- md2Seff
    md2Seff.describedService -- md2Operation
    md2Seff.steps -- md2Action
    where md2Remote.publishCpuMs > 0.0
    forbid done {
        md2Existing: ParametricResourceDemand { }
        md2Action.resourceDemand -- md2Existing
    }
    create md2Demand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (md2Remote.publishCpuMs / md2Decisions.msPerTimeUnit) + ") * (" + md2Realised.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create md2Action.resourceDemand -- md2Demand
} do {
}

// The publisher's wait for the broker per message (Latency.publishWaitMs, DESIGN.md AB33.3): a
// delay on the host's DELAY resource next to the publish CPU, on the publisher's path; plus the network's
// acknowledgement round trip, 2 x RemoteCalls.networkMs (AB39).
for match {
    mwDecisions: ArchitectureDecisions { }
    mwLatency: Latency { }
    mwRealised: RealisedContainer { }
    mwComponent: BasicComponent { }
    mwSeff: ResourceDemandingSEFF { }
    mwOperation: OperationSignature {
        entityName == "publish"
    }
    mwAction: InternalAction { }
    mwRealised.component -- mwComponent
    mwComponent.serviceEffectSpecifications -- mwSeff
    mwSeff.describedService -- mwOperation
    mwSeff.steps -- mwAction
    mwRemote: RemoteCalls { }
    where mwLatency.publishWaitMs != null && mwLatency.publishWaitMs!! > 0.0 && mwRealised.delayRate != null
    forbid done {
        mwExisting: ParametricResourceDemand {
            requiredResource == ProcessingResourceType.DELAY
        }
        mwAction.resourceDemand -- mwExisting
    }
    create mwDemand: ParametricResourceDemand {
        specification = "(" + ((mwLatency.publishWaitMs!! + 2.0 * (mwRemote.networkMs != null ? mwRemote.networkMs!! : 0.0)) / mwDecisions.msPerTimeUnit) + ") * (" + mwRealised.delayRate!! + ")"
        requiredResource = ProcessingResourceType.DELAY
    }
    create mwAction.resourceDemand -- mwDemand
} do {
}

for match {
    md3Decisions: ArchitectureDecisions { }
    md3Remote: RemoteCalls { }
    md3Realised: RealisedContainer { }
    md3Component: BasicComponent { }
    md3Seff: ResourceDemandingSEFF { }
    md3Operation: OperationSignature {
        entityName == "deliver"
    }
    md3Action: InternalAction { }
    md3Realised.component -- md3Component
    md3Component.serviceEffectSpecifications -- md3Seff
    md3Seff.describedService -- md3Operation
    md3Seff.steps -- md3Action
    where md3Remote.deliverCpuMs > 0.0
    forbid done {
        md3Existing: ParametricResourceDemand { }
        md3Action.resourceDemand -- md3Existing
    }
    create md3Demand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (md3Remote.deliverCpuMs / md3Decisions.msPerTimeUnit) + ") * (" + md3Realised.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create md3Action.resourceDemand -- md3Demand
} do {
}

// commit: Latency.commitDelayMs on the host's DELAY resource (AB33.7), like the publisher's wait.
for match {
    mkdDecisions: ArchitectureDecisions { }
    mkdLatency: Latency { }
    mkdRealised: RealisedContainer { }
    mkdComponent: BasicComponent { }
    mkdSeff: ResourceDemandingSEFF { }
    mkdOperation: OperationSignature {
        entityName == "commit"
    }
    mkdAction: InternalAction { }
    mkdRealised.component -- mkdComponent
    mkdComponent.serviceEffectSpecifications -- mkdSeff
    mkdSeff.describedService -- mkdOperation
    mkdSeff.steps -- mkdAction
    where mkdLatency.commitDelayMs != null && mkdLatency.commitDelayMs!! > 0.0 && mkdRealised.delayRate != null
    forbid done {
        mkdExisting: ParametricResourceDemand { }
        mkdAction.resourceDemand -- mkdExisting
    }
    create mkdDemand: ParametricResourceDemand {
        specification = "(" + (mkdLatency.commitDelayMs!! / mkdDecisions.msPerTimeUnit) + ") * (" + mkdRealised.delayRate!! + ")"
        requiredResource = ProcessingResourceType.DELAY
    }
    create mkdAction.resourceDemand -- mkdDemand
} do {
}

// transit: the latency, a constant delay on the host's DELAY resource: the measured latencyMs plus two
// messages over the network, 2 x RemoteCalls.networkMs (AB39).
for match {
    mtDecisions: ArchitectureDecisions { }
    mtRemote: RemoteCalls { }
    mtRealised: RealisedContainer { }
    mtComponent: BasicComponent { }
    mtSeff: ResourceDemandingSEFF { }
    mtOperation: OperationSignature {
        entityName == "transit"
    }
    mtAction: InternalAction { }
    mtRealised.component -- mtComponent
    mtComponent.serviceEffectSpecifications -- mtSeff
    mtSeff.describedService -- mtOperation
    mtSeff.steps -- mtAction
    where mtRemote.latencyMs + 2.0 * (mtRemote.networkMs != null ? mtRemote.networkMs!! : 0.0) > 0.0
    forbid done {
        mtExisting: ParametricResourceDemand { }
        mtAction.resourceDemand -- mtExisting
    }
    create mtDemand: ParametricResourceDemand {
        specification = "(" + ((mtRemote.latencyMs + 2.0 * (mtRemote.networkMs != null ? mtRemote.networkMs!! : 0.0)) / mtDecisions.msPerTimeUnit) + ") * (" + mtRealised.delayRate!! + ")"
        requiredResource = ProcessingResourceType.DELAY
    }
    create mtAction.resourceDemand -- mtDemand
} do {
}
