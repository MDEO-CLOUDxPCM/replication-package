using "../../metamodel/architecture.mm"

// A removal of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19), whole-model.

// A Delivery to anything but the copy store's assembly is stale.
for match {
    uxFeed: CopyFeed { }
    delete uxDelivery: Delivery { }
    delete uxFeed.deliveries -- uxDelivery

    forbid current {
        uxStore: CopyStore { }
        uxAssembly: AssemblyContext { }
        uxWrite: OperationSignature { }
        uxFeed.copyStore -- uxStore
        uxStore.assembly -- uxAssembly
        uxDelivery.provider -- uxAssembly
        uxFeed.write -- uxWrite
        uxDelivery.service -- uxWrite
    }
} do {
}
