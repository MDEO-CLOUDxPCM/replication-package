using "../../metamodel/architecture.mm"

// An addition of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19). Without input it
// covers the whole model (as ../sync-microservices.mt calls it); `aaStore` pins the copy store (the
// object of that name), so that ./site.mt repairs only there.
in aaStore: CopyStore?

// A copy store with a read copy sits with its consumer.
for match {
    aaStore: CopyStore { }
    aaComponent: BasicComponent { }
    aaConsumer: AssemblyContext { }
    aaSystem: System { }
    aaDecisions: ArchitectureDecisions { }
    aaStore.component -- aaComponent
    aaStore.store -- aaConsumer

    require read {
        aaFeed: CopyFeed { }
        aaSite: CallSite { }
        aaCopy: LocalCopy { }
        aaFeed.copyStore -- aaStore
        aaFeed.site -- aaSite
        aaSite.mechanism -- aaCopy
    }

    forbid placed {
        aaExisting: AssemblyContext { }
        aaStore.assembly -- aaExisting
    }

    create aaAssembly: AssemblyContext {
        entityName = "Assembly_" + aaComponent.entityName
    }
    create aaColocation: Colocation { }
    create aaSystem.assemblyContexts -- aaAssembly
    create aaAssembly.encapsulatedComponent -- aaComponent
    create aaDecisions.colocations -- aaColocation
    create aaColocation.assembly -- aaAssembly
    create aaColocation.host -- aaConsumer
    create aaStore.assembly -- aaAssembly
    create aaStore.colocation -- aaColocation
} do {
}
