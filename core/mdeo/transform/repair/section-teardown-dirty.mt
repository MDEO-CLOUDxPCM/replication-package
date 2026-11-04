using "../../metamodel/architecture.mm"
import "../pinned/teardown-calls.mt" as pinnedTeardownCalls
import "../realise/teardown-calls.mt" as teardownCalls
import "../realise/teardown-groups.mt" as teardownGroups
import "../realise/teardown-notifications.mt" as teardownNotifications

// ./section-teardown.mt with the per-call part and its guard for the calls marked dirty only
// (placement repair, DESIGN.md B4.9): only a re-planned call (dirty) can differ from its plan. A
// move changes no coordination and removes no assembly: no workflow teardown, no orphans.

for match {
    dtRoot: Realisation { }
    dtRoot.dirty -- dtCall
    dtCall: RealisedCall {
        built != "plain"
    }
    where dtCall.built != dtCall.shape
} do {
    call pinnedTeardownCalls(pc = dtCall)
}

call teardownGroups()

if match {
    gtRoot: Realisation { }
    gtRoot.dirty -- gtCall
    gtCall: RealisedCall { }
    where gtCall.built != gtCall.shape && (gtCall.built != "plain" || gtCall.shape != "gone")
} then {
    call teardownCalls()
    call teardownGroups()
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

