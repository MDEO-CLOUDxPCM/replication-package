using "../../../metamodel/architecture.mm"

// The target of a mechanism group operator (DESIGN.md M2): the options that would change at least
// one site of `sites` (an allowed mechanism the site does not have now) are collected, and one of
// them is drawn uniformly (a single match with one free object: the engine's first match after its
// shuffle, DESIGN.md E3). An option is a Mechanism object; F's domain models share one object per
// kind (sync, async, cache, join, joinCache, copy), so there the draw is uniform over the kinds that
// would change something. Fails, before any change, when no site of `sites` can change. Changes
// nothing.
in sites: List<CallSite>
out target: Mechanism
out options: Set<Mechanism>

for x in sites do {
    for match {
        x { }
        dmOption: Mechanism { }
        x.allowed -- dmOption
        forbid current {
            x.mechanism -- dmOption
        }
        options += dmOption
    } do {
    }
}
match {
    dmDrawn: Mechanism { }
    where options.includes(dmDrawn)
}
target = dmDrawn
