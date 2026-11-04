using "../../metamodel/architecture.mm"
import "./mark-dirty.mt" as markDirty

// The start of a placement repair (DESIGN.md B4.9): colocated contexts follow their host; each AllocationContext whose container differs
// from its RealisedPlacement's is marked moved (Realisation.moved) and its placement updated; a
// context without a placement (a model realised before the trace) gets one and counts as moved.
// Then the calls with an end in a moved context are marked (./mark-dirty.mt).

// Colocated contexts follow their host (as ../realise/colocations.mt; a move adds or removes no
// Colocation, so its other statements are not needed here).
for match {
    cfAllocation: RealisedAllocation { }
    cfColocation: Colocation { }
    cfContext: AllocationContext { }
    cfHost: AssemblyContext { }
    cfHostContext: AllocationContext { }
    cfOld: ResourceContainer { }
    cfNew: ResourceContainer { }
    cfAllocation.allocation -- cfContext
    cfAllocation.colocation -- cfColocation
    cfColocation.host -- cfHost
    cfHostContext.assemblyContext -- cfHost
    cfHostContext.resourceContainer -- cfNew
    delete cfContext.resourceContainer -- cfOld
    create cfContext.resourceContainer -- cfNew
} do {
}

for match {
    nmRoot: Realisation { }
    nmContext: AllocationContext { }
    nmContainer: ResourceContainer { }
    nmContext.resourceContainer -- nmContainer
    forbid placed {
        nmExisting: RealisedPlacement { }
        nmExisting.allocation -- nmContext
    }
    create nmPlacement: RealisedPlacement { }
    create nmRoot.placements -- nmPlacement
    create nmPlacement.allocation -- nmContext
    create nmPlacement.container -- nmContainer
    create nmRoot.moved -- nmPlacement
} do {
}

for match {
    muRoot: Realisation { }
    muPlacement: RealisedPlacement { }
    muContext: AllocationContext { }
    muOld: ResourceContainer { }
    muNew: ResourceContainer { }
    muPlacement.allocation -- muContext
    muContext.resourceContainer -- muNew
    delete muPlacement.container -- muOld
    create muPlacement.container -- muNew
    create muRoot.moved -- muPlacement
} do {
}

call markDirty()
