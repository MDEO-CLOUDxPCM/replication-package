using "../../metamodel/architecture.mm"
import "./group/unit-members.mt" as unitMembers
import "./group/move-all.mt" as moveAll

// Move a declared unit (DESIGN.md G8): every member of a UnitGroup (a feature, a binding group)
// moves into one container, a candidate of a random member, empty or occupied. Fails, before any
// change, unless every member may run there and at least one is not there yet. With the members
// spread over several containers this gathers the unit; with all of them in one container it moves
// the whole unit. Each component keeps exactly one container.
in unit: UnitGroup?
out moved: List<AllocationContext>
out target: ResourceContainer?

match {
    unit: UnitGroup { }
    anchor: Placement { }
    destination: ResourceContainer { }
    unit.members -- anchor
    anchor.candidates -- destination
}
call unitMembers(unit = unit, destination = destination) -> (all: members, allowed: permitted, away: elsewhere)
match {
    where permitted.size() == members.size()
    where elsewhere.size() > 0
}
call moveAll(members = elsewhere, destination = destination)
moved += elsewhere
target = destination
