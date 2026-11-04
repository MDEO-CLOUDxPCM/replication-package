using "../../metamodel/architecture.mm"

// An addition of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19). Without input it
// covers the whole model (as ../sync-microservices.mt and ./moves.mt call it); `adSite` pins the
// call site (the object of that name), so that ./site.mt repairs only there.
in adSite: CallSite?

// ... and sends every read copy it feeds in another container one message (a Delivery of the
// copy's write operation).
for match {
    adFeed: CopyFeed { }
    adSite: CallSite { }
    adCopy: LocalCopy { }
    adWriter: AbstractAction { }
    adStore: CopyStore { }
    adAssembly: AssemblyContext { }
    adWrite: OperationSignature { }
    adDecisions: ArchitectureDecisions { }
    adNotification: Notification { }
    adFeed.site -- adSite
    adSite.mechanism -- adCopy
    adFeed.writers -- adWriter
    adFeed.copyStore -- adStore
    adStore.assembly -- adAssembly
    adFeed.write -- adWrite
    adDecisions.feedNotifications -- adNotification
    adNotification.after -- adWriter

    // the writer sits in the store's container: the copy is its own data
    forbid colocated {
        adSeff: ResourceDemandingSEFF { }
        adComponent: BasicComponent { }
        adOwner: AssemblyContext { }
        adOwnerAllocation: AllocationContext { }
        adConsumer: AssemblyContext { }
        adConsumerAllocation: AllocationContext { }
        adContainer: ResourceContainer { }
        adSeff.steps -- adWriter
        adComponent.serviceEffectSpecifications -- adSeff
        adOwner.encapsulatedComponent -- adComponent
        adOwnerAllocation.assemblyContext -- adOwner
        adOwnerAllocation.resourceContainer -- adContainer
        adFeed.store -- adConsumer
        adConsumerAllocation.assemblyContext -- adConsumer
        adConsumerAllocation.resourceContainer -- adContainer
    }

    forbid delivered {
        adExisting: Delivery { }
        adFeed.deliveries -- adExisting
        adNotification.deliveries -- adExisting
    }

    create adDelivery: Delivery { }
    create adNotification.deliveries -- adDelivery
    create adDelivery.provider -- adAssembly
    create adDelivery.service -- adWrite
    create adFeed.deliveries -- adDelivery
} do {
}
