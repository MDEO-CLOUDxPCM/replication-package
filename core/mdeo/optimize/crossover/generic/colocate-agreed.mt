using "../../../metamodel/architecture.mm"

// One co-location of agree-colocation (DESIGN.md AC5): a Coupling with at least `needed` votes
// (occurrences in `votes`) whose ends sit in different containers, and one of its ends (the
// mover) whose candidates include the other end's container, drawn uniformly among such
// (coupling, mover) pairs (one match after the engine's shuffle, E3); the mover moves to the other
// end's container (it loses its container and gets that one, G1). Fails, before any change, when
// there is none. `moved` is the mover's allocation.
in votes: List<Coupling>
in needed: double
out moved: AllocationContext

match {
    caCoupling: Coupling { }
    caMover: Placement { }
    caStay: Placement { }
    caMoverAllocation: AllocationContext { }
    caStayAllocation: AllocationContext { }
    caOld: ResourceContainer { }
    caDestination: ResourceContainer { }
    caCoupling.ends -- caMover
    caCoupling.ends -- caStay
    caMover.allocation -- caMoverAllocation
    caStay.allocation -- caStayAllocation
    caStayAllocation.resourceContainer -- caDestination
    caMover.candidates -- caDestination
    where votes.filter((v) => v == caCoupling).size() >= needed
    delete caMoverAllocation.resourceContainer -- caOld
    create caMoverAllocation.resourceContainer -- caDestination
    moved = caMoverAllocation
}
