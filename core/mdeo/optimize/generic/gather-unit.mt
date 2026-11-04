using "../../metamodel/architecture.mm"
import "./group/unit-members.mt" as unitMembers
import "./group/move-all.mt" as moveAll

// Gather a split unit (DESIGN.md G8): the members of a UnitGroup that are spread over several
// containers move into the container of a random member. Fails, before any change, unless every
// member may run there and at least one is elsewhere.
in unit: UnitGroup?
out moved: List<AllocationContext>
out target: ResourceContainer?

match {
    unit: UnitGroup { }
    anchor: Placement { }
    anchorAllocation: AllocationContext { }
    destination: ResourceContainer { }
    unit.members -- anchor
    anchor.allocation -- anchorAllocation
    anchorAllocation.resourceContainer -- destination
}
call unitMembers(unit = unit, destination = destination) -> (all: members, allowed: permitted, away: elsewhere)
match {
    where permitted.size() == members.size()
    where elsewhere.size() > 0
}
call moveAll(members = elsewhere, destination = destination)
moved += elsewhere
target = destination
