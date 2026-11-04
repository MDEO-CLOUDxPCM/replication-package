using "../../metamodel/architecture.mm"
import "./generic/donor-colocated.mt" as donorColocated
import "./generic/colocate-agreed.mt" as colocateAgreed
import "../sync/moves.mt" as syncMoves
import "../../transform/repair/placement.mt" as repairPlacement

// Crossover agree-colocation (DESIGN.md AC5), any number of donors: a coupled pair of components
// (a Coupling, G8) that the model separates and at least `quorum` of the donors (a share: 1.0 =
// all, 0.5 = half) put into one container is co-located: one end moves to the other's container
// (./generic/colocate-agreed.mt). `pairs` such co-locations (default one; the votes are counted
// once, before the first). Then the layer-3 and layer-2 repairs of a change of placement, as the
// group operators (../domain/move-group.mt). Fails, before any change, when no pair qualifies.
// `votes` holds one entry per donor and coupling it co-locates (./generic/donor-colocated.mt).
in donors: List<model>
in quorum: double = 1.0
in pairs: int = 1
out votes: List<Coupling>
out moved: List<AllocationContext>

for d in donors do {
    call donorColocated(donor = d) -> (couplings: agreed)
    votes += agreed
}
call colocateAgreed(votes = votes, needed = quorum * donors.size()) -> (moved: first)
moved += first
if (pairs > 1) {
    for acRound in 2.to(pairs) do {
        if call colocateAgreed(votes = votes, needed = quorum * donors.size()) -> (moved: next) then {
            moved += next
        }
    }
}
call syncMoves()
call repairPlacement()
