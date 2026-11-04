using "../../../metamodel/architecture.mm"

// The coupling threshold of one group move (DESIGN.md G8). Without Couplings in the model: theta =
// -1 (regions grow along assembly connectors) and usable. With Couplings: one coupling of `seed` to a
// movable component on `source` that may run on `destination` is drawn uniformly (a single match,
// DESIGN.md E3) and theta is its strength; the region then follows only couplings at least that
// strong, so the seed's partner of rank r (by strength, among its k eligible couplings) is followed
// with probability r/k. Not usable when the seed has no eligible coupling (theta then exceeds every
// strength). Changes nothing.
in seed: AllocationContext
in source: ResourceContainer
in destination: ResourceContainer
out theta: double
out usable: boolean

theta = -1.0
usable = true
if match {
    anyCoupling: Coupling { }
} then {
    // no eligible coupling of the seed: not usable, and a region grown anyway stays the seed alone
    theta = 1000000000000.0
    usable = false
    if match {
        seed { }
        source { }
        destination { }
        seedPlacement: Placement { }
        drawnCoupling: Coupling { }
        partnerPlacement: Placement { }
        partner: AllocationContext { }
        seedPlacement.allocation -- seed
        drawnCoupling.ends -- seedPlacement
        drawnCoupling.ends -- partnerPlacement
        partnerPlacement.allocation -- partner
        partnerPlacement.candidates -- destination
        partner.resourceContainer -- source
    } then {
        theta = drawnCoupling.strength
        usable = true
    }
}
