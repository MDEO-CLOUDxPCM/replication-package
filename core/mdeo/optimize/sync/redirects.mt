using "../../metamodel/architecture.mm"

// An addition of the layer-3 sync (../sync-microservices.mt, DESIGN.md H14, H19). Without input it
// covers the whole model (as ../sync-microservices.mt calls it); `arSite` pins the call site (the
// object of that name), so that ./site.mt repairs only there.
in arSite: CallSite?

// A call that reads its copy is redirected to the copy's read operation.
for match {
    arFeed: CopyFeed { }
    arSite: CallSite { }
    arCopy: LocalCopy { }
    arCall: ExternalCallAction { }
    arStore: CopyStore { }
    arAssembly: AssemblyContext { }
    arRead: OperationSignature { }
    arDecisions: ArchitectureDecisions { }
    arFeed.site -- arSite
    arSite.mechanism -- arCopy
    arSite.`call` -- arCall
    arFeed.copyStore -- arStore
    arStore.assembly -- arAssembly
    arFeed.read -- arRead

    forbid redirected {
        arExisting: Redirect { }
        arFeed.redirect -- arExisting
    }

    create arRedirect: Redirect { }
    create arDecisions.redirects -- arRedirect
    create arRedirect.`call` -- arCall
    create arRedirect.provider -- arAssembly
    create arRedirect.service -- arRead
    create arFeed.redirect -- arRedirect
} do {
}
