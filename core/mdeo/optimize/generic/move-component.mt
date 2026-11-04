using "../../metamodel/architecture.mm"

// Move a movable component to another of its candidate containers (DESIGN.md §8). The component
// keeps exactly one container. The container's replicas and CPU limit then apply to it.

match {
    placement: Placement { }
    allocation: AllocationContext { }
    current: ResourceContainer { }
    target: ResourceContainer { }

    placement.allocation -- allocation
    placement.candidates -- target

    delete allocation.resourceContainer -- current
    create allocation.resourceContainer -- target
}
