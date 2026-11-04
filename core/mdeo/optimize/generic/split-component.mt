using "../../metamodel/architecture.mm"

// Split a component off: move one movable component of a container that holds at least one
// other component into an empty candidate container.
// The realisation's derived elements (entity name "realised": colocations, middleware, derived
// connectors) are skipped (DESIGN.md B1.8, G9).

match {
    placement: Placement { }
    allocation: AllocationContext { }
    current: ResourceContainer { }
    target: ResourceContainer { }

    placement.allocation -- allocation
    placement.candidates -- target

    delete allocation.resourceContainer -- current
    create allocation.resourceContainer -- target

    require shared {
        neighbour: AllocationContext { }
        neighbour.resourceContainer -- current
        where neighbour.entityName == null || neighbour.entityName!! != "realised"
    }

    forbid occupied {
        resident: AllocationContext { }
        resident.resourceContainer -- target
        where resident.entityName == null || resident.entityName!! != "realised"
    }
}
