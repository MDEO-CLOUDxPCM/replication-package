using "../../metamodel/architecture.mm"
import "../realise/colocations.mt" as realiseColocations
import "./plan-moved.mt" as planPlacementDirty
import "./plan-sites-dirty.mt" as planSitesDirty
import "./clear-marks.mt" as clearMarks
import "./stale-blocks.mt" as repairStaleBlocks
import "./section-teardown.mt" as repairTeardownSection
import "./section-build.mt" as repairBuildSection
import "../realise/work.mt" as realiseWork
import "../realise/rates.mt" as realiseRates
import "../realise/links-add.mt" as realiseNewLinks
import "../realise/publish.mt" as realisePublish
import "./add-blocks.mt" as repairAddBlocks
import "../realise/links-teardown.mt" as teardownUnused

// The layer-2 repair after `site`'s mechanism changed to or from a LocalCopy (DESIGN.md B4), after
// the layer-3 repair (which adds or removes the site's Redirect, copy-store assemblies with their
// Colocations, Notifications and Deliveries): the parts of the whole realisation that depend on
// mechanisms, in its order. The plan changes only for the site's call (marked dirty, planned
// through the dirty-anchored plan, B4.10) and for deliveries whose Delivery went (the whole
// `gone` statement; new delivery calls are made planned); blocks, teardown and build are pinned to
// the calls that need them (DESIGN.md B4.5). Placement is unchanged, so no block becomes local.
in site: CallSite

call realiseColocations()
for match {
    spRoot: Realisation { }
    spCall: RealisedCall { }
    site { }
    spCall.site -- site
    forbid marked {
        spRoot.dirty -- spCall
    }
    create spRoot.dirty -- spCall
} do {
}
call planPlacementDirty()
call planSitesDirty()
call repairStaleBlocks()
call repairTeardownSection()
call repairBuildSection()
call realiseWork()
call realiseRates()
call teardownUnused()
call realiseNewLinks()
call realisePublish()
call repairAddBlocks()
call clearMarks()
