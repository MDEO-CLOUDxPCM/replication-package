using "../../metamodel/architecture.mm"

// Consolidate two servers that components reach directly (RemoteCalls.direct, such as database
// servers): every movable component of `gone` that may run on `keep` moves there, in one step.
// `keep` must already host a component. Unlike merge-containers, the two need not call each
// other: a direct container gets no middleware and its components count for no modularity
// (DESIGN.md D32), so merging two of them changes only contention and cost (D47).
// The realisation's derived elements (entity name "realised": colocations, middleware, derived
// connectors) are skipped (DESIGN.md B1.8, G9).

match {
    remote: RemoteCalls { }
    gone: ResourceContainer { }
    keep: ResourceContainer { }

    remote.direct -- gone
    remote.direct -- keep

    require used {
        resident: AllocationContext { }
        resident.resourceContainer -- keep
        where resident.entityName == null || resident.entityName!! != "realised"
    }

    require movable {
        movablePlacement: Placement { }
        movableAllocation: AllocationContext { }
        movablePlacement.allocation -- movableAllocation
        movablePlacement.candidates -- keep
        movableAllocation.resourceContainer -- gone
    }
}

for match {
    gone { }
    keep { }
    placement: Placement { }
    moved: AllocationContext { }
    placement.allocation -- moved
    placement.candidates -- keep
    delete moved.resourceContainer -- gone
} do {
    match {
        keep { }
        moved { }
        create moved.resourceContainer -- keep
    }
}
