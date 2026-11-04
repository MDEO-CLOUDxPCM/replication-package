using "../../metamodel/architecture.mm"
import "./plan-moved.mt" as planPlacementDirty
import "./plan-sites-dirty.mt" as planSitesDirty
import "./call.mt" as repairCall
import "./clear-marks.mt" as clearMarks
import "../realise/links-teardown.mt" as teardownUnused

// The pinned layer-2 repair after `site`'s mechanism changed (DESIGN.md B4.5, B4.10): its calls
// are marked dirty and planned through the dirty-anchored plan (declared objects: a pinned
// `pc { shape = .. }` writes the wrong property on domain.mm), then each is repaired
// (./call.mt). Not for a change to or from a LocalCopy (./site-pinned.mt).
in site: CallSite

for match {
    rmRoot: Realisation { }
    rmCall: RealisedCall { }
    site { }
    rmCall.site -- site
    forbid marked {
        rmRoot.dirty -- rmCall
    }
    create rmRoot.dirty -- rmCall
} do {
}
call planPlacementDirty()
call planSitesDirty()
for match {
    rcRoot: Realisation { }
    rcCall: RealisedCall { }
    rcRoot.dirty -- rcCall
} do {
    call repairCall(rc = rcCall)
}
call teardownUnused()
call clearMarks()
