using "../../metamodel/architecture.mm"
import "./group/draw-bound.mt" as drawBound
import "./group/region.mt" as region
import "./group/draw-threshold.mt" as drawThreshold
import "./group/move-all.mt" as moveAll

// Split a connected region off (DESIGN.md G5): from a random movable component of a container that
// holds at least one other, grow a connected region of coupled components (only components that
// may run on the target) and move it to an empty candidate container of the seed. The size bound is
// uniform on 1..n-1 (n = the movable components of the container), so at least one stays behind; the
// region stops earlier when no coupled component is left. Fails, before any change, when the seed
// has no coupled partner that may run on the target (that would be split-component's move; size 1
// stays possible, with probability 1/(n-1), when the bound is 1). "Empty" means no AllocationContext
// but the realisation's derived ones (entity name "realised").
in placement: Placement?
out moved: List<AllocationContext>
out target: ResourceContainer?

match {
    placement: Placement { }
    allocation: AllocationContext { }
    current: ResourceContainer { }
    destination: ResourceContainer { }
    placement.allocation -- allocation
    placement.candidates -- destination
    allocation.resourceContainer -- current

    require shared {
        neighbour: AllocationContext { }
        neighbourPlacement: Placement { }
        neighbourPlacement.allocation -- neighbour
        neighbour.resourceContainer -- current
    }

    forbid occupied {
        resident: AllocationContext { }
        resident.resourceContainer -- destination
        where resident.entityName == null || resident.entityName!! != "realised"
    }
}
call drawBound(container = current, seed = allocation) -> (bound: size)
call drawThreshold(seed = allocation, source = current, destination = destination) -> (theta: threshold, usable: coupled)
match {
    where coupled
}
call region(seed = allocation, source = current, destination = destination, bound = size, theta = threshold) -> (members: part, frontier: reach)
match {
    where reach.size() > 0
}
call moveAll(members = part, destination = destination)
moved += part
target = destination
