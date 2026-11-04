using "../../metamodel/architecture.mm"
import "./group/draw-bound.mt" as drawBound
import "./group/region.mt" as region
import "./group/draw-threshold.mt" as drawThreshold
import "./group/move-all.mt" as moveAll

// Swap two coupled groups between two containers (DESIGN.md G6): a connected region grown from a
// movable component of `here` (only components that may run on `there`) and one grown from a
// movable component of `there` (only components that may run on `here`) change places, so the
// number of containers in use stays the same. Each region's size bound is uniform on 1..n of its
// container (seed included). Fails, before any change, when both regions are single components
// (that is swap-components) or both are whole containers (a relabelling).
in first: Placement?
out moved: List<AllocationContext>

match {
    first: Placement { }
    second: Placement { }
    a: AllocationContext { }
    b: AllocationContext { }
    here: ResourceContainer { }
    there: ResourceContainer { }
    first.allocation -- a
    second.allocation -- b
    a.resourceContainer -- here
    b.resourceContainer -- there
    first.candidates -- there
    second.candidates -- here
}
call drawBound(container = here, seed = a, withSeed = true) -> (bound: sizeHere, count: allHere)
call drawBound(container = there, seed = b, withSeed = true) -> (bound: sizeThere, count: allThere)
call drawThreshold(seed = a, source = here, destination = there) -> (theta: thetaHere, usable: coupledHere)
call drawThreshold(seed = b, source = there, destination = here) -> (theta: thetaThere, usable: coupledThere)
call region(seed = a, source = here, destination = there, bound = sizeHere, theta = thetaHere) -> (members: fromHere)
call region(seed = b, source = there, destination = here, bound = sizeThere, theta = thetaThere) -> (members: fromThere)
match {
    where fromHere.size() + fromThere.size() > 2
    where fromHere.size() < allHere || fromThere.size() < allThere
}
call moveAll(members = fromHere, destination = there)
call moveAll(members = fromThere, destination = here)
moved += fromHere
moved += fromThere
