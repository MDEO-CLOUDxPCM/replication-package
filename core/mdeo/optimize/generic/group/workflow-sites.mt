using "../../../metamodel/architecture.mm"

// The scope of change-workflow-mechanisms (DESIGN.md M3): a workflow drawn uniformly among those
// with a step whose call site has at least two options, and the call sites of all its steps.
// `workflow` pins the workflow when a caller passes one; `chosen` is the workflow. Changes nothing.
in workflow: Workflow?
out sites: List<CallSite>
out chosen: Workflow

match {
    workflow: Workflow { }
    require eligible {
        wsEligibleAction: ExternalCallAction { }
        wsEligibleSite: CallSite { }
        wsOne: Mechanism { }
        wsTwo: Mechanism { }
        workflow.steps -- wsEligibleAction
        wsEligibleSite.`call` -- wsEligibleAction
        wsEligibleSite.allowed -- wsOne
        wsEligibleSite.allowed -- wsTwo
    }
}
for match {
    workflow { }
    wsAction: ExternalCallAction { }
    wsSite: CallSite { }
    workflow.steps -- wsAction
    wsSite.`call` -- wsAction
    sites += wsSite
} do {
}
chosen = workflow
