using "../../metamodel/architecture.mm"
import "./generic/differing-workflows.mt" as differingWorkflows
import "./generic/donor-style.mt" as donorStyle
import "./generic/donor-mechanism.mt" as donorMechanism
import "../generic/group/workflow-sites.mt" as workflowSites
import "../generic/group/set-mechanism.mt" as setMechanism
import "../generic/group/set-style.mt" as setStyle
import "../sync/site.mt" as syncSite
import "../../transform/repair/site.mt" as repairSite

// Crossover take-workflow (DESIGN.md AC4): a workflow (saga) on which the donor differs takes the
// donor's coordination style and, at every step whose call site allows it, the donor's mechanism.
// Repaired as ../domain/change-workflow-mechanisms.mt (DESIGN.md M4): per changed step site the
// layer-3 site repair, the style, then the whole layer-2 repair of a mechanism (which also realises
// a new coordination). Fails, before any change, when the donor agrees on every workflow.
// `changed`, `copies` (sites to or from a LocalCopy) as in the mechanism group operators.
in donor: model
out changed: List<CallSite>
out copies: List<CallSite>

call differingWorkflows(donor = donor) -> (chosen: saga)
if call workflowSites(workflow = saga) -> (sites: steps) then {
    for x in steps do {
        if call donorMechanism(donor = donor, site = x) -> (target: wanted) then {
            call setMechanism(site = x, target = wanted) -> (previous: before)
            call syncSite(site = x, previous = before)
            changed += x
            if (wanted is LocalCopy || before is LocalCopy) {
                copies += x
            }
        }
    }
}
if call donorStyle(donor = donor, workflow = saga) -> (style: wantedStyle) then {
    call setStyle(workflow = saga, style = wantedStyle) -> (switched: styleSwitched)
}
call repairSite()
