using "../../metamodel/architecture.mm"

// The removal of orchestrations whose workflow is no longer orchestrated (DESIGN.md B3), after
// their steps went back (./teardown-calls.mt).

// An orchestration whose workflow is no longer orchestrated (its steps are back): the forks of
// its levels, then its body.
while match {
    twLevel: WorkflowLevel { }
    twPlan: WorkflowPlan { }
    twWorkflow: Workflow { }
    delete twFork: ForkAction { }
    delete twPoint: SynchronisationPoint { }
    twPlan.levels -- twLevel
    twPlan.workflow -- twWorkflow
    delete twLevel.fork -- twFork
    delete twFork.synchronisingBehaviours -- twPoint
    forbid orchestrated {
        twStyle: Orchestrated { }
        twWorkflow.style -- twStyle
    }
} do {
}

while match {
    tsPlan: WorkflowPlan { }
    tsWorkflow: Workflow { }
    tsBefore: AbstractAction { }
    tsStop: StopAction { }
    delete tsRealised: RealisedWorkflow { }
    delete tsBody: ForkAction { }
    delete tsPoint: SynchronisationPoint { }
    delete tsForked: ForkedBehaviour { }
    delete tsStart: StartAction { }
    delete tsEnd: StopAction { }
    delete tsRealised.plan -- tsPlan
    tsPlan.workflow -- tsWorkflow
    delete tsRealised.body -- tsBody
    delete tsRealised.behaviour -- tsForked
    delete tsBody.synchronisingBehaviours -- tsPoint
    delete tsPoint.synchronousForkedBehaviours -- tsForked
    delete tsForked.steps -- tsStart
    delete tsForked.steps -- tsEnd
    delete tsBefore.successor -- tsBody
    delete tsBody.successor -- tsStop
    create tsBefore.successor -- tsStop
    forbid orchestrated {
        tsStyle: Orchestrated { }
        tsWorkflow.style -- tsStyle
    }
} do {
}

while match {
    tbPlan: WorkflowPlan { }
    tbWorkflow: Workflow { }
    tbBefore: AbstractAction { }
    tbStop: StopAction { }
    delete tbRealised: RealisedWorkflow { }
    delete tbBody: ForkAction { }
    delete tbForked: ForkedBehaviour { }
    delete tbStart: StartAction { }
    delete tbEnd: StopAction { }
    delete tbRealised.plan -- tbPlan
    tbPlan.workflow -- tbWorkflow
    delete tbRealised.body -- tbBody
    delete tbRealised.behaviour -- tbForked
    delete tbBody.asynchronousForkedBehaviours -- tbForked
    delete tbForked.steps -- tbStart
    delete tbForked.steps -- tbEnd
    delete tbBefore.successor -- tbBody
    delete tbBody.successor -- tbStop
    create tbBefore.successor -- tbStop
    forbid orchestrated {
        tbStyle: Orchestrated { }
        tbWorkflow.style -- tbStyle
    }
} do {
}
