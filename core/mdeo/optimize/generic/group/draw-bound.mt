using "../../../metamodel/architecture.mm"

// A random group size for the group operators (DESIGN.md G3). The movable components of `container`
// (those with a Placement; derived allocations of the realisation have none) are listed, and one of
// them is drawn uniformly (a single match with one free object: the engine's first match after its
// shuffle, DESIGN.md E3). `bound` is the drawn component's position in the list, so it is uniform on
// 1..count whatever the list's order. `withSeed = false` leaves `seed` out of the list (count = the
// others), `withSeed = true` counts it. Changes nothing; an empty list gives count = bound = 0.
in container: ResourceContainer
in seed: AllocationContext
in withSeed: boolean = false
out bound: int
out count: int
out residents: List<AllocationContext>
out passed: boolean

bound = 0
passed = false
if (withSeed) {
    for match {
        container { }
        resident: AllocationContext { }
        residentPlacement: Placement { }
        residentPlacement.allocation -- resident
        resident.resourceContainer -- container
    } do {
        residents += resident
    }
    match {
        container { }
        drawn: AllocationContext { }
        drawnPlacement: Placement { }
        drawnPlacement.allocation -- drawn
        drawn.resourceContainer -- container
    }
    for x in residents do {
        if (!passed) {
            bound = bound + 1
        }
        if (x == drawn) {
            passed = true
        }
    }
} else {
    for match {
        container { }
        seed { }
        other: AllocationContext { }
        otherPlacement: Placement { }
        otherPlacement.allocation -- other
        other.resourceContainer -- container
        // a referenced input is not excluded by the injective matching of the pattern's own objects
        where other != seed
    } do {
        residents += other
    }
    if (residents.size() > 0) {
        match {
            container { }
            seed { }
            drawnOther: AllocationContext { }
            drawnOtherPlacement: Placement { }
            drawnOtherPlacement.allocation -- drawnOther
            drawnOther.resourceContainer -- container
            where drawnOther != seed
        }
        for y in residents do {
            if (!passed) {
                bound = bound + 1
            }
            if (y == drawnOther) {
                passed = true
            }
        }
    }
}
count = residents.size()
