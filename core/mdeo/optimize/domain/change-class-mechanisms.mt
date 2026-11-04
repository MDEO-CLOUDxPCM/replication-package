using "../../metamodel/architecture.mm"
import "../generic/group/provider-sites.mt" as providerSites
import "../generic/group/draw-mechanism.mt" as drawMechanism
import "../generic/group/set-mechanism.mt" as setMechanism
import "../sync/site.mt" as syncSite
import "./repair-sites.mt" as repairSites

// A mechanism group operator with the realised layer 2 (DESIGN.md M7): every call site into one provider component
// (DESIGN.md M5) gets one drawn mechanism (the scope and target draws of ../generic/group), per changed site the
// change and the layer-3 repair of a site (../sync/site.mt, needs the site's previous mechanism), then one layer-2
// repair of all changed sites (./repair-sites.mt). `changed`, `copies` (sites to or from a LocalCopy) are for the
// repair.
out changed: List<CallSite>
out copies: List<CallSite>

call providerSites() -> (sites: scope)
call drawMechanism(sites = scope) -> (target: drawn)
for x in scope do {
    if call setMechanism(site = x, target = drawn) -> (previous: before) then {
        call syncSite(site = x, previous = before)
        changed += x
        if (drawn is LocalCopy || before is LocalCopy) {
            copies += x
        }
    }
}
call repairSites(sites = changed, copies = copies.size() > 0)
