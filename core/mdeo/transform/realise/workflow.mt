using "../../metamodel/architecture.mm"

// Orchestrated workflows (DESIGN.md B3, rule 0 of the earlier translation): the orchestrator
// (the trigger's component) makes every step at the end of the trigger's SEFF, in a body fork
// (synchronous; asynchronous, in the background, when the plan's first step is an asynchronous
// call to another container). The body runs the levels of the plan one after the other, each a
// synchronous fork with a branch per step of that level: the orchestrator's coordination CPU,
// then the step's unit (its call, or the loop or branch around it), moved out of its SEFF.
// (Rule 0 nests a forest's subtrees instead of levels; for a forest whose steps each have at
// most one successor that is the same, and the MiSArch workflows are such chains or need levels.)

// The body, before the trigger's stop.
for match {
    wbRoot: Realisation { }
    wbPlan: WorkflowPlan { }
    wbWorkflow: Workflow { }
    wbStyle: Orchestrated { }
    wbTrigger: ResourceDemandingSEFF { }
    wbStop: StopAction { }
    wbLast: AbstractAction { }
    wbPlan.workflow -- wbWorkflow
    wbWorkflow.style -- wbStyle
    wbWorkflow.trigger -- wbTrigger
    wbTrigger.steps -- wbStop
    delete wbLast.successor -- wbStop
    forbid realised {
        wbExisting: RealisedWorkflow { }
        wbExisting.plan -- wbPlan
    }
    create wbRealised: RealisedWorkflow { }
    create wbBody: ForkAction {
        entityName = "orchestration"
    }
    create wbPoint: SynchronisationPoint { }
    create wbForked: ForkedBehaviour { }
    create wbStart: StartAction { }
    create wbEnd: StopAction { }
    create wbRoot.workflows -- wbRealised
    create wbRealised.plan -- wbPlan
    create wbRealised.body -- wbBody
    create wbRealised.behaviour -- wbForked
    create wbTrigger.steps -- wbBody
    create wbLast.successor -- wbBody
    create wbBody.successor -- wbStop
    create wbBody.synchronisingBehaviours -- wbPoint
    create wbPoint.synchronousForkedBehaviours -- wbForked
    create wbForked.steps -- wbStart
    create wbForked.steps -- wbEnd
    create wbStart.successor -- wbEnd
} do {
}

// The level forks, in the order of their levels: level 0 first, then each after the previous.
for match {
    w0Realised: RealisedWorkflow { }
    w0Plan: WorkflowPlan { }
    w0Level: WorkflowLevel {
        level == 0
    }
    w0Forked: ForkedBehaviour { }
    w0Start: StartAction { }
    w0Next: AbstractAction { }
    w0Realised.plan -- w0Plan
    w0Plan.levels -- w0Level
    w0Realised.behaviour -- w0Forked
    w0Forked.steps -- w0Start
    delete w0Start.successor -- w0Next
    forbid made {
        w0Existing: ForkAction { }
        w0Level.fork -- w0Existing
    }
    create w0Fork: ForkAction {
        entityName = "level"
    }
    create w0Point: SynchronisationPoint { }
    create w0Forked.steps -- w0Fork
    create w0Start.successor -- w0Fork
    create w0Fork.successor -- w0Next
    create w0Fork.synchronisingBehaviours -- w0Point
    create w0Level.fork -- w0Fork
} do {
}

while match {
    wnRealised: RealisedWorkflow { }
    wnPlan: WorkflowPlan { }
    wnLevel: WorkflowLevel { }
    wnPrevious: WorkflowLevel { }
    wnPreviousFork: ForkAction { }
    wnForked: ForkedBehaviour { }
    wnNext: AbstractAction { }
    wnRealised.plan -- wnPlan
    wnPlan.levels -- wnLevel
    wnPlan.levels -- wnPrevious
    wnPrevious.fork -- wnPreviousFork
    wnRealised.behaviour -- wnForked
    delete wnPreviousFork.successor -- wnNext
    where wnPrevious.level + 1 == wnLevel.level
    forbid made {
        wnExisting: ForkAction { }
        wnLevel.fork -- wnExisting
    }
    create wnFork: ForkAction {
        entityName = "level"
    }
    create wnPoint: SynchronisationPoint { }
    create wnForked.steps -- wnFork
    create wnPreviousFork.successor -- wnFork
    create wnFork.successor -- wnNext
    create wnFork.synchronisingBehaviours -- wnPoint
    create wnLevel.fork -- wnFork
} do {
}

// Each step's unit into a branch of its level's fork, an empty placeholder keeps its place
// (MovedUnit, DESIGN.md B4.12); the orchestrator makes the call.
// `while`: units of one SEFF may follow each other.
while match {
    wsRoot: Realisation { }
    wsCall: RealisedCall {
        shape == "step"
        built == "plain"
        built = "step"
    }
    wsAction: ExternalCallAction { }
    wsStep: WorkflowStep { }
    wsPlan: WorkflowPlan { }
    wsRealised: RealisedWorkflow { }
    wsLevel: WorkflowLevel { }
    wsFork: ForkAction { }
    wsPoint: SynchronisationPoint { }
    wsUnit: AbstractAction { }
    wsSeff: ResourceDemandingSEFF { }
    wsBefore: AbstractAction { }
    wsNext: AbstractAction { }
    wsOrchestrator: AssemblyContext { }
    wsProvider: AssemblyContext { }
    wsRole: OperationRequiredRole { }
    wsInterface: OperationInterface { }
    wsKnown: RealisedRole { }
    wsNewRole: OperationRequiredRole { }
    wsCall.action -- wsAction
    wsStep.`call` -- wsCall
    wsPlan.steps -- wsStep
    wsRealised.plan -- wsPlan
    wsPlan.levels -- wsLevel
    wsLevel.fork -- wsFork
    wsFork.synchronisingBehaviours -- wsPoint
    wsCall.unit -- wsUnit
    wsCall.seff -- wsSeff
    wsCall.logicalProvider -- wsProvider
    wsPlan.orchestrator -- wsOrchestrator
    wsAction.role -- wsRole
    wsRole.requiredInterface -- wsInterface
    wsKnown.source -- wsOrchestrator
    wsKnown.target -- wsProvider
    wsKnown.role -- wsNewRole
    wsNewRole.requiredInterface -- wsInterface
    where wsLevel.level == wsStep.level
    delete wsSeff.steps -- wsUnit
    delete wsBefore.successor -- wsUnit
    delete wsUnit.successor -- wsNext
    create wsHold: InternalAction {
        entityName = "moved"
    }
    create wsSeff.steps -- wsHold
    create wsBefore.successor -- wsHold
    create wsHold.successor -- wsNext
    create wsMoved: MovedUnit { }
    create wsRoot.units -- wsMoved
    create wsMoved.unit -- wsUnit
    create wsMoved.behaviour -- wsSeff
    create wsMoved.placeholder -- wsHold
    create wsMoved.`call` -- wsCall
    create wsBranch: ForkedBehaviour { }
    create wsStart: StartAction { }
    create wsStop: StopAction { }
    create wsPoint.synchronousForkedBehaviours -- wsBranch
    create wsBranch.steps -- wsStart
    create wsBranch.steps -- wsUnit
    create wsBranch.steps -- wsStop
    create wsStart.successor -- wsUnit
    create wsUnit.successor -- wsStop
    create wsCall.branch -- wsBranch
    delete wsAction.role -- wsRole
    create wsAction.role -- wsNewRole
    create wsCall.originalRole -- wsRole
} do {
}

// The same for a step whose provider is the orchestrator itself.
while match {
    wtRoot: Realisation { }
    wtCall: RealisedCall {
        shape == "step"
        built == "plain"
        built = "step"
    }
    wtAction: ExternalCallAction { }
    wtStep: WorkflowStep { }
    wtPlan: WorkflowPlan { }
    wtRealised: RealisedWorkflow { }
    wtLevel: WorkflowLevel { }
    wtFork: ForkAction { }
    wtPoint: SynchronisationPoint { }
    wtUnit: AbstractAction { }
    wtSeff: ResourceDemandingSEFF { }
    wtBefore: AbstractAction { }
    wtNext: AbstractAction { }
    wtOrchestrator: AssemblyContext { }
    wtRole: OperationRequiredRole { }
    wtInterface: OperationInterface { }
    wtKnown: RealisedRole { }
    wtNewRole: OperationRequiredRole { }
    wtCall.action -- wtAction
    wtStep.`call` -- wtCall
    wtPlan.steps -- wtStep
    wtRealised.plan -- wtPlan
    wtPlan.levels -- wtLevel
    wtLevel.fork -- wtFork
    wtFork.synchronisingBehaviours -- wtPoint
    wtCall.unit -- wtUnit
    wtCall.seff -- wtSeff
    wtCall.logicalProvider -- wtOrchestrator
    wtPlan.orchestrator -- wtOrchestrator
    wtAction.role -- wtRole
    wtRole.requiredInterface -- wtInterface
    wtKnown.source -- wtOrchestrator
    wtKnown.target -- wtOrchestrator
    wtKnown.role -- wtNewRole
    wtNewRole.requiredInterface -- wtInterface
    where wtLevel.level == wtStep.level
    delete wtSeff.steps -- wtUnit
    delete wtBefore.successor -- wtUnit
    delete wtUnit.successor -- wtNext
    create wtHold: InternalAction {
        entityName = "moved"
    }
    create wtSeff.steps -- wtHold
    create wtBefore.successor -- wtHold
    create wtHold.successor -- wtNext
    create wtMoved: MovedUnit { }
    create wtRoot.units -- wtMoved
    create wtMoved.unit -- wtUnit
    create wtMoved.behaviour -- wtSeff
    create wtMoved.placeholder -- wtHold
    create wtMoved.`call` -- wtCall
    create wtBranch: ForkedBehaviour { }
    create wtStart: StartAction { }
    create wtStop: StopAction { }
    create wtPoint.synchronousForkedBehaviours -- wtBranch
    create wtBranch.steps -- wtStart
    create wtBranch.steps -- wtUnit
    create wtBranch.steps -- wtStop
    create wtStart.successor -- wtUnit
    create wtUnit.successor -- wtStop
    create wtCall.branch -- wtBranch
    delete wtAction.role -- wtRole
    create wtAction.role -- wtNewRole
    create wtCall.originalRole -- wtRole
} do {
}

// The orchestrator makes the call (a step in another SEFF than the trigger's).
for match {
    woCall: RealisedCall {
        built == "step"
    }
    woStep: WorkflowStep { }
    woPlan: WorkflowPlan { }
    woCaller: AssemblyContext { }
    woOrchestrator: AssemblyContext { }
    woStep.`call` -- woCall
    woPlan.steps -- woStep
    woPlan.orchestrator -- woOrchestrator
    delete woCall.caller -- woCaller
    create woCall.caller -- woOrchestrator
} do {
}

// The orchestrator's coordination CPU before each step's unit; for a transactional workflow only
// across containers (./workflow-background.mt, AB35).
for match {
    wcRoot: Realisation { }
    wcDecisions: ArchitectureDecisions { }
    wcCall: RealisedCall {
        built == "step"
    }
    wcAction: ExternalCallAction { }
    wcWorkflow: Workflow { }
    wcStyle: Orchestrated {
        stepCpuMs > 0.0
    }
    wcBranch: ForkedBehaviour { }
    wcStart: StartAction { }
    wcUnit: AbstractAction { }
    wcOrchestrator: AssemblyContext { }
    wcContext: AllocationContext { }
    wcContainer: ResourceContainer { }
    wcRates: RealisedContainer { }
    wcCall.action -- wcAction
    wcWorkflow.steps -- wcAction
    wcWorkflow.style -- wcStyle
    where wcWorkflow.transactional == null || wcWorkflow.transactional!! == false
    wcCall.branch -- wcBranch
    wcBranch.steps -- wcStart
    delete wcStart.successor -- wcUnit
    wcCall.caller -- wcOrchestrator
    wcContext.assemblyContext -- wcOrchestrator
    wcContext.resourceContainer -- wcContainer
    wcRates.container -- wcContainer
    forbid coordinating {
        wcExisting: InternalAction { }
        wcCall.compose -- wcExisting
    }
    create wcCoordinate: InternalAction {
        entityName = "coordinate"
    }
    create wcDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (wcStyle.stepCpuMs / wcDecisions.msPerTimeUnit) + ") * (" + wcRates.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create wcRealised: RealisedDemand {
        ms = wcStyle.stepCpuMs
        kind = "CPU"
        rate = wcRates.cpuRate
    }
    create wcBranch.steps -- wcCoordinate
    create wcStart.successor -- wcCoordinate
    create wcCoordinate.successor -- wcUnit
    create wcCoordinate.resourceDemand -- wcDemand
    create wcRoot.demands -- wcRealised
    create wcRealised.demand -- wcDemand
    create wcRealised.owner -- wcOrchestrator
    create wcCall.compose -- wcCoordinate
} do {
}
