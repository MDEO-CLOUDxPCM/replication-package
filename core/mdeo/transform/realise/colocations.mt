using "../../metamodel/architecture.mm"

// Colocations (DESIGN.md B1.2): every Colocation's assembly gets a derived AllocationContext
// (entity name "realised") in the container of its host, which follows the host. Removal first.
// A new one gets its RealisedPlacement; the placement of a removed one goes.

for match {
    delete crAllocation: RealisedAllocation { }
    delete crContext: AllocationContext { }
    delete crAllocation.allocation -- crContext
    forbid colocated {
        crColocation: Colocation { }
        crAllocation.colocation -- crColocation
    }
} do {
}

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
    caRoot: Realisation { }
    caAllocationRoot: Allocation { }
    caColocation: Colocation { }
    caAssembly: AssemblyContext { }
    caHost: AssemblyContext { }
    caHostContext: AllocationContext { }
    caContainer: ResourceContainer { }
    caColocation.assembly -- caAssembly
    caColocation.host -- caHost
    caHostContext.assemblyContext -- caHost
    caHostContext.resourceContainer -- caContainer
    forbid done {
        caExisting: RealisedAllocation { }
        caExisting.colocation -- caColocation
    }
    create caContext: AllocationContext {
        entityName = "realised"
    }
    create caAllocation: RealisedAllocation { }
    create caAllocationRoot.allocationContexts -- caContext
    create caContext.assemblyContext -- caAssembly
    create caContext.resourceContainer -- caContainer
    create caRoot.allocations -- caAllocation
    create caAllocation.allocation -- caContext
    create caAllocation.colocation -- caColocation
    create caPlacement: RealisedPlacement { }
    create caRoot.placements -- caPlacement
    create caPlacement.allocation -- caContext
    create caPlacement.container -- caContainer
} do {
}

// A placement (RealisedPlacement, ./placements.mt) whose context was removed goes.
for match {
    coRoot: Realisation { }
    delete coPlacement: RealisedPlacement { }
    coContainer: ResourceContainer { }
    delete coRoot.placements -- coPlacement
    delete coPlacement.container -- coContainer
    forbid placed {
        coContext: AllocationContext { }
        coPlacement.allocation -- coContext
    }
} do {
}
