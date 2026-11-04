using "../../../metamodel/architecture.mm"

// One donor's vote for agree-colocation (DESIGN.md AC5): the Couplings whose two ends sit in
// different containers in the model and in one container in the donor. Ends correlate by the
// entityName of their allocations (AC1); the donor's container is any one. One vote per donor and
// coupling (`found` is a Set: the pattern finds each coupling twice, once per order of its ends);
// `couplings` lists the same for the caller's count (a List, so that it can add it to its votes).
// Changes nothing, never fails.
in donor: model
out found: Set<Coupling>
out couplings: List<Coupling>

for match {
    dcCoupling: Coupling { }
    dcFirst: Placement { }
    dcSecond: Placement { }
    dcFirstAllocation: AllocationContext { }
    dcSecondAllocation: AllocationContext { }
    dcFirstHost: ResourceContainer { }
    dcSecondHost: ResourceContainer { }
    dcCoupling.ends -- dcFirst
    dcCoupling.ends -- dcSecond
    dcFirst.allocation -- dcFirstAllocation
    dcSecond.allocation -- dcSecondAllocation
    dcFirstAllocation.resourceContainer -- dcFirstHost
    dcSecondAllocation.resourceContainer -- dcSecondHost
    in donor {
        dcDonorFirst: AllocationContext { }
        dcDonorSecond: AllocationContext { }
        dcDonorHost: ResourceContainer { }
        dcDonorFirst.resourceContainer -- dcDonorHost
        dcDonorSecond.resourceContainer -- dcDonorHost
    }
    where dcFirstAllocation.entityName != null && dcSecondAllocation.entityName != null
    where dcDonorFirst.entityName == dcFirstAllocation.entityName
    where dcDonorSecond.entityName == dcSecondAllocation.entityName
    found += dcCoupling
} do {
}
for dcVote in found do {
    couplings += dcVote
}
