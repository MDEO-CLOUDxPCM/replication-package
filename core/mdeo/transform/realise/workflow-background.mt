using "../../metamodel/architecture.mm"

// An orchestration's body runs in the background (an asynchronous fork) when its plan's first
// step is an asynchronous call to another container, else synchronously (DESIGN.md B3). Depends
// on the first step's mechanism and on placement.

// In the background when the first step is an asynchronous call to another container.
for match {
    waRealised: RealisedWorkflow { }
    waPlan: WorkflowPlan { }
    waBody: ForkAction { }
    delete waPoint: SynchronisationPoint { }
    waForked: ForkedBehaviour { }
    waFirst: RealisedCall { }
    waSite: CallSite { }
    waMechanism: AsyncCall { }
    waOrchestrator: AssemblyContext { }
    waProvider: AssemblyContext { }
    waOrchestratorContext: AllocationContext { }
    waProviderContext: AllocationContext { }
    waOrchestratorContainer: ResourceContainer { }
    waProviderContainer: ResourceContainer { }
    waRealised.plan -- waPlan
    waRealised.body -- waBody
    waRealised.behaviour -- waForked
    delete waBody.synchronisingBehaviours -- waPoint
    delete waPoint.synchronousForkedBehaviours -- waForked
    create waBody.asynchronousForkedBehaviours -- waForked
    waPlan.first -- waFirst
    waFirst.site -- waSite
    waSite.mechanism -- waMechanism
    waPlan.orchestrator -- waOrchestrator
    waFirst.logicalProvider -- waProvider
    waOrchestratorContext.assemblyContext -- waOrchestrator
    waProviderContext.assemblyContext -- waProvider
    waOrchestratorContext.resourceContainer -- waOrchestratorContainer
    waProviderContext.resourceContainer -- waProviderContainer
} do {
}

for match {
    wyRealised: RealisedWorkflow { }
    wyPlan: WorkflowPlan { }
    wyBody: ForkAction { }
    wyForked: ForkedBehaviour { }
    wyRealised.plan -- wyPlan
    wyRealised.body -- wyBody
    wyRealised.behaviour -- wyForked
    delete wyBody.asynchronousForkedBehaviours -- wyForked
    create wyPoint: SynchronisationPoint { }
    create wyBody.synchronisingBehaviours -- wyPoint
    create wyPoint.synchronousForkedBehaviours -- wyForked
    forbid background {
        wyFirst: RealisedCall { }
        wySite: CallSite { }
        wyMechanism: AsyncCall { }
        wyOrchestrator: AssemblyContext { }
        wyProvider: AssemblyContext { }
        wyOrchestratorContext: AllocationContext { }
        wyProviderContext: AllocationContext { }
        wyOrchestratorContainer: ResourceContainer { }
        wyProviderContainer: ResourceContainer { }
        wyPlan.first -- wyFirst
        wyFirst.site -- wySite
        wySite.mechanism -- wyMechanism
        wyPlan.orchestrator -- wyOrchestrator
        wyFirst.logicalProvider -- wyProvider
        wyOrchestratorContext.assemblyContext -- wyOrchestrator
        wyProviderContext.assemblyContext -- wyProvider
        wyOrchestratorContext.resourceContainer -- wyOrchestratorContainer
        wyProviderContext.resourceContainer -- wyProviderContainer
    }
} do {
}

// A transactional workflow's coordination (DESIGN.md AB35) depends on placement: a step whose
// provider sits in the orchestrator's container is a local call in the trigger's transaction and
// costs nothing; across containers the orchestrator's stepCpuMs before it (as ./workflow.mt).
while match {
    xlWorkflow: Workflow { }
    xlCall: RealisedCall {
        built == "step"
    }
    xlAction: ExternalCallAction { }
    xlOrchestrator: AssemblyContext { }
    xlProvider: AssemblyContext { }
    xlOrchestratorContext: AllocationContext { }
    xlProviderContext: AllocationContext { }
    xlContainer: ResourceContainer { }
    xlBehaviour: ResourceDemandingBehaviour { }
    xlBefore: AbstractAction { }
    xlAfter: AbstractAction { }
    xlCall.action -- xlAction
    xlWorkflow.steps -- xlAction
    where xlWorkflow.transactional != null && xlWorkflow.transactional!! == true
    xlCall.caller -- xlOrchestrator
    xlCall.provider -- xlProvider
    xlOrchestratorContext.assemblyContext -- xlOrchestrator
    xlProviderContext.assemblyContext -- xlProvider
    xlOrchestratorContext.resourceContainer -- xlContainer
    xlProviderContext.resourceContainer -- xlContainer
    delete xlCompose: InternalAction { }
    delete xlDemand: ParametricResourceDemand { }
    delete xlRealised: RealisedDemand { }
    delete xlCall.compose -- xlCompose
    delete xlCompose.resourceDemand -- xlDemand
    delete xlRealised.demand -- xlDemand
    delete xlBehaviour.steps -- xlCompose
    delete xlBefore.successor -- xlCompose
    delete xlCompose.successor -- xlAfter
    create xlBefore.successor -- xlAfter
} do {
}
for match {
    xcRoot: Realisation { }
    xcDecisions: ArchitectureDecisions { }
    xcCall: RealisedCall {
        built == "step"
    }
    xcAction: ExternalCallAction { }
    xcWorkflow: Workflow { }
    xcStyle: Orchestrated {
        stepCpuMs > 0.0
    }
    xcBranch: ForkedBehaviour { }
    xcStart: StartAction { }
    xcUnit: AbstractAction { }
    xcOrchestrator: AssemblyContext { }
    xcProvider: AssemblyContext { }
    xcContext: AllocationContext { }
    xcContainer: ResourceContainer { }
    xcRates: RealisedContainer { }
    xcCall.action -- xcAction
    xcWorkflow.steps -- xcAction
    xcWorkflow.style -- xcStyle
    where xcWorkflow.transactional != null && xcWorkflow.transactional!! == true
    xcCall.branch -- xcBranch
    xcBranch.steps -- xcStart
    delete xcStart.successor -- xcUnit
    xcCall.caller -- xcOrchestrator
    xcCall.provider -- xcProvider
    xcContext.assemblyContext -- xcOrchestrator
    xcContext.resourceContainer -- xcContainer
    xcRates.container -- xcContainer
    forbid coordinating {
        xcExisting: InternalAction { }
        xcCall.compose -- xcExisting
    }
    forbid colocated {
        xcProviderContext: AllocationContext { }
        xcProviderContext.assemblyContext -- xcProvider
        xcProviderContext.resourceContainer -- xcContainer
    }
    create xcCoordinate: InternalAction {
        entityName = "coordinate"
    }
    create xcDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (xcStyle.stepCpuMs / xcDecisions.msPerTimeUnit) + ") * (" + xcRates.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create xcRealised: RealisedDemand {
        ms = xcStyle.stepCpuMs
        kind = "CPU"
        rate = xcRates.cpuRate
    }
    create xcBranch.steps -- xcCoordinate
    create xcStart.successor -- xcCoordinate
    create xcCoordinate.successor -- xcUnit
    create xcCoordinate.resourceDemand -- xcDemand
    create xcRoot.demands -- xcRealised
    create xcRealised.demand -- xcDemand
    create xcRealised.owner -- xcOrchestrator
    create xcCall.compose -- xcCoordinate
} do {
}
