using "../../metamodel/architecture.mm"
import "../realise/notifications.mt" as realiseNotifications
import "../pinned/roles.mt" as pinnedRealiseRoles
import "../pinned/build.mt" as pinnedRealiseBuild
import "../realise/roles.mt" as realiseRoles
import "../realise/build.mt" as realiseBuild
import "../realise/workflow.mt" as realiseWorkflows
import "../realise/workflow-background.mt" as realiseWorkflowBackground
import "../realise/deliveries.mt" as realiseDeliveries
import "./mark-dirty.mt" as markDirty

// ./section-build.mt with the per-call part and its guard for the calls marked dirty only
// (placement repair, DESIGN.md B4.9); the calls it makes (deliveries: their owner or copy store
// moved) are marked at the end.

if match {
    gaNotification: Notification { }
    forbid realised {
        gaRealised: RealisedNotification { }
        gaRealised.notification -- gaNotification
    }
} then {
    call realiseNotifications()
}

for match {
    dbRoot: Realisation { }
    dbRoot.dirty -- dbCall
    dbCall: RealisedCall {
        built == "plain"
    }
    where dbCall.shape != "plain" && dbCall.shape != "gone" && dbCall.shape != "step"
} do {
    call pinnedRealiseRoles(pc = dbCall)
    call pinnedRealiseBuild(pc = dbCall)
}

if match {
    gbRoot: Realisation { }
    gbRoot.dirty -- gbCall
    gbCall: RealisedCall {
        built == "plain"
    }
    where gbCall.shape != "plain" && gbCall.shape != "gone"
} then {
    call realiseRoles()
    call realiseBuild()
    call realiseWorkflows()
}

call realiseWorkflowBackground()

if match {
    gdRealised: RealisedNotification { }
    gdNotification: Notification { }
    gdDelivery: Delivery { }
    gdRealised.notification -- gdNotification
    gdNotification.deliveries -- gdDelivery
    forbid realised {
        gdCall: RealisedCall { }
        gdCall.delivery -- gdDelivery
    }
} then {
    call realiseDeliveries()
}
call markDirty()
