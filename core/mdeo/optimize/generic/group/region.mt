using "../../../metamodel/architecture.mm"
import "./neighbours.mt" as neighbours
import "./neighbours-coupled.mt" as neighboursCoupled

// A connected region of `source` grown from `seed` (DESIGN.md G2), as random growth from a seed
// (Eden growth): `frontier` holds the coupled partners of the members (movable, on `source`, allowed
// on `destination`): along assembly connectors (group/neighbours.mt) when `theta` < 0, else along
// Couplings at least `theta` strong (group/neighbours-coupled.mt, DESIGN.md G8); each step adds one component drawn uniformly from the
// frontier minus the members (a single match with one free object, DESIGN.md E3), until `bound`
// members or an empty frontier. Changes nothing (the caller moves the members) and never fails.
in seed: AllocationContext
in source: ResourceContainer
in destination: ResourceContainer
in bound: int
in theta: double = -1.0
out members: List<AllocationContext>
out frontier: List<AllocationContext>
out growing: boolean

members += seed
if (theta < 0.0) {
    call neighbours(component = seed, source = source, destination = destination) -> (found: first)
    frontier += first
} else {
    call neighboursCoupled(component = seed, source = source, destination = destination, theta = theta) -> (found: firstCoupled)
    frontier += firstCoupled
}
growing = true
while (growing && members.size() < bound) {
    if match {
        source { }
        drawn: AllocationContext { }
        drawn.resourceContainer -- source
        // two clauses: two collection lambdas in one expression fail in the engine (DESIGN.md G9)
        where frontier.exists((f) => f == drawn)
        where !members.exists((m) => m == drawn)
    } then {
        members += drawn
        if (theta < 0.0) {
            call neighbours(component = drawn, source = source, destination = destination) -> (found: more)
            frontier += more
        } else {
            call neighboursCoupled(component = drawn, source = source, destination = destination, theta = theta) -> (found: moreCoupled)
            frontier += moreCoupled
        }
    } else {
        growing = false
    }
}
