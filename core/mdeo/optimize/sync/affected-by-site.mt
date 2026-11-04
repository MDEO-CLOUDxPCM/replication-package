using "../../metamodel/architecture.mm"

// What a change of a call site's mechanism affects besides what is pinned at the site itself
// (DESIGN.md H19): the copy store of the site's CopyFeed (its assembly). A new layer-3 concept that
// depends on mechanisms must be added here or to ./site.mt; the check mode (ARCH_CHECK_SYNC) finds
// what is missing.
in site: CallSite
out stores: Set<CopyStore>

for match {
    site { }
    feed: CopyFeed { }
    store: CopyStore { }
    feed.site -- site
    feed.copyStore -- store
    stores += store
} do {
}
