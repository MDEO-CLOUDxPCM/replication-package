using "../../metamodel/architecture.mm"
import "./group/draw-bound.mt" as drawBound
import "./group/region.mt" as region
import "./group/draw-threshold.mt" as drawThreshold
import "./group/move-all.mt" as moveAll

// Move a coupled group (DESIGN.md G4): a movable component and a connected region of its coupled
// partners in the same container (assembly connectors in either direction; only partners that may
// run on the target) move together to another of the seed's candidate containers. The region's size
// bound is uniform on 2..n (n = the movable components of the container, group/draw-bound.mt); the
// region stops earlier when no coupled partner is left (group/region.mt). Fails, before any change,
// when no partner joins (that would be move-component) and when the whole container would move to an
// empty one (a relabelling). Each component keeps exactly one container.
in placement: Placement?
out moved: List<AllocationContext>
out target: ResourceContainer?
out occupied: boolean

match {
    placement: Placement { }
    allocation: AllocationContext { }
    current: ResourceContainer { }
    destination: ResourceContainer { }
    placement.allocation -- allocation
    placement.candidates -- destination
    allocation.resourceContainer -- current
}
occupied = false
if match {
    destination { }
    resident: AllocationContext { }
    resident.resourceContainer -- destination
    where resident.entityName == null || resident.entityName!! != "realised"
} then {
    occupied = true
}
call drawBound(container = current, seed = allocation) -> (bound: others, count: residents)
call drawThreshold(seed = allocation, source = current, destination = destination) -> (theta: threshold, usable: coupled)
match {
    where coupled
}
call region(seed = allocation, source = current, destination = destination, bound = others + 1, theta = threshold) -> (members: group)
match {
    where group.size() >= 2
    where occupied || group.size() <= residents
}
call moveAll(members = group, destination = destination)
moved += group
target = destination
