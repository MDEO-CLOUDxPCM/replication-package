using "../../../metamodel/architecture.mm"

// The partners of `component` along Couplings of strength at least `theta` (DESIGN.md G8): movable
// components on `source` that may run on `destination`. Changes nothing.
in component: AllocationContext
in source: ResourceContainer
in destination: ResourceContainer
in theta: double
out found: List<AllocationContext>

// The partner's container and candidate are checked once it is bound (`require`): as links of the
// pattern the planner walked from the bound container to all its contexts and from the destination
// to all placements allowed there, and paired them (the class-average fan-out of a container looks
// below one; DESIGN.md S4). Same matches.
for match {
    component { }
    source { }
    destination { }
    componentPlacement: Placement { }
    coupling: Coupling { }
    otherPlacement: Placement { }
    other: AllocationContext { }
    componentPlacement.allocation -- component
    coupling.ends -- componentPlacement
    coupling.ends -- otherPlacement
    otherPlacement.allocation -- other
    where coupling.strength >= theta
    require located {
        otherPlacement.candidates -- destination
        other.resourceContainer -- source
    }
    found += other
} do {
}
