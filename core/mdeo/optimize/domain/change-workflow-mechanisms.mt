using "../../metamodel/architecture.mm"
import "../generic/group/workflow-sites.mt" as workflowSites
import "../generic/group/draw-mechanism.mt" as drawMechanism
import "../generic/group/draw-style.mt" as drawStyle
import "../generic/group/set-mechanism.mt" as setMechanism
import "../generic/group/set-style.mt" as setStyle
import "../sync/site.mt" as syncSite
import "../../transform/repair/site.mt" as repairSite

// A mechanism group operator with the realised layer 2 (DESIGN.md M7): the draws of a workflow, a target mechanism
// and a style (../generic/group), per changed step site the change and the layer-3 repair of a site
// (../sync/site.mt), the style, then the whole layer-2 repair of a mechanism (../../transform/repair/site.mt: whole
// plan and sections, which also realise a new coordination, as ../../transform/repair/coordination.mt does). A
// workflow changes up to 15 step sites at once, for which the whole repair is cheaper than the per-site one
// (./repair-sites.mt; measured, M7).
out changed: List<CallSite>
out copies: List<CallSite>

call workflowSites() -> (sites: scope, chosen: saga)
call drawMechanism(sites = scope) -> (target: drawn)
call drawStyle(workflow = saga) -> (style: drawnStyle)
for x in scope do {
    if call setMechanism(site = x, target = drawn) -> (previous: before) then {
        call syncSite(site = x, previous = before)
        changed += x
        if (drawn is LocalCopy || before is LocalCopy) {
            copies += x
        }
    }
}
call setStyle(workflow = saga, style = drawnStyle) -> (switched: styleSwitched)
call repairSite()
