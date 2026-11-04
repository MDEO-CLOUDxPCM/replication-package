using "../../metamodel/architecture.mm"

// A removal of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19). Without input it
// covers the whole model (as ../sync-microservices.mt calls it); `udSite` pins the call site (the
// object of that name), so that ./site.mt repairs only there.
in udSite: CallSite?

// A copy that is not read gets no writes.
for match {
    udFeed: CopyFeed { }
    udSite: CallSite { }
    delete udDelivery: Delivery { }
    udFeed.site -- udSite
    delete udFeed.deliveries -- udDelivery

    forbid copied {
        udCopy: LocalCopy { }
        udSite.mechanism -- udCopy
    }
} do {
}
