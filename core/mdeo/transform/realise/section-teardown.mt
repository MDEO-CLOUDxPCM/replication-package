using "../../metamodel/architecture.mm"
import "./teardown-calls.mt" as teardownCalls
import "./teardown-groups.mt" as teardownGroups
import "./teardown-workflows.mt" as teardownWorkflows
import "./teardown-notifications.mt" as teardownNotifications
import "./teardown-orphans.mt" as teardownOrphans

// The removals of the realisation after the plan and the stale blocks (DESIGN.md B3), each behind
// a cheap `if match` on what it would remove: structures of calls whose `built` differs from
// their `shape`, orchestrations of workflows no longer orchestrated, notifications without their
// Notification and calls of removed Deliveries.

if match {
    gtCall: RealisedCall { }
    where gtCall.built != gtCall.shape
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
