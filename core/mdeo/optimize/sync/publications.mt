using "../../metamodel/architecture.mm"

// An addition of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19), whole-model;
// ./moves.mt and ./site.mt run it as it is (one match; per writer it would take one match each).

// A write that feeds a read copy in another container is published (one Notification per
// writer). Found from the feeds (few) rather than from every action; `while`, since several feeds
// can share a writer.
while match {
    anFeed: CopyFeed { }
    anWriter: AbstractAction { }
    anDecisions: ArchitectureDecisions { }
    anSite: CallSite { }
    anCopy: LocalCopy { }
    anSeff: ResourceDemandingSEFF { }
    anComponent: BasicComponent { }
    anOwner: AssemblyContext { }
    anOwnerAllocation: AllocationContext { }
    anOwnerContainer: ResourceContainer { }
    anConsumer: AssemblyContext { }
    anConsumerAllocation: AllocationContext { }
    anConsumerContainer: ResourceContainer { }
    anFeed.writers -- anWriter
    anFeed.site -- anSite
    anSite.mechanism -- anCopy
    anSeff.steps -- anWriter
    anComponent.serviceEffectSpecifications -- anSeff
    anOwner.encapsulatedComponent -- anComponent
    anOwnerAllocation.assemblyContext -- anOwner
    anOwnerAllocation.resourceContainer -- anOwnerContainer
    anFeed.store -- anConsumer
    anConsumerAllocation.assemblyContext -- anConsumer
    anConsumerAllocation.resourceContainer -- anConsumerContainer

    forbid published {
        anExisting: Notification { }
        anDecisions.feedNotifications -- anExisting
        anExisting.after -- anWriter
    }

    create anNotification: Notification {
        published = true
    }
    create anDecisions.notifications -- anNotification
    create anDecisions.feedNotifications -- anNotification
    create anNotification.after -- anWriter
} do {
}
