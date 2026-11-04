using "../../metamodel/architecture.mm"

// A removal of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19). Without input it
// covers the whole model (as ../sync-microservices.mt calls it); `urSite` pins the call site (the
// object of that name), so that ./site.mt repairs only there.
in urSite: CallSite?

// A call that no longer reads its copy loses its Redirect.
for match {
    urFeed: CopyFeed { }
    urSite: CallSite { }
    delete urRedirect: Redirect { }
    urFeed.site -- urSite
    delete urFeed.redirect -- urRedirect

    forbid copied {
        urCopy: LocalCopy { }
        urSite.mechanism -- urCopy
    }
} do {
}
