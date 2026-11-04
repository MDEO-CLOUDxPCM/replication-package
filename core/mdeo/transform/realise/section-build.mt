using "../../metamodel/architecture.mm"
import "./notifications.mt" as realiseNotifications
import "./roles.mt" as realiseRoles
import "./build.mt" as realiseBuild
import "./workflow.mt" as realiseWorkflows
import "./workflow-background.mt" as realiseWorkflowBackground
import "./deliveries.mt" as realiseDeliveries

// The additions of the realisation at calls and notifications (DESIGN.md B3), each behind a cheap
// `if match` on what it would add: notifications without their realisation, calls whose
// structure is still plain but should not be (roles, call sites, orchestrations), deliveries
// without their call; the background of orchestrations always (it depends on placement).

if match {
    gaNotification: Notification { }
    forbid realised {
        gaRealised: RealisedNotification { }
        gaRealised.notification -- gaNotification
    }
} then {
    call realiseNotifications()
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
