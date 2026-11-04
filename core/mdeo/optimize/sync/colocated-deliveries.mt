using "../../metamodel/architecture.mm"

// A removal of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19), whole-model;
// ./moves.mt runs it as it is.

// A writer in the store's container sends nothing: there the copy is its own data.
for match {
    uwFeed: CopyFeed { }
    uwNotification: Notification { }
    delete uwDelivery: Delivery { }
    uwWriter: AbstractAction { }
    delete uwFeed.deliveries -- uwDelivery
    delete uwNotification.deliveries -- uwDelivery
    uwNotification.after -- uwWriter

    require colocated {
        uwSeff: ResourceDemandingSEFF { }
        uwComponent: BasicComponent { }
        uwOwner: AssemblyContext { }
        uwOwnerAllocation: AllocationContext { }
        uwConsumer: AssemblyContext { }
        uwConsumerAllocation: AllocationContext { }
        uwContainer: ResourceContainer { }
        uwSeff.steps -- uwWriter
        uwComponent.serviceEffectSpecifications -- uwSeff
        uwOwner.encapsulatedComponent -- uwComponent
        uwOwnerAllocation.assemblyContext -- uwOwner
        uwOwnerAllocation.resourceContainer -- uwContainer
        uwFeed.store -- uwConsumer
        uwConsumerAllocation.assemblyContext -- uwConsumer
        uwConsumerAllocation.resourceContainer -- uwContainer
    }
} do {
}
