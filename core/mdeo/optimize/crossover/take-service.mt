using "../../metamodel/architecture.mm"
import "./generic/transplant-service.mt" as transplantService
import "../sync/moves.mt" as syncMoves
import "../../transform/repair/placement.mt" as repairPlacement

// Crossover take-service (DESIGN.md AC2): `services` containers of the donor (default one), each
// transplanted into the model with its movable components (./generic/transplant-service.mt), then
// the layer-3 and layer-2 repairs of a change of placement, as the group operators
// (../domain/move-group.mt). Fails, before any change, when the first transplant finds nothing to
// move; a later one that finds nothing is skipped.
in donor: model
in services: int = 1

call transplantService(donor = donor)
if (services > 1) {
    for tsRound in 2.to(services) do {
        if call transplantService(donor = donor) then {
        }
    }
}
call syncMoves()
call repairPlacement()
