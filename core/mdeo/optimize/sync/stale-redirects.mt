using "../../metamodel/architecture.mm"

// A removal of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19), whole-model.

// A Redirect to anything but the copy store's assembly is stale.
for match {
    usFeed: CopyFeed { }
    delete usRedirect: Redirect { }
    delete usFeed.redirect -- usRedirect

    forbid current {
        usStore: CopyStore { }
        usAssembly: AssemblyContext { }
        usRead: OperationSignature { }
        usFeed.copyStore -- usStore
        usStore.assembly -- usAssembly
        usRedirect.provider -- usAssembly
        usFeed.read -- usRead
        usRedirect.service -- usRead
    }
} do {
}
