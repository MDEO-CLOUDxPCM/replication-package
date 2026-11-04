using "../../metamodel/architecture.mm"

// A removal of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19), whole-model;
// ./moves.mt and ./site.mt run it as it is.

// A writer's Notification without Deliveries goes.
for match {
    unDecisions: ArchitectureDecisions { }
    delete unNotification: Notification { }
    delete unDecisions.feedNotifications -- unNotification

    forbid delivers {
        unDelivery: Delivery { }
        unNotification.deliveries -- unDelivery
    }
} do {
}
