using "../../../metamodel/architecture.mm"

// The members of a UnitGroup (DESIGN.md G8) for a move to `destination`: `all` their allocations,
// `allowed` those that may run on `destination` (Placement.candidates), `away` those not on it yet.
// Changes nothing.
in unit: UnitGroup
in destination: ResourceContainer
out all: List<AllocationContext>
out allowed: List<AllocationContext>
out away: List<AllocationContext>

for match {
    unit { }
    member: Placement { }
    memberAllocation: AllocationContext { }
    unit.members -- member
    member.allocation -- memberAllocation
    all += memberAllocation
} do {
}
for match {
    unit { }
    destination { }
    allowedMember: Placement { }
    allowedAllocation: AllocationContext { }
    unit.members -- allowedMember
    allowedMember.allocation -- allowedAllocation
    allowedMember.candidates -- destination
    allowed += allowedAllocation
} do {
}
for match {
    unit { }
    destination { }
    awayMember: Placement { }
    awayAllocation: AllocationContext { }
    elsewhere: ResourceContainer { }
    unit.members -- awayMember
    awayMember.allocation -- awayAllocation
    awayAllocation.resourceContainer -- elsewhere
    where elsewhere != destination
    away += awayAllocation
} do {
}
