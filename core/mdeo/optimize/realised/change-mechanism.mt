using "../../metamodel/architecture.mm"
import "../generic/change-mechanism.mt" as changeMechanism
import "../sync/site.mt" as syncSite
import "../../transform/repair/site-pinned.mt" as repairSitePinned
import "../../transform/repair/call-site.mt" as repairCallSite

// The MiSArch operator change-mechanism with the realised layer 2 (DESIGN.md B4, B4.10): the
// generic operator, the local layer-3 repair of the site it changed, then the layer-2 repair: of
// the site's call alone (pinned), or, when a LocalCopy is involved (layer 3 then changes
// redirects, copy stores, notifications and deliveries), of a mechanism with per-call sections.
// The whole repair of a mechanism (../../transform/repair/site.mt) remains for reference.
call changeMechanism() -> (changed: site, previous: before)
call syncSite(site = site, previous = before)
if (site.mechanism is LocalCopy || before is LocalCopy) {
    call repairSitePinned(site = site)
} else {
    call repairCallSite(site = site)
}
