using "../../../metamodel/architecture.mm"
import "./donor-style.mt" as donorStyle
import "./donor-mechanism.mt" as donorMechanism
import "../../generic/group/workflow-sites.mt" as workflowSites

// The scope draw of take-workflow (DESIGN.md AC4): the workflows on which the donor differs, in its
// style (./donor-style.mt) or in the mechanism of a step's call site (./donor-mechanism.mt), and
// one of them drawn uniformly (`chosen`). Fails, before any change (it changes nothing), when there
// is none.
in donor: model
out candidates: Set<Workflow>
out chosen: Workflow

for match {
    dwWorkflow: Workflow { }
} do {
    if call donorStyle(donor = donor, workflow = dwWorkflow) -> (style: dwStyle) then {
        candidates += dwWorkflow
    }
    // the step sites (the call fails for a workflow without a step of two options)
    if call workflowSites(workflow = dwWorkflow) -> (sites: dwSteps) then {
        for dwStep in dwSteps do {
            if call donorMechanism(donor = donor, site = dwStep) -> (target: dwWanted) then {
                candidates += dwWorkflow
            }
        }
    }
}
match {
    dwDrawn: Workflow { }
    where candidates.includes(dwDrawn)
}
chosen = dwDrawn
