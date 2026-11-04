using "../../metamodel/architecture.mm"
import "../realise/notifications.mt" as realiseNotifications
import "../pinned/roles.mt" as pinnedRealiseRoles
import "../pinned/build.mt" as pinnedRealiseBuild
import "../realise/roles.mt" as realiseRoles
import "../realise/build.mt" as realiseBuild
import "../realise/workflow.mt" as realiseWorkflows
import "../realise/workflow-background.mt" as realiseWorkflowBackground
import "../realise/deliveries.mt" as realiseDeliveries

// The additions in a repair (DESIGN.md B4.5): ../realise/section-build.mt with the calls' roles
// and structures pinned to each call still plain but planned otherwise (not steps: an
// orchestration is built per workflow), then the whole-model statements behind the same guard
// for what is left (orchestrations).

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
    dbCall: RealisedCall {
        built == "plain"
    }
    where dbCall.shape != "plain" && dbCall.shape != "gone" && dbCall.shape != "step"
} do {
    call pinnedRealiseRoles(pc = dbCall)
    call pinnedRealiseBuild(pc = dbCall)
}
if match {
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
