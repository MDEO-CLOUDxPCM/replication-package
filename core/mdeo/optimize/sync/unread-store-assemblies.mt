using "../../metamodel/architecture.mm"

// A removal of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19). Without input it
// covers the whole model (as ../sync-microservices.mt calls it); `uaStore` pins the copy store (the
// object of that name), so that ./site.mt repairs only there.
in uaStore: CopyStore?

// A copy store whose copies are all unread leaves the system.
for match {
    uaStore: CopyStore { }
    delete uaAssembly: AssemblyContext { }
    delete uaColocation: Colocation { }
    delete uaStore.assembly -- uaAssembly
    delete uaStore.colocation -- uaColocation

    forbid read {
        uaFeed: CopyFeed { }
        uaSite: CallSite { }
        uaCopy: LocalCopy { }
        uaFeed.copyStore -- uaStore
        uaFeed.site -- uaSite
        uaSite.mechanism -- uaCopy
    }
} do {
}
