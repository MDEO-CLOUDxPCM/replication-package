using "../../metamodel/architecture.mm"
import "../pinned/teardown-calls.mt" as pinnedTeardownCalls
import "../realise/teardown-calls.mt" as teardownCalls
import "../realise/teardown-groups.mt" as teardownGroups
import "../realise/teardown-workflows.mt" as teardownWorkflows
import "../realise/teardown-notifications.mt" as teardownNotifications
import "../realise/teardown-orphans.mt" as teardownOrphans

// The removals in a repair (DESIGN.md B4.5): ../realise/section-teardown.mt with the calls' part
// pinned to each call whose structure differs from its plan (a plain one has none to take apart;
// a gone one is deleted with its notification's part below), then the whole-model statements
// behind the same guard for what the pinned ones could not do.

for match {
    dtCall: RealisedCall {
        built != "plain"
    }
    where dtCall.built != dtCall.shape
} do {
    call pinnedTeardownCalls(pc = dtCall)
}
call teardownGroups()
if match {
    gtCall: RealisedCall { }
    where gtCall.built != gtCall.shape && (gtCall.built != "plain" || gtCall.shape != "gone")
} then {
    call teardownCalls()
    call teardownGroups()
}
if match {
    gwRealised: RealisedWorkflow { }
    gwPlan: WorkflowPlan { }
    gwWorkflow: Workflow { }
    gwRealised.plan -- gwPlan
    gwPlan.workflow -- gwWorkflow
    forbid orchestrated {
        gwStyle: Orchestrated { }
        gwWorkflow.style -- gwStyle
    }
} then {
    call teardownWorkflows()
}
if match {
    gnRealised: RealisedNotification { }
    forbid notifying {
        gnNotification: Notification { }
        gnRealised.notification -- gnNotification
    }
} then {
    call teardownNotifications()
} else {
    if match {
        ggCall: RealisedCall {
            shape == "gone"
        }
    } then {
        call teardownNotifications()
    }
}
call teardownOrphans()
