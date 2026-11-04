using "../../metamodel/architecture.mm"
import "./generic/differing-providers.mt" as differingProviders
import "./generic/provider-sites-of.mt" as providerSitesOf
import "./generic/donor-mechanism.mt" as donorMechanism
import "../generic/group/set-mechanism.mt" as setMechanism
import "../sync/site.mt" as syncSite
import "../domain/repair-sites.mt" as repairSites

// Crossover take-mechanisms (DESIGN.md AC3): for `providers` provider components (default one; a
// provider is a domain class in F's models) among those where the donor differs, every call site
// into them takes the donor's mechanism where the site allows it (./generic/donor-mechanism.mt).
// Repaired as the mechanism group operators (../domain/change-class-mechanisms.mt, DESIGN.md M4):
// per changed site the layer-3 site repair, then one layer-2 repair of all changed sites. Fails,
// before any change, when the donor and the model agree on every site they can agree on.
// `changed`, `copies` (sites to or from a LocalCopy) are for the repair.
in donor: model
in providers: int = 1
out changed: List<CallSite>
out copies: List<CallSite>

call differingProviders(donor = donor, count = providers) -> (providers: chosen)
call providerSitesOf(providers = chosen) -> (sites: scope)
for x in scope do {
    if call donorMechanism(donor = donor, site = x) -> (target: wanted) then {
        call setMechanism(site = x, target = wanted) -> (previous: before)
        call syncSite(site = x, previous = before)
        changed += x
        if (wanted is LocalCopy || before is LocalCopy) {
            copies += x
        }
    }
}
call repairSites(sites = changed, copies = copies.size() > 0)
