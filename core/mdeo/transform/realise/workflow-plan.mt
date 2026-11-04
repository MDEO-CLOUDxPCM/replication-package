using "../../metamodel/architecture.mm"
import "./workflow-levels.mt" as workflowLevels

// Fixed part (DESIGN.md B3): the plan of every workflow, as rule 0 orders its steps. A step
// follows another when its call sits in the SEFF that the other calls; its level is the longest
// chain of steps before it (the levels of the earlier translation; a cycle stops at 64). `first`
// is the step of level 0 earliest in the trigger's SEFF. Steps, triggers and the calls between
// them never change, so the plan is made once.

for match {
    pwRoot: Realisation { }
    pwWorkflow: Workflow { }
    pwTrigger: ResourceDemandingSEFF { }
    pwComponent: BasicComponent { }
    pwOrchestrator: AssemblyContext { }
    pwWorkflow.trigger -- pwTrigger
    pwComponent.serviceEffectSpecifications -- pwTrigger
    pwOrchestrator.encapsulatedComponent -- pwComponent
    forbid done {
        pwExisting: WorkflowPlan { }
        pwExisting.workflow -- pwWorkflow
    }
    create pwPlan: WorkflowPlan { }
    create pwRoot.plans -- pwPlan
    create pwPlan.workflow -- pwWorkflow
    create pwPlan.orchestrator -- pwOrchestrator
} do {
}

for match {
    psPlan: WorkflowPlan { }
    psWorkflow: Workflow { }
    psCall: ExternalCallAction { }
    psRealised: RealisedCall { }
    psPlan.workflow -- psWorkflow
    psWorkflow.steps -- psCall
    psRealised.action -- psCall
    forbid done {
        psExisting: WorkflowStep { }
        psPlan.steps -- psExisting
        psExisting.`call` -- psRealised
    }
    create psStep: WorkflowStep {
        level = 0
    }
    create psPlan.steps -- psStep
    create psStep.`call` -- psRealised
} do {
}

// Longest chains (./workflow-levels.mt): a chain may alternate between steps reached directly and
// effect steps reached through their step form (DESIGN.md AB37), so the two rules run to a joint
// fixpoint (a chain of the model alternates at most a few times; four rounds).
call workflowLevels()
call workflowLevels()
call workflowLevels()
call workflowLevels()

while match {
    lvPlan: WorkflowPlan { }
    lvStep: WorkflowStep { }
    lvPlan.steps -- lvStep
    forbid known {
        lvExisting: WorkflowLevel { }
        lvPlan.levels -- lvExisting
        where lvExisting.level == lvStep.level
    }
    create lvLevel: WorkflowLevel {
        level = lvStep.level
    }
    create lvPlan.levels -- lvLevel
} do {
}

// `first`: walk the trigger's SEFF from its start to the first unit of a step of level 0.
for match {
    fcPlan: WorkflowPlan { }
    fcWorkflow: Workflow { }
    fcTrigger: ResourceDemandingSEFF { }
    fcStart: StartAction { }
    fcPlan.workflow -- fcWorkflow
    fcWorkflow.trigger -- fcTrigger
    fcTrigger.steps -- fcStart
    forbid walking {
        fcCursor: AbstractAction { }
        fcPlan.cursor -- fcCursor
    }
    forbid found {
        fcFirst: RealisedCall { }
        fcPlan.first -- fcFirst
    }
    create fcPlan.cursor -- fcStart
} do {
}

while match {
    fwPlan: WorkflowPlan { }
    fwAt: AbstractAction { }
    fwNext: AbstractAction { }
    delete fwPlan.cursor -- fwAt
    fwAt.successor -- fwNext
    create fwPlan.cursor -- fwNext
    forbid arrived {
        fwStep: WorkflowStep {
            level == 0
        }
        fwRealised: RealisedCall { }
        fwPlan.steps -- fwStep
        fwStep.`call` -- fwRealised
        fwRealised.unit -- fwAt
    }
} do {
}

for match {
    ffPlan: WorkflowPlan { }
    ffAt: AbstractAction { }
    ffStep: WorkflowStep {
        level == 0
    }
    ffRealised: RealisedCall { }
    delete ffPlan.cursor -- ffAt
    ffPlan.steps -- ffStep
    ffStep.`call` -- ffRealised
    ffRealised.unit -- ffAt
    create ffPlan.first -- ffRealised
} do {
}

// No step of level 0 in the trigger's SEFF: the walk ends at its stop action.
for match {
    fnPlan: WorkflowPlan { }
    fnAt: StopAction { }
    delete fnPlan.cursor -- fnAt
} do {
}
