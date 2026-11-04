using "../../metamodel/architecture.mm"
import "../pinned/teardown-calls.mt" as pinnedTeardownCalls
import "../realise/teardown-groups.mt" as teardownGroups
import "../pinned/roles.mt" as pinnedRealiseRoles
import "../pinned/build.mt" as pinnedRealiseBuild
import "../realise/workflow-background.mt" as realiseWorkflowBackground
import "../pinned/links-add.mt" as pinnedRealiseNewLinks
import "../pinned/blocks.mt" as pinnedAddBlocks

// A call whose plan changed (./call.mt), after its stale blocks went: its old structure taken
// apart (and a composer's group left empty), its new one built, an orchestration's background
// (the call may be a plan's first step), its middleware links, its blocks. Whole-model are only
// the empty groups and the background (one match each). Guards on the call are `if match` (an `if (rc.built != ...)` on the input
// did not see the plan's new values in F's models).
in rc: RealisedCall

if match {
    rc { }
    where rc.built != rc.shape
} then {
    call pinnedTeardownCalls(pc = rc)
    call teardownGroups()
}
if match {
    rc { }
    where rc.built == "plain"
    where rc.shape != "plain" && rc.shape != "gone"
} then {
    call pinnedRealiseRoles(pc = rc)
    call pinnedRealiseBuild(pc = rc)
}
call realiseWorkflowBackground()
call pinnedRealiseNewLinks(pc = rc)
call pinnedAddBlocks(pc = rc)
