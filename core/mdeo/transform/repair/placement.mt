using "../../metamodel/architecture.mm"
import "./mark-moved.mt" as markMoved
import "./plan-moved.mt" as planPlacementDirty
import "./stale-blocks-dirty.mt" as repairStaleBlocksDirty
import "./section-teardown-dirty.mt" as repairTeardownDirty
import "./section-build-dirty.mt" as repairBuildDirty
import "./rates-moved.mt" as realiseRatesMoved
import "./links-moved.mt" as realiseLinksMoved
import "../realise/publish.mt" as realisePublish
import "./add-blocks-dirty.mt" as repairAddBlocksDirty
import "./clear-marks.mt" as clearMarks
import "../realise/links-teardown.mt" as teardownUnused

// The layer-2 repair after a change of placement (DESIGN.md B4, B4.9), after the layer-3 repair:
// the parts of the whole realisation (../realise.mt) that depend on placement, in its order.
// Placement decides whether a call is remote (middleware blocks, links), whether a composed call
// is composed, where a colocated assembly sits, which rate a derived demand has, whether an
// orchestration runs in the background, and through layer 3 which notifications and deliveries
// exist. Not: the fixed parts, the plan of mechanisms and coordination, Work (store assemblies
// change with mechanisms only), deployables.
// What moved is found in one scan of the RealisedPlacements (./mark-moved.mt): the moved contexts
// and the calls with an end in one are marked, and plan, block removal, teardown, build, rates,
// links and blocks look only at them (the marks go at the end).

call markMoved()
call planPlacementDirty()
call repairStaleBlocksDirty()
call repairTeardownDirty()
call repairBuildDirty()
call realiseRatesMoved()
call teardownUnused()
call realiseLinksMoved()
call realisePublish()
call repairAddBlocksDirty()
call clearMarks()
