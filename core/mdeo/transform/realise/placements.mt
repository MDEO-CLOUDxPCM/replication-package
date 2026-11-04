using "../../metamodel/architecture.mm"

// The container each AllocationContext had when the realisation last saw it (RealisedPlacement,
// DESIGN.md B4.9): made for every context without one, kept up to date. A placement repair
// (../repair/placement.mt) does the same and marks what moved; a derived context gets its
// placement where it is made (./colocations.mt), which also removes the placements of removed
// contexts.

for match {
    rpRoot: Realisation { }
    rpContext: AllocationContext { }
    rpContainer: ResourceContainer { }
    rpContext.resourceContainer -- rpContainer
    forbid placed {
        rpExisting: RealisedPlacement { }
        rpExisting.allocation -- rpContext
    }
    create rpPlacement: RealisedPlacement { }
    create rpRoot.placements -- rpPlacement
    create rpPlacement.allocation -- rpContext
    create rpPlacement.container -- rpContainer
} do {
}

for match {
    ruPlacement: RealisedPlacement { }
    ruContext: AllocationContext { }
    ruOld: ResourceContainer { }
    ruNew: ResourceContainer { }
    ruPlacement.allocation -- ruContext
    ruContext.resourceContainer -- ruNew
    delete ruPlacement.container -- ruOld
    create ruPlacement.container -- ruNew
} do {
}
