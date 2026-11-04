using "../../metamodel/architecture.mm"
import "../../transform/realise/colocations.mt" as realiseColocations
import "../../transform/repair/plan-moved.mt" as planPlacementDirty
import "../../transform/repair/plan-sites-dirty.mt" as planSitesDirty
import "../../transform/repair/call.mt" as repairCall
import "../../transform/repair/clear-marks.mt" as clearMarks
import "../../transform/repair/stale-blocks.mt" as repairStaleBlocks
import "../../transform/repair/section-teardown.mt" as repairTeardownSection
import "../../transform/repair/section-build.mt" as repairBuildSection
import "../../transform/realise/work.mt" as realiseWork
import "../../transform/realise/rates.mt" as realiseRates
import "../../transform/realise/links-add.mt" as realiseNewLinks
import "../../transform/realise/publish.mt" as realisePublish
import "../../transform/repair/add-blocks.mt" as repairAddBlocks
import "../../transform/realise/links-teardown.mt" as teardownUnused

// The layer-2 repair after the mechanisms of several call sites changed at once (DESIGN.md M7), after
// their layer-3 repair: B's pinned repairs of one site (../../transform/repair/call-site.mt,
// site-pinned.mt) for a list. The calls of every site are marked dirty and planned once through the
// dirty-anchored plan; without a LocalCopy involved (`copies` false) each dirty call is repaired
// (repair/call.mt), with one the per-call sections of site-pinned.mt run once for all of them.
in sites: List<CallSite>
in copies: boolean

if (copies) {
    call realiseColocations()
}
for x in sites do {
    for match {
        rsRoot: Realisation { }
        rsCall: RealisedCall { }
        x { }
        rsCall.site -- x
        forbid marked {
            rsRoot.dirty -- rsCall
        }
        create rsRoot.dirty -- rsCall
    } do {
    }
}
call planPlacementDirty()
call planSitesDirty()
if (copies) {
    call repairStaleBlocks()
    call repairTeardownSection()
    call repairBuildSection()
    call realiseWork()
    call realiseRates()
    call realiseNewLinks()
    call realisePublish()
    call repairAddBlocks()
} else {
    for match {
        rdRoot: Realisation { }
        rdCall: RealisedCall { }
        rdRoot.dirty -- rdCall
    } do {
        call repairCall(rc = rdCall)
    }
}
call teardownUnused()
call clearMarks()
