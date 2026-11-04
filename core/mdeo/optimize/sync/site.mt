using "../../metamodel/architecture.mm"
import "./affected-by-site.mt" as affectedBySite
import "./unread-redirects.mt" as removeUnreadRedirects
import "./unread-deliveries.mt" as removeUnreadDeliveries
import "./empty-publications.mt" as removeEmptyPublications
import "./unread-store-assemblies.mt" as removeUnreadStoreAssemblies
import "./store-assemblies.mt" as addStoreAssemblies
import "./redirects.mt" as addRedirects
import "./publications.mt" as addPublications
import "./deliveries.mt" as addDeliveries

// The local layer-3 repair after a call site's mechanism changed from `previous` (DESIGN.md H19):
// the statements of the whole-model sync (../sync-microservices.mt) that depend on mechanisms, in
// its order, pinned to the site or to what ./affected-by-site.mt names. Layer 3 depends on a
// mechanism only through whether it is a LocalCopy: a site that now reads its copy needs only the
// additions, one that no longer does only the removals, any other change nothing. On a model that
// was consistent before, it changes exactly what the whole-model sync would.
in site: CallSite
in previous: Mechanism

if (site.mechanism is LocalCopy) {
    call affectedBySite(site = site) -> (stores: readStores)
    for s1 in readStores do {
        call addStoreAssemblies(aaStore = s1)
    }
    call addRedirects(arSite = site)
    // whole-model: one match, and the writers' Notifications are made in the whole sync's order
    call addPublications()
    call addDeliveries(adSite = site)
} else if (previous is LocalCopy) {
    call removeUnreadRedirects(urSite = site)
    call removeUnreadDeliveries(udSite = site)
    // a writer's last Delivery may have gone: whole-model, one match is cheaper than one per writer
    call removeEmptyPublications()
    call affectedBySite(site = site) -> (stores: unreadStores)
    for s2 in unreadStores do {
        call removeUnreadStoreAssemblies(uaStore = s2)
    }
}
